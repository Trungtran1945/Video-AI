// PLAN Task 0 — Logs/analytics leak after DELETE (S4/S5/E1, 2-user contract).
// Contract test (source-level): NULL-detached logs visible to admin only;
// analytics byDay/byProvider share the same detach semantics.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
const assert = (c, m) => {
  if (c) console.log('PASS:', m)
  else { failures += 1; console.error('FAIL:', m) }
}
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')

const logsSrc = read('src/routes/v1/logs.js')
// Non-admin must NOT see NULL-detached rows: pattern requires project_id IS NOT NULL
// for the user branch, NULL only on the admin branch.
assert(/pl\.project_id IS NOT NULL/.test(logsSrc), 'logs.js user branch requires pl.project_id IS NOT NULL')
assert(!/p\.user_id = \? OR pl\.project_id IS NULL/.test(logsSrc), 'logs.js has no blanket OR pl.project_id IS NULL leak for users')

const analyticsSrc = read('src/routes/v1/analytics.js')
// byDay and byProvider must share semantics: both JOIN (user) / both LEFT JOIN (admin)
// or both filter detached rows the same way — never mixed JOIN vs LEFT JOIN.
const byDayJoin = /JOIN projects p ON pl\.project_id = p\.id/.test(analyticsSrc)
const byDayLeft = /LEFT JOIN projects p ON pl\.project_id = p\.id/.test(analyticsSrc)
assert(byDayJoin && byDayLeft, 'analytics byDay has explicit JOIN (user) + LEFT JOIN (admin) semantics')
const provAdminLeft = /provJoin[\s\S]{0,300}LEFT JOIN/.test(analyticsSrc)
assert(provAdminLeft, 'analytics byProvider keeps admin LEFT JOIN for detached logs')
// Non-admin byProvider must JOIN (exclude detached), matching byDay.
assert(/'JOIN projects p ON pl\.project_id = p\.id'/.test(analyticsSrc), 'analytics non-admin uses JOIN (detached excluded)')

if (failures > 0) process.exit(1)
console.log('ALL PASS')
process.exit(0)
