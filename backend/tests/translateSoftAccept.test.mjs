// Task 2: soft warnings accepted, HARD errors still unresolved.
// Run: node backend/tests/translateSoftAccept.test.mjs
import { resolveFinalTranslation, validateTranslation } from '../src/pipeline/stages/dubTranslate.js'

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

// Base only fails 'entity changed' (soft) -> accepted via base, text unchanged.
const src = 'I met John Smith yesterday'
const baseSoft = 'Hôm qua tôi đã gặp bạn tôi'
const ev = validateTranslation(src, baseSoft, 'vi')
assert(!ev.ok && ev.errors.length === 1 && ev.errors[0] === 'entity changed',
  `precondition: base fails with exactly 'entity changed' (${(ev.errors || []).join(';')})`)

const picked = resolveFinalTranslation({ source: src, base: baseSoft, styled: null, targetLanguage: 'vi' })
assert(picked?.text === baseSoft && picked?.via === 'base',
  `soft entity warning accepted via base (got: ${JSON.stringify(picked)})`)

// Number-mismatch on both styled+base (HARD) -> null.
const srcN = 'I have 2 apples'
const badStyled = 'tôi có 3 quả táo'
const badBase = 'tôi có 5 quả táo'
const evS = validateTranslation(srcN, badStyled, 'vi')
const evB = validateTranslation(srcN, badBase, 'vi')
assert(!evS.ok && evS.errors.some((e) => e.startsWith('number mismatch')),
  `precondition: styled number-mismatch (${(evS.errors || []).join(';')})`)
assert(!evB.ok && evB.errors.some((e) => e.startsWith('number mismatch')),
  `precondition: base number-mismatch (${(evB.errors || []).join(';')})`)

const blocked = resolveFinalTranslation({ source: srcN, base: badBase, styled: badStyled, targetLanguage: 'vi' })
assert(blocked === null, `HARD on both styled+base -> null (got: ${JSON.stringify(blocked)})`)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
