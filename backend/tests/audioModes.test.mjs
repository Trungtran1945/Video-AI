// Audio modes contract: DUB_MIX / DUB_REPLACE / ORIGINAL_ONLY + lag allowance.
// Pure constants — FFmpeg mixing itself is covered by manual verification.
// Run: node tests/audioModes.test.mjs
const { AUDIO_MODES, DUB_MAX_LAG_SEC } = await import('../src/media/mediaService.js')

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

assert(JSON.stringify(AUDIO_MODES) === JSON.stringify(['ORIGINAL_ONLY', 'DUB_MIX', 'DUB_REPLACE']), 'audio modes set')
assert(DUB_MAX_LAG_SEC === 1.2, `lag allowance 1.2s (got ${DUB_MAX_LAG_SEC})`)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
