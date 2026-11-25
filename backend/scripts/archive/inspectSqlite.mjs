import initSqlJs from 'sql.js'
import fs from 'node:fs'
import path from 'node:path'

const dbPath = path.resolve('data.db')
console.log('Inspecting SQLite database:', dbPath)

const SQL = await initSqlJs()
const fileBuffer = fs.readFileSync(dbPath)
const db = new SQL.Database(fileBuffer)

const res = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
const tables = (res[0]?.values || []).flat().sort()
console.log(`Found ${tables.length} tables:`)

let totalRows = 0
for (const t of tables) {
  const countRes = db.exec(`SELECT COUNT(*) FROM "${t}"`)
  const cnt = countRes[0]?.values[0]?.[0] || 0
  totalRows += cnt
  console.log(`- ${t.padEnd(28)}: ${cnt} rows`)
}
console.log(`\nTotal rows across all tables: ${totalRows}`)
