// Translation severity classification: HARD vs soft warnings.
// validateTranslation signature/return/logic untouched; this layer only splits.
// Run: node backend/tests/translationSeverity.test.mjs
import { validateTranslation, classifyTranslationErrors, hasHardTranslationError } from '../src/pipeline/stages/dubTranslate.js'

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

// number mismatch is HARD
const num = hasHardTranslationError('I have 2 apples', 'Tôi có 3 quả táo', 'vi')
assert(num.hard === true, `number mismatch is HARD (${(num.errors || []).join(';')})`)

// valid zh->vi is not HARD
const good = hasHardTranslationError('快换个方向', 'Nhanh chóng đổi hướng', 'vi')
assert(good.hard === false, `valid zh->vi not HARD (${(good.errors || []).join(';')})`)

// untranslated copy is HARD
const copy = hasHardTranslationError('hello world test case', 'hello world test case', 'vi')
assert(copy.hard === true, `untranslated copy is HARD (${(copy.errors || []).join(';')})`)

// entity heuristic is soft (warning, not HARD)
const ev = validateTranslation('I met John Smith yesterday', 'Hôm qua tôi đã gặp bạn tôi', 'vi')
assert(!ev.ok && ev.errors.length === 1 && ev.errors[0] === 'entity changed', `entity pair fails with exactly 'entity changed' (${(ev.errors || []).join(';')})`)
const ent = hasHardTranslationError('I met John Smith yesterday', 'Hôm qua tôi đã gặp bạn tôi', 'vi')
assert(ent.hard === false, `entity changed is soft (${(ent.errors || []).join(';')})`)

// classifier splits 1 hard + 1 warning
const split = classifyTranslationErrors(['entity changed', 'number mismatch (2→3)'])
assert(split.hard.length === 1 && split.warnings.length === 1, `classifier splits 1 hard + 1 warning (hard=${split.hard.join(';')} warnings=${split.warnings.join(';')})`)
assert(split.hard[0] === 'number mismatch (2→3)', 'hard bucket holds number mismatch')
assert(split.warnings[0] === 'entity changed', 'warning bucket holds entity changed')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
