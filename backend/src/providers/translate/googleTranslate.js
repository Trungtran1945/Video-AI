import { classifyProviderError, ERROR_KINDS } from '../../lib/providerErrors.js'

const DELAY_MS = 100 // Rate-limit: 10 request/giây để tránh bị chặn
const MAX_RETRIES = 2

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// Origin + path only — query string carries the source text, never log it.
function safeEndpoint(scriptUrl) {
  try {
    const u = new URL(scriptUrl)
    return `${u.origin}${u.pathname}`
  } catch (_) {
    return '(invalid URL)'
  }
}

function configError(scriptUrl, detail) {
  const err = new Error(
    `Google Translate cấu hình sai (${detail}). ` +
      `Kiểm tra GOOGLE_TRANSLATE_SCRIPT_URL trong file .env — endpoint: ${safeEndpoint(scriptUrl)}. ` +
      `Gợi ý: Apps Script phải được Deploy > New deployment > Web app (Execute as: Me, Access: Anyone) và URL phải kết thúc bằng /exec; deployment cũ/bị xóa sẽ trả 404.`
  )
  err.kind = ERROR_KINDS.CONFIGURATION
  err.status = 404
  err.endpoint = safeEndpoint(scriptUrl)
  err.hint = 'Redeploy Apps Script as Web App and update GOOGLE_TRANSLATE_SCRIPT_URL to the new /exec URL'
  return err
}

export class GoogleTranslate {
  constructor(scriptUrl) {
    this.id = 'google_translate'
    this.scriptUrl = scriptUrl
  }

  async translate(text, sourceLang = 'auto', targetLang = 'vi') {
    if (!text?.trim()) return ''
    if (!this.scriptUrl || !String(this.scriptUrl).trim()) {
      const err = new Error(
        'Thiếu GOOGLE_TRANSLATE_SCRIPT_URL trong file .env — không thể gọi Google Translate.'
      )
      err.kind = ERROR_KINDS.CONFIGURATION
      err.status = null
      err.endpoint = '(missing)'
      err.hint = 'Set GOOGLE_TRANSLATE_SCRIPT_URL to the Apps Script Web App /exec URL'
      throw err
    }
    const p = { text: text.trim(), target: targetLang }
    if (sourceLang && sourceLang !== 'auto') p.source = sourceLang
    const params = new URLSearchParams(p)
    const url = `${this.scriptUrl}?${params}`

    let lastError = null
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let res
      try {
        res = await fetch(url)
      } catch (netErr) {
        lastError = netErr
        // Network blips retry; anything else (incl. config) throws now.
        if (classifyProviderError(netErr).kind !== ERROR_KINDS.TRANSIENT) throw netErr
        if (attempt < MAX_RETRIES) { await sleep(500 * (attempt + 1)); continue }
        throw lastError
      }
      if (!res.ok) {
        const probe = Object.assign(new Error(`Google Translate HTTP ${res.status}`), { status: res.status })
        const classification = classifyProviderError(probe)
        if (classification.kind === ERROR_KINDS.CONFIGURATION) {
          // 404 endpoint — retrying the same URL cannot help.
          throw configError(this.scriptUrl, `HTTP ${res.status}`)
        }
        lastError = probe
        lastError.status = res.status
        lastError.kind = classification.kind
        lastError.endpoint = safeEndpoint(this.scriptUrl)
        if (classification.kind !== ERROR_KINDS.TRANSIENT) throw lastError
        if (attempt < MAX_RETRIES) { await sleep(500 * (attempt + 1)); continue }
        throw lastError
      }
      let data
      try {
        data = await res.json()
      } catch (jsonErr) {
        lastError = new Error(`Google Translate trả về dữ liệu không hợp lệ (endpoint: ${safeEndpoint(this.scriptUrl)})`)
        lastError.kind = ERROR_KINDS.INVALID_RESPONSE
        lastError.endpoint = safeEndpoint(this.scriptUrl)
        lastError.cause = jsonErr
        throw lastError
      }
      if (data.status !== 'success') {
        const providerMsg = data.error || 'Google Translate trả về lỗi'
        const classification = classifyProviderError(new Error(providerMsg))
        lastError = new Error(providerMsg)
        lastError.kind = classification.kind
        lastError.endpoint = safeEndpoint(this.scriptUrl)
        if (classification.kind !== ERROR_KINDS.TRANSIENT) throw lastError
        if (attempt < MAX_RETRIES) { await sleep(500 * (attempt + 1)); continue }
        throw lastError
      }
      return data.translatedText || ''
    }
  }

  async translateBatch(texts, sourceLang = 'auto', targetLang = 'vi') {
    const results = []
    for (let i = 0; i < texts.length; i++) {
      if (!texts[i]?.trim()) {
        results.push('')
        continue
      }
      const translated = await this.translate(texts[i], sourceLang, targetLang)
      results.push(translated)
      if (i < texts.length - 1) await sleep(DELAY_MS)
    }
    return results
  }
}

export default GoogleTranslate
