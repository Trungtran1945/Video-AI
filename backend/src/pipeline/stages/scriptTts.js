import fs from 'node:fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne, run } from '../../db/query.js'
import { listProvidersForCapability } from '../../providers/registry.js'
import { callProvider } from '../../lib/callProvider.js'
import { withProviderFailover } from '../../lib/providerFailover.js'
import { buildTtsCacheInput, ttsClipKey } from '../../lib/ttsCacheKey.js'
import { probe } from '../../media/mediaService.js'
import { isPathInside } from '../../lib/safePath.js'
import {
  projectDir,
  ensureDir,
  resolveStorageKey,
  toStorageKey,
  parseJsonSafe,
  round3,
} from '../context.js'

const SPEED = 1

function voiceFor(candidate, voiceId) {
  return String(voiceId || candidate?.provider?.voice || candidate?.provider?.model || candidate?.id || '').trim()
}

function applyVoiceOverride(candidates, providerId, voiceId) {
  if (!voiceId) return candidates
  if (providerId === 'google_tts') {
    const err = new Error('SCRIPT_VOICE_UNSUPPORTED: google_tts không hỗ trợ chọn voiceId')
    err.code = 'SCRIPT_VOICE_UNSUPPORTED'
    throw err
  }
  for (const cand of candidates) {
    try {
      if (cand.id === 'elevenlabs') cand.provider.voiceId = voiceId
      else if (cand.id !== 'google_tts') {
        cand.provider.voice = voiceId
        cand.provider.model = voiceId
      }
    } catch (_) {}
  }
  return candidates
}

async function probeDuration(file) {
  try {
    const info = await probe(file)
    return Number(info?.durationSec) || 0
  } catch (_) {
    return 0
  }
}

async function removeOldAudio(projectId, audioRow) {
  if (!audioRow) return
  const abs = resolveStorageKey(audioRow.storage_key)
  if (abs && isPathInside(projectDir(projectId), abs)) {
    try { fs.unlinkSync(abs) } catch (_) {}
  }
  await run('DELETE FROM audios WHERE id = ? AND project_id = ?', [audioRow.id, projectId])
}

async function synthesizeSegment({ project, job, seg, candidates, voiceId }) {
  const segDir = ensureDir(path.join(projectDir(project.id), 'segments', `${seg.index_num}_${seg.id}`))
  const out = await withProviderFailover(
    { capability: 'TTS', candidates, maxAttempts: Math.min(4, candidates.length) },
    async (cand) => {
      const voice = voiceFor(cand, voiceId)
      const model = voice || cand.id
      const canonical = buildTtsCacheInput({ provider: cand.id, voice, model, text: seg.narration, speed: SPEED })
      const clipKey = ttsClipKey(canonical)
      const clipPath = path.join(segDir, `clip_${clipKey.slice(0, 16)}.mp3`)
      const res = await callProvider({
        provider: cand.id,
        type: 'tts',
        model,
        input: canonical,
        fn: async () => {
          const synth = await cand.provider.synthesize({
            text: seg.narration,
            outPath: clipPath,
            speed: SPEED,
            voice: voiceId || undefined,
          })
          // Strip raw bytes/audio buffers from the provider result so the
          // generic provider_cache only stores identity + local path metadata.
          return {
            audioPath: synth?.audioPath || clipPath,
            durationSec: synth?.durationSec,
            sampleRate: synth?.sampleRate,
            provider: synth?.provider || cand.id,
            model: synth?.model || model,
          }
        },
        userId: project.user_id,
        apiKeyId: cand.apiKeyId,
        projectId: project.id,
        jobId: job.id,
      })
      const audioPath = res?.audioPath || clipPath
      if (!fs.existsSync(audioPath)) throw new Error('TTS provider không ghi được file audio')
      const durationSec = Number(res?.durationSec) > 0 ? round3(res.durationSec) : round3(await probeDuration(audioPath))
      if (!(durationSec > 0.05)) throw new Error('TTS audio không hợp lệ (duration = 0)')
      return { audioPath, durationSec, clipKey, provider: cand.id }
    }
  )
  return out.result
}

// script.tts — one voice clip per segment. Files are content-addressed by
// (provider, voice, text, speed), so a retry skips every segment whose audio
// file + DB row + key still match. Successful segments persist before a
// partial failure is raised, letting the retry resume instead of redoing all.
export async function scriptTts(ctx) {
  const { project, job, setProgress, signal } = ctx
  const segments = await query(
    'SELECT * FROM script_segments WHERE project_id = ? ORDER BY index_num ASC',
    [project.id]
  )
  if (!segments.length) throw new Error('Chưa có đoạn kịch bản — hãy retry từ stage script.analyze')

  const params = parseJsonSafe(project.params, {}) || {}
  const voiceProvider = String(params.voiceProvider || 'edge_tts')
  const voiceId = params.voiceId ? String(params.voiceId) : null

  let candidates = await listProvidersForCapability(project.user_id, 'tts')
  if (voiceId) candidates = candidates.filter((c) => c.id === voiceProvider)
  if (!candidates.length) {
    throw new Error(
      `NO_PROVIDER_AVAILABLE: không có TTS provider${voiceId ? ` '${voiceProvider}'` : ''} khả dụng — kiểm tra API key/Cài đặt`
    )
  }
  applyVoiceOverride(candidates, voiceProvider, voiceId)

  const failed = []
  const total = segments.length
  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw new Error('Cancelled')
    const seg = segments[i]
    try {
      const existing = seg.voice_audio_id
        ? await queryOne('SELECT * FROM audios WHERE id = ? AND project_id = ?', [seg.voice_audio_id, project.id])
        : null
      const existingCand = existing
        ? candidates.find((c) => c.id === existing.provider)
        : null
      const skipCand = existingCand || candidates[0]
      const skipVoice = voiceFor(skipCand, voiceId)
      const skipKey = ttsClipKey(buildTtsCacheInput({
        provider: skipCand.id,
        voice: skipVoice,
        model: skipVoice || skipCand.id,
        text: seg.narration,
        speed: SPEED,
      }))
      if (existing && seg.tts_clip_key === skipKey) {
        const abs = resolveStorageKey(existing.storage_key)
        if (abs && fs.existsSync(abs) && (await probeDuration(abs)) > 0.05) {
          setProgress(2 + Math.round(((i + 1) / total) * 90))
          continue
        }
      }

      await removeOldAudio(project.id, existing)
      const result = await synthesizeSegment({ project, job, seg, candidates, voiceId })
      const audioId = uuidv4()
      await run(
        `INSERT INTO audios (id, project_id, kind, storage_key, duration_sec, provider) VALUES (?, ?, 'voice', ?, ?, ?)`,
        [audioId, project.id, toStorageKey(result.audioPath), result.durationSec, result.provider]
      )
      await run(
        `UPDATE script_segments
         SET voice_audio_id = ?, duration_sec = ?, tts_clip_key = ?, status = 'tts_ready', updated_at = ?
         WHERE id = ? AND project_id = ?`,
        [audioId, result.durationSec, result.clipKey, new Date().toISOString(), seg.id, project.id]
      )
    } catch (err) {
      if (err?.message === 'Cancelled') throw err
      failed.push(`#${seg.index_num}: ${String(err?.message || err).slice(0, 160)}`)
    }
    setProgress(2 + Math.round(((i + 1) / total) * 90))
  }

  if (failed.length) {
    throw new Error(`SCRIPT_TTS_PARTIAL: ${failed.length}/${total} đoạn lỗi: ${failed.slice(0, 5).join('; ')}`)
  }
  setProgress(98)
  return { audioCount: total, voiceProvider, voiceId: voiceId || null }
}

export default scriptTts
