/**
 * MockTranslate — deterministic translate provider for Demo mode (no API key).
 * Giữ nguyên số/tên riêng/dấu hỏi/phủ định của nguồn và thêm tiền tố tiếng Việt
 * để đi qua semantic gate của pipeline. Không phải bản dịch thật.
 */
export class MockTranslate {
  constructor(_key) {
    this.id = 'mock'
  }

  async translate(text, _sourceLang = 'auto', _targetLang = 'vi') {
    const source = String(text || '').trim()
    if (!source) return ''
    return `Bản dịch mô phỏng: ${source}`
  }

  async translateBatch(texts = [], sourceLang = 'auto', targetLang = 'vi') {
    const out = []
    for (const text of texts) out.push(await this.translate(text, sourceLang, targetLang))
    return out
  }
}

export default MockTranslate
