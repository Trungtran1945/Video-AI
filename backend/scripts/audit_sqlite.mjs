import initSqlJs from 'sql.js'
import fs from 'node:fs'
import path from 'node:path'

async function auditDatabase(dbPath, label) {
  console.log(`\n==================================================`)
  console.log(`AUDITING [${label}]: ${dbPath}`)
  console.log(`==================================================`)
  
  if (!fs.existsSync(dbPath)) {
    console.log(`File does not exist: ${dbPath}`)
    return null
  }

  const SQL = await initSqlJs()
  const buffer = fs.readFileSync(dbPath)
  const db = new SQL.Database(buffer)

  const helper = {
    all(sql, params = []) {
      const res = db.exec(sql, params)
      if (!res.length) return []
      const { columns, values } = res[0]
      return values.map(v => Object.fromEntries(columns.map((c, i) => [c, v[i]])))
    },
    get(sql, params = []) {
      const rows = this.all(sql, params)
      return rows[0] || null
    }
  }

  // Master objects
  const objects = helper.all(`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`)
  const tables = objects.filter(o => o.type === 'table' && !o.name.startsWith('sqlite_'))
  const views = objects.filter(o => o.type === 'view')
  const triggers = objects.filter(o => o.type === 'trigger')
  const indexes = objects.filter(o => o.type === 'index' && !o.name.startsWith('sqlite_'))

  console.log(`Found: ${tables.length} tables, ${views.length} views, ${triggers.length} triggers, ${indexes.length} user indexes`)

  const auditResult = {
    label,
    dbPath,
    fileSizeBytes: buffer.length,
    tableCount: tables.length,
    viewCount: views.length,
    triggerCount: triggers.length,
    indexCount: indexes.length,
    tables: {},
    views: views.map(v => ({ name: v.name, sql: v.sql })),
    triggers: triggers.map(t => ({ name: t.name, table: t.tbl_name, sql: t.sql })),
    orphanedKeys: [],
    invalidJson: [],
    timestampFormats: {},
    enumDistributions: {}
  }

  // Relations map to check orphaned references
  const potentialRelations = [
    { fromTable: 'projects', fromCol: 'user_id', toTable: 'users', toCol: 'id' },
    { fromTable: 'settings', fromCol: 'user_id', toTable: 'users', toCol: 'id' },
    { fromTable: 'api_keys', fromCol: 'user_id', toTable: 'users', toCol: 'id' },
    { fromTable: 'youtube_accounts', fromCol: 'user_id', toTable: 'users', toCol: 'id' },
    { fromTable: 'youtube_oauth_states', fromCol: 'user_id', toTable: 'users', toCol: 'id' },
    { fromTable: 'script_uploads', fromCol: 'user_id', toTable: 'users', toCol: 'id' },
    { fromTable: 'upload_sessions', fromCol: 'user_id', toTable: 'users', toCol: 'id' },
    { fromTable: 'assets', fromCol: 'project_id', toTable: 'projects', toCol: 'id' },
    { fromTable: 'generation_jobs', fromCol: 'project_id', toTable: 'projects', toCol: 'id' },
    { fromTable: 'scenes', fromCol: 'project_id', toTable: 'projects', toCol: 'id' },
    { fromTable: 'script_segments', fromCol: 'project_id', toTable: 'projects', toCol: 'id' },
    { fromTable: 'timeline_tracks', fromCol: 'project_id', toTable: 'projects', toCol: 'id' },
    { fromTable: 'timeline_clips', fromCol: 'project_id', toTable: 'projects', toCol: 'id' },
    { fromTable: 'audios', fromCol: 'project_id', toTable: 'projects', toCol: 'id' },
    { fromTable: 'subtitles', fromCol: 'project_id', toTable: 'projects', toCol: 'id' },
    { fromTable: 'outputs', fromCol: 'project_id', toTable: 'projects', toCol: 'id' },
    { fromTable: 'youtube_uploads', fromCol: 'output_id', toTable: 'outputs', toCol: 'id' },
    { fromTable: 'transcript_segments', fromCol: 'project_id', toTable: 'projects', toCol: 'id' },
    { fromTable: 'ocr_regions', fromCol: 'project_id', toTable: 'projects', toCol: 'id' },
    { fromTable: 'project_glossaries', fromCol: 'project_id', toTable: 'projects', toCol: 'id' },
    { fromTable: 'sse_tickets', fromCol: 'project_id', toTable: 'projects', toCol: 'id' },
    { fromTable: 'sse_tickets', fromCol: 'user_id', toTable: 'users', toCol: 'id' },
    { fromTable: 'project_cleanup_tasks', fromCol: 'project_id', toTable: 'projects', toCol: 'id' },
    { fromTable: 'provider_logs', fromCol: 'project_id', toTable: 'projects', toCol: 'id' },
    { fromTable: 'timeline_clips', fromCol: 'track_id', toTable: 'timeline_tracks', toCol: 'id' },
  ]

  const jsonColumns = [
    { table: 'projects', column: 'params' },
    { table: 'assets', column: 'meta' },
    { table: 'assets', column: 'ocr_data' },
    { table: 'generation_jobs', column: 'payload' },
    { table: 'generation_jobs', column: 'result' },
    { table: 'timeline_clips', column: 'style_json' },
    { table: 'timeline_clips', column: 'meta' },
    { table: 'subtitles', column: 'cues' },
    { table: 'project_cleanup_tasks', column: 'keys_json' }
  ]

  const timestampColumns = [
    { table: 'users', column: 'created_date' },
    { table: 'users', column: 'updated_date' },
    { table: 'projects', column: 'created_date' },
    { table: 'projects', column: 'updated_at' },
    { table: 'projects', column: 'started_at' },
    { table: 'projects', column: 'last_heartbeat_at' },
    { table: 'projects', column: 'expires_at' },
    { table: 'generation_jobs', column: 'created_date' },
    { table: 'generation_jobs', column: 'next_retry_at' },
    { table: 'outputs', column: 'created_date' },
    { table: 'assets', column: 'created_date' },
    { table: 'provider_logs', column: 'created_date' },
    { table: 'upload_sessions', column: 'created_date' },
    { table: 'upload_sessions', column: 'last_activity_at' },
    { table: 'upload_sessions', column: 'expires_at' }
  ]

  for (const t of tables) {
    const tableName = t.name
    const columns = helper.all(`PRAGMA table_info("${tableName}")`)
    const fks = helper.all(`PRAGMA foreign_key_list("${tableName}")`)
    const rawIndexes = helper.all(`PRAGMA index_list("${tableName}")`)
    
    const indexDetails = rawIndexes.map(idx => {
      const cols = helper.all(`PRAGMA index_info("${idx.name}")`).map(c => c.name)
      return {
        name: idx.name,
        unique: !!idx.unique,
        origin: idx.origin,
        partial: !!idx.partial,
        columns: cols
      }
    })

    const countRow = helper.get(`SELECT COUNT(*) as count FROM "${tableName}"`)
    const rowCount = countRow ? countRow.count : 0

    // Column stats (NULL count, sample)
    const colStats = {}
    for (const c of columns) {
      let nullCount = 0
      try {
        const nullRes = helper.get(`SELECT COUNT(*) as null_count FROM "${tableName}" WHERE "${c.name}" IS NULL`)
        nullCount = nullRes ? nullRes.null_count : 0
      } catch (e) {
        nullCount = 'error'
      }

      colStats[c.name] = {
        cid: c.cid,
        type: c.type,
        notnull: !!c.notnull,
        dflt_value: c.dflt_value,
        pk: !!c.pk,
        nullCount,
        hasData: (rowCount - nullCount) > 0
      }
    }

    auditResult.tables[tableName] = {
      name: tableName,
      rowCount,
      columns: colStats,
      declaredFks: fks,
      indexes: indexDetails,
      createSql: t.sql
    }
  }

  // Check orphaned foreign keys
  for (const rel of potentialRelations) {
    if (!auditResult.tables[rel.fromTable] || !auditResult.tables[rel.toTable]) continue
    try {
      const q = `SELECT t1."${rel.fromCol}" as fk_val FROM "${rel.fromTable}" t1
                 WHERE t1."${rel.fromCol}" IS NOT NULL 
                 AND t1."${rel.fromCol}" != ''
                 AND NOT EXISTS (
                   SELECT 1 FROM "${rel.toTable}" t2 WHERE t2."${rel.toCol}" = t1."${rel.fromCol}"
                 )`
      const orphans = helper.all(q)
      if (orphans.length > 0) {
        auditResult.orphanedKeys.push({
          relation: `${rel.fromTable}.${rel.fromCol} -> ${rel.toTable}.${rel.toCol}`,
          count: orphans.length,
          sample: orphans.slice(0, 5).map(o => o.fk_val)
        })
      }
    } catch (err) {
      console.warn(`Could not check orphan for ${rel.fromTable}->${rel.toTable}:`, err.message)
    }
  }

  // Check JSON validation
  for (const jc of jsonColumns) {
    if (!auditResult.tables[jc.table] || !auditResult.tables[jc.table].columns[jc.column]) continue
    try {
      const rows = helper.all(`SELECT "${jc.column}" as val, rowid FROM "${jc.table}" WHERE "${jc.column}" IS NOT NULL AND "${jc.column}" != ''`)
      let invalidCount = 0
      let samples = []
      for (const r of rows) {
        try {
          JSON.parse(r.val)
        } catch (e) {
          invalidCount++
          if (samples.length < 3) samples.push({ rowid: r.rowid, val: String(r.val).slice(0, 100), error: e.message })
        }
      }
      if (invalidCount > 0) {
        auditResult.invalidJson.push({ table: jc.table, column: jc.column, invalidCount, samples })
      }
    } catch (err) {
      console.warn(`JSON check error on ${jc.table}.${jc.column}:`, err.message)
    }
  }

  // Check timestamp formats
  for (const tc of timestampColumns) {
    if (!auditResult.tables[tc.table] || !auditResult.tables[tc.table].columns[tc.column]) continue
    try {
      const rows = helper.all(`SELECT DISTINCT "${tc.column}" as val FROM "${tc.table}" WHERE "${tc.column}" IS NOT NULL AND "${tc.column}" != '' LIMIT 10`)
      if (rows.length > 0) {
        auditResult.timestampFormats[`${tc.table}.${tc.column}`] = rows.map(r => r.val)
      }
    } catch (_) {}
  }

  // Check enum / text distribution
  const enumCols = [
    { table: 'projects', column: 'status' },
    { table: 'projects', column: 'mode' },
    { table: 'generation_jobs', column: 'status' },
    { table: 'generation_jobs', column: 'type' },
    { table: 'users', column: 'role' },
    { table: 'assets', column: 'kind' },
    { table: 'timeline_tracks', column: 'track_type' },
    { table: 'timeline_clips', column: 'clip_type' },
    { table: 'ocr_regions', column: 'status' },
    { table: 'ocr_regions', column: 'source' },
    { table: 'ocr_regions', column: 'type' },
    { table: 'outputs', column: 'status' },
    { table: 'upload_sessions', column: 'status' },
    { table: 'project_cleanup_tasks', column: 'status' }
  ]

  for (const ec of enumCols) {
    if (!auditResult.tables[ec.table] || !auditResult.tables[ec.table].columns[ec.column]) continue
    try {
      const dist = helper.all(`SELECT "${ec.column}" as val, COUNT(*) as cnt FROM "${ec.table}" GROUP BY "${ec.column}"`)
      auditResult.enumDistributions[`${ec.table}.${ec.column}`] = Object.fromEntries(dist.map(d => [d.val, d.cnt]))
    } catch (_) {}
  }

  // Check unicode / Vietnamese characters in text fields
  const unicodeSamples = {}
  for (const [table, col] of [
    ['projects', 'title'],
    ['transcript_segments', 'text'],
    ['transcript_segments', 'translation'],
    ['script_segments', 'narration'],
    ['style_presets', 'name'],
    ['project_glossaries', 'source_term'],
    ['project_glossaries', 'target_term']
  ]) {
    if (auditResult.tables[table] && auditResult.tables[table].columns[col]) {
      const rows = helper.all(`SELECT "${col}" as val FROM "${table}" WHERE "${col}" IS NOT NULL LIMIT 5`)
      const nonAscii = rows.map(r => r.val).filter(v => /[^\x00-\x7F]/.test(v))
      if (nonAscii.length > 0) {
        unicodeSamples[`${table}.${col}`] = nonAscii
      }
    }
  }
  auditResult.unicodeSamples = unicodeSamples

  return auditResult
}

async function main() {
  const currentDbPath = path.resolve('backend/data.db')
  const backupDbPath = 'D:\\E\\Video_AI_Backups\\data_sqlite_original_backup.db'

  const auditCurrent = await auditDatabase(currentDbPath, 'CURRENT')
  const auditBackup = await auditDatabase(backupDbPath, 'BACKUP')

  fs.mkdirSync('docs/database', { recursive: true })
  fs.writeFileSync('docs/database/audit_data_raw.json', JSON.stringify({ current: auditCurrent, backup: auditBackup }, null, 2), 'utf8')
  console.log(`\nAudit finished! Raw data saved to docs/database/audit_data_raw.json`)
}

main().catch(console.error)
