// Subtitle region -> ASS: regions passed (not []), scale-invariant, modes.
// Run: node backend/tests/assRegion.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-ass-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || 'C:\\ffmpeg\\bin\\ffmpeg.exe'
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || 'C:\\ffmpeg\\bin\\ffprobe.exe'

const { initSchema } = await import('../src/db/schema.js')
const { run } = await import('../src/db/query.js')
const mod = await import('../src/pipeline/stages/dubRender.js')
const { buildAss, pickRegion, alignEnd, normalizeRegion, loadSubtitleRegions } = mod

await initSchema()

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

// normalize snake_case DB row -> camelCase + validation
{
  const r = normalizeRegion({ ratio_x: 0.1, ratio_y: 0.7, ratio_w: 0.8, ratio_h: 0.2, start_sec: 0, end_sec: 2 })
  assert(r && r.ratioX === 0.1 && r.ratioW === 0.8, 'normalize snake_case -> camelCase')
  assert(normalizeRegion({ ratio_x: -1, ratio_y: 0, ratio_w: 0.5, ratio_h: 0.2, start_sec: 0, end_sec: 1 }) === null, 'invalid ratio rejected')
  assert(normalizeRegion({ ratio_x: 0.1, ratio_y: 0.1, ratio_w: 0, ratio_h: 0.2, start_sec: 0, end_sec: 1 }) === null, 'zero-size region rejected')
}

// pickRegion by midpoint + alignEnd extension
{
  const regions = [{ ratioX: 0.1, ratioY: 0.7, ratioW: 0.8, ratioH: 0.2, start_sec: 0, end_sec: 2 }]
  assert(pickRegion(regions, 0, 1.8)?.start_sec === 0, 'pickRegion hits midpoint')
  assert(pickRegion(regions, 5, 6) === null, 'pickRegion miss outside')
  assert(alignEnd({ start_sec: 0, end_sec: 1.5 }, regions) === 2, 'alignEnd extends to region end when <1.2s gap')
}

// buildAss uses region for original (scale-invariant to resolution)
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-'))
  const segs = [{ start_sec: 0.5, end_sec: 1.5, translation: 'xin chào' }]
  const regions = [{ ratioX: 0.1, ratioY: 0.7, ratioW: 0.8, ratioH: 0.2, start_sec: 0, end_sec: 2 }]
  const p720 = buildAss(dir, segs, regions, { width: 1280, height: 720, title: 't', subPosition: 'original' })
  const ass720 = fs.readFileSync(p720, 'utf8')
  // cx=(0.1+0.4)*1280=640, cy=(0.7+0.144)*720=607.68->608
  assert(ass720.includes('\\pos(640,608)'), `original uses region center scaled to 720p (got ${ass720.split('\n').pop()})`)
  assert(ass720.includes('PlayResX: 1280') && ass720.includes('PlayResY: 720'), 'PlayRes matches video resolution')
  const p1080 = buildAss(dir, segs, regions, { width: 1920, height: 1080, title: 't', subPosition: 'original' })
  const ass1080 = fs.readFileSync(p1080, 'utf8')
  // cx=(0.5)*1920=960, cy=(0.844)*1080=911.52->912
  assert(ass1080.includes('\\pos(960,912)'), 'same ratio scales to 1080p (scale-independent)')
  // top/bottom modes region-independent
  const pTop = buildAss(dir, segs, regions, { width: 1280, height: 720, title: 't', subPosition: 'top' })
  assert(fs.readFileSync(pTop, 'utf8').includes('\\an8\\pos(640,86)'), 'top mode at 12% height')
  const pBot = buildAss(dir, segs, regions, { width: 1280, height: 720, title: 't', subPosition: 'bottom' })
  assert(fs.readFileSync(pBot, 'utf8').includes('\\an2\\pos(640,648)'), 'bottom mode at 90% height')
  // empty regions -> default bottom (no crash)
  const pEmpty = buildAss(dir, segs, [], { width: 1280, height: 720, title: 't', subPosition: 'original' })
  assert(fs.readFileSync(pEmpty, 'utf8').includes('{\\an2}xin chào'), 'empty regions falls back to bottom default')
}

// loadSubtitleRegions reads persisted ocr_regions (integration with DB)
{
  const pid = 'ass-proj-1'
  await run('INSERT INTO projects (id, user_id, mode, title, params) VALUES (?, ?, ?, ?, ?)',
    [pid, 'u1', 'TRANSLATE_DUB', 't', '{}'])
  await run('INSERT INTO ocr_regions (id, project_id, start_sec, end_sec, ratio_x, ratio_y, ratio_w, ratio_h, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['rg1', pid, 0, 2, 0.1, 0.7, 0.8, 0.2, 'AUTO'])
  const regions = await loadSubtitleRegions(pid)
  assert(regions.length === 1 && regions[0].ratioX === 0.1, 'loadSubtitleRegions reads persisted bbox')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
