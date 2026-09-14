// TDD RED: e2e partial TTS mapping regression (S0 ok / S1 fail / S2 ok)
// Run: node backend/tests/e2ePartialMapping.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveAudioEntries } from '../src/pipeline/stages/dubRender.js'
import { buildAudioFileMap } from '../src/pipeline/stages/dubTtsAlign.js'

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-e2e-'))
const p0 = path.join(tmp, 'seg_s0.wav'); fs.writeFileSync(p0, 'x')
const p2 = path.join(tmp, 'seg_s2.wav'); fs.writeFileSync(p2, 'x')

const fitted = [
  { segmentId: 's0', audioId: 'a0', file: p0, startAtSec: 0, endAtSec: 2 },
  { segmentId: 's2', audioId: 'a2', file: p2, startAtSec: 4, endAtSec: 6 },
]
const fileMap = buildAudioFileMap(fitted)
const rows = [
  { id: 's0', start_sec: 0, end_sec: 2, audio_id: 'a0' },
  { id: 's1', start_sec: 2, end_sec: 4, audio_id: null },
  { id: 's2', start_sec: 4, end_sec: 6, audio_id: 'a2' },
]
const filesById = new Map([['a0', fileMap.get('s0')], ['a2', fileMap.get('s2')]])
const entries = resolveAudioEntries(rows, fitted, filesById)
assert(entries.get('s0')?.file === p0, 'e2e S0 correct')
assert(!entries.get('s1'), 'e2e S1 blocked, no fallback')
assert(entries.get('s2')?.file === p2, 'e2e S2 correct, no index shift')

try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
