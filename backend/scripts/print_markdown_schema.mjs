import fs from 'node:fs'

const schema = JSON.parse(fs.readFileSync('docs/database/detailed_sqlite_schema.json', 'utf8'))

for (const [table, info] of Object.entries(schema)) {
  console.log(`\n### Table: \`${table}\` (Rows: ${info.rowCount})`)
  console.log('| # | Column | SQLite Type | Not Null | Default | PK |')
  console.log('|---|---|---|---|---|---|')
  for (const c of info.columns) {
    console.log(`| ${c.cid} | \`${c.name}\` | ${c.type || 'BLOB/NONE'} | ${c.notnull ? 'YES' : 'NO'} | ${c.dflt_value ?? 'NULL'} | ${c.pk ? 'PK' : ''} |`)
  }
  if (info.indexes.length > 0) {
    console.log('**Indexes:**')
    for (const idx of info.indexes) {
      console.log(`- \`${idx.name}\`: UNIQUE=${idx.unique}, cols=(${idx.columns.join(', ')})`)
    }
  }
}
