import initSqlJs from 'sql.js'
import fs from 'node:fs'

const SQL = await initSqlJs()
const db = new SQL.Database(fs.readFileSync('backend/data.db'))

const tables = db.exec("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")[0].values

const dump = {}

for (const [name, createSql] of tables) {
  const colInfo = db.exec(`PRAGMA table_info("${name}")`)[0]
  const columns = colInfo ? colInfo.values.map(v => ({
    cid: v[0],
    name: v[1],
    type: v[2],
    notnull: v[3],
    dflt_value: v[4],
    pk: v[5]
  })) : []

  const idxInfo = db.exec(`PRAGMA index_list("${name}")`)[0]
  const indexes = []
  if (idxInfo) {
    for (const iv of idxInfo.values) {
      const idxName = iv[1]
      const isUnique = iv[2]
      const cols = db.exec(`PRAGMA index_info("${idxName}")`)[0]?.values.map(c => c[2]) || []
      indexes.push({ name: idxName, unique: isUnique === 1, columns: cols })
    }
  }

  const rowCount = db.exec(`SELECT COUNT(*) FROM "${name}"`)[0].values[0][0]

  dump[name] = {
    name,
    rowCount,
    createSql,
    columns,
    indexes
  }
}

fs.writeFileSync('docs/database/detailed_sqlite_schema.json', JSON.stringify(dump, null, 2), 'utf8')
console.log('Saved detailed_sqlite_schema.json with', Object.keys(dump).length, 'tables.')
