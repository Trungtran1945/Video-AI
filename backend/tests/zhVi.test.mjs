// Task 6 zh->vi: short sentences, questions (吗), negation (不/没),
// numbers+units (个人/分钟), entities, short dialogues. Must PASS correct
// pairs and still BLOCK hallucination/empty/negation-drop/question-drop.
// Also covers normalizeTranslateLang (zh->zh-CN, zh-TW kept, auto = no param).
// Run: node backend/tests/zhVi.test.mjs
import { validateTranslation, hasNegationZh, isCjkQuestion } from '../src/pipeline/stages/dubTranslate.js'
import { GoogleTranslate, normalizeTranslateLang } from '../src/providers/translate/googleTranslate.js'

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }
const okPair = (s, t) => {
  const v = validateTranslation(s, t, 'vi')
  assert(v.ok, `zh->vi passes: "${s}" -> "${t}" (${(v.errors || []).join(';')})`)
}
const blockPair = (s, t, why) => {
  const v = validateTranslation(s, t, 'vi')
  assert(!v.ok, `${why} blocked: "${s}" -> "${t}"`)
}

// ── 1. normalizeTranslateLang ──
assert(normalizeTranslateLang('zh') === 'zh-CN', 'zh -> zh-CN')
assert(normalizeTranslateLang('zh-CN') === 'zh-CN', 'zh-CN kept')
assert(normalizeTranslateLang('zh-TW') === 'zh-TW', 'zh-TW kept')
assert(normalizeTranslateLang('auto') === 'auto', 'auto kept')
assert(normalizeTranslateLang('en') === 'en', 'en verbatim')
assert(normalizeTranslateLang('vi') === 'vi', 'vi verbatim')

// provider sends normalized source; auto sends NO source param
const realFetch = globalThis.fetch
let lastUrl = ''
globalThis.fetch = async (url) => {
  lastUrl = String(url)
  return { ok: true, status: 200, json: async () => ({ status: 'success', translatedText: 'Xin chào' }) }
}
await new GoogleTranslate('https://script.google.com/macros/s/ABC/exec').translate('你好', 'zh', 'vi')
assert(new URL(lastUrl).searchParams.get('source') === 'zh-CN', `zh normalized to zh-CN in request (got ${new URL(lastUrl).searchParams.get('source')})`)
await new GoogleTranslate('https://script.google.com/macros/s/ABC/exec').translate('你好', 'zh-TW', 'vi')
assert(new URL(lastUrl).searchParams.get('source') === 'zh-TW', 'zh-TW kept in request')
await new GoogleTranslate('https://script.google.com/macros/s/ABC/exec').translate('你好', 'auto', 'vi')
assert(new URL(lastUrl).searchParams.get('source') === null, 'auto sends no source param')
globalThis.fetch = realFetch

// ── 2. helpers ──
assert(hasNegationZh('我不明白') === true, 'hasNegationZh 不')
assert(hasNegationZh('我没吃') === true, 'hasNegationZh 没')
assert(hasNegationZh('你好') === false, 'hasNegationZh negative case')
assert(isCjkQuestion('你是学生吗') === true, 'isCjkQuestion 吗')
assert(isCjkQuestion('你吃了吗') === true, 'isCjkQuestion 吗 2')
assert(isCjkQuestion('你好') === false, 'isCjkQuestion statement')
assert(isCjkQuestion('那我对着强调吧') === false, 'isCjkQuestion 吧 excluded (modal, not interrogative)')
assert(isCjkQuestion('小棒是容易啊') === false, 'isCjkQuestion 啊 excluded (modal)')

// ── 3. short dialogues ──
okPair('你好', 'Xin chào')
okPair('谢谢', 'Cảm ơn bạn')
okPair('好的', 'Được rồi')

// ── 4. questions (吗) ──
okPair('你是学生吗', 'Bạn có phải là học sinh không?')
okPair('你吃了吗', 'Bạn ăn cơm chưa?')
blockPair('你是学生吗', 'Bạn là học sinh.', 'question drop')

// ── 5. negation (不/没) ──
okPair('我不明白', 'Tôi không hiểu')
okPair('我没吃', 'Tôi chưa ăn')
blockPair('我不去', 'Tôi đi', 'negation drop')

// ── 6. numbers + units ──
okPair('有3个人', 'Có 3 người')
okPair('等5分钟', 'Đợi 5 phút')
blockPair('有3个人', 'Có 5 người', 'number change')

// ── 7. entities ──
okPair('我在Starbucks喝咖啡', 'Tôi uống cà phê ở Starbucks')
blockPair('我在Starbucks喝咖啡', 'Tôi uống cà phê', 'entity drop')

// ── 8. modal particles lenient (no "?" required) ──
okPair('那我对着强调吧', 'Tôi muốn nhấn mạnh điều đó.')
okPair('小棒是容易啊', 'Cây gậy này dễ cầm lắm.')

// ── 9. guards still hold ──
blockPair('快换个方向', 'Hôm qua tôi đi chợ mua rất nhiều rau củ quả tươi ngon và gặp bạn cũ nói chuyện cả buổi chiều dài lắm luôn á', 'hallucination')
blockPair('你好', '', 'empty')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
