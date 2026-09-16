// Negation gate: không false-positive trên tiểu từ nghi vấn "...không?/chưa?"
// và transcript STT mất dấu nháy ("dont/cant"), vẫn bắt đổi phủ định thật.
// Run: node backend/tests/negationQuestion.test.mjs
import { validateTranslation, stripViQuestionParticle } from '../src/pipeline/stages/dubTranslate.js'

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }
const noNegErr = (v) => !(v.errors || []).some((e) => e === 'negation changed')
const hasNegErr = (v) => (v.errors || []).some((e) => e === 'negation changed')

// 1. Strip helper: trailing question particle bị loại, negation giữa câu giữ nguyên.
assert(stripViQuestionParticle('Có tốt không?') === 'Có tốt', 'strip "...không?" -> gốc')
assert(stripViQuestionParticle('Bạn ăn chưa?') === 'Bạn ăn', 'strip "...chưa?" -> gốc')
assert(stripViQuestionParticle('Tôi không muốn đi') === 'Tôi không muốn đi', 'giữ phủ định giữa câu')

// 2. Câu hỏi EN -> VI thêm "không/chưa?" để hỏi: KHÔNG báo negation.
assert(noNegErr(validateTranslation('Is it good', 'Có tốt không?', 'vi')), 'question particle không? không phải phủ định')
assert(noNegErr(validateTranslation('Have you eaten', 'Bạn ăn chưa?', 'vi')), 'question particle chưa? không phải phủ định')

// 3. Transcript STT mất dấu nháy / từ phủ định không dấu nháy: KHÔNG báo khi VI giữ phủ định.
assert(noNegErr(validateTranslation('I dont want to go', 'Tôi không muốn đi', 'vi')), 'STT "dont" + VI "không" khớp phủ định')
assert(noNegErr(validateTranslation('I cannot go', 'Tôi không thể đi', 'vi')), '"cannot" + VI "không" khớp phủ định')
assert(noNegErr(validateTranslation('Nothing matters here today', 'Không có gì quan trọng ở đây hôm nay', 'vi')), '"Nothing" + VI "Không" khớp phủ định')

// 4. Đổi nghĩa thật vẫn bị bắt (cả mất lẫn thêm phủ định giữa câu).
assert(hasNegErr(validateTranslation('I do not want to go', 'Tôi muốn đi', 'vi')), 'mất phủ định vẫn bị bắt')
assert(hasNegErr(validateTranslation('I want to go home now', 'Tôi không muốn về nhà bây giờ', 'vi')), 'thêm phủ định giữa câu vẫn bị bắt')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
