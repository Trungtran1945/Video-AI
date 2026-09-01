const DELAY_MS = 100 // Rate-limit: 10 request/giây để tránh bị chặn
const MAX_RETRIES = 2

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

export class GoogleTranslate {
  constructor(scriptUrl) {
    this.id = 'google_translate'
    this.scriptUrl = scriptUrl
  }

  async translate(text, sourceLang = 'auto', targetLang = 'vi') {
    if (!text?.trim()) return ''
    const params = new URLSearchParams({ text: text.trim(), source: sourceLang, target: targetLang })
    const url = `${this.scriptUrl}?${params}`

    let lastError = null
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url)
        if (!res.ok) {
          lastError = new Error(`Google Translate HTTP ${res.status}`)
          if (attempt < MAX_RETRIES) { await sleep(500 * (attempt + 1)); continue }
          throw lastError
        }
        const data = await res.json()
        if (data.status !== 'success') {
          lastError = new Error(data.error || 'Google Translate trả về lỗi')
          if (attempt < MAX_RETRIES) { await sleep(500 * (attempt + 1)); continue }
          throw lastError
        }
        return data.translatedText || ''
      } catch (err) {
        lastError = err
        if (attempt < MAX_RETRIES) { await sleep(500 * (attempt + 1)); continue }
        throw lastError
      }
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
