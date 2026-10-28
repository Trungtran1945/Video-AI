import fs from 'node:fs'
import path from 'node:path'

/**
 * MockTts — writes deterministic silent WAV audio (duration from WPM).
 * docs/11 §6. Supports the canonical object contract used by the pipeline:
 *   synthesize({ text, outPath, speed }) -> { audioPath, durationSec, sampleRate }
 * Legacy positional form synthesize(text, opts) is kept for older callers.
 */
export class MockTts {
  constructor(_key) {}

  async synthesize(input, opts = {}) {
    const canonical = input && typeof input === 'object' ? input : null
    const text = String(canonical ? canonical.text ?? '' : input ?? '')
    const outPath = canonical ? canonical.outPath : opts.outPath
    const wpm = Number((canonical ? canonical.wpm : opts.wpm) || 150)
    if (!outPath) {
      const err = new Error('MOCK_TTS_OUTPATH_REQUIRED: mock TTS cần outPath để ghi file')
      err.code = 'MOCK_TTS_OUTPATH_REQUIRED'
      throw err
    }

    const words = text.split(/\s+/).filter(Boolean).length || 1
    const durationSec = Math.max(0.2, (words / wpm) * 60)

    const sampleRate = 24000
    const numSamples = Math.ceil(durationSec * sampleRate)
    const dataSize = numSamples * 2 // 16-bit PCM
    const headerSize = 44
    const buffer = Buffer.alloc(headerSize + dataSize)

    buffer.write('RIFF', 0)
    buffer.writeUInt32LE(36 + dataSize, 4)
    buffer.write('WAVE', 8)
    buffer.write('fmt ', 12)
    buffer.writeUInt32LE(16, 16)
    buffer.writeUInt16LE(1, 20)
    buffer.writeUInt16LE(1, 22)
    buffer.writeUInt32LE(sampleRate, 24)
    buffer.writeUInt32LE(sampleRate * 2, 28)
    buffer.writeUInt16LE(2, 32)
    buffer.writeUInt16LE(16, 34)
    buffer.write('data', 36)
    buffer.writeUInt32LE(dataSize, 40)

    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, buffer)

    return {
      audioPath: outPath,
      durationSec,
      sampleRate,
      provider: 'mock',
      model: 'mock',
      audio: buffer,
    }
  }
}

export default MockTts
