import { v4 as uuidv4 } from 'uuid'
import { insert } from '../db/query.js'

const COST_PER_1K_TOKENS = {
  'gemini-1.5-flash': { in: 0.000075, out: 0.0003 },
  'gemini-1.5-pro': { in: 0.00125, out: 0.005 },
  'gemini-2.5-flash': { in: 0.0003, out: 0.0025 },
  'gpt-4o-mini': { in: 0.00015, out: 0.0006 },
  'gpt-4o': { in: 0.0025, out: 0.01 },
}

const ASR_USD_PER_MIN = { 'whisper-1': 0.006 }
// edge_tts miễn phí → giá 0
const TTS_USD_PER_1K_CHARS = { elevenlabs: 0.18, 'tts-1': 0.015, 'tts-1-hd': 0.03, edge_tts: 0 }

export function estimateCostUsd({ type, model, tokensIn = 0, tokensOut = 0, durationSec = 0, chars = 0, provider }) {
  const rate = COST_PER_1K_TOKENS[model]
  if (rate) return round6((tokensIn / 1000) * rate.in + (tokensOut / 1000) * rate.out)
  if (type === 'asr') {
    const perMin = ASR_USD_PER_MIN[model] ?? 0.006
    return round6((durationSec / 60) * perMin)
  }
  if (type === 'tts') {
    const per1k = TTS_USD_PER_1K_CHARS[provider] ?? 0.02
    return round6((chars / 1000) * per1k)
  }
  return 0
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6
}

export async function logProviderCall(entry) {
  await insert('provider_logs', {
    id: uuidv4(),
    project_id: entry.projectId || null,
    job_id: entry.jobId || null,
    provider: entry.provider || 'unknown',
    type: entry.type || 'llm',
    model: entry.model || null,
    tokens_in: Number.isFinite(entry.tokensIn) ? entry.tokensIn : null,
    tokens_out: Number.isFinite(entry.tokensOut) ? entry.tokensOut : null,
    cost_usd: Number.isFinite(entry.costUsd) ? entry.costUsd : 0,
    duration_ms: Number.isFinite(entry.durationMs) ? entry.durationMs : null,
    status: entry.status === 'error' ? 'error' : 'ok',
    error_message: entry.error ? String(entry.error).slice(0, 500) : null,
  })
}

export async function tracked(meta, fn) {
  const start = Date.now()
  try {
    const result = await fn()
    const usage = result && typeof result === 'object' ? result.usage || {} : {}
    const tokensIn = usage.tokensIn ?? meta.tokensIn
    const tokensOut = usage.tokensOut ?? meta.tokensOut
    const durationSec = usage.durationSec ?? result?.durationSec ?? 0
    const chars = usage.chars ?? result?.chars ?? meta.chars ?? 0
    const model = result?.model ?? meta.model
    await logProviderCall({
      ...meta,
      model,
      tokensIn,
      tokensOut,
      durationMs: Date.now() - start,
      status: 'ok',
      costUsd: estimateCostUsd({ type: meta.type, model, provider: meta.provider, tokensIn, tokensOut, durationSec, chars }),
    })
    return result
  } catch (err) {
    await logProviderCall({
      ...meta,
      durationMs: Date.now() - start,
      status: 'error',
      error: err.message,
    })
    throw err
  }
}

export default { tracked, logProviderCall, estimateCostUsd }
