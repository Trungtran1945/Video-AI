// Task 5: per-language OCR worker pools + language mapping (real workers, POOL=1).
// Run: node backend/tests/ocrLang.test.mjs (cwd repo root) hoặc node tests/ocrLang.test.mjs (cwd backend/)
// Yêu cầu backend/{eng,chi_sim}.traineddata tồn tại (cache local, không cần mạng).
process.env.OCR_CONCURRENCY = '1'

const { mapLanguage, getWorkers, _clearPoolsForTest, closePools } = await import('../src/providers/vision/tesseractOcr.js')

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

try {
  // 1. Language mapping
  assert(JSON.stringify(mapLanguage('zh')) === JSON.stringify(['chi_sim']), 'zh -> [chi_sim]')
  assert(JSON.stringify(mapLanguage('zh-TW')) === JSON.stringify(['chi_tra']), 'zh-TW -> [chi_tra]')
  assert(JSON.stringify(mapLanguage('auto')) === JSON.stringify(['eng']), 'auto -> [eng] (detection/fallback, giữ behavior cũ)')
  assert(!mapLanguage('zh').includes('eng'), 'zh không silent thành eng')
  assert(JSON.stringify(mapLanguage('en')) === JSON.stringify(['eng']), 'en -> [eng]')

  // 2. Pool riêng theo ngôn ngữ (worker thật)
  await _clearPoolsForTest()
  const eng1 = await getWorkers('eng')
  const chi1 = await getWorkers('chi_sim')
  assert(Array.isArray(eng1) && eng1.length === 1, `eng pool size 1 (got ${eng1?.length})`)
  assert(Array.isArray(chi1) && chi1.length === 1, `chi_sim pool size 1 (got ${chi1?.length})`)
  assert(eng1 !== chi1, 'eng và chi_sim là pool riêng (identity khác nhau)')
  assert(typeof eng1[0]?.recognize === 'function', 'eng worker thật (có recognize)')
  assert(typeof chi1[0]?.recognize === 'function', 'chi_sim worker thật (có recognize)')

  // 3. Gọi xen kẽ 2 langs: không terminate nhau, pool còn tồn tại (identity ổn định)
  let termCalls = 0
  for (const w of [...eng1, ...chi1]) {
    const orig = w.terminate.bind(w)
    w.terminate = (...a) => { termCalls++; return orig(...a) }
  }
  const eng2 = await getWorkers(['eng'])
  const chi2 = await getWorkers('chi_sim')
  const eng3 = await getWorkers('eng')
  const chi3 = await getWorkers(['chi_sim'])
  assert(eng1 === eng2 && eng2 === eng3, 'eng pool tồn tại qua các lần gọi xen kẽ (không bị recreate)')
  assert(chi1 === chi2 && chi2 === chi3, 'chi_sim pool tồn tại qua các lần gọi xen kẽ (không bị recreate)')
  assert(termCalls === 0, `xen kẽ 2 langs không terminate worker nào (got ${termCalls})`)
} finally {
  await closePools()
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
