import { clamp, round2, round3, parseJsonSafe } from './context.js'

export const EMBED_DIM = 64
export const HI_TOL = 1.08
export const LO_TOL = 0.92
export const TRANSITION_DURATION = 0.3
export const SPEED_MIN = 0.9
export const SPEED_MAX = 1.1

export function textEmbedding(text) {
  const vec = new Array(EMBED_DIM).fill(0)
  const tokens = String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []
  for (const tok of tokens) {
    let h = 0
    for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0
    vec[h % EMBED_DIM] += 1
  }
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0))
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] = vec[i] / norm
  }
  return vec
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom ? dot / denom : 0
}

function sceneDuration(scene) {
  return Math.max(0.2, (scene.end_sec || 0) - (scene.start_sec || 0))
}

function takeWholeOrTrim(chosen, total, scene, hiBound) {
  const dur = sceneDuration(scene)
  if (total + dur <= hiBound) {
    chosen.push({ scene, in_sec: scene.start_sec, out_sec: scene.end_sec })
    return total + dur
  }
  const remain = hiBound - total
  if (remain >= 0.5) {
    chosen.push({ scene, in_sec: scene.start_sec, out_sec: round2(scene.start_sec + remain) })
    return total + remain
  }
  return total
}

export function packSegment({ candidates, targetDurationSec, extraPool = [], segmentVec }) {
  if (!(targetDurationSec > 1)) targetDurationSec = 10
  const hi = targetDurationSec * HI_TOL
  const lo = targetDurationSec * LO_TOL
  const chosen = []
  let total = 0

  for (const cand of candidates) {
    if (!cand?.scene) continue
    total = takeWholeOrTrim(chosen, total, cand.scene, hi)
    if (total >= lo) break
  }

  if (total < lo && extraPool.length) {
    const takenIds = new Set(chosen.map((c) => c.scene.id))
    const ranked = extraPool
      .filter((sc) => !takenIds.has(sc.id))
      .map((sc) => ({ sc, sim: cosineSimilarity(segmentVec, parseJsonSafe(sc.embedding, [])) }))
      .sort((a, b) => b.sim - a.sim)
    for (const { sc } of ranked) {
      total = takeWholeOrTrim(chosen, total, sc, hi)
      if (total >= lo) break
    }
  }

  if (!chosen.length) {
    return { chosen, speed: 1, effectiveDurationSec: 0, packedRawSec: 0 }
  }

  let speed = 1
  if (total > 0) speed = round3(clamp(total / targetDurationSec, SPEED_MIN, SPEED_MAX))
  let effTotal = total / speed

  if (effTotal > targetDurationSec + 0.25) {
    const last = chosen[chosen.length - 1]
    const lastRaw = last.out_sec - last.in_sec
    const excess = effTotal - targetDurationSec
    const newRaw = round2(Math.max(0.4, lastRaw - excess * speed))
    if (newRaw < lastRaw) {
      last.out_sec = round2(last.in_sec + newRaw)
      total -= lastRaw - newRaw
      effTotal = total / speed
    }
  }

  return {
    chosen,
    speed,
    effectiveDurationSec: round2(effTotal),
    packedRawSec: round2(total),
  }
}

export function buildTimelineRows(segmentsMeta) {
  const flat = []
  segmentsMeta.forEach((sm) => {
    sm.clips.forEach((clip) => flat.push({ sm, clip }))
  })
  let cursor = 0
  return flat.map(({ sm, clip }, i) => {
    const transitionOut = i === flat.length - 1 ? null : 'cross'
    const row = {
      order_index: i,
      source_type: 'SCENE',
      ref_id: clip.scene.id,
      in_sec: round2(clip.in_sec),
      out_sec: round2(clip.out_sec),
      speed: sm.speed,
      transition_in: i === 0 ? null : 'cross',
      transition_out: transitionOut,
      voice_audio_id: sm.audioId,
      start_at_sec: round2(cursor),
    }
    const eff = (clip.out_sec - clip.in_sec) / sm.speed
    cursor += eff - (transitionOut ? TRANSITION_DURATION : 0)
    return row
  })
}

export default { packSegment, buildTimelineRows, textEmbedding, cosineSimilarity }
