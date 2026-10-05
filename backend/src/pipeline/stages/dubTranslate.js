import path from 'path'
import fs from 'node:fs'
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne, updateById, insert, run, withTransaction } from '../../db/query.js'
import { updateGenerationJobOwned, isProjectRunOwned } from '../../services/projectAdmission.js'
import { applyGeneratedTranslations, sanitizeTranscriptOverlaps, TranscriptRevisionConflict } from '../../services/transcriptMutationService.js'
import { getProvider } from '../../providers/registry.js'
import { callProvider } from '../../lib/callProvider.js'
import { classifyProviderError, ERROR_KINDS } from '../../lib/providerErrors.js'
import { projectDir, extractJsonBlock } from '../context.js'
import { TRANSLATION_VERSION } from '../../lib/cacheKey.js'
import { buildSegmentTranslatePrompt, checkGlossaryCompliance } from '../translatePrompt.js'
import { loadGlossaryForPrompt } from '../../services/glossaryService.js'
import { runDeterministicQa, runAiQa, blockingRenderIndexes } from '../translateQa.js'

// Single source of truth cho cache version (đồng bộ với POST /projects
// isCacheCompatible). Bump TRANSLATION_VERSION trong lib/cacheKey.js khi
// đổi logic dịch để cache cũ không reuse nhầm.
export { TRANSLATION_VERSION }

// Wider context window for free tier = fewer LLM calls (docs/11 §3.1)
function getContextWindowSec(project) {
  let tier = 'free'
  try { tier = JSON.parse(project.params || '{}').tier || 'free' } catch (_) {}
  return tier === 'free' ? 45 : 30
}

// TransFlow-inspired LLM batching caps: one LLM call carries at most 30 lines
// or ~2500 chars so long windows never truncate mid-JSON (fewer silent drops).
// Concurrency 2 bounds provider pressure; CONTEXT_LINES = 3 prior lines travel
// as context-only (never translated) for pronoun/register consistency.
export const LLM_BATCH_MAX_LINES = 30
export const LLM_BATCH_MAX_CHARS = 2500
export const LLM_BATCH_CONCURRENCY = 2
export const LLM_CONTEXT_LINES = 3

// Normalize source text before sending to LLM: NFC + collapse whitespace.
// Keeps timing/DB untouched (prompt-only); gate still checks original.
export function normalizeSourceText(s) {
  return String(s || '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
}

// Split segments into LLM batches honoring window + line/char caps.
// Pure (no I/O) — exported for unit tests.
export function splitLlmBatches(segments, windowSec = 45) {
  const groups = []
  let cur = []
  let chars = 0
  let winStart = 0
  for (const s of segments || []) {
    const len = String(s.text || '').length
    if (
      cur.length &&
      ((Number(s.end_sec) - winStart) > windowSec ||
        cur.length >= LLM_BATCH_MAX_LINES ||
        chars + len > LLM_BATCH_MAX_CHARS)
    ) {
      groups.push(cur)
      cur = []
      chars = 0
    }
    if (!cur.length) winStart = Number(s.start_sec) || 0
    cur.push(s)
    chars += len
  }
  if (cur.length) groups.push(cur)
  return groups
}

// Multi-shape batch payload parser: models return keyed lists in various
// shapes ({segments:[...]} vs {translations:[...]} vs {"id":text}).
// Returns Map(index → translation); ignores blanks/non-integers.
export function parseLlmBatchPayload(text) {
  let payload = null
  try {
    payload = extractJsonBlock(String(text || '')) || null
  } catch (_) {
    payload = null
  }
  if (!payload && String(text || '').trim().startsWith('[')) {
    try { payload = JSON.parse(String(text || '').trim()) } catch (_) { payload = null }
  }
  const entries = []
  if (Array.isArray(payload)) {
    entries.push(...payload)
  } else if (payload && typeof payload === 'object') {
    for (const key of ['translations', 'segments', 'lines', 'items', 'results']) {
      const v = payload[key]
      if (Array.isArray(v)) { entries.push(...v); break }
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k, val] of Object.entries(v)) entries.push({ id: k, translation: val })
        break
      }
    }
    if (!entries.length) {
      const vals = Object.values(payload)
      if (vals.length && vals.every((v) => typeof v === 'string')) {
        for (const [k, val] of Object.entries(payload)) entries.push({ id: k, translation: val })
      }
    }
  }
  const m = new Map()
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue
    const rawIdx = item.index ?? item.id ?? item.line_id
    const idx = typeof rawIdx === 'string' && /^\d+$/.test(rawIdx.trim()) ? Number(rawIdx.trim()) : rawIdx
    const t = item.translation ?? item.text ?? item.target_text
    if (Number.isInteger(idx) && typeof t === 'string' && t.trim()) m.set(idx, t.trim())
  }
  return m
}

// dub.translate (docs/05 §B.4): Hybrid Google Translate + LLM restyle.
// Bước 1: Google Translate dịch sát nghĩa (accurate base translation).
// Bước 2: Nếu có style preset → LLM chỉ "viết lại" theo style (giữ nguyên nghĩa).
// Nếu không có style preset → dùng kết quả Google Translate trực tiếp.
export async function dubTranslate(ctx) {
  const { project, job, setProgress, signal, runToken } = ctx
  const params = parseParams(project.params)

  // Check abort signal
  if (signal?.aborted) throw new Error('Cancelled')

  const currentProject = await queryOne('SELECT transcript_version FROM projects WHERE id = ?', [project.id])
  let transcriptVersion = Number(currentProject?.transcript_version ?? project.transcript_version ?? 0)

  // Dọn overlap/duplicate timing trước khi dịch để không bị QA block_render oan
  try {
    const sRes = await sanitizeTranscriptOverlaps(project.id, transcriptVersion, { runToken })
    if (sRes.changed) transcriptVersion = sRes.revision
  } catch (e) {
    console.warn(`[dubTranslate] sanitize overlaps bỏ qua: ${String(e?.message || e).slice(0, 160)}`)
  }

  const segments = await query(
    'SELECT * FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC',
    [project.id]
  )
  if (!segments.length) throw new Error('Không có transcript để dịch — stage dub.stt chưa chạy hoặc rỗng')
  const generatedUpdates = []
  let generatedPersisted = false
  let generatedRevision = transcriptVersion
  const persistGeneratedTranslations = async () => {
    if (!generatedUpdates.length) return { changed: false, revision: generatedRevision }
    if (generatedPersisted) return { changed: true, revision: generatedRevision }
    try {
      const result = await applyGeneratedTranslations(project.id, generatedUpdates, transcriptVersion, { runToken })
      generatedPersisted = true
      generatedRevision = Number(result.revision ?? transcriptVersion)
      transcriptVersion = generatedRevision
      return { ...result, revision: generatedRevision }
    } catch (error) {
      if (error instanceof TranscriptRevisionConflict) {
        const conflict = new Error('TRANSCRIPT_CHANGED_DURING_TRANSLATE')
        conflict.transient = true
        throw conflict
      }
      throw error
    }
  }

  // Transcript pool: TRANSLATE_DUB consumes ASR segments directly.
  const pool = segments

  // Skip translation if all segments already have translations.
  // Task 1: cache identity đã validate ở POST /projects (isCacheCompatible:
  // videoHash + source/target + stylePreset + translationVersion)
  // nên tới đây reuse translation là an toàn. Transcript-only reuse
  // (style khác) copy translation=NULL nên không skip mà dịch lại.
  const untranslated = pool.filter((s) => s.text && !s.translation)
  if (untranslated.length === 0 && pool.length > 0) {
    // Build SRT from existing translations
    const cues = pool
      .filter((s) => s.translation)
      .map((s) => ({ start: Number(s.start_sec), end: Number(s.end_sec), text: s.translation }))
    if (cues.length) await writeSrt(project, cues, runToken, transcriptVersion)
    return {
      translatedCount: pool.length,
      segmentCount: pool.length,
      skipped: true,
      reason: 'cached',
      presetSlug: params.stylePreset || null,
      targetLanguage: params.targetLanguage || 'vi',
      method: 'cached',
    }
  }

  const presetSlug = params.stylePreset
  const preset = presetSlug
    ? await queryOne('SELECT * FROM style_presets WHERE slug = ?', [presetSlug])
    : null

  const targetLanguage = params.targetLanguage || 'vi'
  // sourceLanguage passed VERBATIM to provider (never coerced here).
  // 'auto' only when user chose auto (or unset). 'zh' stays 'zh' at this
  // layer — GoogleTranslate.normalizeTranslateLang maps zh->zh-CN;
  // 'zh-TW' stays 'zh-TW'. Normalization lives in the provider, not here.
  const sourceLanguage = params.sourceLanguage || 'auto'
  const hasStyle = !!preset?.system_prompt

  // Lấy providers: LLM là primary (luôn thử), Google Translate là fallback
//  // (chỉ gọi cho segment LLM unresolved). Không throw khi thiếu GT ở đây —
  // GT thiếu thì LLM phải gánh toàn bộ; chỉ fail khi cả hai đều trống.
  let llm = null
  try { llm = await getProvider(project.user_id, 'llm') } catch (_) { llm = null }
  let gt = null
  try { gt = await getProvider(project.user_id, 'translate') } catch (_) { gt = null }

  // Glossary tối thiểu (phase 1): load best-effort, rỗng khi bảng chưa migrate.
  let glossary = []
  try { glossary = await loadGlossaryForPrompt(project.id) } catch (_) { glossary = [] }

  const system = buildSystemPrompt(preset, targetLanguage)
  setProgress(5)

  // BƯỚC 1: LLM DIRECT PRIMARY — dịch trực tiếp source → target cho TOÀN BỘ
  // segment bằng numbered XML batches (TransFlow segment_translation.py).
  // Mỗi batch mang ≤30 dòng / ~2500 ký tự + 3 previous_lines context-only nên
  // đại từ xưng hô/register/terminology giữ continuity mà không merge segment.
  // Mỗi segment độc lập: segment lỗi không làm hỏng segment khác.
  const gtResults = new Map() // index_num → base translation (LLM-primary, GT fallback)
  const gtErrors = new Map() // index_num → error kind (diagnostic)
  // §8: user edit là source of truth — segment đã sửa translation tay thì AI
  // không được overwrite. Chúng được seed vào `translations` ở dưới và loại
  // khỏi mọi vòng dịch/ghi DB.
  const isManualTranslation = (s) => s.is_translation_manually_edited && s.translation && String(s.translation).trim()
  const segmentsToTranslate = pool.filter((s) => s.text && s.text.trim() && !isManualTranslation(s))
  let usedLlmDirect = false

  if (llm && segmentsToTranslate.length) {
    const directMap = await translateMissingWithLlm(llm, segmentsToTranslate, {
      system, targetLanguage, sourceLanguage, glossary,
      job, projectId: project.id, userId: project.user_id,
      allSegments: pool,
    })
    for (const [idx, txt] of directMap) {
      gtResults.set(idx, txt)
      usedLlmDirect = true
    }
    setProgress(5 + Math.round((gtResults.size / Math.max(1, segmentsToTranslate.length)) * 40))
    // Glossary soft-check (warning only, never hard-fail phase 1).
    if (glossary.length) {
      for (const seg of segmentsToTranslate) {
        const txt = gtResults.get(seg.index_num)
        if (!txt) continue
        const gw = checkGlossaryCompliance(seg.text, txt, glossary)
        if (gw.length) console.warn(`[dubTranslate] segment #${seg.index_num} glossary warnings: ${gw.join('; ')}`)
      }
    }
  } else if (segmentsToTranslate.length) {
    console.warn('[dubTranslate] Thiếu LLM provider — dùng Google Translate làm primary tạm thời')
  }

  // BƯỚC 1b: GOOGLE TRANSLATE FALLBACK — chỉ cho segment LLM chưa có base.
  // Mỗi segment độc lập, retry bounded; CONFIGURATION (404/missing) → sau 3 lỗi
  // liên tiếp short-circuit phần còn lại. TRANSIENT → retry tối đa 2 lần.
  const missingAfterLlm = segmentsToTranslate.filter((s) => !gtResults.has(s.index_num))
  let usedGtFallback = false
  if (missingAfterLlm.length > 0) {
    if (!gt) {
      console.warn(`[dubTranslate] Thiếu Google Translate fallback cho ${missingAfterLlm.length} segment LLM unresolved (indexes: ${missingAfterLlm.map((s) => s.index_num).join(',')})`)
    } else {
      let googleUnhealthy = false
      let consecutiveConfig = 0
      for (let i = 0; i < missingAfterLlm.length; i++) {
        const seg = missingAfterLlm[i]
        const text = (seg.text || '').trim()
        if (!text) continue
        if (googleUnhealthy) {
          gtErrors.set(seg.index_num, ERROR_KINDS.CONFIGURATION)
          continue
        }
        let translated = null
        let lastCls = null
        for (let attempt = 0; attempt <= 2; attempt++) {
          try {
            // sourceLanguage verbatim: 'zh' normalized to 'zh-CN' inside provider,
            // 'zh-TW' kept as-is, 'auto' sends no source param (auto-detect).
            translated = await gt.provider.translate(text, sourceLanguage, targetLanguage)
            break
          } catch (err) {
            // Diagnostic only: kind + endpoint (origin+path). Never log source
            // text, query strings, keys or secrets.
            const cls = classifyProviderError(err)
            lastCls = cls
            gtErrors.set(seg.index_num, cls.kind)
            const where = err.endpoint ? ` endpoint=${err.endpoint}` : ''
            console.warn(`[dubTranslate] Google Translate fallback lỗi segment #${seg.index_num} [${cls.kind}]${where} attempt=${attempt + 1}: ${String(err.message || err).slice(0, 200)}`)
            if (cls.kind === ERROR_KINDS.CONFIGURATION) {
              // 404 endpoint — retrying the same URL cannot help. Sau 3 lỗi liên
              // tiếp thì endpoint chắc chắn hỏng → short-circuit phần còn lại.
              consecutiveConfig++
              if (consecutiveConfig >= 3) {
                googleUnhealthy = true
              }
              break
            }
            if (cls.kind === ERROR_KINDS.TRANSIENT && attempt < 2) {
              await sleepMs(500 * (attempt + 1))
              continue
            }
            break
          }
        }
        if (translated && translated !== text) {
          gtResults.set(seg.index_num, translated.trim())
          usedGtFallback = true
          consecutiveConfig = 0
        } else if (translated && translated === text && lastCls) {
          // Giữ nguyên diagnostic; untranslated copy không tính là base hợp lệ.
        } else if (!translated && !lastCls) {
          consecutiveConfig = 0
        }
        setProgress(5 + Math.round(((i + 1) / missingAfterLlm.length) * 40))
      }
    }
  }

  if (!gtResults.size) throw new Error('LLM không trả về bản dịch hợp lệ nào (kèm Google Translate fallback cũng thất bại)')

  // BƯỚC 2: LLM restyle (chỉ khi có style preset VÀ có LLM)
  const translations = new Map() // segment id → bản dịch cuối cùng
  // Seed bản dịch sửa tay để assertTranslateComplete/SRT tính đủ mà không ghi đè DB.
  for (const s of pool) {
    if (isManualTranslation(s)) translations.set(s.id, s.translation)
  }
  let noStyleUnresolved = []

  if (hasStyle && llm) {
    // Có style preset + có LLM → LLM viết lại theo style.
    // Style là lớp optional: restyle lỗi → fallback bản GT/LLM-direct đã validate,
    // KHÔNG fail cả stage vì style. Nhưng mọi segment required đều phải có
    // translation hợp lệ — còn unresolved thì stage FAILED (không defer cho render).
    const restyleSystem = buildRestyleSystemPrompt(preset, targetLanguage)
    const groups = groupByWindow(pool, getContextWindowSec(project))
    let styleFallback = false
    let unresolved = []
    let qaIssues = []
    const styledAll = new Map() // index_num → styled text (mọi group, cho quarantine details)
    for (let g = 0; g < groups.length; g++) {
      // Bỏ segment sửa tay khỏi group dịch (giữ nguyên DB) — group rỗng thì qua.
      const group = groups[g].filter((s) => !isManualTranslation(s))
      if (!group.length) continue
      const groupTranslations = []
      for (const seg of group) {
        const gtText = gtResults.get(seg.index_num)
        if (gtText) {
          groupTranslations.push({ index: seg.index_num, original: seg.text, translation: gtText })
        }
      }
      if (!groupTranslations.length) {
        for (const seg of group) {
          if (seg.text && seg.text.trim()) unresolved.push(seg.index_num)
        }
        continue
      }

      const { map: restyledGroup, fallback } = await restyleWithFallback(
        llm, restyleSystem, groupTranslations, preset, job, project.id, project.user_id
      )
      if (fallback) styleFallback = true
      for (const [idx, txt] of restyledGroup) if (!styledAll.has(idx)) styledAll.set(idx, txt)

      for (const seg of group) {
        const final = resolveFinalTranslation({
          source: seg.text,
          base: gtResults.get(seg.index_num),
          styled: restyledGroup.get(seg.index_num),
          targetLanguage,
        })
        if (final) {
          generatedUpdates.push({ id: seg.id, translation: final.text })
          translations.set(seg.id, final.text)
          if (final.via === 'base') styleFallback = true
        } else if (seg.text && seg.text.trim()) {
          // Bounded repair: base hard-fail nhưng LLM có thể dịch lại đúng.
          // Tối đa 1 lần/segment; output phải pass gate mới dùng; TRANSIENT
          // (LLM quá tải) thì bỏ qua lặng và giữ unresolved như cũ.
          const gi = group.indexOf(seg)
          const repaired = await repairTranslationWithLlm(llm, {
            source: seg.text,
            badTranslation: gtResults.get(seg.index_num) || restyledGroup.get(seg.index_num) || null,
            prev: group[gi - 1]?.text || '',
            next: group[gi + 1]?.text || '',
            targetLanguage,
            system,
          }, { job, projectId: project.id, userId: project.user_id }).catch(() => null)
          if (repaired) {
            generatedUpdates.push({ id: seg.id, translation: repaired })
            translations.set(seg.id, repaired)
            styleFallback = true
            console.warn(`[dubTranslate] segment #${seg.index_num} repaired qua LLM (base+styled đều fail gate)`)
          } else {
            unresolved.push(seg.index_num)
            const bErr = (validateTranslation(seg.text, gtResults.get(seg.index_num) || '', targetLanguage).errors || []).join(';')
            const sErr = (validateTranslation(seg.text, restyledGroup.get(seg.index_num) || '', targetLanguage).errors || []).join(';')
            console.warn(`[dubTranslate] Block segment #${seg.index_num}: restyle+GT đều fail gate (base:[${bErr}] styled:[${sErr}])`)
          }
        }
      }
      setProgress(45 + Math.round(((g + 1) / groups.length) * 45))
    }
    if (!translations.size) {
      await persistTranslateReview(job, buildTranslateReviewDetails(pool, unresolved, {
        gtResults, styledAll, targetLanguage, qaIssues,
      }), runToken)
      throw new Error(
        `TRANSLATE_NEEDS_REVIEW: LLM không trả về bản dịch restyle hợp lệ nào` +
        (unresolved.length ? ` (unresolved: ${unresolved.join(',')})` : '') +
        ` — sửa bản dịch thủ công qua PATCH /projects/:id/segments/:segmentId/translation rồi chạy lại từ dub.translate`
      )
    }
    // QA pass (flag + block): deterministic luôn chạy, AI best-effort.
    // BLOCK_RENDER merge vào unresolved trước quarantine + assert.
    try {
      const qa = await runQaAndMerge(pool, translations, unresolved, { llm, job, project, targetLanguage })
      qaIssues = qa.qaIssues
      unresolved = qa.merged
    } catch (_) {}
    // Invariant: COMPLETED chỉ khi 100% required translations hợp lệ.
    // Quarantine: còn unresolved → lưu details vào job.result TRƯỚC khi throw
    // để user sửa tay từng segment (PATCH .../segments/:id/translation) rồi
    // regenerate từ dub.translate, thay vì retry mù cùng lỗi.
    await persistTranslateReview(job, buildTranslateReviewDetails(pool, unresolved, {
      gtResults, styledAll, targetLanguage, qaIssues,
    }), runToken)
    await persistGeneratedTranslations()
    // Restyle-down hint: group có nội dung nhưng LLM không trả styled nào
    // (quá tải/outage) → mọi câu đang dùng bản gốc/repair; báo rõ để user
    // phân biệt với lỗi dữ liệu và biết Regenerate sau cũng có thể khỏi.
    try {
      assertTranslateComplete(pool, translations, unresolved)
    } catch (e) {
      const restyleDown = styledAll.size === 0 && groups.some((g) => g.some((s) => s.text && s.text.trim()))
      if (restyleDown && unresolved.length && String(e.message || '').startsWith('TRANSLATE_NEEDS_REVIEW:')) {
        throw new Error(e.message + ' (lưu ý: LLM restyle đang quá tải nên các câu dùng bản dịch gốc; thử Regenerate sau ít phút, hoặc sửa tay)')
      }
      throw e
    }
    // Sinh SRT từ timing gốc + bản dịch (docs/05 FR-T6)
    await persistGeneratedTranslations()
    const styleCues = pool
      .filter((s) => translations.has(s.id))
      .map((s) => ({ start: Number(s.start_sec), end: Number(s.end_sec), text: translations.get(s.id) }))
    if (styleCues.length) await writeSrt(project, styleCues, runToken, transcriptVersion)

    return {
      translatedCount: translations.size,
      segmentCount: pool.length,
      presetSlug: preset?.slug || null,
      targetLanguage,
      method: usedGtFallback
        ? (usedLlmDirect ? 'llm_direct + google_translate_fallback + llm_restyle' : 'google_translate_fallback + llm_restyle')
        : (usedLlmDirect ? 'llm_direct + llm_restyle' : 'llm_restyle'),
      styleFallback,
      unresolved,
    }
  } else {
    // Không có style preset HOẶC không có LLM → dùng Google Translate trực tiếp (có gate ngữ nghĩa)
    if (hasStyle && !llm) {
      console.warn('[dubTranslate] Có style preset nhưng thiếu LLM provider — dùng Google Translate trực tiếp')
    }
    const repairLlm = llm || await getProvider(project.user_id, 'llm').catch(() => null)
    noStyleUnresolved = []
    for (let si = 0; si < pool.length; si++) {
      const seg = pool[si]
      if (isManualTranslation(seg)) continue // §8: giữ bản sửa tay, không ghi đè
      let gtText = gtResults.get(seg.index_num)
      if (!gtText) {
        if (seg.text && seg.text.trim()) noStyleUnresolved.push(seg.index_num)
        continue
      }
      const gate = hasHardTranslationError(seg.text, gtText, targetLanguage)
      if (gate.hard) {
        const fixed = repairLlm ? await repairTranslationWithLlm(repairLlm, {
          source: seg.text, badTranslation: gtText,
          prev: pool[si - 1]?.text || '', next: pool[si + 1]?.text || '',
          targetLanguage, system,
        }, { job, projectId: project.id, userId: project.user_id }) : null
        if (fixed) gtText = fixed
        else {
          const errs = (validateTranslation(seg.text, gtText, targetLanguage).errors || []).join(';')
          console.warn(`[dubTranslate] Block segment #${seg.index_num}: semantic gate failed [${errs}]`)
          noStyleUnresolved.push(seg.index_num); continue
        }
      } else if (gate.errors?.length) {
        console.warn(`[dubTranslate] segment #${seg.index_num} soft warnings (allowed): ${(gate.errors || []).join(';')}`)
      }
      generatedUpdates.push({ id: seg.id, translation: gtText })
      translations.set(seg.id, gtText)
    }
    setProgress(90)
  }

  if (!translations.size) throw new Error('Không có bản dịch hợp lệ nào')

  // QA pass (flag + block) cho nhánh no-style — cùng semantics nhánh style.
  let qaIssuesNoStyle = []
  try {
    const qaLlm = llm || await getProvider(project.user_id, 'llm').catch(() => null)
    const qa = await runQaAndMerge(pool, translations, noStyleUnresolved, {
      llm: qaLlm, job, project, targetLanguage,
    })
    qaIssuesNoStyle = qa.qaIssues
    noStyleUnresolved = qa.merged
  } catch (_) {}

  // Invariant: COMPLETED chỉ khi 100% required translations hợp lệ.
  // Quarantine như nhánh style (xem trên).
  await persistTranslateReview(job, buildTranslateReviewDetails(pool, noStyleUnresolved, {
    gtResults, styledAll: null, targetLanguage, qaIssues: qaIssuesNoStyle,
  }), runToken)
  await persistGeneratedTranslations()
  assertTranslateComplete(pool, translations, noStyleUnresolved)

  await persistGeneratedTranslations()
  const cues = pool
    .filter((s) => translations.has(s.id))
    .map((s) => ({ start: Number(s.start_sec), end: Number(s.end_sec), text: translations.get(s.id) }))
  if (cues.length) await writeSrt(project, cues, runToken, transcriptVersion)

  return {
    translatedCount: translations.size,
    segmentCount: pool.length,
    presetSlug: preset?.slug || null,
    targetLanguage,
    method: usedGtFallback
      ? (usedLlmDirect ? 'llm_direct + google_translate_fallback' : (hasStyle ? 'google_translate_fallback' : 'google_translate_fallback'))
      : (usedLlmDirect ? 'llm_direct' : (hasStyle ? 'google_translate + llm_restyle' : 'google_translate')),
    styleFallback: false,
    unresolved: noStyleUnresolved,
  }
}

// Invariant: dub.translate COMPLETED chỉ khi mọi transcript segment có text
// đều có translation hợp lệ. Còn unresolved → throw FAILED với mã
// TRANSLATE_NEEDS_REVIEW (validation, KHÔNG retry backoff — phải sửa tay rồi
// regenerate), không success giả.
export function assertTranslateComplete(segments, translations, unresolved) {
  const required = (segments || []).filter((s) => s.text && String(s.text).trim())
  const requiredCount = required.length
  const translatedCount = translations?.size || 0
  const unresolvedList = Array.isArray(unresolved) ? unresolved : []
  if (unresolvedList.length > 0 || translatedCount !== requiredCount) {
    throw new Error(
      `TRANSLATE_NEEDS_REVIEW: dub.translate incomplete: ${translatedCount}/${requiredCount} translations` +
      (unresolvedList.length ? ` (unresolved: ${unresolvedList.join(',')})` : '') +
      ` — sửa bản dịch thủ công qua PATCH /projects/:id/segments/:segmentId/translation rồi chạy lại từ dub.translate`
    )
  }
}

// QA pass (flag + block only — never rewrites translations).
// Runs deterministic guards always + best-effort AI judge when LLM exists.
// BLOCK_RENDER issues merge into unresolved so assertTranslateComplete fails
// the stage via the existing TRANSLATE_NEEDS_REVIEW quarantine.
async function runQaAndMerge(pool, translations, unresolved, { llm, job, project, targetLanguage }) {
  let qaIssues = []
  try {
    qaIssues = runDeterministicQa(pool, translations) || []
  } catch (_) { qaIssues = [] }
  if (llm) {
    const pairs = pool
      .filter((s) => translations.has(s.id))
      .map((s) => ({ segmentId: s.id, index: s.index_num, source: s.text, translation: translations.get(s.id) }))
    try {
      const ai = await runAiQa(llm, pairs, { job, projectId: project.id, userId: project.user_id })
      if (ai?.issues?.length) qaIssues = [...qaIssues, ...ai.issues]
    } catch (_) {}
  }
  const merged = Array.isArray(unresolved) ? [...unresolved] : []
  for (const idx of blockingRenderIndexes(qaIssues)) {
    if (!merged.includes(idx)) merged.push(idx)
  }
  return { qaIssues, merged }
}

// Quarantine details cho segment unresolved: đủ để user sửa tay mà không cần
// chạy lại provider (source + base/styled thử qua + lỗi gate từng bản).
// Trả về [] khi không có unresolved (caller persist no-op).
export function buildTranslateReviewDetails(segments, unresolved, { gtResults, styledAll, targetLanguage = 'vi', qaIssues = [] } = {}) {
  const list = Array.isArray(unresolved) ? unresolved : []
  if (!list.length) return []
  const byIndex = new Map((segments || []).map((s) => [s.index_num, s]))
  const qaByIndex = new Map()
  for (const q of qaIssues || []) {
    if (q?.index == null) continue
    if (!qaByIndex.has(q.index)) qaByIndex.set(q.index, [])
    qaByIndex.get(q.index).push(q)
  }
  return list.map((idx) => {
    const seg = byIndex.get(idx) || {}
    const base = gtResults?.get(idx) ?? null
    const styled = styledAll?.get(idx) ?? null
    const baseErrors = base != null
      ? (validateTranslation(seg.text, base, targetLanguage).errors || [])
      : ['missing base translation']
    const styledErrors = styledAll == null ? null : (styled != null
      ? (validateTranslation(seg.text, styled, targetLanguage).errors || [])
      : ['missing styled translation'])
    return {
      segmentId: seg.id || null,
      index: idx,
      source: seg.text || '',
      base,
      styled,
      baseErrors,
      styledErrors,
      qa: qaByIndex.get(idx) || [],
    }
  })
}

// Lưu quarantine details vào generation_jobs.result (best-effort, không throw).
// failJob chỉ giữ error_message 500 ký tự nên details phải persist riêng ở đây,
// TRƯỚC khi assertTranslateComplete throw.
export async function persistTranslateReview(job, details, runToken = null) {
  try {
    if (!job?.id || !Array.isArray(details) || !details.length) return false
    const result = JSON.stringify({ needsReview: true, unresolvedDetails: details })
    const updated = job.project_id
      ? await updateGenerationJobOwned(job.project_id, job.id, { result }, runToken)
      : await updateById('generation_jobs', job.id, { result })
    return Boolean(updated)
  } catch (_) {
    return false
  }
}

// LLM DIRECT TRANSLATION primary cho mọi segment (TransFlow segment_translation).
// Numbered XML batches one-to-one + previous_lines context-only + glossary.
// Dịch trực tiếp source → target, có validate + repair bounded.
// Không bịa translation, không copy source. Preserve index_num. Bounded: mỗi group
// tối đa 2 attempts cho TRANSIENT, PERMANENT/CONFIGURATION → dừng ngay.
export async function translateMissingWithLlm(llm, missingSegments, { system, targetLanguage, sourceLanguage = 'auto', glossary = [], job, projectId, userId, allSegments = [] }) {
  const out = new Map() // index_num → validated translation
  if (!llm || !missingSegments?.length) return out
  const list = [...missingSegments].sort((a, b) => (a.index_num || 0) - (b.index_num || 0))
  // Nhóm theo window + line/char caps (TransFlow batching) để giảm số LLM
  // calls mà không truncate giữa JSON. Giữ thứ tự/timing ở caller.
  const groups = splitLlmBatches(list, 45)

  const buildPrompt = (group) => {
    const requiredIndexes = group.map((s) => s.index_num)
    const firstIndex = group[0]?.index_num ?? 0
    // Sliding context: 3 câu thoại liền trước, context-only (TransFlow previous_lines).
    const prevSegs = (allSegments || [])
      .filter((s) => s.index_num < firstIndex && s.text && s.text.trim())
      .slice(-LLM_CONTEXT_LINES)
    const previousLines = prevSegs.map((s) => normalizeSourceText(s.text))
    // Numbered per-batch 1-based ids (TransFlow) mapped back to index_num below.
    const lines = group.map((s, n) => [String(n + 1), normalizeSourceText(s.text)])
    const { system: segSystem, prompt } = buildSegmentTranslatePrompt(
      sourceLanguage, targetLanguage, lines, glossary, previousLines
    )
    const estTokens = group.reduce((n, s) => n + Math.max(8, Math.ceil(String(s.text || '').length * 2.5)), 0) + 256
    const maxOutputTokens = Math.min(65536, Math.max(1024, Math.ceil(estTokens * 1.5)))
    return { system: segSystem, prompt, requiredIndexes, maxOutputTokens }
  }

  // Một group qua translateGroup với retry bounded cho TRANSIENT (temp 0.2:
  // dịch trung thành, ít sáng tạo bậy — TransFlow default).
  const translateOneGroup = async (group) => {
    const { system: segSystem, prompt, requiredIndexes, maxOutputTokens } = buildPrompt(group)
    // Map batch-local "1".."N" ids back to real index_num for the caller.
    const idToIndex = new Map(group.map((s, n) => [String(n + 1), s.index_num]))
    const remap = (m) => {
      const r = new Map()
      for (const [k, v] of m) {
        const real = idToIndex.get(String(k))
        if (real == null) {
          // Fallback: model echoed global index_num directly.
          if (requiredIndexes.includes(Number(k))) r.set(Number(k), v)
          continue
        }
        r.set(real, v)
      }
      return r
    }
    let collected = new Map()
    let lastErr = null
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const raw = await translateGroup(llm, segSystem, prompt, job, projectId, {
          requiredIndexes, maxOutputTokens, userId, temperature: 0.2,
        })
        collected = remap(raw)
        lastErr = null
        break
      } catch (err) {
        lastErr = err
        const cls = classifyProviderError(err)
        console.warn(`[dubTranslate] llm-direct attempt ${attempt} failed [${cls.code || cls.kind}]: ${String(err.message || err).slice(0, 200)}`)
        // Quota must NOT be retried on the same key — fail over to GT fallback.
        if (cls.retryable === true && attempt < 2) {
          await sleepMs(1000 * attempt)
          continue
        }
        break
      }
    }
    return { collected, lastErr }
  }

  const collectedAll = new Map()
  let providerDown = false
  // Round 1: full batches, tối đa LLM_BATCH_CONCURRENCY calls cùng lúc.
  {
    const pending = [...groups]
    const workers = Array.from(
      { length: Math.min(LLM_BATCH_CONCURRENCY, pending.length) },
      async () => {
        while (pending.length && !providerDown) {
          const group = pending.shift()
          const { collected, lastErr } = await translateOneGroup(group)
          for (const [idx, txt] of collected) if (!collectedAll.has(idx)) collectedAll.set(idx, txt)
          if (lastErr) {
            const cls = classifyProviderError(lastErr)
            // Quota/auth/model/config → stop LLM rounds, fall back to GT now.
            if (cls.kind === ERROR_KINDS.CONFIGURATION || cls.kind === ERROR_KINDS.PERMANENT || cls.retryable === false) {
              providerDown = true
            }
          }
        }
      }
    )
    await Promise.all(workers)
  }

  // Fast-fail: nếu Round 1 gặp lỗi provider nghiêm trọng hoặc 0 kết quả thu được,
  // bỏ qua Round 2 & 3 để chuyển ngay sang Google Translate fallback (tránh nghẽn vô ích).
  if (!providerDown && collectedAll.size > 0) {
    const byIndex = new Map(list.map((s) => [s.index_num, s]))
    // Round 2: dòng còn thiếu gom batch 5 (TransFlow round 2) — batch nhỏ
    // thường qua được khi batch lớn bị truncate/malformed.
    const missingIdx = list.map((s) => s.index_num).filter((i) => !collectedAll.has(i))
    if (missingIdx.length > 0) {
      for (let i = 0; i < missingIdx.length; i += 5) {
        if (providerDown) break
        const chunk = missingIdx.slice(i, i + 5).map((idx) => byIndex.get(idx)).filter(Boolean)
        if (!chunk.length) continue
        const { collected, lastErr } = await translateOneGroup(chunk)
        for (const [idx, txt] of collected) if (!collectedAll.has(idx)) collectedAll.set(idx, txt)
        if (lastErr) {
          const cls = classifyProviderError(lastErr)
          if (cls.kind === ERROR_KINDS.CONFIGURATION || cls.kind === ERROR_KINDS.PERMANENT || cls.retryable === false) {
            providerDown = true
            break
          }
        }
      }
    }
    // Round 3: từng dòng đơn lẻ (TransFlow round 3) — cứu dòng cuối cùng.
    if (!providerDown) {
      const stillMissing = list.map((s) => s.index_num).filter((i) => !collectedAll.has(i))
      for (const idx of stillMissing) {
        if (providerDown) break
        const seg = byIndex.get(idx)
        if (!seg) continue
        const { collected, lastErr } = await translateOneGroup([seg])
        for (const [k, txt] of collected) if (!collectedAll.has(k)) collectedAll.set(k, txt)
        if (lastErr) {
          const cls = classifyProviderError(lastErr)
          if (cls.kind === ERROR_KINDS.CONFIGURATION || cls.kind === ERROR_KINDS.PERMANENT || cls.retryable === false) {
            providerDown = true
            break
          }
        }
      }
    }
  }

  for (const seg of list) {
    let txt = collectedAll.get(seg.index_num)
    if (txt) txt = String(txt).trim()
    // Từ chối JSON artifact lọt qua gate yếu (không phải bản dịch thật).
    if (txt && !/[{}[\]]/.test(txt) && !hasHardTranslationError(seg.text, txt, targetLanguage).hard) {
      out.set(seg.index_num, txt)
      continue
    }
    // Semantic fail → repair bounded 1 lần. Vẫn fail → để unresolved (caller fail stage).
    if (txt && !providerDown) {
      const fixed = await repairTranslationWithLlm(llm, {
        source: seg.text, badTranslation: txt, prev: '', next: '',
        targetLanguage, system,
      }, { job, projectId, userId }).catch(() => null)
      if (fixed && !/[{}[\]]/.test(fixed) && !hasHardTranslationError(seg.text, fixed, targetLanguage).hard) {
        out.set(seg.index_num, fixed)
      } else {
        const errs = (validateTranslation(seg.text, txt, targetLanguage).errors || []).join(';')
        console.warn(`[dubTranslate] Block segment #${seg.index_num}: llm-direct semantic gate failed [${errs}]`)
      }
    }
  }
  return out
}

// ── Fault isolation cho style transformation ─────────────────────────
// sourceText → baseTranslation (LLM-direct primary, GT fallback, đã validate)
// → styledTranslation (LLM, phải qua validate) → finalTranslation.
//
// Quy tắc: base đã validate KHÔNG BAO GIỜ bị hủy chỉ vì style lỗi.
// styled hợp lệ → dùng styled; ngược lại → dùng base; cả hai lỗi → null
// (segment unresolved — stage FAILED, KHÔNG success giả, KHÔNG bịa bản dịch).
export function resolveFinalTranslation({ source, base, styled, targetLanguage = 'vi' }) {
  if (styled && !hasHardTranslationError(source, styled, targetLanguage).hard) {
    return { text: styled, via: 'styled' }
  }
  if (base && !hasHardTranslationError(source, base, targetLanguage).hard) {
    return { text: base, via: 'base' }
  }
  return null
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// Gọi restyleGroup với retry giới hạn cho lỗi TRANSIENT rồi fallback.
// Không bao giờ throw: trả về { map, fallback } — caller dùng base cho
// phần còn thiếu. Lỗi PERMANENT/CONFIGURATION → fallback ngay, không retry.
async function restyleWithFallback(llm, restyleSystem, groupTranslations, preset, job, projectId, userId) {
  const required = groupTranslations.map((t) => t.index)
  let lastError = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const map = await restyleGroup(llm, restyleSystem, groupTranslations, preset, job, projectId, userId)
      const complete = required.every((i) => map.has(i))
      return { map, fallback: !complete, error: complete ? null : new Error('incomplete restyle coverage') }
    } catch (err) {
      lastError = err
      const classification = classifyProviderError(err)
      console.warn(`[dubTranslate] restyle attempt ${attempt} failed [${classification.code || classification.kind}]: ${String(err.message || err).slice(0, 200)}`)
      if (classification.retryable === true && attempt < 2) {
        await sleepMs(1500 * attempt)
        continue
      }
      break
    }
  }
  return { map: new Map(), fallback: true, error: lastError }
}

// LLM restyle: chỉ viết lại bản dịch đã chính xác theo style preset.
// KHÔNG dịch lại — giữ nguyên nghĩa, chỉ thay văn phong.
async function restyleGroup(llm, system, groupTranslations, preset, job, projectId, userId) {
  const input = groupTranslations
    .map((t) => `${t.index}|src:${t.original || ''}|tgt:${t.translation}`)
    .join('\n')

  const prompt =
    `Viết lại các câu lồng tiếng dưới đây theo phong cách: ${preset.name}.\n` +
    `Bản dịch gốc đã ĐÚNG NGHĨA — KHÔNG được thay đổi ý, chỉ thay đổi văn phong. Giữ tên riêng, con số, phủ định, nghi vấn.\n` +
    `Mỗi dòng có định dạng "index|src:nguồn|tgt:bản dịch". Giữ nguyên index, CHỈ viết lại phần bản dịch (sau "tgt:").\n` +
    `GIỮ NGUYÊN mọi con số, tên riêng trong bản dịch (cấm đổi/thêm/bớt số). Mỗi index bắt buộc có translation khác rỗng.\n\n` +
    `${input}\n\n` +
    `Trả về DUY NHẤT JSON: {"segments":[{"index":int,"translation":string}]}`

  const requiredIndexes = groupTranslations.map((t) => t.index)
  const estTokens = groupTranslations.reduce((n, t) => n + Math.max(8, Math.ceil((t.translation || '').length * 2.5)), 0) + 256
  const maxOutputTokens = Math.min(65536, Math.max(1024, Math.ceil(estTokens * 1.5)))

  const collected = new Map()
  const MAX_ATTEMPTS = 3
  let attempt = 0
  while (attempt < MAX_ATTEMPTS) {
    let p = prompt
    if (attempt > 0) {
      const missingNow = requiredIndexes.filter((i) => !collected.has(i))
      p = `${prompt}\n\nLƯU Ý: trả về ĐÚNG định dạng JSON. Các index SAU CHƯA được viết lại (bắt buộc phải có đủ): ${missingNow.join(', ')}.`
    }
    const call = (pp) =>
      callProvider({
        provider: llm.id,
        type: 'llm',
        model: llm.provider.model || llm.id,
        input: { system, prompt: pp, json: true, temperature: 0.4, maxOutputTokens },
        fn: () => llm.provider.complete({ system, prompt: pp, json: true, temperature: 0.4, maxOutputTokens }),
        userId,
        apiKeyId: llm.apiKeyId,
        projectId,
        jobId: job.id,
      })

    const sanitize = (text) =>
      String(text || '')
        .replace(/^[\s\S]*?```(?:json)?\s*/i, '')
        .replace(/```[\s\S]*$/, '')
        .trim()

    const parseToMap = (res) => {
      const parsed = extractJsonBlock(sanitize(res.text)) || {}
      const list = Array.isArray(parsed.segments) ? parsed.segments : []
      const m = new Map()
      for (const item of list) {
        if (item && Number.isInteger(item.index) && typeof item.translation === 'string') {
          const t = item.translation.trim()
          if (t) m.set(item.index, t)
        }
      }
      return m
    }

    const m = parseToMap(await call(p))
    for (const [idx, t] of m) if (!collected.has(idx)) collected.set(idx, t)

    const missingIndexes = requiredIndexes.filter((i) => !collected.has(i))
    if (!missingIndexes.length) break
    attempt++
  }
  return collected
}

async function writeSrt(project, cues, runToken = null, expectedRevision = null) {
  if (!cues.length) return
  if (runToken && !(await isProjectRunOwned(project.id, runToken))) {
    const error = new Error('RUN_ABORTED')
    error.code = 'RUN_ABORTED'
    throw error
  }
  if (expectedRevision !== null && expectedRevision !== undefined) {
    const current = await queryOne('SELECT transcript_version FROM projects WHERE id = ?', [project.id])
    if (Number(current?.transcript_version ?? 0) !== Number(expectedRevision)) {
      const error = new Error('TRANSCRIPT_CHANGED_DURING_TRANSLATE')
      error.transient = true
      throw error
    }
  }
  const dir = projectDir(project.id)
  fs.mkdirSync(dir, { recursive: true })
  const srtPath = path.join(dir, 'subtitles.srt')
  const body = cues
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`)
    .join('\n')
  fs.writeFileSync(srtPath, body, 'utf8')

  const subtitle = {
    id: uuidv4(),
    project_id: project.id,
    format: 'srt',
    language: parseParams(project.params).targetLanguage || 'vi',
    storage_key: null,
    cues: JSON.stringify(cues),
  }
  if (runToken || expectedRevision !== null) {
    const commitResult = await withTransaction(async (tx) => {
      const owner = await tx.queryOne('SELECT status, run_token, transcript_version FROM projects WHERE id = ?', [project.id])
      if (!owner || (runToken && (owner.status !== 'running' || owner.run_token !== runToken))) return { committed: false, reason: 'ownership' }
      if (expectedRevision !== null && expectedRevision !== undefined && Number(owner.transcript_version ?? 0) !== Number(expectedRevision)) return { committed: false, reason: 'revision' }
      await tx.run('DELETE FROM subtitles WHERE project_id = ?', [project.id])
      await tx.insert('subtitles', subtitle)
      return { committed: true }
    }, { op: 'pipeline.translate.srt' })
    if (!commitResult.committed) {
      const revisionChanged = commitResult.reason === 'revision'
      const error = new Error(revisionChanged ? 'TRANSCRIPT_CHANGED_DURING_TRANSLATE' : 'RUN_ABORTED')
      error.code = revisionChanged ? 'TRANSCRIPT_CHANGED' : 'RUN_ABORTED'
      error.transient = revisionChanged
      throw error
    }
  } else {
    await run('DELETE FROM subtitles WHERE project_id = ?', [project.id])
    await insert('subtitles', subtitle)
  }
}

// Giữ lại translateGroup làm fallback (nếu Google Translate lỗi)
export async function translateGroup(llm, system, prompt, job, projectId, opts = {}) {
  const { requiredIndexes = null, maxOutputTokens = null, userId = null, temperature = 0.4 } = opts
  const call = (p) =>
    callProvider({
      provider: llm.id,
      type: 'llm',
      model: llm.provider.model || llm.id,
      input: { system, prompt: p, json: true, temperature, maxOutputTokens },
      fn: () => llm.provider.complete({ system, prompt: p, json: true, temperature, maxOutputTokens }),
      userId,
      apiKeyId: llm.apiKeyId,
      projectId,
      jobId: job.id,
    })

  const sanitize = (text) =>
    String(text || '')
      .replace(/^[\s\S]*?```(?:json)?\s*/i, '')
      .replace(/```[\s\S]*$/, '')
      .trim()

  // Multi-shape parser (TransFlow technique): models trả keyed list dưới
  // nhiều dạng ({segments}/{translations}/{lines}/{"id":text}) — chấp nhận
  // hết thay vì mất thầm lặng khi model đổi shape.
  const parseToMap = (res) => parseLlmBatchPayload(sanitize(res.text))

  const collected = new Map()
  const MAX_ATTEMPTS = 3
  let attempt = 0
  while (attempt < MAX_ATTEMPTS) {
    let p = prompt
    if (attempt > 0) {
      const missingNow = requiredIndexes.filter((i) => !collected.has(i))
      p = `${prompt}\n\nLƯU Ý: trả về ĐÚNG định dạng JSON. Các index SAU CHƯA được dịch (bắt buộc phải có đủ): ${missingNow.join(', ')}.`
    }
    const m = parseToMap(await call(p))
    for (const [idx, t] of m) if (!collected.has(idx)) collected.set(idx, t)
    if (!requiredIndexes) break
    const missingIndexes = requiredIndexes.filter((i) => !collected.has(i))
    if (!missingIndexes.length) break
    attempt++
  }
  return collected
}

const NEG_EN = [
  'not', 'no', 'never', "n't", 'without', 'none',
  // ASR transcripts usually drop apostrophes ("dont", "cant") và dùng từ
  // phủ định không dấu nháy — thiếu chúng là false-positive hàng loạt
  // (nguồn STT "I dont ..." bị tính là không phủ định trong khi VI đúng
  // là "Tôi không ..."). Giữ lowercase match với space-boundary như cũ.
  'cannot', 'nothing', 'nobody', 'nowhere', 'neither', 'nor',
  'hardly', 'scarcely', 'barely', 'seldom', 'rarely',
  'dont', 'cant', 'wont', 'isnt', 'arent', 'wasnt', 'werent',
  'hasnt', 'havent', 'hadnt', 'doesnt', 'didnt', 'couldnt',
  'shouldnt', 'wouldnt', 'mustnt', 'neednt',
]
const NEG_VI = ['không', 'chưa', 'chẳng', 'đừng', 'không hề', 'chưa từng']

function extractNumbers(s) {
  return (String(s || '').match(/-?\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(',', '.'))
}

function extractEntities(s) {
  return (String(s || '').match(/\b[A-ZÀ-Ỹ][a-zà-ỹ]+(?:\s+[A-ZÀ-Ỹ][a-zà-ỹ]+)*/g) || []).map((x) => x.toLowerCase())
}

function hasNegation(s, lang) {
  const t = ` ${String(s || '').toLowerCase()} `
  const lex = lang === 'vi' ? NEG_VI : NEG_EN
  return lex.some((w) => t.includes(w === "n't" ? w : ` ${w} `) || (w === "n't" && t.includes(w)))
}

// Strip trailing VI question particle trước khi check phủ định.
// "Có tốt không?", "Bạn ăn chưa?" — chữ không/chưa ở cuối là tiểu từ nghi
// vấn, KHÔNG phải phủ định. So equality trên câu đã strip thì dạng thêm
// "không?" hỏi không còn false-positive, nhưng thêm phủ định giữa câu
// ("Tôi không muốn đi" cho nguồn khẳng định) vẫn bị bắt.
const VI_TRAILING_QUESTION_PARTICLES = ['không', 'chưa', 'chứ', 'nhỉ', 'hả', 'à', 'ạ', 'ư', 'vậy', 'sao', 'hay', 'nhé', 'nha', 'đâu', 'nào', 'gì', 'ai']
export function stripViQuestionParticle(s) {
  let t = String(s || '').trim()
  for (let i = 0; i < 2; i++) {
    const noQ = t.replace(/[?？]+\s*$/, '').trim()
    const low = ` ${noQ.toLowerCase()} `
    const hit = VI_TRAILING_QUESTION_PARTICLES.some((w) => low.endsWith(` ${w} `))
    if (!hit) return noQ || t
    t = noQ.replace(new RegExp(`\\s+[^\\s]+\\s*$`), '').trim()
  }
  return t
}

// CJK negation: 不/没/未/别/莫/无/非/勿 (+ compounds 不用/不能/不是… covered
// by single-char match). Single regex is enough; these chars are almost
// always negative in zh.
export function hasNegationZh(s) {
  return /[不没未别莫无非勿]/.test(String(s || ''))
}

// Punctuation-tolerant vi negation (trailing "không?"/"chưa." must count —
// legacy hasNegation misses them due to space-boundary check; kept as-is
// for en gate, this robust variant is used for the CJK gate only).
export function hasNegationVi(s) {
  const t = ` ${String(s || '').toLowerCase().replace(/[?？!.,;:…~～"“”'‘’()—–-]/g, ' ')} `.replace(/\s+/g, ' ')
  return NEG_VI.some((w) => t.includes(` ${w.toLowerCase()} `))
}

// True CJK interrogative: trailing ?/？, or question particles 吗/呢 (+ optional
// closing punctuation). 吧/啊/么/嘛 EXCLUDED on purpose: they are modal /
// suggestive (live GT renders 强调吧/容易啊 as vi statements without "?"),
// treating them as questions over-rejects and breaks cjkValidate pairs.
export function isCjkQuestion(s) {
  const t = String(s || '').trim()
  if (!t) return false
  if (/[?？]\s*$/.test(t)) return true
  if (/[吗呢]\s*[。！？!?.…~～]*\s*$/.test(t)) return true
  return false
}

const VI_QUESTION_TOKENS = ['ai', 'gì', 'nào', 'sao', 'không', 'nhỉ', 'hả', 'chứ', 'vậy', 'hay', 'bao', 'mấy', 'đâu', 'chưa', 'nhé', 'nha', 'à', 'ạ', 'ư']

// Lenient vi-question check: "?" counts, else any standalone question word
// (unicode-letter boundaries so "là" doesn't match "à", "hai" doesn't match
// "ai"). Wide list on purpose — missing both is a strong changed-intent signal.
function hasViQuestion(t) {
  const s = String(t || '')
  if (/[?？]/.test(s)) return true
  const low = s.toLowerCase()
  return VI_QUESTION_TOKENS.some((tok) => {
    const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^\\p{L}])${esc}([^\\p{L}]|$)`, 'iu').test(low)
  })
}

function looksVietnamese(s) {
  return /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(String(s || ''))
}

// CJK chars (zh/ja/ko) expand ~3-8x when translated into Vietnamese
// (verified live zh->vi GT outputs, ratios 3.4-7.7 for correct translations),
// so latin-oriented heuristics must not apply to them as-is.
function countCjk(s) {
  const m = String(s || '').match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/g)
  return m ? m.length : 0
}

export function validateTranslation(src, tgt, targetLang = 'vi') {
  const errors = []
  const s = String(src || '').trim(), t = String(tgt || '').trim()
  if (!s) errors.push('empty source')
  if (!t) errors.push('empty translation')
  if (errors.length) return { ok: false, errors }
  if (s.toLowerCase() === t.toLowerCase()) errors.push('untranslated copy')
  const sn = extractNumbers(s), tn = extractNumbers(t)
  if (sn.length !== tn.length || sn.some((n, i) => n !== tn[i])) errors.push(`number mismatch (${sn.join(',')}→${tn.join(',')})`)
  const sQ = /\?\s*$/.test(s), tQ = /[?？]\s*$/.test(t)
  // CJK ASR transcripts carry no reliable punctuation (questions end with
  // particles like 吗/呢/吧, not "?") while vi correctly adds "?" — skip check.
  if (countCjk(s) === 0 && sQ !== tQ) errors.push('question intent changed')
  // CJK context-aware question: 吗/呢/? source must map to vi "?" or question
  // word (wide lenient list). 吧/啊 sources excluded via isCjkQuestion.
  if (countCjk(s) > 0 && isCjkQuestion(s) && !hasViQuestion(t)) errors.push('question intent changed')
  // EN-like negation: so sánh trên bản VI đã strip tiểu từ nghi vấn cuối câu
  // ("...không?/chưa?") — dạng thêm không/chưa để hỏi không còn false-positive,
  // nhưng thêm/bớt phủ định giữa câu vẫn bị bắt. Giữ equality (2 chiều) trên
  // câu đã strip: chỉ nguồn có → dịch mất, hoặc nguồn khẳng định → dịch thêm
  // phủ định giữa câu, mới là đổi nghĩa thật.
  if (hasNegation(s, 'en') !== hasNegation(stripViQuestionParticle(t), 'vi') && /[a-z]/i.test(s)) {
    // Only enforce when source is English-like; avoids false positives on other langs
    errors.push('negation changed')
  }
  // CJK negation, one-sided: source 不/没/… present → vi must keep negation.
  // One-sided (not equality) so vi question-final "…không?" never false-positives
  // on negation-free sources. Enforced only for CJK→vi.
  if (countCjk(s) > 0 && targetLang === 'vi' && hasNegationZh(s) && !hasNegationVi(t)) {
    errors.push('negation changed')
  }
  const se = extractEntities(s)
  if (se.length) {
    const tl = t.toLowerCase()
    const kept = se.filter((e) => e.length > 2 && tl.includes(e.split(' ')[0]))
    if (kept.length / se.length < 0.5) errors.push('entity changed')
  }
  if (targetLang === 'vi' && /^[A-Za-z0-9\s.,!?'"():;—–-]+$/.test(t) && !looksVietnamese(t) && t.length > 12) {
    errors.push('wrong target language')
  }
  // CJK script leakage: Vietnamese target must not contain Chinese/Han/CJK characters (TransFlow technique)
  if (targetLang === 'vi' && countCjk(t) > 0) {
    errors.push('wrong target language')
  }
  const ratio = t.length / Math.max(1, s.length)
  const isCjk = countCjk(s) > 0
  // CJK chars expand ~3-9x into Vietnamese for short sentences (live GT ratios up to ~8.8
  // for natural 4-9 char phrases like "再拖下去" -> "Nếu tình trạng này kéo dài hơn nữa").
  // Latin expands up to ~3x (style up to 8x).
  const maxRatio = isCjk ? 8 : 3
  const maxHardRatio = isCjk ? 12 : 8
  // Ba tầng length:
  // - ratio < 0.3 (rụng nội dung) → HARD.
  // - ratio > maxHardRatio (bịa/nở cực đoan, vd CJK 5 chữ → VI >60 chữ) → HARD.
  // - giữa maxRatio..maxHardRatio (nở vừa, câu ngắn/style) → soft warning, pipeline/PATCH
  //   cho qua như 'entity changed'. Number/language/empty vẫn bắt HARD.
  if (ratio < 0.3 || ratio > maxHardRatio) errors.push('length implausible (hallucination?)')
  else if (ratio > maxRatio) errors.push('length expansion (style?)')
  return { ok: errors.length === 0, errors }
}

const HARD_PREFIXES = ['number mismatch', 'length implausible']
const HARD_EXACT = new Set(['empty source', 'empty translation', 'untranslated copy', 'wrong target language'])
export function classifyTranslationErrors(errors) {
  const hard = [], warnings = []
  for (const e of errors || []) {
    const s = String(e || '')
    if (HARD_EXACT.has(s) || HARD_PREFIXES.some((p) => s.startsWith(p)) || /[{}[\]]/.test(s)) hard.push(s)
    else warnings.push(s)
  }
  return { hard, warnings }
}
export function hasHardTranslationError(src, tgt, targetLang = 'vi') {
  const t = String(tgt || '')
  if (/[{}[\]]/.test(t)) return { hard: true, errors: ['translation artifact'], warnings: [] }
  const v = validateTranslation(src, tgt, targetLang)
  if (v.ok) return { hard: false, errors: [], warnings: [] }
  const { hard, warnings } = classifyTranslationErrors(v.errors)
  return { hard: hard.length > 0, errors: v.errors, warnings }
}

export async function repairTranslationWithLlm(llm, { source, badTranslation, prev, next, targetLanguage, system }, { job, projectId, userId }) {
  const prompt =
    `Dịch lại câu sau sang ${languageName(targetLanguage)}, GIỮ ĐÚNG nghĩa, tên riêng, con số, phủ định, nghi vấn. Không bịa thêm.\n` +
    (prev ? `Câu trước: "${prev}"\n` : '') +
    `Câu cần dịch: "${source}"\n` +
    (next ? `Câu sau: "${next}"\n` : '') +
    (badTranslation ? `Bản dịch sai cần sửa: "${badTranslation}"\n` : '') +
    `Chỉ trả về bản dịch, không giải thích.`
  try {
    const res = await callProvider({
      provider: llm.id, type: 'llm', model: llm.provider.model || llm.id,
      input: { system: system || 'translate', prompt, temperature: 0.2, maxOutputTokens: 300 },
      fn: () => llm.provider.complete({ system: system || 'translate', prompt, temperature: 0.2, maxOutputTokens: 300 }),
      userId, apiKeyId: llm.apiKeyId, projectId, jobId: job?.id,
    })
    const out = String(res?.text || '').replace(/^["'\s]+|["'\s]+$/g, '').trim()
    // Từ chối JSON artifact lọt qua gate yếu (validateTranslation không check
    // ngoặc — hasHardTranslationError mới check; repair phải check ở đây để
    // không bao giờ ghi '{"segments":...}' vào DB như bản dịch thật).
    if (!out || /[{}[\]]/.test(out)) return null
    // Chấp nhận repair khi không lỗi HARD (khớp resolveFinalTranslation) —
    // trước đây đòi .ok tuyệt đối nên bản repair chỉ dính soft warning
    // (entity changed/length) bị loại oan dù pipeline vẫn accept via base.
    if (!hasHardTranslationError(source, out, targetLanguage).hard) return out
  } catch (_) {}
  return null
}

function buildSystemPrompt(preset, targetLanguage) {
  const base =
    `Bạn là biên tập viên phụ đề và lồng tiếng chuyên nghiệp. Nhiệm vụ: viết lại câu lồng tiếng sang ${languageDescription(targetLanguage)}.` +
    ` Luôn giữ ý nghĩa gốc, chọn đại từ nhân xưng tự nhiên theo ngữ cảnh, không bịa thêm chi tiết.` +
    ` Các câu thoại ngắn, khẩu ngữ, tiếng lóng phải dịch tự nhiên sang ${languageName(targetLanguage)}, không chép lại nguyên văn chữ nước ngoài.` +
    ` Dịch từng câu độc lập, không dồn chữ sang câu khác.`
  if (preset?.system_prompt) return `${base} Văn phong bắt buộc — ${preset.name}: ${preset.system_prompt}`
  return `${base} Văn phong trung tính tự nhiên.`
}

function buildRestyleSystemPrompt(preset, targetLanguage) {
  const base =
    `Bạn là biên tập viên phụ đề và lồng tiếng chuyên nghiệp. Nhiệm vụ: VIẾT LẠI câu lồng tiếng đã được dịch sẵn sang ${languageDescription(targetLanguage)}.` +
    ` BẢN DỊCH GỐC ĐÃ ĐÚNG NGHĨA — bạn CHỈ thay đổi văn phong cho mượt mà, đúng ngữ cảnh lồng tiếng, KHÔNG được thay đổi ý nghĩa.` +
    ` KHÔNG thêm bớt nội dung, KHÔNG dịch lại từ đầu.`
  if (preset?.system_prompt) return `${base} Văn phong bắt buộc — ${preset.name}: ${preset.system_prompt}`
  return `${base} Văn phong trung tính tự nhiên.`
}

function groupByWindow(segments, windowSec) {
  const groups = []
  let current = []
  let windowStart = 0
  for (const s of segments) {
    if (!current.length) windowStart = Number(s.start_sec) || 0
    if ((Number(s.end_sec) - windowStart) > windowSec && current.length) {
      groups.push(current)
      current = [s]
      windowStart = Number(s.start_sec) || 0
    } else {
      current.push(s)
    }
  }
  if (current.length) groups.push(current)
  return groups
}

function parseParams(raw) {
  try { return raw ? JSON.parse(raw) : {} } catch (_) { return {} }
}

function languageName(code) {
  const names = { vi: 'tiếng Việt', en: 'tiếng Anh' }
  return names[code] || code
}

function languageDescription(code) {
  const names = {
    vi: 'tiếng Việt (Vietnamese)',
    en: 'tiếng Anh (English)',
    zh: 'tiếng Trung (Chinese, 中文)',
    'zh-CN': 'tiếng Trung Giản thể (Simplified Chinese, 中文)',
    'zh-TW': 'tiếng Trung Phồn thể (Traditional Chinese)',
    ja: 'tiếng Nhật (Japanese, 日本語)',
    ko: 'tiếng Hàn (Korean, 한국어)',
    fr: 'tiếng Pháp (French)',
    de: 'tiếng Đức (German)',
    es: 'tiếng Tây Ban Nha (Spanish)',
  }
  return names[code] || languageName(code)
}

function srtTime(sec) {
  const total = Math.max(0, Math.round(sec * 1000))
  const ms = total % 1000
  const s = Math.floor(total / 1000) % 60
  const m = Math.floor(total / 60000) % 60
  const h = Math.floor(total / 3600000)
  const p2 = (n) => String(n).padStart(2, '0')
  const p3 = (n) => String(n).padStart(3, '0')
  return `${p2(h)}:${p2(m)}:${p2(s)},${p3(ms)}`
}

export default dubTranslate
