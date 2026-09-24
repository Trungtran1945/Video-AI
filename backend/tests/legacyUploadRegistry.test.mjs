import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let registry = null
try {
  registry = await import('../src/services/legacyUploadRegistry.js')
} catch (_) {}

let failures = 0
function assert(condition, message) {
  if (condition) console.log('PASS:', message)
  else {
    failures += 1
    console.error('FAIL:', message)
  }
}

assert(Boolean(registry?.cleanupLegacyUploads), 'legacy upload registry is available')
if (!registry?.cleanupLegacyUploads) process.exit(1)

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-legacy-registry-'))
const active = path.join(root, 'active.upload')
const stale = path.join(root, 'stale.upload')
const fresh = path.join(root, 'fresh.upload')
for (const filePath of [active, stale, fresh]) fs.writeFileSync(filePath, 'partial')
const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
fs.utimesSync(active, old, old)
fs.utimesSync(stale, old, old)
registry.markLegacyUploadActive(active)

const result = await registry.cleanupLegacyUploads({ root, maxAgeMs: 7 * 24 * 60 * 60 * 1000 })
assert(result.cleaned === 1, 'legacy cleanup removes one inactive stale staging file')
assert(fs.existsSync(active), 'legacy cleanup never removes an active multipart file')
assert(!fs.existsSync(stale), 'legacy cleanup removes the inactive stale staging file')
assert(fs.existsSync(fresh), 'legacy cleanup preserves fresh staging files')

registry.releaseLegacyUpload(active)
const afterRelease = await registry.cleanupLegacyUploads({ root, maxAgeMs: 0 })
assert(afterRelease.cleaned === 2 && !fs.existsSync(active), 'released stale staging becomes collectible')

const raceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-legacy-race-'))
const disappearing = path.join(raceRoot, 'disappearing.upload')
const removable = path.join(raceRoot, 'removable.upload')
fs.writeFileSync(disappearing, 'gone')
fs.writeFileSync(removable, 'old')
fs.utimesSync(removable, new Date(0), new Date(0))
const raceFs = {
  ...fs,
  promises: {
    ...fs.promises,
    async lstat(filePath) {
      if (String(filePath) === disappearing) {
        const error = new Error('missing')
        error.code = 'ENOENT'
        throw error
      }
      return fs.promises.lstat(filePath)
    },
  },
}
const raceResult = await registry.cleanupLegacyUploads({ root: raceRoot, fileSystem: raceFs, maxAgeMs: 0 })
assert(raceResult.cleaned === 1 && !fs.existsSync(removable), 'legacy cleanup tolerates a file disappearing after readdir')

const symlinkRootCalls = { readdir: 0 }
const symlinkRootFs = {
  ...fs,
  promises: {
    ...fs.promises,
    async readdir(...args) {
      symlinkRootCalls.readdir += 1
      return fs.promises.readdir(...args)
    },
    async lstat(filePath) {
      if (String(filePath).endsWith(`${path.sep}tmp`)) {
        return { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => true }
      }
      return fs.promises.lstat(filePath)
    },
  },
}
const protectedResult = await registry.cleanupLegacyUploads({
  root: path.join(root, 'tmp', 'legacy_uploads'),
  trustedRoot: root,
  fileSystem: symlinkRootFs,
})
assert(protectedResult.skipped === 1 && symlinkRootCalls.readdir === 0, 'legacy cleanup rejects a symlinked tmp ancestor before scanning')

fs.rmSync(raceRoot, { recursive: true, force: true })
fs.rmSync(root, { recursive: true, force: true })
if (failures > 0) process.exit(1)
console.log('ALL PASS')
