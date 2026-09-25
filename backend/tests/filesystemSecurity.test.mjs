// Filesystem security: canonical containment (path.relative, never
// startsWith(root)), traversal/sibling-prefix rejection, choke-proof storage id
// segments, and the clearArtifacts/cleanup deletion fences.
// Run: node backend/tests/filesystemSecurity.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-fs-security-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')

const { isPathInside, resolveSafePath, UnsafeStoragePathError } = await import('../src/lib/safePath.js')
const { resolveStorageKey, toStorageKey, projectDir, tmpDirOf } = await import('../src/pipeline/context.js')

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const storage = path.resolve(process.env.STORAGE_DIR)

// 1. isPathInside — canonical rules
assert(isPathInside(storage, path.join(storage, 'uploads', 'a.mp4')) === true, 'file inside root is inside')
assert(isPathInside(storage, storage) === false, 'root itself is not inside by default')
assert(isPathInside(storage, storage, { allowRoot: true }) === true, 'allowRoot admits the root itself')
assert(isPathInside('/app/storage', '/app/storage_backup/x') === false, 'sibling-prefix escape rejected (storage vs storage_backup)')
assert(isPathInside('/app/storage', '/app/storage2/x') === false, 'common-prefix sibling rejected')
assert(isPathInside(storage, path.join(storage, '..', '..', 'etc', 'passwd')) === false, '../ traversal rejected')
assert(isPathInside(storage, '/etc/passwd') === false, 'absolute external path rejected')

// 2. resolveSafePath — unsafe input returns null, never an outside path
assert(resolveSafePath(storage, 'uploads/a.mp4') === path.join(storage, 'uploads', 'a.mp4'), 'safe relative key resolves inside')
assert(resolveSafePath(storage, '../evil') === null, 'traversal returns null')
assert(resolveSafePath(storage, '/etc/passwd') === null, 'absolute external returns null')
assert(resolveSafePath(storage, '../storage_backup/x') === null, 'sibling-prefix key returns null')
assert(resolveSafePath(storage, '') === null, 'empty key returns null')
assert(resolveSafePath(storage, null) === null, 'non-string key returns null')

// 3. Storage key conversion helpers
const insideKey = resolveStorageKey('projects/p1/final.mp4')
assert(insideKey !== null && isPathInside(storage, insideKey), 'resolveStorageKey keeps normal keys inside storage')
assert(resolveStorageKey('../secrets.txt') === null, 'resolveStorageKey rejects traversal key')
assert(resolveStorageKey('/etc/passwd') === null, 'resolveStorageKey rejects absolute key')
assert(toStorageKey(path.join(storage, 'outputs', 'v.mp4')) === 'outputs/v.mp4', 'toStorageKey returns relative key for inside path')
let threw = null
try { toStorageKey(path.join(tmpRoot, 'outside.mp4')) } catch (e) { threw = e }
assert(threw instanceof UnsafeStoragePathError, 'toStorageKey throws UnsafeStoragePathError outside storage root')
assert(!String(threw?.message || '').includes('..'), 'toStorageKey error message never carries a path')

// 4. Choke guard: recursive-delete roots reject ids that could escape
assert(isPathInside(path.join(storage, 'projects'), projectDir('p-ok')) === true, 'projectDir stays in storage/projects')
assert(isPathInside(path.join(storage, 'tmp'), tmpDirOf('p-ok')) === true, 'tmpDirOf stays in storage/tmp')
for (const badId of ['..', '.', 'a/b', 'a\\b', '/abs', '']) {
  let projectThrew = false
  try { projectDir(badId) } catch (_) { projectThrew = true }
  assert(projectThrew, `projectDir rejects id ${JSON.stringify(badId)}`)
  let tmpThrew = false
  try { tmpDirOf(badId) } catch (_) { tmpThrew = true }
  assert(tmpThrew, `tmpDirOf rejects id ${JSON.stringify(badId)}`)
}

// 5. clearArtifacts ownership: the old startsWith(dir) bug deleted sibling
//    project artifacts (abc vs abc2) — containment fence must not.
const siblingDir = path.join(storage, 'projects', 'abc')
const siblingFile = path.join(storage, 'projects', 'abc2', 'artifact.wav')
assert(siblingFile.startsWith(siblingDir) === true, 'regression setup: old startsWith pattern admits the sibling file')
assert(isPathInside(siblingDir, siblingFile) === false, 'containment fence rejects the sibling project file')

const readSrc = (parts) => fs.readFileSync(path.join(__dirname, '..', 'src', ...parts), 'utf8')
const runnerSrc = readSrc(['pipeline', 'runner.js'])
assert(runnerSrc.includes('isPathInside(dir, abs)'), 'clearArtifacts audio deletion is containment-fenced')
assert(runnerSrc.includes('isPathInside(outputsRoot, abs)'), 'clearArtifacts output deletion only touches storage/outputs')
assert(!runnerSrc.includes('abs.startsWith(dir)'), 'clearArtifacts never uses startsWith for deletion')

// 6. Legacy relative-.. checks swapped to the canonical helper
const staticSrc = readSrc(['middleware', 'safeMediaStatic.js'])
assert(staticSrc.includes('isPathInside(root, absolute)'), 'safeMediaStatic uses canonical containment')
assert(!staticSrc.includes("startsWith('..')"), 'safeMediaStatic drops the relative .. check')
const uploadServiceSrc = readSrc(['services', 'resumableUploadService.js'])
assert(uploadServiceSrc.includes('return isPathInside(root, target)'), 'resumable upload containedPath uses canonical containment')
assert(!uploadServiceSrc.includes("startsWith('..')"), 'resumable upload drops the relative .. check')
const uploadRouteSrc = readSrc(['routes', 'v1', 'upload.js'])
assert(uploadRouteSrc.includes('isPathInside(config.storageDir, finalPath)'), 'legacy upload final path uses canonical containment')
assert(!uploadRouteSrc.includes("relative.startsWith('..')"), 'legacy upload drops the relative .. check')

// 7. Recursive deletes are trusted-root fenced
const cleanupSrc = readSrc(['services', 'projectCleanup.js'])
assert(cleanupSrc.includes('isPathInside(config.storageDir, dir)'), 'project cleanup refuses directories outside storage')
const workerSrc = readSrc(['queue', 'workers', 'cleanupWorker.js'])
assert(workerSrc.includes("isPathInside(path.join(config.storageDir, 'projects'), dir)"), 'cleanup worker only prunes storage/projects')
assert(workerSrc.includes('isPathInside(tmpRoot, dirPath)'), 'cleanup worker tmp sweep refuses entries outside tmpRoot')

fs.rmSync(tmpRoot, { recursive: true, force: true })
if (failures > 0) process.exit(1)
console.log('ALL PASS')
