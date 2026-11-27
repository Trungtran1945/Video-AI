import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import { createJobStagingContext, stageSourceMedia } from '../src/pipeline/mediaStaging.js'
import { StorageService } from '../src/services/storage/storageService.js'
import { createResumableUploadService } from '../src/services/resumableUploadService.js'
import { createOutput } from '../src/services/outputService.js'

let failures = 0
function assert(condition, message) {
  if (condition) {
    console.log(`PASS: ${message}`)
  } else {
    failures += 1
    console.error(`FAIL: ${message}`)
  }
}

console.log('=== Test: Media Upload, Pipeline Staging & Cloudinary Storage (Phase 5, 7, 8) ===')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-media-test-'))
const storageDir = path.join(tmpRoot, 'storage')
fs.mkdirSync(path.join(storageDir, 'uploads'), { recursive: true })
fs.mkdirSync(path.join(storageDir, 'outputs', 'thumbs'), { recursive: true })
fs.mkdirSync(path.join(storageDir, 'tmp'), { recursive: true })

// Mock DB for isolated unit testing
const mockDb = {
  data: {
    upload_sessions: new Map(),
    outputs: new Map(),
    cloudinary_assets: new Map(),
    projects: new Map(),
  },
  async queryOne(sql, params = []) {
    if (sql.includes('FROM upload_sessions WHERE id = ?')) {
      return mockDb.data.upload_sessions.get(params[0]) || null
    }
    if (sql.includes('FROM upload_sessions WHERE storage_key = ?')) {
      for (const row of mockDb.data.upload_sessions.values()) {
        if (row.storage_key === params[0]) return row
      }
      return null
    }
    if (sql.includes('FROM projects WHERE id = ?')) {
      return mockDb.data.projects.get(params[0]) || { id: params[0], mode: 'TRANSLATE_DUB', transcript_version: 0 }
    }
    if (sql.includes('FROM generation_jobs')) {
      return null
    }
    return null
  },
  async insert(table, row) {
    const id = row.id || uuidv4()
    const stored = { ...row, id }
    if (!mockDb.data[table]) mockDb.data[table] = new Map()
    mockDb.data[table].set(id, stored)
    return stored
  },
  async runAffected(sql, params = []) {
    if (sql.includes('UPDATE upload_sessions SET bytes_received =')) {
      const current = mockDb.data.upload_sessions.get(params[4])
      if (current) {
        current.bytes_received = params[0]
        mockDb.data.upload_sessions.set(params[4], current)
        return 1
      }
    }
    if (sql.includes("UPDATE upload_sessions SET status = 'completing'")) {
      const current = mockDb.data.upload_sessions.get(params[3])
      if (current) {
        current.status = 'completing'
        current.storage_key = params[0]
        current.video_hash = params[1]
        mockDb.data.upload_sessions.set(params[3], current)
        return 1
      }
    }
    if (sql.includes('UPDATE upload_sessions SET status =')) {
      const id = params.length > 5 ? params[5] : params[1]
      const current = mockDb.data.upload_sessions.get(id)
      if (current) {
        if (params.length > 5) {
          current.status = 'completed'
          current.storage_provider = params[1]
          current.cloudinary_asset_id = params[2]
          current.cloudinary_public_id = params[3]
          current.secure_url = params[4]
        } else {
          current.status = 'completed'
        }
        mockDb.data.upload_sessions.set(id, current)
        return 1
      }
      return 0
    }
    return 1
  },
  async run() {
    return { changes: 1 }
  },
}

// ── 1. Phase 7: Media Staging & Job Temporary Directory ──
console.log('\n--- 1. Media Staging Context & Job Scoped Cleanup ---')

const projectId = `proj-${uuidv4().slice(0, 8)}`
const mockStorage = {
  async downloadToTemp(keyOrUrl, destPath) {
    fs.writeFileSync(destPath, Buffer.from('downloaded-cloudinary-bytes'))
    return { destinationPath: destPath, bytes: 26 }
  },
}
const stagingCtx = createJobStagingContext(projectId, 'dub.render', { storageDir, storage: mockStorage })

assert(stagingCtx.stagingDir.includes(projectId), 'Job staging directory is scoped to project id')
assert(stagingCtx.stagingDir.includes('dub.render'), 'Job staging directory includes stage name')

// Test 1.1: Local file fast-path
const sampleLocalKey = 'uploads/sample_local.mp4'
const localAbsPath = path.join(storageDir, sampleLocalKey)
fs.writeFileSync(localAbsPath, Buffer.from('fake-mp4-content-here'))

const resolvedLocal = await stagingCtx.stageFile(sampleLocalKey)
assert(resolvedLocal === localAbsPath, 'Direct local file resolves without redundant copy or download')
assert(stagingCtx.stagedFiles.size === 0, 'Local existing file not added to ephemeral stagedFiles set')

// Test 1.2: Remote URL / Cloudinary download to temporary job directory
// Temporarily test remote staging
const remoteUrl = 'https://res.cloudinary.com/demo/video/upload/v1234/sample.mp4'
const stagedRemote = await stagingCtx.stageFile(remoteUrl, 'sample_remote.mp4')
assert(fs.existsSync(stagedRemote), 'Remote Cloudinary media successfully staged into job temporary directory')
assert(stagingCtx.stagedFiles.has(stagedRemote), 'Staged file tracked in job stagingContext')
assert(fs.readFileSync(stagedRemote, 'utf8') === 'downloaded-cloudinary-bytes', 'Staged file contains downloaded bytes')

// Test 1.3: Cleanup on completion or cancellation
await stagingCtx.cleanup()
assert(!fs.existsSync(stagedRemote), 'Staged file deleted after stagingCtx.cleanup()')
assert(!fs.existsSync(stagingCtx.stagingDir), 'Job staging directory removed completely on cleanup')

// Test 1.4: Abort signal auto-cleanup
const abortController = new AbortController()
const abortStaging = createJobStagingContext(projectId, 'dub.ingest', { storageDir, storage: mockStorage })
abortController.signal.addEventListener('abort', () => abortStaging.cleanup(), { once: true })
const abortFile = await abortStaging.stageFile(remoteUrl, 'abort_test.mp4')
assert(fs.existsSync(abortFile), 'File staged prior to abort')
abortController.abort()
await abortStaging.cleanup()
assert(!fs.existsSync(abortFile), 'AbortSignal cleans up staged file immediately upon cancellation')

// Test 1.5: stageSourceMedia helper
const projectWithLocal = {
  id: projectId,
  source_video_key: localAbsPath,
}
const stagedSrcLocal = await stageSourceMedia(projectWithLocal, { storageDir })
assert(stagedSrcLocal === localAbsPath, 'stageSourceMedia returns local path for on-disk source video')

const projectWithRemote = {
  id: projectId,
  source_video_key: 'uploads/remote_asset.mp4',
  source_secure_url: 'https://res.cloudinary.com/demo/video/upload/source.mp4',
}
const remoteStageCtx = createJobStagingContext(projectId, 'dub.stt', { storageDir, storage: mockStorage })
const stagedSrcRemote = await stageSourceMedia(projectWithRemote, { stagingContext: remoteStageCtx })
assert(fs.existsSync(stagedSrcRemote), 'stageSourceMedia downloads remote source via stagingContext')
await remoteStageCtx.cleanup()
assert(!fs.existsSync(stagedSrcRemote), 'Staged remote source cleaned up after stage finish')

// ── 2. Phase 5: Resumable Upload Completion with Storage Provider ──
console.log('\n--- 2. Resumable Upload Flow with Storage Provider ---')

const mockCloudinaryStorage = {
  async uploadLarge(filePath, options = {}) {
    return {
      provider: 'cloudinary',
      key: options.key,
      publicId: `video_ai/${options.key.replace(/\.[^.]+$/, '')}`,
      assetId: 'cld-asset-12345',
      url: `https://res.cloudinary.com/test-cloud/video/upload/${options.key}`,
      secureUrl: `https://res.cloudinary.com/test-cloud/video/upload/${options.key}`,
      resourceType: 'video',
      format: 'mp4',
      bytes: fs.statSync(filePath).size,
    }
  },
}

const resumableService = createResumableUploadService({
  storageDir,
  db: mockDb,
  storage: mockCloudinaryStorage,
  probe: async () => ({ available: true, codec: 'h264' }),
})

const testPayload = Buffer.alloc(64)
testPayload.writeUInt32BE(24, 0)
testPayload.write('ftyp', 4, 'ascii')
testPayload.write('isom', 8, 'ascii')
testPayload.write('phase5-upload', 12, 'ascii')

const session = await resumableService.createSession({
  userId: 'test-user-1',
  filename: 'my_video.mp4',
  size: testPayload.length,
  mime: 'video/mp4',
})
assert(session.uploadId, 'Upload session created')

await resumableService.appendChunk({
  id: session.uploadId,
  userId: 'test-user-1',
  offset: 0,
  chunk: testPayload,
})

const completedSession = await resumableService.complete({
  id: session.uploadId,
  userId: 'test-user-1',
})

assert(completedSession.storageKey, 'Completed upload returns storageKey')
assert(completedSession.storageProvider === 'cloudinary', 'Completed upload identifies storageProvider as cloudinary')
assert(completedSession.cloudinaryPublicId?.includes('video_ai/'), 'Completed upload populates cloudinaryPublicId')
assert(completedSession.secureUrl?.startsWith('https://res.cloudinary.com/'), 'Completed upload populates secureUrl')
assert(completedSession.url === completedSession.secureUrl, 'Completed upload response url uses secureUrl')

// ── 3. Phase 8: Rendered Outputs & DB Persistence ──
console.log('\n--- 3. Rendered Output Upload & DB Metadata ---')

const finalVideoKey = 'outputs/final_rendered.mp4'
const finalThumbKey = 'outputs/thumbs/final_thumb.jpg'
const finalVideoAbs = path.join(storageDir, finalVideoKey)
const finalThumbAbs = path.join(storageDir, finalThumbKey)
fs.writeFileSync(finalVideoAbs, Buffer.from('rendered-video-bytes'))
fs.writeFileSync(finalThumbAbs, Buffer.from('rendered-thumb-bytes'))

// Insert project into mockDb for output validation
mockDb.data.projects.set(projectId, {
  id: projectId,
  mode: 'TRANSLATE_DUB',
  transcript_version: 1,
  script_version: 0,
})

const outputId = uuidv4()
const createdOutput = await createOutput({
  id: outputId,
  projectId,
  storageKey: finalVideoKey,
  thumbnailKey: finalThumbKey,
  durationSec: 15.5,
  transcriptVersion: 1,
}, {
  queryOne: mockDb.queryOne,
  insert: mockDb.insert,
  run: mockDb.run,
  runAffected: mockDb.runAffected,
})

assert(createdOutput.id === outputId, 'Output created successfully')
assert(createdOutput.storage_key === finalVideoKey, 'Output retains canonical storage_key')
assert(createdOutput.thumbnail_key === finalThumbKey, 'Output retains thumbnail_key')
assert(createdOutput.storage_provider, 'Output records storage_provider')
assert(createdOutput.format === 'mp4', 'Output records video format')

// Cleanup tmpRoot
fs.rmSync(tmpRoot, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\nFAILED: ${failures} assertion(s) failed`)
  process.exit(1)
} else {
  console.log('\nALL MEDIA UPLOAD & PIPELINE CLOUDINARY TESTS PASSED!')
}
