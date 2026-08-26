import { spawn } from 'node:child_process'

const sanitizeBin = (value) => String(value || '').trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')

export const FFMPEG_BIN = sanitizeBin(process.env.FFMPEG_PATH) || 'ffmpeg'
export const FFPROBE_BIN = sanitizeBin(process.env.FFPROBE_PATH) || 'ffprobe'

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
      else reject(new Error(`${bin} thoát với mã ${code}. ${stderr.slice(-1200)}`))
    })
  })
}

export function ffmpeg(args, opts = {}) {
  return runBin(FFMPEG_BIN, args, opts)
}

export async function ffmpegAvailable() {
  try {
    const { stdout } = await runBin(FFMPEG_BIN, ['-version'], { captureStdout: true })
    return { ok: true, version: stdout.split('\n')[0].trim() }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

export async function probe(file) {
  const { stdout } = await runBin(FFPROBE_BIN, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    file,
  ], { captureStdout: true })
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
