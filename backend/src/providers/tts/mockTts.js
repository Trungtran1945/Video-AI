/**
 * MockTts — returns silence audio with duration calculated from text length / WPM.
 * docs/11 §6
 */
export class MockTts {
  constructor(_key) {}

  /**
   * Generate TTS audio for text.
   * @param {string} text
   * @param {object} opts
   * @returns {Promise<{audio: Buffer, durationSec: number, sampleRate: number}>}
   */
  async synthesize(text, opts = {}) {
    const wpm = opts.wpm || 150
    const words = text.split(/\s+/).length
    const durationSec = (words / wpm) * 60

    // Generate silent audio (WAV header + silence samples)
    const sampleRate = 24000
    const numSamples = Math.ceil(durationSec * sampleRate)
    const dataSize = numSamples * 2 // 16-bit PCM
    const headerSize = 44
    const buffer = Buffer.alloc(headerSize + dataSize)

    // WAV header
    buffer.write('RIFF', 0)
    buffer.writeUInt32LE(36 + dataSize, 4)
    buffer.write('WAVE', 8)
    buffer.write('fmt ', 12)
    buffer.writeUInt32LE(16, 16) // chunk size
    buffer.writeUInt16LE(1, 20) // PCM
    buffer.writeUInt16LE(1, 22) // mono
    buffer.writeUInt32LE(sampleRate, 24)
    buffer.writeUInt32LE(sampleRate * 2, 28) // byte rate
    buffer.writeUInt16LE(2, 32) // block align
    buffer.writeUInt16LE(16, 34) // bits per sample
    buffer.write('data', 36)
    buffer.writeUInt32LE(dataSize, 40)
    // Rest is zeros (silence)

    return { audio: buffer, durationSec, sampleRate }
  }
}

export default MockTts
