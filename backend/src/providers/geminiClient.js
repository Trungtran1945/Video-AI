// Client chung cho m��?i cu��Tc g��?i generateContent c��a Gemini (LLM + Vision/OCR).
// �?���c �`i���m: (1) tuA�n th�� rate-limit quota free-tier qua acquireGeminiQuota;
// (2) t��� �`��Tng th��- l���i khi g���p l��-i transient (429/quota, 503 high-demand,
// 5xx, timeout/network blips), dA1ng �`A�ng �`��T tr��. API g���i A�
// ("Please retry in Xs" ho���c header Retry-After) k���t h���p exponential backoff.
//
// Tr��� v��? { text, model, usage } �?" �`��<nh d���ng gi��`ng nh�� cA�c provider c�c �`��� khA'ng
// ph���i �`��i code ��Y t��ng stage.

import { acquireGeminiQuota } from './rateLimit.js'
import { classifyProviderError, ERROR_KINDS, ERROR_CODES } from '../lib/providerErrors.js'

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

function defaultMaxRetries() {
  return Number(process.env.GEMINI_MAX_RETRIES) || 5
}

function defaultTimeoutMs() {
  const v = Number(process.env.GEMINI_TIMEOUT_MS || process.env.GEMINI_REQUEST_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? v : 60_000
}

// TrA-ch s��` giA�y ch��? t��� thA'ng bA�o l��-i Gemini: "...retry in 53.065674238s"
function parseRetryDelaySeconds(message = '') {
  const m = String(message).match(/retry in\s+([\d.]+)\s*s/i)
  if (m) return Number(m[1])
  const m2 = String(message).match(/retry in\s+([\d.]+)/i)
  if (m2) return Number(m2[1])
  return null
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

export async function generateContent({ model, apiKey, body, json = false, maxOutputTokens, label = 'Gemini', maxRetries, timeoutMs, signal }) {
  const payload = { ...body }
  if (json) payload.generationConfig = { ...payload.generationConfig, response_mime_type: 'application/json' }
  if (maxOutputTokens) payload.generationConfig = { ...payload.generationConfig, maxOutputTokens }
  if (payload.generationConfig && !Object.keys(payload.generationConfig).length) delete payload.generationConfig
  // Per-call retry budget (best-effort callers like TTS shorten pass 0 to fail
  // fast instead of burning N x suggested-wait). Default: env GEMINI_MAX_RETRIES.
  const retryBudget = Number.isInteger(maxRetries) && maxRetries >= 0 ? maxRetries : defaultMaxRetries()
  const requestTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : defaultTimeoutMs()

  let attempt = 0
  // backoff: 1s, 2s, 4s, 8s, 16s ... (capped 30s), c��Tng thA�m �`��T tr��. API g���i A�.
  let backoffMs = 1000

  // Combined abort controller: honors caller signal + per-request timeout.
  const makeController = () => {
    const controller = new AbortController()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    return controller
  }

  while (true) {
    await acquireGeminiQuota(apiKey)
    const controller = makeController()
    let timeoutHandle = null
    let res
    try {
      const fetchPromise = fetch(`${BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          controller.abort()
          const err = new Error(`${label} timeout sau ${Math.round(requestTimeoutMs / 1000)}s`)
          err.code = ERROR_CODES.PROVIDER_TIMEOUT
          err.errorCode = ERROR_CODES.PROVIDER_TIMEOUT
          err.retryable = true
          err.status = 504
          reject(err)
        }, requestTimeoutMs)
      })
      res = await Promise.race([fetchPromise, timeoutPromise])
      if (timeoutHandle) clearTimeout(timeoutHandle)
    } catch (netErr) {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      // Network-level failure (DNS/timeout/reset) �?" retry only if transient.
      if (controller.signal.aborted && !netErr?.code) {
        const terr = new Error(`${label} timeout sau ${Math.round(requestTimeoutMs / 1000)}s`)
        terr.code = ERROR_CODES.PROVIDER_TIMEOUT
        terr.errorCode = ERROR_CODES.PROVIDER_TIMEOUT
        terr.retryable = true
        terr.status = 504
        netErr = terr
      }
      if (classifyProviderError(netErr).kind !== ERROR_KINDS.TRANSIENT) throw netErr
      attempt++
      if (attempt > retryBudget) throw netErr
      const waitMs = Math.min(60_000, backoffMs / 2 + Math.random() * (backoffMs / 2))
      console.warn(
        `[Gemini] transient (network) �?" th��- l���i l��n ${attempt}/${retryBudget} sau ${(waitMs / 1000).toFixed(1)}s: ${netErr.message}`
      )
      await sleep(waitMs)
      backoffMs = Math.min(30_000, backoffMs * 2)
      continue
    }
    const data = await res.json().catch(() => null)

    if (res.ok) {
      const candidate = data?.candidates?.[0]
      const text = (candidate?.content?.parts || []).map((p) => p.text || '').join('')
      return {
        text,
        model,
        usage: {
          tokensIn: data?.usageMetadata?.promptTokenCount ?? null,
          tokensOut: data?.usageMetadata?.candidatesTokenCount ?? null,
        },
        _safetyEmpty: !text.trim() && !candidate?.finishReason,
      }
    }

    const message = data?.error?.message || `Gemini HTTP ${res.status}`
    const probe = Object.assign(new Error(message), { status: res.status })
    const classification = classifyProviderError(probe)
    // Quota/auth/model errors must NEVER be retried on the same key �?" they
    // need cooldown/exclude + failover to another provider (TransFlow pool
    // behavior). Only temporary pressure (rate/timeout/unavailable) retries.
    const nonRetryableCodes = new Set([
      ERROR_CODES.PROVIDER_QUOTA_EXCEEDED,
      ERROR_CODES.PROVIDER_AUTH_FAILED,
      ERROR_CODES.PROVIDER_PERMISSION_DENIED,
      ERROR_CODES.PROVIDER_MODEL_NOT_FOUND,
      ERROR_CODES.PROVIDER_INVALID_REQUEST,
    ])
    if (nonRetryableCodes.has(classification.code)) {
      const err = new Error(`${label} l��-i: ${message}`)
      err.status = res.status
      err.code = classification.code
      err.errorCode = classification.code
      err.retryable = false
      throw err
    }
    // TRANSIENT covers rate-limit plus 503 high-demand, 5xx, timeouts and
    // network blips. PERMANENT (401/403) and CONFIGURATION never retry.
    const isRetryable =
      classification.retryable === true && classification.kind === ERROR_KINDS.TRANSIENT

    if (!isRetryable) {
      throw new Error(`${label} l��-i: ${message}`)
    }

    attempt++
    if (attempt > retryBudget) {
      const err = new Error(
        `${label} l��-i (quA� ${retryBudget} l��n th��- l���i, mA� ${classification.code}): ${message}. ` +
          'H��� th��ng s��� th��- provider d��� phA�ng n���u cA3 thay vA� retry cA1ng key.'
      )
      err.status = res.status
      err.errorCode = classification.code
      err.retryable = classification.retryable
      throw err
    }

    const suggested = parseRetryDelaySeconds(message)
    const retryAfter = res.headers?.get?.('retry-after')
    const headerSec = retryAfter ? Number(retryAfter) : null
    const waitSec = Number.isFinite(headerSec) && headerSec > 0 ? headerSec : suggested ?? 0
    // �_u tiA�n �`��T tr��. API g���i A�, nh��ng luA'n A-t nh���t b���ng backoff �`��� trA�nh spam.
    const retryAfterMs = waitSec > 0 ? waitSec * 1000 : 0
    const jitteredBackoff = backoffMs / 2 + Math.random() * (backoffMs / 2)
    const waitMs = Math.min(60_000, Math.max(retryAfterMs, jitteredBackoff))
    console.warn(
      `[Gemini] transient (${res.status}) �?" th��- l���i l��n ${attempt}/${retryBudget} sau ${(waitMs / 1000).toFixed(1)}s: ${message}`
    )
    await sleep(waitMs)
    backoffMs = Math.min(30_000, backoffMs * 2)
  }
}

export default { generateContent }
