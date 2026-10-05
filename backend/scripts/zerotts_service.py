#!/usr/bin/env python3
"""ZeroTTS Local HTTP Service for Video-AI.

Provides a persistent, lightweight HTTP service for ZeroTTS inference:
- Model loaded once at startup and kept in memory.
- Default concurrency = 1 (optimized for 8 GB RAM machines).
- No PyTorch dependencies (ONNX Runtime + NumPy + SoundFile only).
- Exposes GET /health, GET /voices, POST /synthesize.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import signal
import sys
import threading
import time
from http import HTTPStatus
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path

# Configuration defaults (BE-Z01..Z04/BE-D01: env + validate + help text).
# Admission: HTTP → bounded admission (admission_sem) → bounded queue → inference
# workers (model_lock). Vượt capacity → 429/503 SERVER_BUSY/QUEUE_FULL, không để
# hàng trăm thread chờ semaphore 120s.
def _int_env(name: str, default: int) -> int:
    try:
        raw = os.environ.get(name)
        if raw is None or str(raw).strip() == "":
            return default
        return int(str(raw).strip())
    except Exception:
        return default


DEFAULT_HOST = os.environ.get("ZEROTTS_HOST", "127.0.0.1")
DEFAULT_PORT = _int_env("ZEROTTS_PORT", 5005)
DEFAULT_MODEL = (
    os.environ.get("ZEROTTS_MODEL")
    or os.environ.get("ZEROTTS_MODEL_DIR")
    or os.environ.get("ZEROTTS_MODEL_ID")
    or "zeroweight-ai/ZeroTTS"
)
DEFAULT_VOICE = os.environ.get("ZEROTTS_VOICE") or os.environ.get("ZEROTTS_DEFAULT_VOICE") or "maichi"
DEFAULT_THREADS = _int_env("ZEROTTS_THREADS", 4)
DEFAULT_CONCURRENCY = _int_env("ZEROTTS_CONCURRENCY", 1)
DEFAULT_MAX_INFLIGHT = _int_env("ZEROTTS_MAX_INFLIGHT_REQUESTS", 8)
DEFAULT_MAX_BODY_BYTES = _int_env("ZEROTTS_MAX_BODY_BYTES", 64 * 1024)
DEFAULT_MAX_TEXT_CHARS = _int_env("ZEROTTS_MAX_TEXT_CHARS", 2000)
DEFAULT_OUTPUT_ROOT = os.environ.get("ZEROTTS_OUTPUT_ROOT", "") or ""
DEFAULT_SHUTDOWN_TIMEOUT_MS = _int_env("ZEROTTS_SHUTDOWN_TIMEOUT_MS", 15000)

# Global service state
model_instance = None
model_lock = None
admission_sem = None
state_lock = threading.Lock()
server_stopping = False
model_meta = {
    "model": DEFAULT_MODEL,
    "voices": [],
    "sample_rate": 48000,
    "default_voice": DEFAULT_VOICE,
    "concurrency": DEFAULT_CONCURRENCY,
    "load_time_sec": None,
    "synthesize_count": 0,
}
# BE-Z07 observability (không leak paths/secrets/full text).
service_stats = {
    "started": 0,
    "completed": 0,
    "failed": 0,
    "abandoned": 0,
    "active_requests": 0,
    "active_inference": 0,
}
service_limits = {
    "max_inflight": DEFAULT_MAX_INFLIGHT,
    "max_body_bytes": DEFAULT_MAX_BODY_BYTES,
    "max_text_chars": DEFAULT_MAX_TEXT_CHARS,
    "output_root": DEFAULT_OUTPUT_ROOT,
}


def validate_resource_config(threads: int, concurrency: int, max_inflight: int) -> None:
    """BE-Z03: fail-fast khi config tài nguyên invalid (exit non-zero + log rõ)."""
    problems = []
    if not isinstance(threads, int) or threads < 1 or threads > 64:
        problems.append(f"ZEROTTS_THREADS={threads} invalid (must be 1..64)")
    if not isinstance(concurrency, int) or concurrency < 1 or concurrency > 16:
        problems.append(f"ZEROTTS_CONCURRENCY={concurrency} invalid (must be 1..16)")
    if not isinstance(max_inflight, int) or max_inflight < 1 or max_inflight > 64:
        problems.append(f"ZEROTTS_MAX_INFLIGHT_REQUESTS={max_inflight} invalid (must be 1..64)")
    if service_limits.get("max_body_bytes", 0) < 1024:
        problems.append("ZEROTTS_MAX_BODY_BYTES invalid (must be >=1024)")
    if service_limits.get("max_text_chars", 0) < 1:
        problems.append("ZEROTTS_MAX_TEXT_CHARS invalid (must be >=1)")
    if problems:
        for p in problems:
            print(f"[ZeroTTS Service] FATAL config: {p}", file=sys.stderr)
        sys.exit(2)


def resolve_output_root(raw: str) -> Path:
    """BE-Z04: mọi output phải nằm dưới OUTPUT_ROOT (jail). Default tmp service-owned."""
    base = (raw or "").strip()
    if not base:
        base = str(Path(os.environ.get("TMPDIR", "/tmp")) / "zerotts_service")
    root = Path(base).resolve()
    try:
        root.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        print(f"[ZeroTTS Service] FATAL: cannot create OUTPUT_ROOT {root}: {e}", file=sys.stderr)
        sys.exit(2)
    return root


OUTPUT_ROOT = resolve_output_root(DEFAULT_OUTPUT_ROOT)
service_limits["output_root"] = str(OUTPUT_ROOT)


def is_path_inside_root(target: Path, root: Path) -> bool:
    try:
        target.resolve().relative_to(root.resolve())
        return True
    except Exception:
        return False


def load_model(model_id_or_dir: str, intra_threads: int = 4):
    """Load ZeroTTS model once into memory."""
    global model_instance, model_meta
    from zerotts import ZeroTTS

    t0 = time.time()
    print(f"[ZeroTTS Service] Loading model '{model_id_or_dir}' (threads={intra_threads})...")
    tts = ZeroTTS.from_pretrained(model_id_or_dir, intra_op_num_threads=intra_threads)
    duration = round(time.time() - t0, 2)
    voices = tts.list_voices()
    print(f"[ZeroTTS Service] Model loaded successfully in {duration}s.")
    print(f"[ZeroTTS Service] Available voices ({len(voices)}): {voices}")

    model_instance = tts
    model_meta["model"] = str(model_id_or_dir)
    model_meta["voices"] = voices
    model_meta["sample_rate"] = int(tts.sample_rate)
    model_meta["load_time_sec"] = duration
    return tts


class ZeroTTSRequestHandler(BaseHTTPRequestHandler):
    """HTTP request handler for ZeroTTS endpoints."""

    def _send_json(self, status: int, data: dict):
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _send_error(self, status: int, message: str, code: str = "ERROR"):
        self._send_json(status, {"error": message, "code": code})

    def do_GET(self):
        url_path = self.path.split("?")[0].rstrip("/")
        if url_path in ("", "/health"):
            if model_instance is None:
                self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {
                    "status": "error",
                    "error": "Model not loaded",
                    "code": "MODEL_NOT_READY",
                })
                return
            # BE-Z07: health giàu có nhưng không leak paths/secrets/full text.
            with state_lock:
                stats = dict(service_stats)
            self._send_json(HTTPStatus.OK, {
                "status": "ok",
                "model_loaded": True,
                "model": model_meta["model"],
                "voices": model_meta["voices"],
                "default_voice": model_meta["default_voice"],
                "sample_rate": model_meta["sample_rate"],
                "concurrency": model_meta["concurrency"],
                "synthesize_count": model_meta["synthesize_count"],
                "load_time_sec": model_meta["load_time_sec"],
                "queueDepth": max(0, stats["active_requests"] - stats["active_inference"]),
                "activeRequests": stats["active_requests"],
                "activeInference": stats["active_inference"],
                "started": stats["started"],
                "completed": stats["completed"],
                "failed": stats["failed"],
                "abandoned": stats["abandoned"],
                "maxInflight": service_limits["max_inflight"],
                "stopping": server_stopping,
            })
        elif url_path == "/voices":
            if model_instance is None:
                self._send_error(HTTPStatus.SERVICE_UNAVAILABLE, "Model not loaded", "MODEL_NOT_READY")
                return
            self._send_json(HTTPStatus.OK, {
                "voices": model_meta["voices"],
                "default": model_meta["default_voice"],
            })
        else:
            self._send_error(HTTPStatus.NOT_FOUND, f"Endpoint not found: {self.path}", "NOT_FOUND")

    def do_POST(self):
        url_path = self.path.split("?")[0].rstrip("/")
        if url_path != "/synthesize":
            self._send_error(HTTPStatus.NOT_FOUND, f"Endpoint not found: {self.path}", "NOT_FOUND")
            return

        if server_stopping:
            self._send_error(HTTPStatus.SERVICE_UNAVAILABLE, "Server is stopping, please retry later", "SERVER_BUSY")
            return

        if model_instance is None:
            self._send_error(HTTPStatus.SERVICE_UNAVAILABLE, "Model not loaded", "MODEL_NOT_READY")
            return

        # BE-Z02: check Content-Length TRƯỚC khi read (không đọc unlimited body).
        raw_len = self.headers.get("Content-Length")
        if raw_len is None or str(raw_len).strip() == "":
            self._send_error(HTTPStatus.BAD_REQUEST, "Content-Length is required", "INVALID_REQUEST")
            return
        try:
            content_length = int(str(raw_len).strip())
        except Exception:
            self._send_error(HTTPStatus.BAD_REQUEST, "Invalid Content-Length", "INVALID_REQUEST")
            return
        if content_length <= 0:
            self._send_error(HTTPStatus.BAD_REQUEST, "Empty request body", "INVALID_REQUEST")
            return
        if content_length > int(service_limits["max_body_bytes"]):
            self._send_error(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                f"Request body too large (>{service_limits['max_body_bytes']} bytes), please retry later",
                "BODY_TOO_LARGE",
            )
            return

        # BE-Z01: bounded admission — fail fast khi vượt capacity, không giữ hàng
        # trăm thread chờ model_lock 120s. Non-blocking acquire.
        admitted = admission_sem.acquire(blocking=False) if admission_sem is not None else True
        if not admitted:
            self._send_error(
                HTTPStatus.TOO_MANY_REQUESTS,
                "Server busy, too many requests please retry later (admission queue full)",
                "QUEUE_FULL",
            )
            return
        with state_lock:
            service_stats["started"] += 1
            service_stats["active_requests"] += 1
        inference_held = False
        try:
            try:
                raw = self.rfile.read(content_length)
            except Exception as e:
                with state_lock:
                    service_stats["failed"] += 1
                self._send_error(HTTPStatus.BAD_REQUEST, f"Failed to read request body: {e}", "INVALID_REQUEST")
                return
            try:
                body = json.loads(raw.decode("utf-8"))
            except Exception as e:
                with state_lock:
                    service_stats["failed"] += 1
                self._send_error(HTTPStatus.BAD_REQUEST, f"Malformed JSON: {e}", "INVALID_JSON")
                return

            raw_text = body.get("text")
            if not raw_text or not isinstance(raw_text, str) or not raw_text.strip():
                with state_lock:
                    service_stats["failed"] += 1
                self._send_error(HTTPStatus.BAD_REQUEST, "Text is required and must not be empty", "INVALID_TEXT")
                return
            text = raw_text.strip()
            # BE-Z02: text limit sau parse (không log full text).
            if len(text) > int(service_limits["max_text_chars"]):
                with state_lock:
                    service_stats["failed"] += 1
                self._send_error(
                    HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                    f"Text too long (>{service_limits['max_text_chars']} chars)",
                    "TEXT_TOO_LONG",
                )
                return

            voice = body.get("voice") or model_meta["default_voice"]
            if voice and voice not in model_meta["voices"]:
                with state_lock:
                    service_stats["failed"] += 1
                self._send_error(
                    HTTPStatus.BAD_REQUEST,
                    f"Voice '{voice}' không tồn tại.",
                    "VOICE_NOT_FOUND",
                )
                return

            try:
                speed = float(body.get("speed", 1.0))
            except Exception:
                speed = 1.0
            out_path = body.get("out_path")

            # Acquire concurrency lock (guarantees single-concurrency or configured limit)
            acquired = model_lock.acquire(timeout=120)
            if not acquired:
                with state_lock:
                    service_stats["failed"] += 1
                self._send_error(HTTPStatus.SERVICE_UNAVAILABLE, "Server busy, too many requests please retry later (concurrency limit reached)", "SERVER_BUSY")
                return
            inference_held = True
            with state_lock:
                service_stats["active_inference"] += 1

            try:
                t0 = time.time()
                audio = model_instance.synthesize(text, voice=voice)
                infer_dur = time.time() - t0
                model_meta["synthesize_count"] += 1

                num_samples = audio.shape[1] if audio.ndim > 1 else len(audio)
                duration_sec = round(num_samples / model_instance.sample_rate, 3)

                # If out_path is specified, save file directly (BE-Z04 jailed).
                if out_path:
                    try:
                        target = Path(str(out_path)).resolve()
                    except Exception:
                        with state_lock:
                            service_stats["failed"] += 1
                        self._send_error(HTTPStatus.BAD_REQUEST, "Invalid out_path", "INVALID_REQUEST")
                        return
                    # BE-Z04 OUTPUT_ROOT jail: reject traversal/absolute ngoài root/
                    # symlink escape + arbitrary parent mkdir.
                    try:
                        if target.is_symlink() or not is_path_inside_root(target, OUTPUT_ROOT):
                            with state_lock:
                                service_stats["failed"] += 1
                            self._send_error(HTTPStatus.FORBIDDEN, "out_path outside OUTPUT_ROOT", "FORBIDDEN_PATH")
                            return
                    except Exception:
                        with state_lock:
                            service_stats["failed"] += 1
                        self._send_error(HTTPStatus.FORBIDDEN, "out_path outside OUTPUT_ROOT", "FORBIDDEN_PATH")
                        return
                    try:
                        target.parent.mkdir(parents=True, exist_ok=True)
                    except Exception as e:
                        with state_lock:
                            service_stats["failed"] += 1
                        self._send_error(HTTPStatus.FORBIDDEN, f"Cannot create output dir: {e}", "FORBIDDEN_PATH")
                        return
                    # Re-check sau mkdir để chống symlink escape (parent bị swap).
                    try:
                        if not is_path_inside_root(target.parent.resolve(), OUTPUT_ROOT):
                            with state_lock:
                                service_stats["failed"] += 1
                            self._send_error(HTTPStatus.FORBIDDEN, "out_path escapes OUTPUT_ROOT", "FORBIDDEN_PATH")
                            return
                    except Exception:
                        with state_lock:
                            service_stats["failed"] += 1
                        self._send_error(HTTPStatus.FORBIDDEN, "out_path escapes OUTPUT_ROOT", "FORBIDDEN_PATH")
                        return

                    # SoundFile requires .wav path when saving PCM_16 WAV
                    if target.suffix.lower() == ".wav":
                        model_instance.save_audio(audio, str(target))
                        saved_path = target
                    else:
                        wav_target = target.with_suffix(".wav")
                        if not is_path_inside_root(wav_target, OUTPUT_ROOT):
                            with state_lock:
                                service_stats["failed"] += 1
                            self._send_error(HTTPStatus.FORBIDDEN, "out_path outside OUTPUT_ROOT", "FORBIDDEN_PATH")
                            return
                        model_instance.save_audio(audio, str(wav_target))
                        saved_path = wav_target
                        # BE-Z05 MP3 thật fail-closed: FFmpeg missing/convert fail → 5xx,
                        # không `except: pass` để lại WAV đội lốt MP3.
                        if target.suffix.lower() == ".mp3":
                            import shutil, subprocess
                            ffmpeg_bin = shutil.which("ffmpeg")
                            if not ffmpeg_bin:
                                try:
                                    wav_target.unlink(missing_ok=True)
                                except Exception:
                                    pass
                                with state_lock:
                                    service_stats["failed"] += 1
                                self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, "MP3 conversion unavailable (ffmpeg missing)", "SYNTHESIS_ERROR")
                                return
                            try:
                                subprocess.run(
                                    [ffmpeg_bin, "-y", "-i", str(wav_target), "-c:a", "libmp3lame", "-q:a", "2", str(target)],
                                    check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                                )
                            except Exception as conv_e:
                                try:
                                    wav_target.unlink(missing_ok=True)
                                except Exception:
                                    pass
                                try:
                                    if target.exists():
                                        target.unlink(missing_ok=True)
                                except Exception:
                                    pass
                                with state_lock:
                                    service_stats["failed"] += 1
                                self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, f"MP3 conversion failed: {conv_e}", "SYNTHESIS_ERROR")
                                return
                            # ffprobe validate MP3 thật trước khi success.
                            try:
                                probe = subprocess.run(
                                    [shutil.which("ffprobe") or "ffprobe", "-v", "quiet", "-print_format", "json",
                                     "-show_format", str(target)],
                                    capture_output=True, text=True, timeout=10,
                                )
                                info = json.loads(probe.stdout or "{}")
                                fmt = str(info.get("format", {}).get("format_name", ""))
                                if "mp3" not in fmt.lower():
                                    try:
                                        target.unlink(missing_ok=True)
                                    except Exception:
                                        pass
                                    with state_lock:
                                        service_stats["failed"] += 1
                                    self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, "MP3 validation failed", "SYNTHESIS_ERROR")
                                    return
                            except Exception as probe_e:
                                # ffprobe missing/invalid → fail-closed (không trả file chưa verify).
                                try:
                                    target.unlink(missing_ok=True)
                                except Exception:
                                    pass
                                with state_lock:
                                    service_stats["failed"] += 1
                                self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, f"MP3 validation failed: {probe_e}", "SYNTHESIS_ERROR")
                                return
                            wav_target.unlink(missing_ok=True)
                            saved_path = target

                    self._send_json(HTTPStatus.OK, {
                        "ok": True,
                        "audioPath": str(saved_path),
                        "durationSec": duration_sec,
                        "sampleRate": model_instance.sample_rate,
                        "voice": voice,
                        "provider": "zerotts",
                        "inferTimeSec": round(infer_dur, 3),
                    })
                    with state_lock:
                        service_stats["completed"] += 1
                    return

                # Otherwise return WAV stream
                buf = io.BytesIO()
                model_instance.save_audio(audio, buf)
                wav_bytes = buf.getvalue()

                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(wav_bytes)))
                self.send_header("X-Audio-Duration", str(duration_sec))
                self.send_header("X-Sample-Rate", str(model_instance.sample_rate))
                self.send_header("X-Voice", str(voice))
                self.send_header("X-Provider", "zerotts")
                self.end_headers()
                try:
                    self.wfile.write(wav_bytes)
                except (BrokenPipeError, ConnectionResetError):
                    with state_lock:
                        service_stats["abandoned"] += 1
                    return
                with state_lock:
                    service_stats["completed"] += 1

            except Exception as e:
                with state_lock:
                    service_stats["failed"] += 1
                try:
                    self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, "Synthesis error", "SYNTHESIS_ERROR")
                except Exception:
                    pass
            finally:
                if inference_held:
                    try:
                        model_lock.release()
                    except Exception:
                        pass
                    with state_lock:
                        service_stats["active_inference"] = max(0, service_stats["active_inference"] - 1)
        finally:
            # BE-Z08: luôn release admission slot (kể cả client timeout/disconnect) để
            # request tiếp theo không bị kẹt semaphore.
            with state_lock:
                service_stats["active_requests"] = max(0, service_stats["active_requests"] - 1)
            try:
                admission_sem.release()
            except Exception:
                pass

    def log_message(self, format, *args):
        # Override to keep logs clean
        sys.stderr.write(f"[ZeroTTS Server] {self.address_string()} - {format % args}\n")


def run_server(host: str, port: int, model_id: str, default_voice: str, threads: int, concurrency: int,
               max_inflight: int = DEFAULT_MAX_INFLIGHT, max_body_bytes: int = DEFAULT_MAX_BODY_BYTES,
               max_text_chars: int = DEFAULT_MAX_TEXT_CHARS, output_root: str = "",
               shutdown_timeout_ms: int = DEFAULT_SHUTDOWN_TIMEOUT_MS):
    """Start persistent ZeroTTS HTTP service (BE-Z01/Z03/Z07)."""
    global model_lock, admission_sem, model_meta, server_stopping, OUTPUT_ROOT
    service_limits["max_inflight"] = int(max_inflight)
    service_limits["max_body_bytes"] = int(max_body_bytes)
    service_limits["max_text_chars"] = int(max_text_chars)
    if output_root:
        OUTPUT_ROOT = resolve_output_root(output_root)
        service_limits["output_root"] = str(OUTPUT_ROOT)
    validate_resource_config(int(threads), int(concurrency), int(max_inflight))
    model_lock = threading.Semaphore(int(concurrency))
    admission_sem = threading.Semaphore(int(max_inflight))
    model_meta["default_voice"] = default_voice
    model_meta["concurrency"] = int(concurrency)

    load_model(model_id, intra_threads=int(threads))

    # Allow immediate rebinding of the test port between runs.
    ThreadingHTTPServer.allow_reuse_address = True
    server = ThreadingHTTPServer((host, port), ZeroTTSRequestHandler)
    print(f"[ZeroTTS Service] Listening on http://{host}:{port}")
    print(f"[ZeroTTS Service] Concurrency={concurrency}, intra_threads={threads}, max_inflight={max_inflight}, "
          f"max_body={max_body_bytes}B, max_text={max_text_chars} chars, output_root={OUTPUT_ROOT}")

    # BE-Z07 graceful shutdown: SIGTERM/SIGINT → STOPPING (reject new) → drain bounded
    # work → shutdown queue → release. Bounded bởi SHUTDOWN_TIMEOUT_MS, không treo vô hạn.
    def handle_exit(signum, frame):
        global server_stopping
        print("\n[ZeroTTS Service] Shutting down (STOPPING, reject new requests)...")
        server_stopping = True
        deadline = time.time() + max(1, int(shutdown_timeout_ms) / 1000)
        def _drain_and_stop():
            try:
                while time.time() < deadline:
                    with state_lock:
                        active = service_stats["active_requests"]
                    if active <= 0:
                        break
                    time.sleep(0.1)
            finally:
                try:
                    server.shutdown()
                except Exception:
                    pass
        threading.Thread(target=_drain_and_stop, daemon=True).start()

    try:
        signal.signal(signal.SIGINT, handle_exit)
    except Exception:
        pass
    try:
        signal.signal(signal.SIGTERM, handle_exit)
    except Exception:
        pass

    try:
        server.serve_forever()
    finally:
        server.server_close()
        print("[ZeroTTS Service] Server stopped.")


def main():
    parser = argparse.ArgumentParser(description="ZeroTTS Local HTTP Service for Video-AI")
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"Host to bind (default: {DEFAULT_HOST})")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"Port to bind (default: {DEFAULT_PORT})")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Model directory or HF repo ID (default: {DEFAULT_MODEL})")
    parser.add_argument("--voice", default=DEFAULT_VOICE, help=f"Default voice (default: {DEFAULT_VOICE})")
    parser.add_argument("--threads", type=int, default=DEFAULT_THREADS, help=f"ONNX intra_op_num_threads 1..64 (default: {DEFAULT_THREADS})")
    parser.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY, help=f"Max concurrent inferences 1..16 (default: {DEFAULT_CONCURRENCY})")
    parser.add_argument("--max-inflight", dest="max_inflight", type=int, default=DEFAULT_MAX_INFLIGHT,
                        help=f"Bounded admission: max in-flight HTTP requests 1..64 (default: {DEFAULT_MAX_INFLIGHT}). Vượt → 429 QUEUE_FULL.")
    parser.add_argument("--max-body-bytes", dest="max_body_bytes", type=int, default=DEFAULT_MAX_BODY_BYTES,
                        help=f"Max request body bytes (default: {DEFAULT_MAX_BODY_BYTES}). Vượt → 413.")
    parser.add_argument("--max-text-chars", dest="max_text_chars", type=int, default=DEFAULT_MAX_TEXT_CHARS,
                        help=f"Max text chars per request (default: {DEFAULT_MAX_TEXT_CHARS}). Vượt → 413.")
    parser.add_argument("--output-root", dest="output_root", default=DEFAULT_OUTPUT_ROOT,
                        help="OUTPUT_ROOT jail: mọi out_path phải nằm dưới root (default: tmp service-owned). Ngoài root → 403.")
    parser.add_argument("--shutdown-timeout-ms", dest="shutdown_timeout_ms", type=int, default=DEFAULT_SHUTDOWN_TIMEOUT_MS,
                        help=f"Graceful shutdown drain timeout ms (default: {DEFAULT_SHUTDOWN_TIMEOUT_MS})")

    args = parser.parse_args()
    run_server(args.host, args.port, args.model, args.voice, args.threads, args.concurrency,
               args.max_inflight, args.max_body_bytes, args.max_text_chars,
               args.output_root, args.shutdown_timeout_ms)


if __name__ == "__main__":
    main()
