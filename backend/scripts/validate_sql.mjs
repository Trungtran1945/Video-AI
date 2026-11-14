import fs from 'node:fs'

const sql = fs.readFileSync('backend/src/db/postgresSchema.sql', 'utf8')

// Parse table definitions
const tableRegex = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\);/g
const tables = {}
let match

while ((match = tableRegex.exec(sql)) !== null) {
  const tableName = match[1]
  const body = match[2]
  const lines = body.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('--'))
  const cols = new Set()
  const fks = []

  for (const line of lines) {
    if (line.startsWith('PRIMARY KEY') || line.startsWith('CONSTRAINT') || line.startsWith('UNIQUE')) continue
    const colMatch = line.match(/^(\w+)\s+([A-Za-z0-9_()]+)/)
    if (colMatch) {
      cols.add(colMatch[1])
    }
    const fkMatch = line.match(/^(\w+).*?REFERENCES\s+(\w+)\s*\((.*?)\)/i)
    if (fkMatch) {
      fks.push({ fromCol: fkMatch[1], toTable: fkMatch[2], toCol: fkMatch[3] })
    }
  }
  tables[tableName] = { cols, fks }
}

console.log(`Found ${Object.keys(tables).length} tables in postgresSchema.sql.`)

let errors = 0
for (const [tName, tInfo] of Object.entries(tables)) {
  for (const fk of tInfo.fks) {
    if (!tables[fk.toTable]) {
      console.error(`ERROR in ${tName}: References non-existent table ${fk.toTable}`)
      errors++
    } else if (!tables[fk.toTable].cols.has(fk.toCol)) {
      console.error(`ERROR in ${tName}: References non-existent column ${fk.toCol} in table ${fk.toTable}`)
      errors++
    }
  }
}

if (errors === 0) {
  console.log('All Foreign Key table and column references are 100% valid!')
}
