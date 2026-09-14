// TDD RED: physical overlap validator
// Run: node backend/tests/physicalAudio.test.mjs
import { validateNoOverlap } from '../src/pipeline/forcedAlignService.js'

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const overlap = validateNoOverlap([
  { segmentId: 'a', startAtSec: 5, endAtSec: 8 },
  { segmentId: 'b', startAtSec: 7, endAtSec: 9 },
])
assert(!overlap.ok, 'overlap A[5,8] B[7,..] blocked')

const ok = validateNoOverlap([
  { segmentId: 'a', startAtSec: 5, endAtSec: 7 },
  { segmentId: 'b', startAtSec: 7, endAtSec: 9 },
])
assert(ok.ok, 'sequential segments pass')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
