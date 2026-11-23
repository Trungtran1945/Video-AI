import fs from 'fs';
import path from 'path';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: 'backend/.env' });

async function verifyAll() {
  const report = {};

  // 1. Check package.json & package-lock.json
  const pkg = JSON.parse(fs.readFileSync('backend/package.json', 'utf8'));
  const lock = fs.readFileSync('backend/package-lock.json', 'utf8');
  report.sqlJsInPackageJson = Boolean(pkg.dependencies?.['sql.js'] || pkg.devDependencies?.['sql.js']);
  report.sqlJsInPackageLock = lock.includes('"sql.js"') || lock.includes('node_modules/sql.js');

  // 2. Scan backend/src for sql.js, FORCE_SQLITE, DB_PATH
  const searchPatterns = ['sql.js', 'FORCE_SQLITE', 'DB_PATH'];
  const srcHits = { 'sql.js': [], 'FORCE_SQLITE': [], 'DB_PATH': [] };

  function scanDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(full);
      } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.sql'))) {
        const text = fs.readFileSync(full, 'utf8');
        for (const pat of searchPatterns) {
          if (text.includes(pat)) {
            srcHits[pat].push(full);
          }
        }
      }
    }
  }
  scanDir('backend/src');
  report.srcHits = srcHits;

  // 3. Scan root & backend env files
  const envFiles = [
    'backend/.env.example',
    'backend/.env.production.example',
    '.env.example',
    '.env.production.example',
    'docker-compose.yml',
    'docker/api.Dockerfile'
  ];
  const envHits = {};
  for (const ef of envFiles) {
    if (fs.existsSync(ef)) {
      const content = fs.readFileSync(ef, 'utf8');
      envHits[ef] = {
        hasDbPath: content.includes('DB_PATH'),
        hasForceSqlite: content.includes('FORCE_SQLITE'),
        hasSqlJs: content.includes('sql.js'),
        hasDbDataVolume: content.includes('db_data')
      };
    }
  }
  report.envHits = envHits;

  // 4. Check PostgreSQL database connectivity & schema
  const dbUrl = process.env.DATABASE_URL || 'postgresql://video_ai_user:video_ai_pass@localhost:5433/video_ai';
  const pool = new pg.Pool({ connectionString: dbUrl });
  try {
    const tablesRes = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"
    );
    report.tableCount = tablesRes.rows.length;
    report.tables = tablesRes.rows.map(r => r.table_name);

    const indexesRes = await pool.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'"
    );
    report.indexCount = indexesRes.rows.length;

    const fkRes = await pool.query(`
      SELECT tc.constraint_name, tc.table_name, kcu.column_name, ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name 
      FROM information_schema.table_constraints AS tc 
      JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name 
      JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name 
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema='public';
    `);
    report.foreignKeyCount = fkRes.rows.length;

    const seqRes = await pool.query("SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public'");
    report.sequenceCount = seqRes.rows.length;

    // Count rows across all tables
    let totalRows = 0;
    const rowCounts = {};
    for (const t of report.tables) {
      const cntRes = await pool.query(`SELECT COUNT(*) AS c FROM "${t}"`);
      const c = parseInt(cntRes.rows[0].c, 10);
      rowCounts[t] = c;
      totalRows += c;
    }
    report.rowCounts = rowCounts;
    report.totalRows = totalRows;

    // Check migrations table
    const migRes = await pool.query("SELECT * FROM schema_migrations");
    report.appliedMigrations = migRes.rows;

  } finally {
    await pool.end();
  }

  console.log(JSON.stringify(report, null, 2));
}

verifyAll().catch(err => {
  console.error('Verification error:', err);
  process.exit(1);
});
