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
}

export default MockLlm
