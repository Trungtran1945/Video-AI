// TDD RED: render ID resolve + BLOCK_RENDER
// Run: node backend/tests/renderBlock.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveAudioEntries } from '../src/pipeline/stages/dubRender.js'

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-render-'))
const f0 = path.join(tmp, 'a0.wav'); fs.writeFileSync(f0, 'x')
const f2 = path.join(tmp, 'a2.wav'); fs.writeFileSync(f2, 'x')

const rows = [
  { id: 's0', start_sec: 0, end_sec: 2, audio_id: 'a0' },
  { id: 's1', start_sec: 2, end_sec: 4, audio_id: null },
  { id: 's2', start_sec: 4, end_sec: 6, audio_id: 'a2' },
]
const aligns = [
  { segmentId: 's0', audioId: 'a0', startAtSec: 0, endAtSec: 2 },
  { segmentId: 's2', audioId: 'a2', startAtSec: 4, endAtSec: 6 },
]
const filesById = new Map([['a0', f0], ['a2', f2]])
const entries = resolveAudioEntries(rows, aligns, filesById)
assert(entries.get('s0')?.file === f0, 'S0 -> file0')
assert(!entries.get('s1'), 'S1 missing -> no entry (blocks render)')
assert(entries.get('s2')?.file === f2, 'S2 -> file2, never shifted')

// Duplicate audio assigned to two segments must be blocked (1:1)
const dupRows = [
  { id: 's0', start_sec: 0, end_sec: 2, audio_id: 'a0' },
  { id: 's1', start_sec: 2, end_sec: 4, audio_id: 'a0' },
]
const dup = resolveAudioEntries(dupRows, [{ segmentId: 's0', audioId: 'a0', startAtSec: 0, endAtSec: 2 }, { segmentId: 's1', audioId: 'a0', startAtSec: 2, endAtSec: 4 }], new Map([['a0', f0]]))
assert(dup.size === 1, 'duplicate audio assignment blocked (1:1)')

try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
