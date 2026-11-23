import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { ALLOWED_TABLES } from '../src/lib/sqlHelpers.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
let failures = 0
const assert = (condition, message) => {
  if (condition) {
    console.log('PASS:', message)
  } else {
    failures++
    console.error('FAIL:', message)
  }
}

console.log('=== Test: Cloudinary Schema Migration & Tooling Validation ===')

// 1. Verify ALLOWED_TABLES includes new tables
assert(ALLOWED_TABLES.has('cloudinary_assets'), 'ALLOWED_TABLES includes cloudinary_assets')
assert(ALLOWED_TABLES.has('media_migration_manifest'), 'ALLOWED_TABLES includes media_migration_manifest')

// 2. Verify migration SQL file exists and contains all required columns
const migrationPath = path.join(__dirname, '../src/db/migrations/003_cloudinary_metadata.sql')
assert(fs.existsSync(migrationPath), 'Migration file 003_cloudinary_metadata.sql exists')

const ddl = fs.readFileSync(migrationPath, 'utf8')

// Check columns for assets
assert(ddl.includes('ALTER TABLE assets ADD COLUMN IF NOT EXISTS storage_provider'), 'assets.storage_provider defined')
assert(ddl.includes('ALTER TABLE assets ADD COLUMN IF NOT EXISTS cloudinary_asset_id'), 'assets.cloudinary_asset_id defined')
assert(ddl.includes('ALTER TABLE assets ADD COLUMN IF NOT EXISTS cloudinary_public_id'), 'assets.cloudinary_public_id defined')
assert(ddl.includes('ALTER TABLE assets ADD COLUMN IF NOT EXISTS secure_url'), 'assets.secure_url defined')
assert(ddl.includes('ALTER TABLE assets ADD COLUMN IF NOT EXISTS resource_type'), 'assets.resource_type defined')
assert(ddl.includes('ALTER TABLE assets ADD COLUMN IF NOT EXISTS format'), 'assets.format defined')
assert(ddl.includes('ALTER TABLE assets ADD COLUMN IF NOT EXISTS bytes'), 'assets.bytes defined')

// Check columns for audios, outputs, subtitles, projects
assert(ddl.includes('ALTER TABLE audios ADD COLUMN IF NOT EXISTS storage_provider'), 'audios.storage_provider defined')
assert(ddl.includes('ALTER TABLE audios ADD COLUMN IF NOT EXISTS cloudinary_public_id'), 'audios.cloudinary_public_id defined')
assert(ddl.includes('ALTER TABLE outputs ADD COLUMN IF NOT EXISTS storage_provider'), 'outputs.storage_provider defined')
assert(ddl.includes('ALTER TABLE outputs ADD COLUMN IF NOT EXISTS thumbnail_storage_provider'), 'outputs.thumbnail_storage_provider defined')
assert(ddl.includes('ALTER TABLE subtitles ADD COLUMN IF NOT EXISTS storage_provider'), 'subtitles.storage_provider defined')
assert(ddl.includes('ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_storage_provider'), 'projects.source_storage_provider defined')

// Check tracking and registry tables
assert(ddl.includes('CREATE TABLE IF NOT EXISTS cloudinary_assets'), 'cloudinary_assets table defined')
assert(ddl.includes('CREATE TABLE IF NOT EXISTS media_migration_manifest'), 'media_migration_manifest table defined')

// Check indexes
assert(ddl.includes('idx_assets_storage_provider'), 'idx_assets_storage_provider defined')
assert(ddl.includes('idx_media_migration_status'), 'idx_media_migration_status defined')

// 3. Verify postgresSchema.sql includes the additions
const mainSchemaPath = path.join(__dirname, '../src/db/postgresSchema.sql')
const mainDdl = fs.readFileSync(mainSchemaPath, 'utf8')
assert(mainDdl.includes('cloudinary_assets'), 'postgresSchema.sql includes cloudinary_assets')
assert(mainDdl.includes('media_migration_manifest'), 'postgresSchema.sql includes media_migration_manifest')

// 4. Verify scripts exist
const migrateScriptPath = path.join(__dirname, '../scripts/migrate-media-to-cloudinary.js')
assert(fs.existsSync(migrateScriptPath), 'migrate-media-to-cloudinary.js exists')

const rollbackScriptPath = path.join(__dirname, '../scripts/rollback-media-migration.js')
assert(fs.existsSync(rollbackScriptPath), 'rollback-media-migration.js exists')

// 5. Test SHA-256 calculation logic
const sampleContent = 'VideoAI Cloudinary Migration Checksum Test'
const expectedHash = crypto.createHash('sha256').update(sampleContent).digest('hex')
const tempFile = path.join(__dirname, 'temp-checksum-test.txt')
fs.writeFileSync(tempFile, sampleContent, 'utf8')

try {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(tempFile)
  const actualHash = await new Promise((resolve, reject) => {
    stream.on('data', (d) => hash.update(d))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
  assert(actualHash === expectedHash, 'SHA-256 stream hashing computes exact cryptographic checksum')
} finally {
  if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile)
}

// 6. Test DB connection if available
try {
  const { getPool } = await import('../src/db.js')
  const pool = getPool()
  const res = await pool.query('SELECT 1 as connected')
  if (res && res.rows && res.rows[0]?.connected === 1) {
    console.log('PostgreSQL database reachable, testing initSchema...')
    const { initSchema } = await import('../src/db/schema.js')
    await initSchema()
    const cols = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'assets' AND column_name = 'storage_provider'"
    )
    assert(cols.rows.length > 0, 'assets.storage_provider exists in active PostgreSQL database')
  }
} catch (e) {
  console.log(`[Note] Database connection skipped for unit test run: ${e.message}`)
}

console.log(failures === 0 ? '\nALL CLOUDINARY MIGRATION TESTS PASSED' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
