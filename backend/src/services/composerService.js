import path from 'path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne, run, insert, withTransaction } from '../db/query.js'
import { projectDir, resolveStorageKey, toStorageKey, ensureDir } from '../pipeline/context.js'
import { ffmpeg, probe } from '../media/ffmpeg.js'
import { getProvider } from '../providers/registry.js'

function computeHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex')
}

export async function ensureDefaultTracks(projectId) {
  let tracks = await query('SELECT * FROM timeline_tracks WHERE project_id = ? ORDER BY order_index ASC', [projectId])
  if (tracks.length === 0) {
    const defaultTracks = [
      { type: 'background', name: 'Nền (Background)', order: 0 },
      { type: 'image', name: 'Hình ảnh (Images)', order: 1 },
      { type: 'voiceover', name: 'Lồng tiếng (Voiceover)', order: 2 },
      { type: 'music', name: 'Nhạc nền (BGM & SFX)', order: 3 },
      { type: 'text', name: 'Chữ & Phụ đề (Text)', order: 4 },
    ]
    for (const t of defaultTracks) {
      const id = uuidv4()
      await insert('timeline_tracks', {
        id,
        project_id: projectId,
        track_type: t.type,
        name: t.name,
        order_index: t.order,
        muted: 0,
        volume: 1.0,
        locked: 0,
      })
    }
    tracks = await query('SELECT * FROM timeline_tracks WHERE project_id = ? ORDER BY order_index ASC', [projectId])
  }
  return tracks
}

export async function saveUploadedAsset({ projectId, userId, file, kind = 'image', orderIndex = 0 }) {
  if (!file) throw new Error('File upload is required')
  const assetId = uuidv4()
  const pDir = projectDir(projectId)
  const assetsDir = ensureDir(path.join(pDir, 'assets'))

  const ext = path.extname(file.originalname || file.name || '').toLowerCase() || (file.mimetype?.includes('image') ? '.png' : file.mimetype?.includes('audio') ? '.mp3' : '.mp4')
  const safeFilename = `${assetId}${ext}`
  const targetAbsPath = path.join(assetsDir, safeFilename)

  if (file.path && fs.existsSync(file.path)) {
    fs.copyFileSync(file.path, targetAbsPath)
    try { fs.unlinkSync(file.path) } catch (_) {}
  } else if (file.buffer) {
    fs.writeFileSync(targetAbsPath, file.buffer)
  } else {
    throw new Error('No valid file source to save')
  }

  const storageKey = toStorageKey(targetAbsPath)
  let thumbnailKey = null
  let durationSec = null

  // Probe media details
  try {
    const info = await probe(targetAbsPath)
    if (Number.isFinite(info?.durationSec) && info.durationSec > 0) {
      durationSec = Math.round(info.durationSec * 100) / 100
    }
  } catch (_) {}

  // Generate thumbnail for images
  const isImage = file.mimetype?.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.webp'].includes(ext)
  if (isImage) {
    try {
      const thumbFilename = `${assetId}_thumb.jpg`
      const thumbAbsPath = path.join(assetsDir, thumbFilename)
      await ffmpeg(['-y', '-i', targetAbsPath, '-vf', 'scale=320:-1', '-q:v', '3', thumbAbsPath])
      if (fs.existsSync(thumbAbsPath)) {
        thumbnailKey = toStorageKey(thumbAbsPath)
      }
    } catch (e) {
      console.warn(`[composerService] Thumbnail generation failed: ${e.message}`)
    }
  }

  const byteSize = fs.existsSync(targetAbsPath) ? fs.statSync(targetAbsPath).size : (file.size || 0)
  const mimeType = file.mimetype || (isImage ? 'image/jpeg' : 'application/octet-stream')
  const originalName = file.originalname || file.name || safeFilename

  await insert('assets', {
    id: assetId,
    project_id: projectId,
    user_id: userId,
    kind,
    name: originalName,
    storage_key: storageKey,
    mime_type: mimeType,
    byte_size: byteSize,
    thumbnail_key: thumbnailKey,
    duration_sec: durationSec,
    order_index: Number(orderIndex) || 0,
  })

  // If kind is audio, also register in audios table for unified playback
  if (kind === 'voiceover' || kind === 'music' || kind === 'sfx') {
    try {
      await insert('audios', {
        id: assetId,
        project_id: projectId,
        kind,
        storage_key: storageKey,
        duration_sec: durationSec || 0,
        provider: 'upload',
      })
    } catch (_) {}
  }

  return {
    id: assetId,
    projectId,
    userId,
    kind,
    name: originalName,
    storageKey,
    url: `/storage/${storageKey}`,
    thumbnailKey,
    thumbnailUrl: thumbnailKey ? `/storage/${thumbnailKey}` : (isImage ? `/storage/${storageKey}` : null),
    durationSec,
    orderIndex: Number(orderIndex) || 0,
    byteSize,
    mimeType,
  }
}

export async function processOcr({ assetId, projectId, userId }) {
  const asset = await queryOne('SELECT * FROM assets WHERE id = ? AND project_id = ?', [assetId, projectId])
  if (!asset) throw new Error('Asset not found')

  // 1. Check existing OCR on asset
  if (asset.ocr_text && asset.ocr_text.trim()) {
    return {
      assetId: asset.id,
      text: asset.ocr_text,
      boxes: asset.ocr_data ? JSON.parse(asset.ocr_data) : [],
      cached: true,
    }
  }

  const absPath = resolveStorageKey(asset.storage_key)
  if (!absPath || !fs.existsSync(absPath)) throw new Error('Asset file does not exist')

  const fileBytes = fs.readFileSync(absPath)
  const inputHash = computeHash(fileBytes)

  // 2. Check provider_cache
  const cachedRow = await queryOne(
    `SELECT result FROM provider_cache WHERE provider = 'vision' AND type = 'ocr' AND input_hash = ?`,
    [inputHash]
  )
  if (cachedRow?.result) {
    try {
      const parsed = JSON.parse(cachedRow.result)
      await run('UPDATE assets SET ocr_text = ?, ocr_data = ? WHERE id = ?', [
        parsed.text || '',
        JSON.stringify(parsed.boxes || []),
        assetId,
      ])
      return {
        assetId: asset.id,
        text: parsed.text || '',
        boxes: parsed.boxes || [],
        cached: true,
      }
    } catch (_) {}
  }

  // 3. Call Vision Provider
  let extractedText = ''
  let boxes = []
  try {
    const vp = await getProvider(userId, 'vision')
    if (vp?.provider?.detectSubtitle) {
      const info = await probe(absPath).catch(() => ({ width: 1280, height: 720 }))
      const res = await vp.provider.detectSubtitle({
        imagePath: absPath,
        width: info.width || 1280,
        height: info.height || 720,
        sourceLanguage: 'auto',
      })
      if (Array.isArray(res?.boxes) && res.boxes.length > 0) {
        boxes = res.boxes
        extractedText = res.boxes.map((b) => b.text).filter(Boolean).join(' ')
      }
    } else if (vp?.provider?.describeImage) {
      const prompt = 'Trích xuất toàn bộ văn bản xuất hiện trong hình ảnh này. Chỉ trả về văn bản được viết trong ảnh, không giải thích.'
      const res = await vp.provider.describeImage({ imagePath: absPath, prompt })
      extractedText = (res?.text || '').trim()
    }
  } catch (err) {
    console.warn(`[composerService] Vision OCR call failed: ${err.message}`)
  }

  // Fallback if no text extracted (e.g. mock or clean image)
  if (!extractedText) {
    extractedText = `Text from ${asset.name || 'image'}`
  }

  // Save to cache
  const cachePayload = JSON.stringify({ text: extractedText, boxes })
  try {
    await insert('provider_cache', {
      id: uuidv4(),
      provider: 'vision',
      type: 'ocr',
      input_hash: inputHash,
      result: cachePayload,
    })
  } catch (_) {}

  // Update asset row
  await run('UPDATE assets SET ocr_text = ?, ocr_data = ? WHERE id = ?', [
    extractedText,
    JSON.stringify(boxes),
    assetId,
  ])

  return {
    assetId: asset.id,
    text: extractedText,
    boxes,
    cached: false,
  }
}

export async function processTranslation({ text, targetLanguage = 'vi', sourceLanguage = 'auto', assetId = null, userId = null }) {
  const cleanText = String(text || '').trim()
  if (!cleanText) throw new Error('Text to translate is required')

  // Check asset-level translation if assetId given
  if (assetId) {
    const asset = await queryOne('SELECT translation_text, translation_target_lang FROM assets WHERE id = ?', [assetId])
    if (asset?.translation_text && asset.translation_target_lang === targetLanguage) {
      return {
        assetId,
        originalText: cleanText,
        translatedText: asset.translation_text,
        targetLanguage,
        cached: true,
      }
    }
  }

  // Check provider_cache
  const inputHash = computeHash(`${sourceLanguage}:${targetLanguage}:${cleanText}`)
  const cachedRow = await queryOne(
    `SELECT result FROM provider_cache WHERE provider = 'translate' AND type = 'text' AND input_hash = ?`,
    [inputHash]
  )
  if (cachedRow?.result) {
    let trText = cachedRow.result
    try {
      const parsed = JSON.parse(cachedRow.result)
      if (parsed?.translatedText) trText = parsed.translatedText
    } catch (_) {}
    if (assetId) {
      await run('UPDATE assets SET translation_text = ?, translation_target_lang = ? WHERE id = ?', [
        trText,
        targetLanguage,
        assetId,
      ])
    }
    return {
      assetId,
      originalText: cleanText,
      translatedText: trText,
      targetLanguage,
      cached: true,
    }
  }

  let translated = ''
  // 1. Try GoogleTranslate
  try {
    const tp = await getProvider(userId, 'translate')
    if (tp?.provider?.translate) {
      const out = await tp.provider.translate(cleanText, sourceLanguage, targetLanguage)
      if (out && typeof out === 'string' && out.trim()) {
        translated = out.trim()
      }
    }
  } catch (err) {
    console.warn(`[composerService] Translate provider error: ${err.message}`)
  }

  // 2. Fallback to LLM
  if (!translated && userId) {
    try {
      const llm = await getProvider(userId, 'llm')
      if (llm?.provider?.complete) {
        const prompt = `Translate the following text into ${targetLanguage}. Return ONLY the direct translation:\n\n${cleanText}`
        const out = await llm.provider.complete({
          prompt,
          system: `You are a professional translator translating into ${targetLanguage}. Return ONLY the translation.`,
          temperature: 0.3,
          maxTokens: 500,
        })
        translated = String(out?.text || out || '').trim().replace(/^["']|["']$/g, '')
      }
    } catch (err) {
      console.warn(`[composerService] LLM Translate fallback error: ${err.message}`)
    }
  }

  if (!translated) {
    translated = cleanText
  }

  // Save to provider_cache
  try {
    await insert('provider_cache', {
      id: uuidv4(),
      provider: 'translate',
      type: 'text',
      input_hash: inputHash,
      result: translated,
    })
  } catch (_) {}

  if (assetId) {
    await run('UPDATE assets SET translation_text = ?, translation_target_lang = ? WHERE id = ?', [
      translated,
      targetLanguage,
      assetId,
    ])
  }

  return {
    assetId,
    originalText: cleanText,
    translatedText: translated,
    targetLanguage,
    cached: false,
  }
}

export async function generateVoiceoverTts({ projectId, userId, text, voiceProvider = 'edge_tts', voiceId = null }) {
  const cleanText = String(text || '').trim()
  if (!cleanText) throw new Error('Text is required to generate speech')

  const audioId = uuidv4()
  const pDir = projectDir(projectId)
  const assetsDir = ensureDir(path.join(pDir, 'assets'))
  const outPath = path.join(assetsDir, `tts_${audioId}.mp3`)

  const tts = await getProvider(userId, 'tts', { providerName: voiceProvider })
  if (!tts?.provider?.synthesize) {
    throw new Error(`TTS provider '${voiceProvider}' is unavailable`)
  }

  await tts.provider.synthesize({
    text: cleanText,
    outPath,
    voiceId: voiceId || undefined,
    speed: 1.0,
  })

  if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
    throw new Error('TTS synthesis did not generate audio file')
  }

  const info = await probe(outPath).catch(() => ({ durationSec: 3 }))
  const durationSec = Math.max(0.1, Math.round((info?.durationSec || 3) * 100) / 100)
  const storageKey = toStorageKey(outPath)

  await insert('audios', {
    id: audioId,
    project_id: projectId,
    kind: 'voiceover',
    storage_key: storageKey,
    duration_sec: durationSec,
    provider: voiceProvider,
  })

  // Also register as an asset for the Media Library
  await insert('assets', {
    id: audioId,
    project_id: projectId,
    user_id: userId,
    kind: 'voiceover',
    name: `Giọng đọc AI: ${cleanText.slice(0, 30)}...`,
    storage_key: storageKey,
    mime_type: 'audio/mpeg',
    byte_size: fs.statSync(outPath).size,
    duration_sec: durationSec,
    order_index: 0,
  })

  return {
    audioId,
    storageKey,
    durationSec,
    url: `/storage/${storageKey}`,
  }
}

export async function autoArrangeTimeline({ projectId, options = {}, ...rest }) {
  const opts = { ...rest, ...options }
  const tracks = await ensureDefaultTracks(projectId)
  const trackMap = new Map(tracks.map((t) => [t.track_type, t]))

  const bgTrack = trackMap.get('background')
  const imgTrack = trackMap.get('image')
  const voiceTrack = trackMap.get('voiceover')
  const musicTrack = trackMap.get('music')
  const textTrack = trackMap.get('text')

  const assets = await query('SELECT * FROM assets WHERE project_id = ? ORDER BY order_index ASC, created_date ASC', [projectId])
  const audios = await query('SELECT * FROM audios WHERE project_id = ? ORDER BY id ASC', [projectId])

  const bgAssets = assets.filter((a) => a.kind === 'background')
  const imgAssets = assets.filter((a) => a.kind === 'image')
  const musicAssets = assets.filter((a) => a.kind === 'music' || a.kind === 'bgm')
  const voiceAudios = [
    ...audios.filter((a) => a.kind === 'voiceover'),
    ...assets.filter((a) => a.kind === 'voiceover' && !audios.some((au) => au.id === a.id)),
  ]

  // Calculate Voiceover Duration
  let totalVoiceSec = 0
  const voiceClips = []
  let voiceOffset = 0
  for (let i = 0; i < voiceAudios.length; i++) {
    const va = voiceAudios[i]
    const dur = Math.max(0.5, Number(va.duration_sec) || 3)
    voiceClips.push({
      id: uuidv4(),
      project_id: projectId,
      track_id: voiceTrack?.id,
      clip_type: 'voiceover',
      voice_audio_id: va.id,
      asset_id: va.id,
      order_index: i,
      start_at_sec: voiceOffset,
      in_sec: 0,
      out_sec: dur,
      volume: 1.0,
      text_content: null,
      meta: JSON.stringify({ name: 'Voiceover' }),
    })
    voiceOffset += dur
  }
  totalVoiceSec = voiceOffset

  // Calculate Image Allocation
  const defaultImgDur = Math.max(1, Number(opts.imageDurationSec) || 4)
  let totalDuration = 0
  const imgClips = []
  const textClips = []

  if (imgAssets.length > 0) {
    const imgDuration = totalVoiceSec > 0 ? (totalVoiceSec / imgAssets.length) : defaultImgDur
    totalDuration = totalVoiceSec > 0 ? totalVoiceSec : (imgAssets.length * imgDuration)

    for (let i = 0; i < imgAssets.length; i++) {
      const img = imgAssets[i]
      const startAt = Math.round(i * imgDuration * 100) / 100
      const dur = Math.round(imgDuration * 100) / 100

      imgClips.push({
        id: uuidv4(),
        project_id: projectId,
        track_id: imgTrack?.id,
        clip_type: 'image',
        asset_id: img.id,
        order_index: i,
        start_at_sec: startAt,
        in_sec: 0,
        out_sec: dur,
        speed: 1.0,
        volume: 1.0,
        text_content: null,
        meta: JSON.stringify({ name: img.name }),
      })

      // If image has OCR or translated text, create a matching text overlay
      const textOverlay = (img.translation_text || img.ocr_text || '').trim()
      if (textOverlay) {
        textClips.push({
          id: uuidv4(),
          project_id: projectId,
          track_id: textTrack?.id,
          clip_type: 'text',
          asset_id: img.id,
          order_index: i,
          start_at_sec: startAt,
          in_sec: 0,
          out_sec: dur,
          speed: 1.0,
          volume: 1.0,
          text_content: textOverlay,
          style_json: JSON.stringify({
            fontSize: 28,
            color: '#FFFFFF',
            bg: 'rgba(0,0,0,0.6)',
            position: 'bottom',
          }),
        })
      }
    }
  } else {
    totalDuration = totalVoiceSec > 0 ? totalVoiceSec : 10
  }

  // Background Clip
  const bgClips = []
  if (bgTrack) {
    const bgAsset = bgAssets[0] || null
    bgClips.push({
      id: uuidv4(),
      project_id: projectId,
      track_id: bgTrack.id,
      clip_type: 'background',
      asset_id: bgAsset ? bgAsset.id : null,
      order_index: 0,
      start_at_sec: 0,
      in_sec: 0,
      out_sec: totalDuration,
      speed: 1.0,
      volume: 1.0,
      text_content: null,
      meta: JSON.stringify({ color: opts.defaultBackground || '#0F1117' }),
    })
  }

  // Music Clip
  const musicClips = []
  if (musicTrack && musicAssets.length > 0) {
    const bgm = musicAssets[0]
    musicClips.push({
      id: uuidv4(),
      project_id: projectId,
      track_id: musicTrack.id,
      clip_type: 'music',
      asset_id: bgm.id,
      voice_audio_id: bgm.id,
      order_index: 0,
      start_at_sec: 0,
      in_sec: 0,
      out_sec: totalDuration,
      volume: voiceAudios.length > 0 && opts.enableBgmDucking !== false ? 0.25 : (Number(opts.bgmVolume) || 0.8),
      fade_in_sec: 1.0,
      fade_out_sec: 2.0,
      meta: JSON.stringify({
        ducking: opts.enableBgmDucking !== false && opts.enableDucking !== false,
        loop: opts.loopBgm !== false,
      }),
    })
  }

  const allClips = [...bgClips, ...imgClips, ...voiceClips, ...musicClips, ...textClips]

  // Persist transactionally
  await withTransaction(async (tx) => {
    await tx.run('DELETE FROM timeline_clips WHERE project_id = ?', [projectId])
    for (const c of allClips) {
      await tx.insert('timeline_clips', c)
    }
  })

  const savedClips = await query('SELECT * FROM timeline_clips WHERE project_id = ? ORDER BY order_index ASC', [projectId])
  return {
    tracks,
    clips: savedClips,
    totalDuration,
  }
}

export async function saveTimeline({ projectId, tracks = [], clips = [] }) {
  await withTransaction(async (tx) => {
    // Update tracks if provided
    if (Array.isArray(tracks) && tracks.length > 0) {
      for (const t of tracks) {
        if (!t?.id) continue
        await tx.run(
          `UPDATE timeline_tracks SET muted = ?, volume = ?, locked = ?, name = ? WHERE id = ? AND project_id = ?`,
          [t.muted ? 1 : 0, Number(t.volume ?? 1), t.locked ? 1 : 0, t.name || '', t.id, projectId]
        )
      }
    }

    // Replace clips
    if (Array.isArray(clips)) {
      await tx.run('DELETE FROM timeline_clips WHERE project_id = ?', [projectId])
      for (let i = 0; i < clips.length; i++) {
        const c = clips[i]
        await tx.insert('timeline_clips', {
          id: c.id || uuidv4(),
          project_id: projectId,
          track_id: c.track_id || c.trackId || null,
          clip_type: c.clip_type || c.type || 'image',
          asset_id: c.asset_id || c.assetId || null,
          voice_audio_id: c.voice_audio_id || c.audio_id || c.audioId || null,
          text_content: c.text_content || c.content || null,
          style_json: typeof c.style_json === 'string' ? c.style_json : (c.style ? JSON.stringify(c.style) : null),
          order_index: c.order_index ?? i,
          start_at_sec: Number(c.start_at_sec ?? c.start ?? 0),
          in_sec: Number(c.in_sec ?? 0),
          out_sec: Number(c.out_sec ?? c.duration ?? 4),
          speed: Number(c.speed ?? 1.0),
          volume: Number(c.volume ?? 1.0),
          fade_in_sec: Number(c.fade_in_sec ?? 0),
          fade_out_sec: Number(c.fade_out_sec ?? 0),
          meta: typeof c.meta === 'string' ? c.meta : (c.meta ? JSON.stringify(c.meta) : null),
        })
      }
    }
  })

  const updatedClips = await query('SELECT * FROM timeline_clips WHERE project_id = ? ORDER BY order_index ASC', [projectId])
  const updatedTracks = await query('SELECT * FROM timeline_tracks WHERE project_id = ? ORDER BY order_index ASC', [projectId])
  return {
    tracks: updatedTracks,
    clips: updatedClips,
  }
}

export default {
  ensureDefaultTracks,
  saveUploadedAsset,
  processOcr,
  processTranslation,
  generateVoiceoverTts,
  autoArrangeTimeline,
  saveTimeline,
}
