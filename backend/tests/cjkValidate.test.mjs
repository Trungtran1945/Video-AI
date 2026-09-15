// RED: CJK (zh->vi) semantic gate must accept valid translations.
// Real failure: project d736 (zh->vi, 12 segments) failed 11/12 because
// length ratio 0.3-3 assumes latin source, and question check misses CJK particles.
// Run: node backend/tests/cjkValidate.test.mjs
import { validateTranslation } from '../src/pipeline/stages/dubTranslate.js'

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

// Live GT outputs from the failing project (verified correct Vietnamese)
const pairs = [
  ['快换个方向', 'Nhanh chóng đổi hướng'],
  ['哦哦哦好的好的', 'Được rồi, được rồi.'],
  ['那我对着强调吧', 'Tôi muốn nhấn mạnh điều đó.'],
  ['是我都要补餐', 'Tôi cần ăn nhiều hơn.'],
  ['小棒是容易啊', 'Cây gậy này dễ cầm lắm.'],
]
for (const [src, tgt] of pairs) {
  const v = validateTranslation(src, tgt, 'vi')
  assert(v.ok, `zh->vi passes: "${src}" -> "${tgt}" (${(v.errors || []).join(';')})`)
}

// CJK question particle 吗/呢/吧 maps to Vietnamese "?"
const q = validateTranslation('不知道这是谁的鲤鱼吗', 'Không biết con cá chép này là của ai nhỉ?', 'vi')
assert(q.ok, `CJK question particle passes (${(q.errors || []).join(';')})`)

// Guards must still hold
const hallu = validateTranslation('快换个方向', 'Hôm qua tôi đi chợ mua rất nhiều rau củ quả tươi ngon và gặp bạn cũ nói chuyện cả buổi chiều dài lắm luôn á', 'vi')
assert(!hallu.ok, 'extreme hallucination still blocked')
const empty = validateTranslation('你好', '', 'vi')
assert(!empty.ok, 'empty translation still blocked')
const copy = validateTranslation('hello world test case', 'hello world test case', 'vi')
assert(!copy.ok, 'untranslated latin copy still blocked')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
