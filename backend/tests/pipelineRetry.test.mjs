// Pipeline state machine: TRANSIENT -> retry (bounded), VALIDATION -> fail-fast,
// PERMANENT/CONFIGURATION -> failed, never skip predecessors, restart resumable.
// Run: node backend/tests/pipelineRetry.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { RETRY_POLICY, isValidationError, describeFailure } = await import('../src/pipeline/runner.js')
const { classifyProviderError } = await import('../src/lib/providerErrors.js')
const { firstRunnableStage } = await import('../src/pipeline/context.js')
const { findDuplicateGroups } = await import('../src/pipeline/stages/dubMerge.js')

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

// 1. RETRY_POLICY is wired (bounded backoff per stage — no endless retry).
assert(RETRY_POLICY['dub.ttsAlign']?.maxRetries === 3, 'ttsAlign maxRetries=3')
assert(RETRY_POLICY['dub.render']?.maxRetries === 2, 'render maxRetries=2')
assert(RETRY_POLICY['dub.translate']?.maxRetries === 3, 'translate maxRetries=3')
assert(Array.isArray(RETRY_POLICY['dub.ttsAlign']?.backoffMs), 'ttsAlign has backoff schedule')

// 2. Failure categories (TRANSIENT retryable, others fail fast).
{
  const t = classifyProviderError(Object.assign(new Error('Gemini HTTP 503'), { status: 503 }))
  assert(t.kind === 'TRANSIENT' && t.retryable === true, '503 -> TRANSIENT retryable')
  const p = classifyProviderError(Object.assign(new Error('invalid api key'), { status: 401 }))
  assert(p.retryable === false, '401 -> non-retryable')
  const c = classifyProviderError(new Error('Google Translate HTTP 404'))
  assert(c.retryable === false, '404 -> non-retryable configuration')
  assert(isValidationError(new Error('BLOCK_RENDER: MISSING_TTS_AUDIO')) === true, 'BLOCK_RENDER is validation')
  assert(isValidationError(new Error('TRANSLATE_NEEDS_REVIEW: incomplete')) === true, 'NEEDS_REVIEW is validation')
  assert(isValidationError(new Error('fetch failed: timeout')) === false, 'timeout is not validation')
}

// 3. describeFailure observability contract (category/provider/retryable).
{
  const d1 = describeFailure(new Error('BLOCK_RENDER: x'), 'dub.render')
  assert(d1.category === 'VALIDATION' && d1.retryable === false && d1.provider === 'ffmpeg', 'validation described')
  const d2 = describeFailure(Object.assign(new Error('overloaded'), { status: 503 }), 'dub.translate')
  assert(d2.category === 'TRANSIENT' && d2.retryable === true && d2.provider === 'llm', 'transient described with provider')
  const d3 = describeFailure(Object.assign(new Error('bad key'), { status: 401 }), 'dub.ttsAlign')
  assert(d3.retryable === false && d3.provider === 'tts', 'permanent described with provider')
}

// 4. Runner wires the policy (transient -> retry/waiting, validation fail-fast).
{
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pipeline', 'runner.js'), 'utf8')
  assert(src.includes('RETRY_POLICY[job.type]'), 'executeStage reads RETRY_POLICY')
  assert(src.includes("status: 'retry'") && src.includes("step: 'transient'"), 'transient parks as retry')
  assert(src.includes('firstRunnableStage'), 'runner clamps resume to earliest incomplete')
  assert(src.includes('Clamped resume'), 'resume clamp is observable')
  assert(src.includes('safeAddNotify'), 'notifications isolated via safeAddNotify')
  assert(src.includes('projectId') && src.includes('category=') && src.includes('retryable='), 'failures log project/stage/category/retryable')
  assert(src.includes('updateGenerationJobOwned'), 'stage job updates are fenced by run ownership')
  assert(src.includes("error.code = 'RUN_ABORTED'"), 'lost run ownership is treated as an abort')
}

// 5. Never skip an incomplete predecessor (redub clamp scenario).
{
  const DUB = ['dub.ingest', 'dub.stt', 'dub.merge', 'dub.translate', 'dub.ttsAlign', 'dub.render']
  const J = (type, status) => ({ type, status, next_retry_at: null })
  const jobs = [
    J('dub.ingest', 'success'), J('dub.stt', 'success'), J('dub.merge', 'success'),
    J('dub.translate', 'failed'), J('dub.ttsAlign', 'pending'), J('dub.render', 'failed'),
  ]
  const r = firstRunnableStage(DUB, jobs)
  assert(r.type === 'dub.translate', `forced ttsAlign clamps to translate (got ${r.type})`)
}

// 6. Restart recovery is resumable (queued + artifacts preserved, never stuck running)
// via the single shared service (server boot + periodic drain call the same
// recoverStaleProjects — no divergent SQL copies).
{
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
  assert(serverSrc.includes('recoverStaleProjects'), 'boot uses shared recovery service')
  assert(!serverSrc.match(/UPDATE projects SET status = 'failed' WHERE id = \?/), 'boot no longer terminal-fails stale projects')
  const drainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'queue', 'workers', 'drainQueued.js'), 'utf8')
  assert(drainSrc.includes('recoverStaleProjects'), 'drain uses shared recovery service')
  const recSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pipeline', 'recovery.js'), 'utf8')
  assert(recSrc.includes('status = ?') && recSrc.includes('run_token = ?'), 'shared service parks stale running as queued')
  assert(recSrc.includes('status = ?') && recSrc.includes('tokenPredicate'), 'shared service recovery is conditional (idempotent)')
}

// 7. Strict render gates preserved (BLOCK_RENDER, 1:1 audio, no fallback).
{
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const renderSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pipeline', 'stages', 'dubRender.js'), 'utf8')
  assert(renderSrc.includes('BLOCK_RENDER'), 'dubRender keeps BLOCK_RENDER')
  assert(renderSrc.includes('MISSING_TTS_AUDIO'), 'dubRender keeps missing-audio block')
  assert(!renderSrc.toLowerCase().includes('fallback to original') || renderSrc.includes('fallbackToOriginal = 0'), 'no original-voice fallback when dubbing')
  const mergeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pipeline', 'stages', 'dubMerge.js'), 'utf8')
  assert(mergeSrc.includes('MISSING_TTS_AUDIO') && mergeSrc.includes('DUPLICATE_AUDIO'), 'validateForRender keeps TTS 1:1 gates')
  assert(mergeSrc.includes('OVERLAP') || mergeSrc.includes('TIMELINE_OVERLAP'), 'overlap gate preserved')
}

// 8. Deduplication stays exact (verbatim trim + <1.0s gap), no fuzzy merge.
{
  const segs = [
    { id: 'a', text: 'Hello world', start_sec: 0, end_sec: 1 },
    { id: 'b', text: 'Hello world', start_sec: 1.2, end_sec: 2 },
    { id: 'c', text: 'Hello world?', start_sec: 2.1, end_sec: 3 },
  ]
  const groups = findDuplicateGroups(segs)
  assert(groups.length === 1 && groups[0].length === 2, 'verbatim adjacent dup grouped')
  assert(!groups[0].some((s) => s.id === 'c'), 'punctuation variant not merged')
}

// 9. Pipeline stages fence direct artifact writes.
{
  const stageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pipeline', 'stages')
  const ingestSrc = fs.readFileSync(path.join(stageRoot, 'dubIngest.js'), 'utf8')
  const translateSrc = fs.readFileSync(path.join(stageRoot, 'dubTranslate.js'), 'utf8')
  const ttsSrc = fs.readFileSync(path.join(stageRoot, 'dubTtsAlign.js'), 'utf8')
  const summarySrc = fs.readFileSync(path.join(stageRoot, 'summaryRender.js'), 'utf8')
  assert(ingestSrc.includes('updateProjectOwned'), 'dub.ingest fences project metadata writes')
  assert(translateSrc.includes('withTransaction') && translateSrc.includes('writeSrt(project, cues, runToken, transcriptVersion)'), 'dub.translate fences SRT writes')
  assert(translateSrc.includes("reason: 'revision'") && translateSrc.includes('TRANSCRIPT_CHANGED_DURING_TRANSLATE'), 'SRT revision races are retryable')
  const fencedReviewCalls = (translateSrc.match(/\}\), runToken\)/g) || []).length
  assert(fencedReviewCalls === 3, 'all translate review diagnostics carry run ownership')
  assert(ttsSrc.includes('isProjectRunOwned') && ttsSrc.includes('runProjectOwned'), 'dub.ttsAlign fences audio rows')
  assert(summarySrc.includes('isProjectRunOwned'), 'summary render checks run ownership')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
