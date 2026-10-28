import fs from 'node:fs'
import { listProvidersForCapability } from '../../providers/registry.js'
import { callProvider } from '../../lib/callProvider.js'
import { withProviderFailover } from '../../lib/providerFailover.js'
import {
  SCRIPT_LIMITS,
  SEGMENTATION_SYSTEM_PROMPT,
  chunkScript,
  deterministicSegments,
  validateSegments,
  parseLlmSegments,
  buildSegmentRows,
  wrapChunkForPrompt,
} from '../../services/scriptService.js'
import { requireSourceFile, insertMany } from '../context.js'

function chunkPrompt(chunk) {
  return `${SEGMENTATION_SYSTEM_PROMPT}\n\n${wrapChunkForPrompt(chunk)}`
}

async function segmentChunkWithLlm({ project, job, candidates, chunk }) {
  const prompt = chunkPrompt(chunk)
  const { result } = await withProviderFailover(
    { capability: 'LLM', candidates, maxAttempts: Math.min(4, candidates.length) },
    async (cand) => {
      const res = await callProvider({
        provider: cand.id,
        type: 'llm',
        model: cand.provider.model || cand.id,
        input: {
          system: SEGMENTATION_SYSTEM_PROMPT,
          chunk,
          schemaVersion: SCRIPT_LIMITS.schemaVersion,
        },
        fn: () => cand.provider.complete({
          system: SEGMENTATION_SYSTEM_PROMPT,
          prompt,
          json: true,
          maxOutputTokens: 8000,
        }),
        userId: project.user_id,
        apiKeyId: cand.apiKeyId,
        projectId: project.id,
        jobId: job.id,
      })
      const segments = parseLlmSegments(res)
      if (!segments) throw new Error('SCRIPT_LLM_INVALID_JSON: LLM không trả JSON segmentation hợp lệ')
      return segments
    }
  )
  return result
}

// script.analyze — verbatim segmentation through the LLM, with a deterministic
// fallback for the WHOLE script when any chunk is unusable. Coverage is checked
// before persistence, so narration can never silently lose or rewrite text.
export async function scriptAnalyze(ctx) {
  const { project, job, setProgress, signal } = ctx
  const sourceAbs = requireSourceFile(project.script_key, 'Kịch bản nguồn')
  const sourceText = fs.readFileSync(sourceAbs, 'utf8')
  if (!sourceText.trim()) throw new Error('Kịch bản rỗng — hãy upload lại kịch bản')

  if (signal?.aborted) throw new Error('Cancelled')

  const chunks = chunkScript(sourceText)
  if (!chunks.length) throw new Error('Không tách được đoạn kịch bản nào từ nội dung đã lưu')
  setProgress(5)

  let segments = null
  let warning = null
  let source = 'llm'
  try {
    const candidates = await listProvidersForCapability(project.user_id, 'llm')
    if (!candidates.length) {
      throw new Error('NO_PROVIDER_AVAILABLE: chưa cấu hình LLM provider')
    }
    const merged = []
    for (let i = 0; i < chunks.length; i++) {
      if (signal?.aborted) throw new Error('Cancelled')
      const part = await segmentChunkWithLlm({ project, job, candidates, chunk: chunks[i] })
      merged.push(...part)
      setProgress(5 + Math.round(((i + 1) / chunks.length) * 65))
    }
    const validation = validateSegments(merged, sourceText)
    if (!validation.ok) {
      warning = `LLM phân đoạn không hợp lệ (${validation.reason}) — đã dùng bộ chia nội bộ, nội dung giữ nguyên`
    } else {
      segments = validation.segments
    }
  } catch (err) {
    if (err?.message === 'Cancelled') throw err
    warning = `LLM phân đoạn thất bại (${String(err?.message || err).slice(0, 160)}) — đã dùng bộ chia nội bộ, nội dung giữ nguyên`
  }

  if (!segments) {
    source = 'fallback'
    segments = deterministicSegments(sourceText)
  }
  if (!segments.length) throw new Error('Không tạo được đoạn kịch bản nào')

  setProgress(85)
  await insertMany('script_segments', buildSegmentRows(project.id, segments))
  setProgress(98)

  return {
    segmentCount: segments.length,
    source,
    warning,
  }
}

export default scriptAnalyze
