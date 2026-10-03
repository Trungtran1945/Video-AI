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
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

# Configuration defaults
DEFAULT_HOST = os.environ.get("ZEROTTS_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("ZEROTTS_PORT", "5005"))
DEFAULT_MODEL = os.environ.get("ZEROTTS_MODEL_DIR") or os.environ.get("ZEROTTS_MODEL_ID") or "zeroweight-ai/ZeroTTS"
DEFAULT_VOICE = os.environ.get("ZEROTTS_VOICE") or os.environ.get("ZEROTTS_DEFAULT_VOICE") or "maichi"
DEFAULT_THREADS = int(os.environ.get("ZEROTTS_THREADS", "4"))
DEFAULT_CONCURRENCY = int(os.environ.get("ZEROTTS_CONCURRENCY", "1"))

# Global service state
model_instance = None
model_lock = None
model_meta = {
    "model": DEFAULT_MODEL,
    "voices": [],
    "sample_rate": 48000,
    "default_voice": DEFAULT_VOICE,
    "concurrency": DEFAULT_CONCURRENCY,
    "load_time_sec": None,
    "synthesize_count": 0,
}


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

        if model_instance is None:
            self._send_error(HTTPStatus.SERVICE_UNAVAILABLE, "Model not loaded", "MODEL_NOT_READY")
            return

        content_length = int(self.headers.get("Content-Length", 0))
        if content_length <= 0:
            self._send_error(HTTPStatus.BAD_REQUEST, "Empty request body", "INVALID_REQUEST")
            return

        try:
            body = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except Exception as e:
            self._send_error(HTTPStatus.BAD_REQUEST, f"Malformed JSON: {e}", "INVALID_JSON")
            return

        raw_text = body.get("text")
        if not raw_text or not isinstance(raw_text, str) or not raw_text.strip():
            self._send_error(HTTPStatus.BAD_REQUEST, "Text is required and must not be empty", "INVALID_TEXT")
            return
        text = raw_text.strip()

        voice = body.get("voice") or model_meta["default_voice"]
        if voice and voice not in model_meta["voices"]:
            self._send_error(
                HTTPStatus.BAD_REQUEST,
                f"Voice '{voice}' không tồn tại. Các voice hợp lệ: {model_meta['voices']}",
                "VOICE_NOT_FOUND",
            )
            return

        speed = float(body.get("speed", 1.0))
        out_path = body.get("out_path")
        accept_header = self.headers.get("Accept", "")

        # Acquire concurrency lock (guarantees single-concurrency or configured limit)
        acquired = model_lock.acquire(timeout=120)
        if not acquired:
            self._send_error(HTTPStatus.SERVICE_UNAVAILABLE, "Server busy (concurrency limit reached)", "SERVER_BUSY")
            return

        try:
            t0 = time.time()
            audio = model_instance.synthesize(text, voice=voice)
            infer_dur = time.time() - t0
            model_meta["synthesize_count"] += 1

            num_samples = audio.shape[1] if audio.ndim > 1 else len(audio)
            duration_sec = round(num_samples / model_instance.sample_rate, 3)

            # If out_path is specified, save file directly
            if out_path:
                target = Path(out_path).resolve()
                target.parent.mkdir(parents=True, exist_ok=True)

                # SoundFile requires .wav path when saving PCM_16 WAV
                if target.suffix.lower() == ".wav":
                    model_instance.save_audio(audio, str(target))
                    saved_path = target
                else:
                    wav_target = target.with_suffix(".wav")
                    model_instance.save_audio(audio, str(wav_target))
                    saved_path = wav_target
                    # Best-effort conversion to MP3 if ffmpeg is available
                    if target.suffix.lower() == ".mp3":
                        import shutil, subprocess
                        ffmpeg_bin = shutil.which("ffmpeg")
                        if ffmpeg_bin:
                            try:
                                subprocess.run(
                                    [ffmpeg_bin, "-y", "-i", str(wav_target), "-c:a", "libmp3lame", "-q:a", "2", str(target)],
                                    check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                                )
                                wav_target.unlink(missing_ok=True)
                                saved_path = target
                            except Exception:
                                pass

                self._send_json(HTTPStatus.OK, {
                    "ok": True,
                    "audioPath": str(saved_path),
                    "durationSec": duration_sec,
                    "sampleRate": model_instance.sample_rate,
                    "voice": voice,
                    "provider": "zerotts",
                    "inferTimeSec": round(infer_dur, 3),
                })
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
            self.wfile.write(wav_bytes)

        except Exception as e:
            self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, f"Synthesis error: {e}", "SYNTHESIS_ERROR")
        finally:
            model_lock.release()

    def log_message(self, format, *args):
        # Override to keep logs clean
        sys.stderr.write(f"[ZeroTTS Server] {self.address_string()} - {format % args}\n")


def run_server(host: str, port: int, model_id: str, default_voice: str, threads: int, concurrency: int):
    """Start persistent ZeroTTS HTTP server."""
    global model_lock, model_meta
    model_lock = threading.Semaphore(concurrency)
    model_meta["default_voice"] = default_voice
    model_meta["concurrency"] = concurrency

    load_model(model_id, intra_threads=threads)

    server = HTTPServer((host, port), ZeroTTSRequestHandler)
    print(f"[ZeroTTS Service] Listening on http://{host}:{port}")
    print(f"[ZeroTTS Service] Concurrency limit: {concurrency}, intra_threads: {threads}")

    def handle_exit(signum, frame):
        print("\n[ZeroTTS Service] Shutting down...")
        threading.Thread(target=server.shutdown).start()

    signal.signal(signal.SIGINT, handle_exit)
    signal.signal(signal.SIGTERM, handle_exit)

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
    parser.add_argument("--threads", type=int, default=DEFAULT_THREADS, help=f"ONNX intra_op_num_threads (default: {DEFAULT_THREADS})")
    parser.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY, help=f"Max concurrent inferences (default: {DEFAULT_CONCURRENCY})")

    args = parser.parse_args()
    run_server(args.host, args.port, args.model, args.voice, args.threads, args.concurrency)


if __name__ == "__main__":
    main()
