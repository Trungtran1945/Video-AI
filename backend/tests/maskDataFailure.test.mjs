// Mask data failure & error surfacing tests (§4.3)
// Proves DB errors and malformed approved masks cause BLOCK_RENDER errors instead of silent failure
import path from 'node:path'
import os from 'node:os'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_mask_fail_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { insert, run } = await import('../src/db/query.js')
const { loadSubtitleRegions } = await import('../src/pipeline/stages/dubRender.js')

await initSchema()

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

const pid = `p-mask-fail-${Date.now()}`
await insert('projects', { id: pid, user_id: 'u-fail', mode: 'TRANSLATE_DUB', title: 'mask fail' })

// 1. No rows -> returns [] (valid empty state)
{
  const res = await loadSubtitleRegions(pid)
  assert(Array.isArray(res) && res.length === 0, 'no mask rows returns [] safely')
}

// 2. Malformed APPROVED mask: ratioW <= 0 -> throws BLOCK_RENDER: MASK_INVALID
{
  await insert('ocr_regions', {
    id: 'm-bad-w',
    project_id: pid,
    start_sec: 1, end_sec: 3,
    ratio_x: 0.1, ratio_y: 0.1, ratio_w: 0, ratio_h: 0.2, // zero width
    status: 'APPROVED',
    enabled: 1,
  })

  let threw = false
  let errCode = ''
  let errMsg = ''
  try {
    await loadSubtitleRegions(pid)
  } catch (err) {
    threw = true
    errCode = err.code
    errMsg = err.message
  }
  assert(threw === true, 'loadSubtitleRegions throws on invalid APPROVED geometry')
  assert(errCode === 'BLOCK_RENDER', `error code is BLOCK_RENDER (got ${errCode})`)
  assert(errMsg.includes('MASK_INVALID'), `error message includes MASK_INVALID (got ${errMsg})`)

  await run('DELETE FROM ocr_regions WHERE id = ?', ['m-bad-w'])
}

// 3. Malformed APPROVED mask: endSec <= startSec -> throws BLOCK_RENDER: MASK_INVALID
{
  await insert('ocr_regions', {
    id: 'm-bad-timing',
    project_id: pid,
    start_sec: 5, end_sec: 2, // end before start
    ratio_x: 0.1, ratio_y: 0.1, ratio_w: 0.5, ratio_h: 0.2,
    status: 'APPROVED',
    enabled: 1,
  })

  let threw = false
  let errMsg = ''
  try {
    await loadSubtitleRegions(pid)
  } catch (err) {
    threw = true
    errMsg = err.message
  }
  assert(threw === true, 'loadSubtitleRegions throws on invalid timing')
  assert(errMsg.includes('BLOCK_RENDER: MASK_INVALID'), 'error is BLOCK_RENDER: MASK_INVALID')

  await run('DELETE FROM ocr_regions WHERE id = ?', ['m-bad-timing'])
}

// 4. Malformed APPROVED mask: ratioX out of bounds (< 0) -> throws BLOCK_RENDER: MASK_INVALID
{
  await insert('ocr_regions', {
    id: 'm-bad-coord',
    project_id: pid,
    start_sec: 1, end_sec: 3,
    ratio_x: -0.5, ratio_y: 0.1, ratio_w: 0.5, ratio_h: 0.2,
    status: 'APPROVED',
    enabled: 1,
  })

  let threw = false
  try {
    await loadSubtitleRegions(pid)
  } catch (err) {
    threw = true
    assert(err.message.includes('BLOCK_RENDER: MASK_INVALID'), 'throws BLOCK_RENDER: MASK_INVALID on ratio_x < 0')
  }
  assert(threw === true, 'loadSubtitleRegions throws on out-of-bounds coordinate')

  await run('DELETE FROM ocr_regions WHERE id = ?', ['m-bad-coord'])
}

// 5. Database failure: simulate query failure -> throws BLOCK_RENDER: MASK_DATA_UNAVAILABLE (not swallowed to [])
{
  // Drop table to induce real SQLite failure
  await run('DROP TABLE ocr_regions')

  let threw = false
  let errMsg = ''
  let errCode = ''
  try {
    await loadSubtitleRegions(pid)
  } catch (err) {
    threw = true
    errCode = err.code
    errMsg = err.message
  }
  assert(threw === true, 'DB query failure throws instead of returning empty array []')
  assert(errCode === 'BLOCK_RENDER', `DB failure code is BLOCK_RENDER (got ${errCode})`)
  assert(errMsg.includes('BLOCK_RENDER: MASK_DATA_UNAVAILABLE'), `DB failure message is BLOCK_RENDER: MASK_DATA_UNAVAILABLE (got ${errMsg})`)
}

try { (await import('node:fs')).rmSync(process.env.DB_PATH, { force: true }) } catch (_) {}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
if (failures > 0) process.exit(1)
