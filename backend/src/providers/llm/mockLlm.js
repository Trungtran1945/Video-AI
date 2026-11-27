/**
 * MockLlm — returns valid JSON per schema for pipeline testing without tokens.
 * Dùng cho Demo mode (DEFAULT_PROVIDER_MODE=mock): đủ shape để pipeline chạy
 * end-to-end, nhưng nội dung là mô phỏng — KHÔNG phải kết quả AI thật.
 * docs/11 §6
 */

const MOCK_TRANSLATE_PREFIX = 'Bản dịch mô phỏng: '

function mockTranslateText(source) {
  const text = String(source || '').trim()
  return text ? `${MOCK_TRANSLATE_PREFIX}${text}` : ''
}

function unescapeXml(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function splitScriptSource(source) {
  const segments = []
  for (const line of String(source || '').split(/\n+/)) {
    const text = line.trim()
    if (!text) continue
    const parts = text.split(/(?<=[.!?…。])\s+/).map((s) => s.trim()).filter(Boolean)
    for (const part of parts) {
      segments.push({ narrationText: part, visualPrompt: part.slice(0, 160) })
    }
  }
  return segments
}

function extractPlainSource(prompt) {
  // repairTranslationWithLlm / shortenTranslation / composerService / retranslateSegment
  const repair = prompt.match(/Câu cần dịch:\s*"([^"]*)"/)
  if (repair) return mockTranslateText(repair[1])
  const shorten = prompt.match(/Rút gọn câu lồng tiếng sau[\s\S]*?\n"([^"]*)"/)
  if (shorten) return shorten[1] // cosmetic: giữ nguyên câu, không rút gọn
  const named = prompt.match(/^\s*Text:\s*(.+?)\s*$/m)
  if (named) return mockTranslateText(named[1])
  const direct = prompt.match(/Translate the following text into[^\n]*\n\s*\n([\s\S]*)$/)
  if (direct) return mockTranslateText(direct[1].trim())
  const lines = prompt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const longest = lines.sort((a, b) => b.length - a.length)[0] || ''
  return mockTranslateText(longest)
}

export class MockLlm {
  constructor(_key) {}

  /**
   * Generate script from scenes (SUMMARY pipeline).
   * @param {object[]} scenes
   * @returns {Promise<{title: string, summary: string, scenes: object[]}>}
   */
  async generateScript(scenes) {
    return {
      title: 'Mock Title — Test Video',
      summary: 'This is a mock summary generated for pipeline testing.',
      scenes: scenes.map((s, i) => ({
        startMs: s.startMs || i * 10000,
        endMs: s.endMs || (i + 1) * 10000,
        text: `Scene ${i + 1}: ${s.description || 'Mock scene description'}`,
      })),
    }
  }

  /**
   * Translate transcript segments (TRANSLATE_DUB pipeline, legacy caller).
   * @param {{text: string, startMs: number, endMs: number}[]} segments
   * @param {string} targetLang
   * @returns {Promise<{text: string, startMs: number, endMs: number}[]>}
   */
  async translate(segments, targetLang) {
    return segments.map((s) => ({
      ...s,
      text: `[${targetLang}] ${s.text}`,
    }))
  }

  /**
   * Analyze keyframes (SUMMARY pipeline).
   * @param {{image: Buffer|string}[]} keyframes
   * @returns {Promise<{description: string, timestampMs: number}[]>}
   */
  async analyze(keyframes) {
    return keyframes.map((kf, i) => ({
      description: `Mock keyframe ${i + 1}: visual description placeholder`,
      timestampMs: kf.timestampMs || i * 5000,
    }))
  }

  #jsonResponse(payload) {
    return {
      text: JSON.stringify(payload),
      model: 'mock',
      usage: { tokensIn: 0, tokensOut: 0 },
    }
  }

  #summaryScriptResponse(prompt) {
    const scenes = []
    const re = /^\[([^\]]+)\]\s*(\d+)\s*-\s*(\d+)\s*s?:\s*(.+)$/gm
    let m
    while ((m = re.exec(prompt))) {
      scenes.push({ id: m[1], start: Number(m[2]), end: Number(m[3]), description: m[4].trim() })
    }
    if (!scenes.length) return { segments: [] }

    const durMatch = prompt.match(/xấp xỉ\s*(\d+)\s*giây/)
    const target = durMatch ? Number(durMatch[1]) : 120
    const count = Math.max(3, Math.min(8, Math.round(target / 60)))
    const per = Math.max(30, Math.min(90, Math.round(target / count)))
    const vietnamese = /tiếng Việt/.test(prompt)

    const segments = []
    for (let i = 0; i < count; i++) {
      const scene = scenes[Math.floor((i * scenes.length) / count)] || scenes[0]
      const description = scene.description || 'cảnh phim'
      const narration = vietnamese
        ? `Cảnh ${i + 1}: ${description}. Đây là lời tường thuật mô phỏng để xem thử quy trình tạo video.`
        : `Scene ${i + 1}: ${description}. This is mock narration for the demo pipeline.`
      segments.push({
        narration,
        targetDurationSec: per,
        sceneRefs: [{ sceneId: scene.id, weight: 0.8 }],
      })
    }
    return { segments }
  }

  /**
   * Shape-aware mock completion. Nhận diện prompt theo cấu trúc mà pipeline
   * dùng rồi trả payload đúng schema; fallback cuối là plain text mô phỏng.
   * @param {{system?: string, prompt?: string, json?: boolean}} input
   */
  async complete({ prompt } = {}) {
    const p = String(prompt || '')

    // 1. SCRIPT_TO_VIDEO: verbatim segmentation (giữ nguyên 100% nội dung).
    const chunk = p.match(/SCRIPT_CHUNK_BEGIN\s*([\s\S]*?)\s*SCRIPT_CHUNK_END/)
    if (chunk) return this.#jsonResponse({ segments: splitScriptSource(chunk[1]) })

    // 2. TRANSLATE_DUB: dịch theo batch <line id="..."> ... </line>.
    if (/<lines>[\s\S]*?<line id=/.test(p)) {
      const translations = []
      const re = /<line id="([^"]+)">([\s\S]*?)<\/line>/g
      let m
      while ((m = re.exec(p))) {
        translations.push({ id: m[1], translation: mockTranslateText(unescapeXml(m[2])) })
      }
      if (translations.length) return this.#jsonResponse({ translations })
    }

    // 3. TRANSLATE_DUB restyle: giữ nguyên bản dịch đã đúng nghĩa.
    if (/index\|src:|^\s*\d+\s*\|src:/m.test(p)) {
      const segments = []
      for (const line of p.split(/\r?\n/)) {
        const m = line.match(/^\s*(\d+)\s*\|src:[\s\S]*?\|tgt:([\s\S]*)$/)
        if (!m) continue
        const translation = m[2].trim()
        if (translation) segments.push({ index: Number(m[1]), translation })
      }
      if (segments.length) return this.#jsonResponse({ segments })
    }

    // 4. Translation QA: không có issue, điểm tối đa.
    if (/<checks>/.test(p) && /<output_format>\s*\{"issues"/.test(p)) {
      return this.#jsonResponse({ issues: [], score: 1 })
    }

    // 5. SUMMARY: kịch bản review tham chiếu cảnh có thật.
    if (/sceneRefs/.test(p) && /"segments"/.test(p)) {
      return this.#jsonResponse(this.#summaryScriptResponse(p))
    }

    // 6. Plain text (repair / shorten / composer / retranslate).
    return {
      text: extractPlainSource(p),
      model: 'mock',
      usage: { tokensIn: 0, tokensOut: 0 },
    }
  }
}

export default MockLlm
