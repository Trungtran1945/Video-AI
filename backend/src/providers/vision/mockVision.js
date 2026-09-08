/**
 * MockVision — returns fixed/template descriptions by timestamp for pipeline testing.
 * docs/11 §6
 */
export class MockVision {
  constructor(_key) {}

  /**
   * Analyze keyframes and return descriptions.
   * @param {{image: Buffer|string, timestampMs: number}[]} keyframes
   * @returns {Promise<{description: string, timestampMs: number}[]>}
   */
  async analyzeKeyframes(keyframes) {
    return keyframes.map((kf, i) => ({
      description: `Mock frame ${i + 1} at ${(kf.timestampMs / 1000).toFixed(1)}s: scene description placeholder`,
      timestampMs: kf.timestampMs || i * 5000,
    }))
  }

  /**
   * Analyze a single image.
   * @param {Buffer|string} image
   * @returns {Promise<{description: string}>}
   */
  async analyze(image) {
    return { description: 'Mock image analysis: placeholder description' }
  }
}

export default MockVision
