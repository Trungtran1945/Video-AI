import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { execSync } from 'node:child_process'

const sanitizeBin = (value) => String(value || '').trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')

// Resolve a media binary path, with graceful fallback:
// 1. explicit env path if the file actually exists
// 2. explicit env path with `.exe` auto-appended (Windows typo safeguard)
// 3. resolve `<name>` from PATH (ffmpeg/ffprobe installed via WinGet on PATH)
// 4. finally fall back to the bare `name` and let spawn report the error.
function resolveBin(envName, name) {
  const raw = sanitizeBin(process.env[envName])
  if (raw) {
    if (fs.existsSync(raw)) return raw
    if (process.platform === 'win32' && !/\.(exe|cmd|bat|ps1)$/i.test(raw)) {
      const withExe = raw + '.exe'
      if (fs.existsSync(withExe)) return withExe
    }
  }
  const fromPath = resolveFromPath(name)
  if (fromPath) return fromPath
  // Common install locations, in case FFMPEG_PATH is wrong/missing and the
  // binary isn't on PATH (e.g. user dropped it in C:\ffmpeg\bin).
  for (const dir of COMMON_BIN_DIRS) {
    const candidate = require('node:path').join(dir, process.platform === 'win32' ? `${name}.exe` : name)
    try { if (fs.existsSync(candidate)) return candidate } catch (_) {}
  }
  return name
}

const COMMON_BIN_DIRS = (process.platform === 'win32')
  ? ['C:\\ffmpeg\\bin', 'C:\\Program Files\\ffmpeg\\bin', 'C:\\ffmpeg']
  : ['/usr/local/bin', '/usr/bin', '/opt/ffmpeg/bin']

function resolveFromPath(name) {
  try {
    const cmd = process.platform === 'win32' ? `where ${name}` : `command -v ${name}`
    const out = execSync(cmd, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)[0]
    return out || null
  } catch (_) {
    return null
  }
}

export const FFMPEG_BIN = resolveBin('FFMPEG_PATH', 'ffmpeg')
export const FFPROBE_BIN = resolveBin('FFPROBE_PATH', 'ffprobe')

function runBin(bin, args, { captureStdout = false, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      if (captureStdout) stdout += d
    })
    child.stderr.on('data', (d) => {
      stderr += d
      if (stderr.length > 128 * 1024) stderr = stderr.slice(-64 * 1024)
    })
    child.on('error', (err) => {
      reject(new Error(`Không chạy được "${bin}". Hãy cài FFmpeg hoặc đặt FFMPEG_PATH trong .env. Chi tiết: ${err.message}`))
    })
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else {
        // Ưu tiên dòng chứa "Error" để dễ chẩn đoán, thay vì chỉ lấy đuôi bị cắt ngắn.
        const errLine = stderr
          .split(/\r?\n/)
          .find((l) => /\berror\b/i.test(l) && l.trim().length > 0)
        const detail = (errLine ? errLine.trim() + '\n' : '') + stderr.slice(-1000)
        reject(new Error(`${bin} thoát với mã ${code}. ${detail}`))
      }
    })
  })
}

// Serialize mọi lời gọi ffmpeg/ffprobe: build ffmpeg 9.0 trên Windows crash
// (exit -22 / 4294967294) khi 2 tiến trình ghi file chạy đồng thời
// (vd: dub.stt ‖ dub.ocr đều spawn ffmpeg ghi file cùng lúc).
let taskQueue = Promise.resolve()
function enqueue(task) {
  const next = taskQueue.then(task, task)
  taskQueue = next.then(() => {}, () => {}) // không giữ lỗi, không rò rỉ chuỗi
  return next
}

export function ffmpeg(args, opts = {}) {
  return enqueue(() => runBin(FFMPEG_BIN, args, opts))
}

export async function ffmpegAvailable() {
  try {
    const { stdout } = await enqueue(() => runBin(FFMPEG_BIN, ['-version'], { captureStdout: true }))
    return { ok: true, version: stdout.split('\n')[0].trim() }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

export async function probe(file) {
  const { stdout } = await enqueue(() => runBin(FFPROBE_BIN, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    file,
  ], { captureStdout: true }))
  let info
  try {
    info = JSON.parse(stdout)
  } catch (_) {
    throw new Error(`ffprobe không đọc được tệp: ${file}`)
  }
  const streams = info.streams || []
  const video = streams.find((s) => s.codec_type === 'video')
  const audio = streams.find((s) => s.codec_type === 'audio')
  const fpsRaw = video?.avg_frame_rate || video?.r_frame_rate || '0/1'
  const [num, den] = fpsRaw.split('/').map(Number)
  return {
    durationSec: Number(info.format?.duration) || 0,
    width: video?.width || 0,
    height: video?.height || 0,
    fps: den ? num / den : 0,
    sizeBytes: Number(info.format?.size) || 0,
    hasAudio: Boolean(audio),
    codec: video?.codec_name || null,
    formatName: info.format?.format_name || null,
  }
}
