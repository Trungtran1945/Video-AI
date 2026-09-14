// TDD RED: semantic translation gate
// Run: node backend/tests/translateValidate.test.mjs
import { validateTranslation } from '../src/pipeline/stages/dubTranslate.js'

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const good = validateTranslation('I have 2 apples, do you not want one?', 'Tôi có 2 quả táo, bạn không muốn một quả sao?', 'vi')
assert(good.ok, `valid translation passes (${(good.errors || []).join(';')})`)

const num = validateTranslation('I have 2 apples', 'Tôi có 3 quả táo.', 'vi')
assert(!num.ok, 'number change blocked')

const neg = validateTranslation('I do not want to go', 'Tôi muốn đi', 'vi')
assert(!neg.ok, 'negation drop blocked')

const empty = validateTranslation('Hello', '', 'vi')
assert(!empty.ok, 'empty translation blocked')

const lang = validateTranslation('Hello world', 'Hello world', 'vi')
assert(!lang.ok, 'untranslated copy blocked when target is vi')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
