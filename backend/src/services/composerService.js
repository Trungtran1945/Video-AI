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

export async function processOcr({ assetId, projectId, userId, force = false, visionProvider = null }) {
  const asset = projectId
    ? await queryOne('SELECT * FROM assets WHERE id = ? AND project_id = ?', [assetId, projectId])
    : await queryOne('SELECT * FROM assets WHERE id = ?', [assetId])
  if (!asset) throw new Error('Asset not found')

  // 1. Check existing OCR on asset (unless forced)
  if (!force && asset.ocr_text && asset.ocr_text.trim()) {
    let boxes = []
    try {
      boxes = asset.ocr_data ? JSON.parse(asset.ocr_data) : []
    } catch (_) {}
    return {
      assetId: asset.id,
      text: asset.ocr_text,
      boxes,
      status: 'SUCCESS',
      cached: true,
    }
  }

  const absPath = resolveStorageKey(asset.storage_key)
  if (!absPath || !fs.existsSync(absPath)) throw new Error('Asset file does not exist')

  const fileBytes = fs.readFileSync(absPath)
  const inputHash = computeHash(fileBytes)

  // 2. Check provider_cache (only valid OCR results with text are cached)
  if (!force) {
    const cachedRow = await queryOne(
      `SELECT result FROM provider_cache WHERE provider = 'vision' AND type = 'ocr' AND input_hash = ?`,
      [inputHash]
    )
    if (cachedRow?.result) {
      try {
        const parsed = JSON.parse(cachedRow.result)
        const cachedText = (parsed.text || '').trim()
        if (cachedText) {
          await run('UPDATE assets SET ocr_text = ?, ocr_data = ? WHERE id = ?', [
            cachedText,
            JSON.stringify(parsed.boxes || []),
            assetId,
          ])
          return {
            assetId: asset.id,
            text: cachedText,
            boxes: parsed.boxes || [],
            status: 'SUCCESS',
            cached: true,
          }
        }
      } catch (_) {}
    }
  }

  // 3. Call Vision Provider
  let extractedText = ''
  let boxes = []
  let providerError = null

  try {
    const vp = await getProvider(userId, 'vision', visionProvider ? { id: visionProvider } : {})
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
        extractedText = res.boxes.map((b) => b.text).filter(Boolean).join(' ').trim()
      }
    } else if (vp?.provider?.describeImage) {
      const prompt = 'Trích xuất toàn bộ văn bản xuất hiện trong hình ảnh này. Chỉ trả về văn bản được viết trong ảnh, không giải thích.'
      const res = await vp.provider.describeImage({ imagePath: absPath, prompt })
      extractedText = (res?.text || '').trim()
    } else {
      throw new Error('Không tìm thấy nhà cung cấp Vision OCR phù hợp')
    }
  } catch (err) {
    console.warn(`[composerService] Vision OCR call failed: ${err.message}`)
    providerError = err
  }

  if (providerError) {
    const err = new Error(`Vision OCR thất bại: ${providerError.message}`)
    err.code = 'VISION_OCR_FAILED'
    throw err
  }

  // Distinguish SUCCESS vs NO_TEXT
  if (!extractedText) {
    // Vision OCR ran successfully but found no text in image
    await run('UPDATE assets SET ocr_text = ?, ocr_data = ? WHERE id = ?', [
      '',
      JSON.stringify([]),
      assetId,
    ])
    return {
      assetId: asset.id,
      text: '',
      boxes: [],
      status: 'NO_TEXT',
      cached: false,
    }
  }

  // Save successful OCR to provider_cache
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
    status: 'SUCCESS',
    cached: false,
  }
}

export async function processTranslation({ text, targetLanguage = 'vi', sourceLanguage = 'auto', assetId = null, userId = null, translateProvider = null }) {
  const cleanText = String(text || '').trim()
  if (!cleanText) throw new Error('Text to translate is required')

  // Check asset-level translation if assetId given
  // Cache invalidation rule: Only hit cache if targetLanguage matches AND asset's ocr_text matches cleanText
  if (assetId) {
    const asset = await queryOne('SELECT ocr_text, translation_text, translation_target_lang FROM assets WHERE id = ?', [assetId])
    if (
      asset?.translation_text &&
      asset.translation_target_lang === targetLanguage &&
      (asset.ocr_text || '').trim() === cleanText
    ) {
      return {
        assetId,
        originalText: cleanText,
        translatedText: asset.translation_text,
        targetLanguage,
        status: 'SUCCESS',
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
    if (trText && trText.trim()) {
      if (assetId) {
        await run('UPDATE assets SET translation_text = ?, translation_target_lang = ?, ocr_text = ? WHERE id = ?', [
          trText,
          targetLanguage,
          cleanText,
          assetId,
        ])
      }
      return {
        assetId,
        originalText: cleanText,
        translatedText: trText,
        targetLanguage,
        status: 'SUCCESS',
        cached: true,
      }
    }
  }

  let translated = ''
  let lastError = null

  // 1. Try GoogleTranslate
  try {
    const tp = await getProvider(userId, 'translate', translateProvider ? { id: translateProvider } : {})
    if (tp?.provider?.translate) {
      const out = await tp.provider.translate(cleanText, sourceLanguage, targetLanguage)
      if (out && typeof out === 'string' && out.trim()) {
        translated = out.trim()
      }
    }
  } catch (err) {
    console.warn(`[composerService] Translate provider error: ${err.message}`)
    lastError = err
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
        const candidate = String(out?.text || out || '').trim().replace(/^["']|["']$/g, '')
        if (candidate) {
          translated = candidate
        }
      }
    } catch (err) {
      console.warn(`[composerService] LLM Translate fallback error: ${err.message}`)
      lastError = err
    }
  }

  if (!translated) {
    const err = new Error(
      `Không thể dịch thuật văn bản qua bất kỳ nhà cung cấp nào${lastError ? `: ${lastError.message}` : ''}`
    )
    err.code = 'TRANSLATION_FAILED'
    throw err
  }

  // Save to provider_cache ONLY when translation actually succeeds
  try {
    await insert('provider_cache', {
      id: uuidv4(),
      provider: 'translate',
      type: 'text',
      input_hash: inputHash,
      result: translated,
    })
  } catch (_) {}

  // Update asset row
  if (assetId) {
    await run('UPDATE assets SET translation_text = ?, translation_target_lang = ?, ocr_text = ? WHERE id = ?', [
      translated,
      targetLanguage,
      cleanText,
      assetId,
    ])
  }

  return {
    assetId,
    originalText: cleanText,
    translatedText: translated,
    targetLanguage,
    status: 'SUCCESS',
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
  if (!projectId) {
    const err = new Error('projectId is required')
    err.code = 'INVALID_TIMELINE_DATA'
    err.statusCode = 400
    throw err
  }

  const project = await queryOne('SELECT id FROM projects WHERE id = ?', [projectId])
  if (!project) {
    const err = new Error(`Dự án "${projectId}" không tồn tại`)
    err.code = 'PROJECT_NOT_FOUND'
    err.statusCode = 404
    throw err
  }

  // Ensure default tracks exist for this project
  const existingTracks = await ensureDefaultTracks(projectId)
  const validTrackIds = new Set(existingTracks.map((t) => t.id))

  // Fetch valid asset IDs and audio IDs for this project
  const projectAssets = await query('SELECT id FROM assets WHERE project_id = ?', [projectId])
  const validAssetIds = new Set(projectAssets.map((a) => a.id))
  const projectAudios = await query('SELECT id FROM audios WHERE project_id = ?', [projectId])
  const validAudioIds = new Set(projectAudios.map((a) => a.id))

  const ALLOWED_CLIP_TYPES = new Set(['image', 'background', 'voiceover', 'music', 'text', 'sfx'])

  // Validate tracks
  if (Array.isArray(tracks) && tracks.length > 0) {
    for (const t of tracks) {
      if (!t?.id) continue
      if (!validTrackIds.has(t.id)) {
        const err = new Error(`Track ID "${t.id}" không thuộc dự án "${projectId}"`)
        err.code = 'INVALID_TIMELINE_DATA'
        err.statusCode = 400
        throw err
      }
      if (t.volume != null) {
        const v = Number(t.volume)
        if (!Number.isFinite(v) || v < 0 || v > 2.0) {
          const err = new Error(`Track volume (${t.volume}) phải là số trong khoảng [0, 2.0]`)
          err.code = 'INVALID_TIMELINE_DATA'
          err.statusCode = 400
          throw err
        }
      }
    }
  }

  // Validate clips
  if (Array.isArray(clips)) {
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i]
      if (!c) continue

      const clipType = c.clip_type || c.type || 'image'
      if (!ALLOWED_CLIP_TYPES.has(clipType)) {
        const err = new Error(`Loại clip không hợp lệ: "${clipType}". Chỉ chấp nhận: image, background, voiceover, music, text, sfx`)
        err.code = 'INVALID_TIMELINE_DATA'
        err.statusCode = 400
        throw err
      }

      const trackId = c.track_id || c.trackId || null
      if (trackId && !validTrackIds.has(trackId)) {
        const err = new Error(`Clip #${i}: Track ID "${trackId}" không thuộc dự án "${projectId}"`)
        err.code = 'INVALID_TIMELINE_DATA'
        err.statusCode = 400
        throw err
      }

      const assetId = c.asset_id || c.assetId || null
      if (assetId && !validAssetIds.has(assetId)) {
        const err = new Error(`Clip #${i}: Asset ID "${assetId}" không thuộc dự án "${projectId}"`)
        err.code = 'INVALID_TIMELINE_DATA'
        err.statusCode = 400
        throw err
      }

      const voiceAudioId = c.voice_audio_id || c.audio_id || c.audioId || null
      if (voiceAudioId && !validAudioIds.has(voiceAudioId) && !validAssetIds.has(voiceAudioId)) {
        const err = new Error(`Clip #${i}: Audio ID "${voiceAudioId}" không thuộc dự án "${projectId}"`)
        err.code = 'INVALID_TIMELINE_DATA'
        err.statusCode = 400
        throw err
      }

      const startAtSec = Number(c.start_at_sec ?? c.start ?? 0)
      if (!Number.isFinite(startAtSec) || startAtSec < 0) {
        const err = new Error(`Clip #${i}: start_at_sec (${startAtSec}) phải là số hữu hạn >= 0`)
        err.code = 'INVALID_TIMELINE_DATA'
        err.statusCode = 400
        throw err
      }

      const inSec = Number(c.in_sec ?? 0)
      if (!Number.isFinite(inSec) || inSec < 0) {
        const err = new Error(`Clip #${i}: in_sec (${inSec}) phải là số hữu hạn >= 0`)
        err.code = 'INVALID_TIMELINE_DATA'
        err.statusCode = 400
        throw err
      }

      const outSec = c.out_sec != null ? Number(c.out_sec) : (c.duration != null ? inSec + Number(c.duration) : inSec + 4)
      if (!Number.isFinite(outSec) || outSec <= inSec) {
        const err = new Error(`Clip #${i}: out_sec (${outSec}) phải là số hữu hạn và lớn hơn in_sec (${inSec})`)
        err.code = 'INVALID_TIMELINE_DATA'
        err.statusCode = 400
        throw err
      }

      const volume = Number(c.volume ?? 1.0)
      if (!Number.isFinite(volume) || volume < 0 || volume > 2.0) {
        const err = new Error(`Clip #${i}: volume (${volume}) phải nằm trong khoảng [0, 2.0]`)
        err.code = 'INVALID_TIMELINE_DATA'
        err.statusCode = 400
        throw err
      }

      const speed = Number(c.speed ?? 1.0)
      if (!Number.isFinite(speed) || speed <= 0 || speed > 10.0) {
        const err = new Error(`Clip #${i}: speed (${speed}) phải nằm trong khoảng (0, 10.0]`)
        err.code = 'INVALID_TIMELINE_DATA'
        err.statusCode = 400
        throw err
      }

      const fadeIn = Number(c.fade_in_sec ?? 0)
      const fadeOut = Number(c.fade_out_sec ?? 0)
      if (!Number.isFinite(fadeIn) || fadeIn < 0 || !Number.isFinite(fadeOut) || fadeOut < 0) {
        const err = new Error(`Clip #${i}: fade_in_sec và fade_out_sec phải là số hữu hạn >= 0`)
        err.code = 'INVALID_TIMELINE_DATA'
        err.statusCode = 400
        throw err
      }
    }
  }

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
        const inSec = Number(c.in_sec ?? 0)
        const outSec = c.out_sec != null ? Number(c.out_sec) : (c.duration != null ? inSec + Number(c.duration) : inSec + 4)

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
          in_sec: inSec,
          out_sec: outSec,
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
