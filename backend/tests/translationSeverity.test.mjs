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

// length 3 tầng (regression incident seg #15/#34 — câu EN ngắn nở câu tự nhiên,
// style preset cố ý nở câu; ratio 3-8x KHÔNG chứng minh sai nghĩa).
// Nở vừa (ratio ~8): soft warning, pipeline/PATCH cho qua.
const expand = hasHardTranslationError('Hi', 'Xin chào các bạn', 'vi')
assert(expand.hard === false, `moderate expansion is soft, not HARD (${(expand.errors || []).join(';')})`)
assert(expand.errors.some((e) => e.startsWith('length expansion')), 'expansion still reported as warning')
// Nở cực đoan (ratio > 8, bịa thêm): vẫn HARD.
const padded = hasHardTranslationError('Hi', 'Xin chào các bạn, rất vui được gặp bạn hôm nay trong buổi tiệc lớn này nhé', 'vi')
assert(padded.hard === true, `extreme padding stays HARD (${(padded.errors || []).join(';')})`)
// Rụng nội dung (ratio < 0.3, vd LLM trả "nhé" cho câu dài): vẫn HARD.
const dropped = hasHardTranslationError('this place is very beautiful', 'nhé', 'vi')
assert(dropped.hard === true, `dropped content stays HARD (${(dropped.errors || []).join(';')})`)
const expandSplit = classifyTranslationErrors(['length expansion (style?)'])
assert(expandSplit.hard.length === 0 && expandSplit.warnings.length === 1, 'expansion bucketed as warning')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
