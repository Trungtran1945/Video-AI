import initSqlJs from 'sql.js'
import fs from 'node:fs'

const SQL = await initSqlJs()
const db = new SQL.Database(fs.readFileSync('backend/data.db'))

function q(sql) {
  const res = db.exec(sql)
  return res.length ? res[0].values : []
}

console.log('--- subtitles sample ---')
const subs = q('SELECT id, format, language, cues FROM subtitles LIMIT 2')
for (const s of subs) {
  console.log('sub id:', s[0], 'format:', s[1], 'cues snippet:', String(s[3]).slice(0, 150))
}

console.log('--- project_cleanup_tasks sample ---')
const cleanups = q('SELECT id, project_id, keys_json, operation FROM project_cleanup_tasks LIMIT 2')
for (const c of cleanups) {
  console.log('cleanup id:', c[0], 'keys_json:', c[2])
}

console.log('--- assets meta & ocr_data sample ---')
const assets = q('SELECT id, kind, meta, ocr_data FROM assets WHERE meta IS NOT NULL OR ocr_data IS NOT NULL LIMIT 2')
for (const a of assets) {
  console.log('asset id:', a[0], 'kind:', a[1], 'meta:', a[2], 'ocr_data:', a[3])
}

console.log('--- generation_jobs payload & result sample ---')
const jobs = q('SELECT id, type, payload, result FROM generation_jobs WHERE payload IS NOT NULL OR result IS NOT NULL LIMIT 2')
for (const j of jobs) {
  console.log('job id:', j[0], 'type:', j[1], 'payload:', String(j[2]).slice(0, 100), 'result:', String(j[3]).slice(0, 100))
}
