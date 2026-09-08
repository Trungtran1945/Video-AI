/**
 * MockAsr — returns mock transcript segments for pipeline testing.
 * docs/11 §6
 */
export class MockAsr {
  constructor(_key) {}

  /**
   * Transcribe audio file.
   * @param {string} audioPath
   * @param {object} opts
   * @returns {Promise<{text: string, segments: {start: number, end: number, text: string}[]}>}
   */
  async transcribe(audioPath, opts = {}) {
    const language = opts.language || 'en'
    return {
      text: `Mock transcription for ${audioPath || 'audio'} in ${language}`,
      segments: [
        { start: 0, end: 3, text: 'Mock segment 1.' },
        { start: 3, end: 6, text: 'Mock segment 2.' },
        { start: 6, end: 9, text: 'Mock segment 3.' },
      ],
    }
  }
}

export default MockAsr
