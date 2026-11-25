import initSqlJs from 'sql.js'
import fs from 'node:fs'

const SQL = await initSqlJs()
const db = new SQL.Database(fs.readFileSync('backend/data.db'))
const res = db.exec("SELECT sql FROM sqlite_master WHERE name = 'otp_codes'")
console.log('otp_codes DDL:\n', res[0]?.values[0]?.[0])
const rows = db.exec('SELECT * FROM otp_codes')
if (rows.length) {
  const { columns, values } = rows[0]
  console.log('Columns:', columns)
  console.log('Rows count:', values.length)
  console.log('First 2 rows:', values.slice(0, 2))
}
