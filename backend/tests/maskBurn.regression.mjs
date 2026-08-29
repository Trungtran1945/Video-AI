// Regression test cho lỗi: "làm mờ tất cả phụ đề" không chạy khi OCR phát hiện 0 vùng,
// và phụ đề dịch không được chèn thay thế.
// Chạy: node tests/maskBurn.regression.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ffmpeg } from '../src/media/ffmpeg.js'
import { maskRegions, burnSubtitlesStyled } from '../src/media/mediaService.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dir = path.join(__dirname, '.tmp')
fs.mkdirSync(dir, { recursive: true })

const SRC = path.join(dir, 'src.mp4')
const MASKED = path.join(dir, 'masked.mp4')
const BURNED = path.join(dir, 'burned.mp4')
const ASS = path.join(dir, 'sub.ass')

const VW = 1280
const VH = 720
// Vùng phụ đề mặc định đáy khung hình (trùng với logic sinh vùng ở dubRender/dubOcr)
const region = {
  start_sec: 0,
  end_sec: 2,
  x: Math.round(VW * 0.05),
  y: Math.round(VH * 0.80),
  width: Math.round(VW * 0.90),
  height: Math.round(VH * 0.15),
}
// Vùng phụ đề thứ 2, vị trí khác (tái hiện pipeline ≥2 vùng — từng gây lỗi
// double bracket [[ov0]] ở maskRegions method='blur').
const region2 = {
  start_sec: 0,
  end_sec: 2,
  x: Math.round(VW * 0.10),
  y: Math.round(VH * 0.55),
  width: Math.round(VW * 0.80),
  height: Math.round(VH * 0.12),
}

function roiStats(file, x, y, w, h) {
  const raw = path.join(dir, 'roi.raw')
  fs.rmSync(raw, { force: true })
  // region cần nằm trong frame; crop tọa độ gốc video
  return ffmpeg([
    '-y', '-i', file,
    '-vf', `crop=${w}:${h}:${x}:${y},format=gray`,
    '-frames:v', '1', '-f', 'rawvideo', raw,
  ]).then(() => {
    const buf = fs.readFileSync(raw)
    let sum = 0
    for (const v of buf) sum += v
    const mean = sum / buf.length
    let s = 0
    for (const v of buf) s += (v - mean) ** 2
    const std = Math.sqrt(s / buf.length)
    let max = 0
    let white = 0
    for (const v of buf) { if (v > max) max = v; if (v > 250) white++ }
    fs.rmSync(raw, { force: true })
    return { mean, std, max, white, n: buf.length }
  })
}

async function main() {
  // 1) Video nguồn: nền đen + nhiễu (để có phương sai đo được) + vùng đáy có nhiễu mạnh
  await ffmpeg([
    '-y', '-f', 'lavfi', '-i', `color=c=black:s=${VW}x${VH}:d=2`,
    '-vf', `noise=alls=25:allf=t+u,drawbox=x=${region.x}:y=${region.y}:w=${region.width}:h=${region.height}:color=gray:t=fill,noise=alls=40:allf=t+u`,
    '-pix_fmt', 'yuv420p', '-t', '2', SRC,
  ])

  // 2) Làm mờ vùng (maskMethod=blur) — tái hiện exactly pipeline gọi maskRegions
  await maskRegions(SRC, [region, region2], MASKED, { method: 'blur', videoDims: { width: VW, height: VH } })

  // 3) Chèn phụ đề dịch (ASS vẽ hình chữ nhật trắng, không cần font)
  fs.writeFileSync(ASS, [
    '[Script Info]',
    `Title: test`,
    'ScriptType: v4.00+',
    `PlayResX: ${VW}`,
    `PlayResY: ${VH}`,
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Dub,Arial,42,&H00FFFFFF,&H000000FF,&H00202020,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,40,40,40,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    `Dialogue: 0,0:00:00.00,0:00:02.00,Dub,,0,0,0,,{\\an5\\pos(${Math.round(region.x + region.width / 2)},${Math.round(region.y + region.height * 0.5)})}{\\p1}m 0 0 l 200 0 l 200 80 l 0 80{\\p0}`,
  ].join('\n'), 'utf8')
  await burnSubtitlesStyled(MASKED, ASS, BURNED)

  // 4) Xác minh: blur làm GIẢM phương sai vùng; burn THÊM pixel trắng
  const srcRoi = await roiStats(SRC, region.x, region.y, region.width, region.height)
  const maskedRoi = await roiStats(MASKED, region.x, region.y, region.width, region.height)
  const burnedRoi = await roiStats(BURNED, region.x, region.y, region.width, region.height)

  const srcRoi2 = await roiStats(SRC, region2.x, region2.y, region2.width, region2.height)
  const maskedRoi2 = await roiStats(MASKED, region2.x, region2.y, region2.width, region2.height)

  console.log('SRC  roi:', JSON.stringify(srcRoi))
  console.log('MASK roi:', JSON.stringify(maskedRoi))
  console.log('BURN roi:', JSON.stringify(burnedRoi))
  console.log('SRC  roi2:', JSON.stringify(srcRoi2))
  console.log('MASK roi2:', JSON.stringify(maskedRoi2))

  const blurOk = maskedRoi.std < srcRoi.std * 0.9
  const blur2Ok = maskedRoi2.std < srcRoi2.std * 0.9
  const burnOk = burnedRoi.white > 0 && burnedRoi.white >= srcRoi.white

  console.log('blur reduced variance (vùng 1):', blurOk, `(src=${srcRoi.std.toFixed(1)} -> masked=${maskedRoi.std.toFixed(1)})`)
  console.log('blur reduced variance (vùng 2):', blur2Ok, `(src=${srcRoi2.std.toFixed(1)} -> masked=${maskedRoi2.std.toFixed(1)})`)
  console.log('burn added white text :', burnOk, `(src white=${srcRoi.white}, burned white=${burnedRoi.white})`)

  if (!blurOk) throw new Error('FAIL: blur không làm mờ vùng phụ đề 1')
  if (!blur2Ok) throw new Error('FAIL: blur không làm mờ vùng phụ đề 2 (lỗi double bracket [[ov0]])')
  if (!burnOk) throw new Error('FAIL: phụ đề dịch không được chèn')
  console.log('\nPASS: maskRegions(blur) + burnSubtitlesStyled hoạt động đúng (≥2 vùng)')
}

main().catch((e) => { console.error(e.message); process.exit(1) })
