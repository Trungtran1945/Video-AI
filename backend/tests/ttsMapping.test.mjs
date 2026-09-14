// TDD RED: one segment -> one audio, partial failure never shifts mapping
// Run: node backend/tests/ttsMapping.test.mjs
import { buildAudioFileMap } from '../src/pipeline/stages/dubTtsAlign.js'

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

// S0 success, S1 failed, S2 success
const fitted = [
  { segmentId: 's0', audioId: 'a0', file: '/tmp/seg_s0.wav' },
  { segmentId: 's2', audioId: 'a2', file: '/tmp/seg_s2.wav' },
]
const m = buildAudioFileMap(fitted)
assert(m.get('s0') === '/tmp/seg_s0.wav', 'S0 receives audio 0')
assert(!m.get('s1'), 'S1 has no audio (failed)')
assert(m.get('s2') === '/tmp/seg_s2.wav', 'S2 receives audio 2, never S1 file')
assert(m.get('s1') !== '/tmp/seg_s2.wav', 'no index-shift: S1 never gets S2 file')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
