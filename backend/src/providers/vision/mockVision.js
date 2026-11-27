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
  async analyze(_image) {
    return { description: 'Mock image analysis: placeholder description' }
  }

  /**
   * Contract dùng bởi summary.analyze (giống GeminiVision.describeImage).
   * Không đọc file — trả mô tả mẫu theo thứ tự để pipeline có embedding ổn định.
   * @param {{imagePath?: string, prompt?: string}} opts
   * @returns {Promise<{text: string, model: string}>}
   */
  async describeImage({ imagePath, prompt } = {}) {
    void imagePath
    void prompt
    return { text: 'Cảnh phim mô phỏng dùng để xem thử quy trình tóm tắt video.', model: 'mock' }
  }

  /**
   * Contract dùng bởi summary.analyze khi có nhiều ảnh cùng lúc.
   * @param {{imagePaths?: string[]}} opts
   * @returns {Promise<Array<{text: string, model: string}>>}
   */
  async describeBatch({ imagePaths = [] } = {}) {
    const n = Array.isArray(imagePaths) ? imagePaths.length : 1
    return Array.from({ length: n }, (_, i) => ({
      text: `Cảnh ${i + 1} trong chuỗi video mô phỏng.`,
      model: 'mock',
    }))
  }

  /**
   * Detect hardsub subtitle region (dub.mask test double).
   * Returns one fixed bottom-frame box so CI covers union→insert→render
   * without a real vision key. Ignores imagePath (no I/O).
   * @param {{imagePath?: string, width?: number, height?: number}} opts
   * @returns {Promise<{boxes: object[], model: string}>}
   */
  async detectSubtitle({ imagePath, width = 1280, height = 720 } = {}) {
    void imagePath
    const W = Number(width) || 1280
    const H = Number(height) || 720
    return {
      boxes: [{
        x: Math.round(W * 0.1),
        y: Math.round(H * 0.72),
        width: Math.round(W * 0.8),
        height: Math.round(H * 0.16),
        text: 'mock hardsub',
        confidence: 0.9,
      }],
      model: 'mock',
    }
  }
}

export default MockVision
