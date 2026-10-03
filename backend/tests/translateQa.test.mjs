// Translation QA regression: deterministic guards (timing/overlap/length)
// + BLOCK_RENDER index extraction. Pure — no LLM/DB needed.
// Run: node tests/translateQa.test.mjs
const { runDeterministicQa, blockingRenderIndexes, QA_CHECKS } = await import('../src/pipeline/translateQa.js')

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

assert(JSON.stringify(QA_CHECKS) === JSON.stringify(['accuracy', 'fluency', 'terminology', 'length', 'timing']), 'QA checks set')

const seg = (id, index, start, end) => ({ id, index_num: index, start_sec: start, end_sec: end, text: `src ${index}` })
const tr = (segs, texts) => new Map(segs.map((s, i) => [s.id, texts[i]]))

// 1. Clean timeline → no issues
{
  const segs = [seg('a', 0, 0, 2), seg('b', 1, 2.5, 4)]
  const issues = runDeterministicQa(segs, tr(segs, ['xin chào', 'tạm biệt']))
  assert(issues.length === 0, 'clean timeline passes')
}

// 2. Invalid timing end<=start → CRITICAL BLOCK_RENDER
{
  const segs = [seg('a', 0, 2, 2)]
  const issues = runDeterministicQa(segs, tr(segs, ['x']))
  assert(issues.some((i) => i.type === 'invalid_timing' && i.severity === 'critical' && i.blockingActions.includes('BLOCK_RENDER')), 'invalid timing blocks render')
}

// 3. Overlap → CRITICAL BLOCK_RENDER on later cue
{
  const segs = [seg('a', 0, 0, 3), seg('b', 1, 2.5, 4)]
  const issues = runDeterministicQa(segs, tr(segs, ['một', 'hai']))
  const ov = issues.filter((i) => i.type === 'subtitle_overlap')
  assert(ov.length === 1 && ov[0].segmentId === 'b', 'overlap flagged on later cue')
  assert(ov[0].blockingActions.includes('BLOCK_RENDER'), 'overlap blocks render')
}

// 4. Too-long-for-slot → HIGH BLOCK_PUBLISH (not render)
{
  const segs = [seg('a', 0, 0, 1)]
  const issues = runDeterministicQa(segs, tr(segs, ['một câu dịch rất là dài không thể đọc kịp trong một giây đồng hồ']))
  const len = issues.filter((i) => i.type === 'length')
  assert(len.length === 1 && len[0].severity === 'high', 'overslot flagged high')
  assert(len[0].blockingActions.includes('BLOCK_PUBLISH') && !len[0].blockingActions.includes('BLOCK_RENDER'), 'overslot blocks publish only')
}

// 5. blockingRenderIndexes collects only BLOCK_RENDER
{
  const idx = blockingRenderIndexes([
    { index: 3, blockingActions: ['BLOCK_RENDER'] },
    { index: 5, blockingActions: ['BLOCK_PUBLISH'] },
    { index: 7, blockingActions: [] },
  ])
  assert(idx.length === 1 && idx[0] === 3, 'only BLOCK_RENDER indexes')
  assert(blockingRenderIndexes([]).length === 0, 'empty -> empty')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
