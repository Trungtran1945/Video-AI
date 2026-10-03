// Translation QA: deterministic guards + best-effort AI judge (TransFlow-inspired).
// Phase 1 = flag + block only: QA never rewrites translations. BLOCK_RENDER
// issues join the existing TRANSLATE_NEEDS_REVIEW quarantine; everything else
// is a warning surfaced in job.result for manual fix.
import { callProvider } from '../lib/callProvider.js'
import { extractJsonBlock } from './context.js'

export const QA_CHECKS = ['accuracy', 'fluency', 'terminology', 'length', 'timing']
const BLOCK_ALLOW = new Set(['BLOCK_APPROVAL', 'BLOCK_PUBLISH', 'BLOCK_RENDER'])

// Deterministic QA — pure, no I/O. Always runs, even when the LLM is down.
export function runDeterministicQa(segments, translationsById) {
  const issues = []
  const ordered = [...(segments || [])]
    .filter((s) => s.text && String(s.text).trim())
    .sort((a, b) => Number(a.start_sec) - Number(b.start_sec))
  let prevEnd = null
  for (const seg of ordered) {
    const start = Number(seg.start_sec)
    const end = Number(seg.end_sec)
    const tgt = translationsById?.get(seg.id)
    if (!(end > start)) {
      issues.push({
        segmentId: seg.id, index: seg.index_num, type: 'invalid_timing',
        severity: 'critical', message: `invalid timing (start ${start} >= end ${end})`,
        blockingActions: ['BLOCK_RENDER'],
      })
    }
    if (prevEnd !== null && Number.isFinite(start) && start < prevEnd) {
      issues.push({
        segmentId: seg.id, index: seg.index_num, type: 'subtitle_overlap',
        severity: 'critical', message: `subtitle overlaps previous cue (starts ${start}s before prev ends ${prevEnd}s)`,
        blockingActions: ['BLOCK_RENDER'],
      })
    }
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && typeof tgt === 'string' && tgt.trim()) {
      const dur = end - start
      const cps = tgt.trim().length / dur
      // Vietnamese dubbing ~15-20 chars/sec is comfortable; >30 is unreadable.
      if (cps > 30) {
        issues.push({
          segmentId: seg.id, index: seg.index_num, type: 'length',
          severity: 'high', message: `too long for slot (${cps.toFixed(1)} chars/sec over ${dur.toFixed(1)}s)`,
          blockingActions: ['BLOCK_PUBLISH'],
        })
      }
    }
    if (Number.isFinite(end)) prevEnd = Math.max(prevEnd ?? -Infinity, end)
  }
  return issues
}

const QA_SYSTEM =
  'You are a meticulous bilingual QA editor. Review each translated subtitle line against its source. ' +
  'Report issues with type (accuracy, fluency, terminology, length, timing), severity ' +
  '(critical, high, medium, low), a message in the target language, verbatim source_span ' +
  '(max 500 chars) and target_span from the texts, a suggestion fix in the target language, ' +
  'and blocking_actions (BLOCK_APPROVAL, BLOCK_PUBLISH, BLOCK_RENDER). ' +
  'Flag wrong meaning, omissions, additions, wrong proper nouns, wrong numbers, wrong negation, ' +
  'wrong pronouns, wrong terminology, wrong target language, and lines too long for their timing. ' +
  'Return ONLY a JSON object described in <output_format>; no prose, no code fences.'

function buildQaPrompt(pairs) {
  const lines = pairs.map((p, i) =>
    `<item id="${i + 1}" index="${p.index}">\n<source>${escapeXml(p.source)}</source>\n<translation>${escapeXml(p.translation)}</translation>\n</item>`
  ).join('\n')
  return (
    `<checks>${QA_CHECKS.join(', ')}</checks>\n<pairs>\n${lines}\n</pairs>\n` +
    '<output_format>{"issues": [{"id": "<item id>", "type": "<check>", "severity": "critical|high|medium|low", ' +
    '"message": "<what/why>", "source_span": "<verbatim source>", "target_span": "<verbatim translation>", ' +
    '"suggestion": "<fix>", "blocking_actions": ["BLOCK_APPROVAL|BLOCK_PUBLISH|BLOCK_RENDER"]}], ' +
    '"score": <0..1>}</output_format>'
  )
}

function escapeXml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function normalizeBlocking(actions) {
  const out = []
  for (const a of Array.isArray(actions) ? actions : []) {
    let v = String(a || '').toUpperCase().trim()
    if (v === 'BLOCK_EXPORT') v = 'BLOCK_PUBLISH' // legacy alias
    if (BLOCK_ALLOW.has(v) && !out.includes(v)) out.push(v)
  }
  return out
}

// Best-effort AI QA. Never throws — returns null when the LLM is unavailable
// or the output is unparseable (deterministic guards still apply).
export async function runAiQa(llm, pairs, { job, projectId, userId } = {}) {
  if (!llm || !pairs?.length) return null
  const all = []
  let scoreSum = 0
  let scoreN = 0
  for (let i = 0; i < pairs.length; i += 10) {
    const chunk = pairs.slice(i, i + 10)
    let res = null
    try {
      res = await callProvider({
        provider: llm.id, type: 'llm', model: llm.provider.model || llm.id,
        input: { system: QA_SYSTEM, prompt: buildQaPrompt(chunk), json: true, temperature: 0.1, maxOutputTokens: 2048 },
        fn: () => llm.provider.complete({ system: QA_SYSTEM, prompt: buildQaPrompt(chunk), json: true, temperature: 0.1, maxOutputTokens: 2048 }),
        userId, apiKeyId: llm.apiKeyId, projectId, jobId: job?.id,
      })
    } catch (err) {
      console.warn(`[translateQa] AI QA chunk failed (best-effort): ${String(err?.message || err).slice(0, 150)}`)
      return all.length ? { issues: all, score: scoreN ? scoreSum / scoreN : null } : null
    }
    let payload = null
    try {
      const text = String(res?.text || '').replace(/^[\s\S]*?```(?:json)?\s*/i, '').replace(/```[\s\S]*$/, '').trim()
      payload = extractJsonBlock(text) || JSON.parse(text)
    } catch (_) { payload = null }
    if (!payload || typeof payload !== 'object') continue
    const raw = Array.isArray(payload.issues) ? payload.issues : []
    for (const it of raw) {
      if (!it || typeof it !== 'object') continue
      const ref = chunk[Number(it.id) - 1] || chunk[0]
      const sev = String(it.severity || 'medium').toLowerCase()
      all.push({
        segmentId: ref?.segmentId || null,
        index: ref?.index ?? null,
        type: String(it.type || 'accuracy').toLowerCase(),
        severity: ['critical', 'high', 'medium', 'low'].includes(sev) ? sev : 'medium',
        message: String(it.message || 'QA issue').slice(0, 500),
        source_span: String(it.source_span || ref?.source || '').slice(0, 500),
        target_span: String(it.target_span || ref?.translation || '').slice(0, 500),
        suggestion: String(it.suggestion || '').slice(0, 500),
        blockingActions: normalizeBlocking(it.blocking_actions || it.blockingActions),
      })
    }
    if (Number.isFinite(Number(payload.score))) {
      scoreSum += Math.max(0, Math.min(1, Number(payload.score)))
      scoreN++
    }
  }
  return { issues: all, score: scoreN ? scoreSum / scoreN : null }
}

export function blockingRenderIndexes(issues) {
  const set = new Set()
  for (const it of issues || []) {
    if ((it.blockingActions || []).includes('BLOCK_RENDER') && it.index != null) set.add(it.index)
  }
  return [...set]
}

export default { QA_CHECKS, runDeterministicQa, runAiQa, blockingRenderIndexes }
