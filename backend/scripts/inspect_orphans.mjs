import initSqlJs from 'sql.js'
import fs from 'node:fs'

const SQL = await initSqlJs()
const db = new SQL.Database(fs.readFileSync('backend/data.db'))

function q(sql, p = []) {
  const res = db.exec(sql, p)
  if (!res.length) return []
  const { columns, values } = res[0]
  return values.map(v => Object.fromEntries(columns.map((c, i) => [c, v[i]])))
}

console.log('--- 1. projects with invalid user_id ---')
console.log(q(`SELECT id, user_id, title, mode, status, created_date FROM projects WHERE user_id NOT IN (SELECT id FROM users)`))

console.log('--- 2. settings with invalid user_id ---')
console.log(q(`SELECT user_id, default_language FROM settings WHERE user_id NOT IN (SELECT id FROM users)`))

console.log('--- 3. timeline_tracks with invalid project_id ---')
console.log(q(`SELECT DISTINCT project_id FROM timeline_tracks WHERE project_id NOT IN (SELECT id FROM projects)`))
console.log('Total count:', q(`SELECT COUNT(*) as c FROM timeline_tracks WHERE project_id NOT IN (SELECT id FROM projects)`)[0].c)

console.log('--- 4. sse_tickets with invalid project_id ---')
console.log(q(`SELECT DISTINCT project_id FROM sse_tickets WHERE project_id NOT IN (SELECT id FROM projects)`))

console.log('--- 5. project_cleanup_tasks with invalid project_id ---')
console.log(q(`SELECT DISTINCT project_id, operation, status FROM project_cleanup_tasks WHERE project_id NOT IN (SELECT id FROM projects)`))

console.log('--- 6. provider_logs with invalid project_id ---')
console.log(q(`SELECT DISTINCT project_id FROM provider_logs WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects)`))
