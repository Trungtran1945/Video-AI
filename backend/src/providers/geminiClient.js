// Client chung cho mọi cuộc gọi generateContent của Gemini (LLM + Vision/OCR).
// Đặc điểm: (1) tuân thủ rate-limit quota free-tier qua acquireGeminiQuota;
// (2) tự động thử lại khi gặp lỗi transient (429/quota, 503 high-demand,
// 5xx, timeout/network blips), dùng đúng độ trễ API gợi ý
// ("Please retry in Xs" hoặc header Retry-After) kết hợp exponential backoff.
//
// Trả về { text, model, usage } — định dạng giống như các provider cũ để không
// phải đổi code ở tầng stage.

import { acquireGeminiQuota } from './rateLimit.js'
import { classifyProviderError, ERROR_KINDS } from '../lib/providerErrors.js'

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

function maxRetries() {
  return Number(process.env.GEMINI_MAX_RETRIES) || 5
}

// Trích số giây chờ từ thông báo lỗi Gemini: "...retry in 53.065674238s"
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

export async function generateContent({ model, apiKey, body, json = false, maxOutputTokens, label = 'Gemini' }) {
  const payload = { ...body }
  if (json) payload.generationConfig = { ...payload.generationConfig, response_mime_type: 'application/json' }
  if (maxOutputTokens) payload.generationConfig = { ...payload.generationConfig, maxOutputTokens }
  if (payload.generationConfig && !Object.keys(payload.generationConfig).length) delete payload.generationConfig

  let attempt = 0
  // backoff: 1s, 2s, 4s, 8s, 16s ... (capped 30s), cộng thêm độ trễ API gợi ý.
  let backoffMs = 1000

  while (true) {
    await acquireGeminiQuota(apiKey)
    let res
    try {
      res = await fetch(`${BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    } catch (netErr) {
      // Network-level failure (DNS/timeout/reset) — retry only if transient.
      if (classifyProviderError(netErr).kind !== ERROR_KINDS.TRANSIENT) throw netErr
      attempt++
      if (attempt > maxRetries()) throw netErr
      const waitMs = Math.min(60_000, backoffMs)
      console.warn(
        `[Gemini] transient (network) — thử lại lần ${attempt}/${maxRetries()} sau ${(waitMs / 1000).toFixed(1)}s: ${netErr.message}`
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
    const isQuota =
      res.status === 429 ||
      /quota|rate[ -_]?limit|resource has been exhausted|please retry/i.test(message)
    // TRANSIENT covers 429/quota plus 503 high-demand, 5xx, timeouts and
    // network blips. PERMANENT (401/403) and CONFIGURATION never retry.
    const isRetryable =
      isQuota || classification.kind === ERROR_KINDS.TRANSIENT

    if (!isRetryable) {
      throw new Error(`${label} lỗi: ${message}`)
    }

    attempt++
    if (attempt > maxRetries()) {
      throw new Error(
        `${label} lỗi (quá giới hạn quota sau ${maxRetries()} lần thử lại): ${message}. ` +
          `Hãy nâng cấp gói Gemini hoặc đặt GEMINI_RPM thấp hơn để tránh vượt hạn mức.`
      )
    }

    const suggested = parseRetryDelaySeconds(message)
    const retryAfter = res.headers?.get?.('retry-after')
    const headerSec = retryAfter ? Number(retryAfter) : null
    const waitSec = Number.isFinite(headerSec) && headerSec > 0 ? headerSec : suggested ?? 0
    // Ưu tiên độ trễ API gợi ý, nhưng luôn ít nhất bằng backoff để tránh spam.
    const waitMs = Math.min(60_000, Math.max(waitSec * 1000, backoffMs))
    console.warn(
      `[Gemini] transient (${res.status}) — thử lại lần ${attempt}/${maxRetries()} sau ${(waitMs / 1000).toFixed(1)}s: ${message}`
    )
    await sleep(waitMs)
    backoffMs = Math.min(30_000, backoffMs * 2)
  }
}

export default { generateContent }
