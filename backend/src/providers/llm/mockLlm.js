/**
 * MockLlm — returns valid JSON per schema for pipeline testing without tokens.
 * docs/11 §6
 */
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
   * Translate transcript segments (TRANSLATE_DUB pipeline).
   * @param {{text: string, startMs: number, endMs: number}[]} segments
   * @param {string} targetLang
   * @returns {Promise<{text: string, startMs: number, endMs: number}[]>}
   */
  async translate(segments, targetLang) {
    return segments.map(s => ({
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

  /**
   * SCRIPT_TO_VIDEO: verbatim segmentation stub. Splits the text enclosed by
   * SCRIPT_CHUNK_BEGIN/END markers so coverage tests can assert 100% retention.
   * @param {{system?: string, prompt?: string, json?: boolean}} input
   */
  async complete({ prompt } = {}) {
    const match = String(prompt || '').match(/SCRIPT_CHUNK_BEGIN\s*([\s\S]*?)\s*SCRIPT_CHUNK_END/)
    const source = match ? match[1].trim() : ''
    const segments = []
    if (source) {
      for (const line of source.split(/\n+/)) {
        const text = line.trim()
        if (!text) continue
        const parts = text.split(/(?<=[.!?…。])\s+/).map((s) => s.trim()).filter(Boolean)
        for (const part of parts) {
          segments.push({ narrationText: part, visualPrompt: part.slice(0, 160) })
        }
      }
    }
    return {
      text: JSON.stringify({ segments }),
      model: 'mock',
      usage: { tokensIn: 0, tokensOut: 0 },
    }
  }
}

export default MockLlm
