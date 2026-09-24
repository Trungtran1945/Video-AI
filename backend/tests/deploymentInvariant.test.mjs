import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
let failures = 0
const assert = (condition, message) => {
  if (condition) console.log('PASS:', message)
  else {
    failures += 1
    console.error('FAIL:', message)
  }
}

const compose = fs.readFileSync(path.join(root, '..', 'docker-compose.yml'), 'utf8')
assert(compose.includes('DB_PATH=/app/data/data.db'), 'Compose persists the sql.js file inside the mounted volume')
assert(compose.includes('INSTANCE_MODE=single'), 'Compose API declares the single-writer invariant')
assert(compose.includes('INSTANCE_MODE=multi'), 'Compose scale worker is explicitly blocked from sql.js ownership')
assert(compose.includes('- scale-disabled'), 'unsafe scale worker is not in the default scale profile')
assert(compose.includes('UPLOAD_SESSION_TTL_MINUTES=${UPLOAD_SESSION_TTL_MINUTES:-60}'), 'Compose configures the upload session TTL')

const result = spawnSync(process.execPath, ['-e', "process.env.INSTANCE_MODE='multi'; import('./src/config.js')"], {
  cwd: root,
  encoding: 'utf8',
})
assert(result.status !== 0 && String(result.stderr).includes('INSTANCE_MODE=single'), 'multi-writer startup is rejected before serving')

const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8')
const drainQueue = fs.readFileSync(path.join(root, 'src', 'queue', 'drainQueue.js'), 'utf8')
const nginx = fs.readFileSync(path.join(root, '..', 'docker', 'nginx.conf'), 'utf8')
const apiDockerfile = fs.readFileSync(path.join(root, '..', 'docker', 'api.Dockerfile'), 'utf8')
assert(server.includes('safeAddDrainSweep'), 'server schedules queued-project draining')
assert(server.includes('resumableUploadService.recoverUploadSessions()'), 'server recovers completing uploads before listening')
assert(server.includes('createSafeMediaStatic'), 'server uses filtered media serving')
assert(drainQueue.includes("every: 5000"), 'queued-project drain has a bounded repeat interval')
assert(nginx.includes('client_max_body_size 4100m') && nginx.includes('proxy_request_buffering off') && nginx.includes('proxy_read_timeout 7200s'), 'Nginx admits 4GiB multipart overhead and long upload processing without prebuffering')
assert(!/\|\| true/.test(apiDockerfile), 'API image build does not mask a missing build command')

const ttlConfig = spawnSync(process.execPath, ['-e', "import('./src/config.js').then(({ config }) => console.log(config.uploadSessionTtlMinutes))"], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, UPLOAD_SESSION_TTL_MINUTES: '17', INSTANCE_MODE: 'single', NODE_ENV: 'test' },
})
assert(ttlConfig.status === 0 && String(ttlConfig.stdout).trim().endsWith('17'), 'upload session TTL is configurable')

const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-single-writer-'))
const dbPath = path.join(dbRoot, 'data.db')
const readyPath = path.join(dbRoot, 'ready')
const firstWriterCode = `import { getDb } from './src/db.js'; import fs from 'node:fs'; await getDb(); fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready'); setTimeout(() => {}, 1500);`
const firstWriter = spawn(process.execPath, ['-e', firstWriterCode], {
  cwd: root,
  env: { ...process.env, DB_PATH: dbPath, INSTANCE_MODE: 'single', NODE_ENV: 'test' },
  stdio: 'ignore',
})
const waitForReady = async () => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (fs.existsSync(readyPath)) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}
assert(await waitForReady(), 'first sql.js process acquires the writer lock')
const secondWriter = spawnSync(process.execPath, ['-e', "import('./src/db.js').then(({ getDb }) => getDb()).then(() => process.exit(2)).catch(() => process.exit(0))"], {
  cwd: root,
  env: { ...process.env, DB_PATH: dbPath, INSTANCE_MODE: 'single', NODE_ENV: 'test' },
  encoding: 'utf8',
})
assert(secondWriter.status === 0, 'second sql.js process is rejected by the writer lock')
firstWriter.kill()
await new Promise((resolve) => setTimeout(resolve, 1100))
const restartedWriter = spawnSync(process.execPath, ['-e', "import('./src/db.js').then(({ getDb }) => getDb()).then(() => process.exit(0)).catch(() => process.exit(1))"], {
  cwd: root,
  env: { ...process.env, DB_PATH: dbPath, INSTANCE_MODE: 'single', NODE_ENV: 'test' },
  encoding: 'utf8',
})
assert(restartedWriter.status === 0, 'a killed single writer can be restarted after stale-lock recovery')

const malformedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-malformed-lock-'))
const malformedDb = path.join(malformedRoot, 'data.db')
fs.writeFileSync(`${malformedDb}.writer.lock`, '{broken', 'utf8')
await new Promise((resolve) => setTimeout(resolve, 1100))
const malformedWriter = spawnSync(process.execPath, ['-e', "import('./src/db.js').then(({ getDb }) => getDb()).then(() => process.exit(0)).catch(() => process.exit(1))"], {
  cwd: root,
  env: { ...process.env, DB_PATH: malformedDb, INSTANCE_MODE: 'single', NODE_ENV: 'test' },
  encoding: 'utf8',
})
assert(malformedWriter.status === 0, 'a stale malformed writer lock can be recovered')

const foreignRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-foreign-lock-'))
const foreignDb = path.join(foreignRoot, 'data.db')
const foreignLock = `${foreignDb}.writer.lock`
fs.writeFileSync(foreignLock, JSON.stringify({ pid: 999999, hostname: 'old-container', startedAt: '2000-01-01T00:00:00.000Z' }))
const oldLockTime = new Date(Date.now() - 10 * 60 * 1000)
fs.utimesSync(foreignLock, oldLockTime, oldLockTime)
const foreignWriter = spawnSync(process.execPath, ['-e', "import('./src/db.js').then(({ getDb }) => getDb()).then(() => process.exit(0)).catch(() => process.exit(1))"], {
  cwd: root,
  env: { ...process.env, DB_PATH: foreignDb, INSTANCE_MODE: 'single', NODE_ENV: 'test' },
  encoding: 'utf8',
})
assert(foreignWriter.status === 0, 'a stale writer lock from a replaced container can be recovered')
fs.rmSync(foreignRoot, { recursive: true, force: true })

const persistenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-persistence-recovery-'))
const persistenceDb = path.join(persistenceRoot, 'data.db')
const saveWriter = spawnSync(process.execPath, ['-e', "import('./src/db.js').then(async ({ getDb, save }) => { await getDb(); save(); process.exit(0) }).catch(() => process.exit(1))"], {
  cwd: root,
  env: { ...process.env, DB_PATH: persistenceDb, INSTANCE_MODE: 'single', NODE_ENV: 'test' },
  encoding: 'utf8',
})
assert(saveWriter.status === 0 && fs.existsSync(persistenceDb), 'writer creates the persisted database')
const persistenceBackup = `${persistenceDb}.backup`
fs.renameSync(persistenceDb, persistenceBackup)
const restoreWriter = spawnSync(process.execPath, ['-e', "import('./src/db.js').then(({ getDb }) => getDb()).then(() => process.exit(0)).catch(() => process.exit(1))"], {
  cwd: root,
  env: { ...process.env, DB_PATH: persistenceDb, INSTANCE_MODE: 'single', NODE_ENV: 'test' },
  encoding: 'utf8',
})
assert(restoreWriter.status === 0 && fs.existsSync(persistenceDb) && !fs.existsSync(persistenceBackup), 'startup restores a recoverable database backup')
fs.rmSync(dbRoot, { recursive: true, force: true })
fs.rmSync(malformedRoot, { recursive: true, force: true })
fs.rmSync(persistenceRoot, { recursive: true, force: true })

if (failures > 0) process.exit(1)
console.log('ALL PASS')
