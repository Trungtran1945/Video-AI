// Production seed guard (Issue L, decision 4.A):
// - production without ADMIN_PASSWORD → skip (no predictable default admin)
// - production with weak ADMIN_PASSWORD → throw (fail fast)
// - production with strong ADMIN_PASSWORD → create with that email
// - dev/test keep documented fallback admin@asf.local/admin1234
// Run: node backend/tests/seedProductionGuard.test.mjs
const { resolveAdminSeed } = await import('../src/db/seed.js')

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

// 1) production, no password → skip, no predictable credential materialized
{
  const d = resolveAdminSeed({ nodeEnv: 'production', adminEmail: undefined, adminPassword: undefined })
  assert(d.action === 'skip', 'production without ADMIN_PASSWORD skips admin seed')
  assert(!('password' in d) || d.password == null, 'skip decision carries no password')
}

// 2) production, weak password → throw
{
  let threw = false
  try {
    resolveAdminSeed({ nodeEnv: 'production', adminEmail: 'ops@example.com', adminPassword: 'short' })
  } catch (e) {
    threw = /too weak|FATAL/.test(e?.message || '')
  }
  assert(threw, 'production weak ADMIN_PASSWORD throws fail-fast')
}

// 3) production, strong password → create with provided email
{
  const strong = 'correct-horse-battery-staple-99!'
  const d = resolveAdminSeed({ nodeEnv: 'production', adminEmail: 'ops@example.com', adminPassword: strong })
  assert(d.action === 'create' && d.email === 'ops@example.com' && d.password === strong,
    'production strong ADMIN_PASSWORD creates env-specified admin')
}

// 4) dev/test keep fallback (local setup not broken)
{
  const d = resolveAdminSeed({ nodeEnv: 'development', adminEmail: undefined, adminPassword: undefined })
  assert(d.action === 'create' && d.email === 'admin@asf.local' && d.password === 'admin1234',
    'development keeps documented fallback')
  const t = resolveAdminSeed({ nodeEnv: 'test', adminEmail: undefined, adminPassword: undefined })
  assert(t.action === 'create', 'test keeps fallback')
}

// 5) seed.js never hardcodes the fallback outside the non-production branch
{
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'seed.js'), 'utf8')
  assert(src.includes('resolveAdminSeed'), 'seed.js exposes resolveAdminSeed')
  assert(src.includes("nodeEnv === 'production'"), 'seed.js branches on production')
  assert(!/password:\s*['"]admin1234['"]/.test(src), 'admin1234 never used as a literal password value')
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS')
process.exit(failures === 0 ? 0 : 1)
