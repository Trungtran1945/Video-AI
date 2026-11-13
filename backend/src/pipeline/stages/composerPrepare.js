import fs from 'node:fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { query, insert, run } from '../../db/query.js'
import { isProjectRunOwned } from '../../services/projectAdmission.js'
import { ffmpeg } from '../../media/ffmpeg.js'
import {
  tmpDirOf,
  ensureDir,
  resolveStorageKey,
  toStorageKey,
  dimsForAspect,
} from '../context.js'

async function assertRunOwner(projectId, runToken) {
  if (runToken && !(await isProjectRunOwned(projectId, runToken))) {
    const error = new Error('RUN_ABORTED')
    error.code = 'RUN_ABORTED'
    throw error
  }
}

function fmtAssTime(sec) {
  const s = Math.max(0, Number(sec) || 0)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rem = s % 60
  const remSec = Math.floor(rem)
  const cs = Math.floor((rem - remSec) * 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(remSec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

function hexToAssColor(hex) {
  if (!hex || typeof hex !== 'string') return ''
  const clean = hex.replace('#', '').trim()
  if (clean.length === 6) {
    const r = clean.slice(0, 2)
    const g = clean.slice(2, 4)
    const b = clean.slice(4, 6)
    return `&H00${b}${g}${r}&`
  }
  return ''
}

export async function composerPrepare(ctx = {}) {
  const { project, setProgress = () => {}, signal, runToken } = ctx
  if (runToken) await assertRunOwner(project.id, runToken)
  if (signal?.aborted) throw new Error('Cancelled')

  setProgress(10)
  const tmp = ensureDir(tmpDirOf(project.id))
  const prepDir = ensureDir(path.join(tmp, 'prepared'))

  const { width, height } = dimsForAspect(project.aspect_ratio || '16:9')

  const clips = await query(
    'SELECT * FROM timeline_clips WHERE project_id = ? ORDER BY order_index ASC',
    [project.id]
  )

  const imageClips = clips.filter((c) => c.clip_type === 'image' || (!c.clip_type && c.source_type === 'ASSET'))
  const textClips = clips.filter((c) => c.clip_type === 'text' || Boolean(c.text_content))

  // 1. Prepare images: scale & pad to canvas resolution
  const assets = await query('SELECT * FROM assets WHERE project_id = ?', [project.id])
  const assetMap = new Map(assets.map((a) => [a.id, a]))

  for (let i = 0; i < imageClips.length; i++) {
    if (signal?.aborted) throw new Error('Cancelled')
    const c = imageClips[i]
    const asset = assetMap.get(c.asset_id)
    if (!asset) continue

    const srcPath = resolveStorageKey(asset.storage_key)
    if (!srcPath || !fs.existsSync(srcPath)) continue

    const outPrepImage = path.join(prepDir, `img_${c.id}.png`)
    try {
      await ffmpeg([
        '-y', '-i', srcPath,
        '-vf', `scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
        outPrepImage,
      ])
    } catch (err) {
      console.warn(`[composerPrepare] Scale image failed for ${c.id}: ${err.message}`)
      try { fs.copyFileSync(srcPath, outPrepImage) } catch (_) {}
    }

    const pct = Math.round(10 + (40 * (i + 1)) / Math.max(1, imageClips.length))
    setProgress(pct)
  }

  await assertRunOwner(project.id, runToken)

  // 2. Prepare ASS Subtitle File for Text Overlays (Unicode Vietnamese Safe)
  let assPath = null
  let assStorageKey = null
  const assFile = path.join(prepDir, 'subtitles.ass')

  if (textClips.length === 0) {
    // If no text overlays on timeline, ensure stale subtitle files and DB records are completely wiped
    if (fs.existsSync(assFile)) {
      try { fs.unlinkSync(assFile) } catch (_) {}
    }
    try {
      await run("DELETE FROM subtitles WHERE project_id = ? AND format = 'ass'", [project.id])
    } catch (_) {}
    assPath = null
    assStorageKey = null
  } else {
    const assLines = [
      '[Script Info]',
      'Title: Composer Text Overlays',
      'ScriptType: v4.00+',
      'WrapStyle: 0',
      `PlayResX: ${width}`,
      `PlayResY: ${height}`,
      'ScaledBorderAndShadow: yes',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      'Style: Bottom,Arial,36,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,2,1,2,40,40,50,1',
      'Style: Center,Arial,36,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,2,1,5,40,40,40,1',
      'Style: Top,Arial,36,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,2,1,8,40,40,50,1',
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ]

    for (const tc of textClips) {
      // Escape special ASS curly braces to preserve Unicode text safely
      const rawText = (tc.text_content || '').trim().replace(/[{}]/g, '')
      const text = rawText.replace(/\r?\n/g, '\\N')
      if (!text) continue

      let styleName = 'Bottom'
      let parsedStyle = null
      try {
        parsedStyle = tc.style_json ? JSON.parse(tc.style_json) : null
        if (parsedStyle?.position === 'top') styleName = 'Top'
        if (parsedStyle?.position === 'center') styleName = 'Center'
      } catch (_) {}

      let inlineTags = ''
      if (parsedStyle?.color) {
        const assCol = hexToAssColor(parsedStyle.color)
        if (assCol) inlineTags += `\\c${assCol}`
      }
      if (parsedStyle?.fontSize) {
        inlineTags += `\\fs${Math.max(16, Math.min(72, parsedStyle.fontSize))}`
      }
      if (parsedStyle?.fontFamily) {
        inlineTags += `\\fn${parsedStyle.fontFamily}`
      }
      const formattedText = inlineTags ? `{${inlineTags}}${text}` : text

      const start = Number(tc.start_at_sec) || 0
      const duration = Math.max(0.5, Number(tc.out_sec) - Number(tc.in_sec || 0))
      const end = start + duration

      assLines.push(
        `Dialogue: 0,${fmtAssTime(start)},${fmtAssTime(end)},${styleName},,0,0,0,,${formattedText}`
      )
    }

    fs.writeFileSync(assFile, assLines.join('\n'), 'utf8')
    assPath = assFile
    assStorageKey = toStorageKey(assFile)

    // Wipe stale rows and save fresh record into subtitles table
    try {
      await run("DELETE FROM subtitles WHERE project_id = ? AND format = 'ass'", [project.id])
      await insert('subtitles', {
        id: uuidv4(),
        project_id: project.id,
        format: 'ass',
        language: 'vi',
        storage_key: assStorageKey,
      })
    } catch (_) {}
  }

  setProgress(80)
  await assertRunOwner(project.id, runToken)

  // 3. Prepare audio elements (Voiceover & SFX)
  const audios = await query('SELECT * FROM audios WHERE project_id = ?', [project.id])
  const audioMap = new Map(audios.map((a) => [a.id, a]))
  const audioClips = clips.filter((c) => c.clip_type === 'voiceover' || c.clip_type === 'sfx' || c.voice_audio_id || c.audio_id)

  for (const ac of audioClips) {
    const audioId = ac.audio_id || ac.voice_audio_id || ac.asset_id
    const aud = audioMap.get(audioId) || assetMap.get(audioId)
    if (!aud) continue
    const srcAudio = resolveStorageKey(aud.storage_key)
    if (!srcAudio || !fs.existsSync(srcAudio)) continue

    const outPrepWav = path.join(prepDir, `voice_${ac.id}.wav`)
    try {
      await ffmpeg(['-y', '-i', srcAudio, '-ar', '48000', '-ac', '2', outPrepWav])
    } catch (err) {
      console.warn(`[composerPrepare] Resample audio failed for ${ac.id}: ${err.message}`)
    }
  }

  setProgress(100)
  return {
    prepDir,
    assPath,
    assStorageKey,
    imageClipsCount: imageClips.length,
    textClipsCount: textClips.length,
  }
}

export default composerPrepare
