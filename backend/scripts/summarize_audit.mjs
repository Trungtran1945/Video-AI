import fs from 'node:fs'

const data = JSON.parse(fs.readFileSync('docs/database/audit_data_raw.json', 'utf8'))

console.log('=== TABLE ROW COUNTS ===')
const tables = Object.keys(data.current.tables).sort()
for (const t of tables) {
  const curCount = data.current.tables[t].rowCount
  const bkpCount = data.backup.tables[t] ? data.backup.tables[t].rowCount : 'N/A'
  console.log(`${t.padEnd(25)} | Current: ${String(curCount).padStart(5)} | Backup: ${String(bkpCount).padStart(5)}`)
}

console.log('\n=== ORPHANED FOREIGN KEYS ===')
console.log('Current orphans:', JSON.stringify(data.current.orphanedKeys, null, 2))
console.log('Backup orphans:', JSON.stringify(data.backup.orphanedKeys, null, 2))

console.log('\n=== INVALID JSON ===')
console.log('Current invalid JSON:', JSON.stringify(data.current.invalidJson, null, 2))
console.log('Backup invalid JSON:', JSON.stringify(data.backup.invalidJson, null, 2))

console.log('\n=== TIMESTAMP SAMPLES ===')
console.log(JSON.stringify(data.current.timestampFormats, null, 2))

console.log('\n=== ENUM DISTRIBUTIONS ===')
console.log(JSON.stringify(data.current.enumDistributions, null, 2))

console.log('\n=== UNICODE SAMPLES ===')
console.log(JSON.stringify(data.current.unicodeSamples, null, 2))
