import path from 'path'
import fs from 'node:fs'
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne, updateById, insert, run } from '../../db/query.js'
import { getProvider } from '../../providers/registry.js'
import { callProvider } from '../../lib/callProvider.js'
import { classifyProviderError, ERROR_KINDS } from '../../lib/providerErrors.js'
import { projectDir, extractJsonBlock, round2 } from '../context.js'
import { TRANSLATION_VERSION } from '../../lib/cacheKey.js'

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

// dub.translate (docs/05 §B.4): Hybrid Google Translate + LLM restyle.
// Bước 1: Google Translate dịch sát nghĩa (accurate base translation).
// Bước 2: Nếu có style preset → LLM chỉ "viết lại" theo style (giữ nguyên nghĩa).
// Nếu không có style preset → dùng kết quả Google Translate trực tiếp.
export async function dubTranslate(ctx) {
  const { project, job, setProgress, signal } = ctx
  const params = parseParams(project.params)

  // Check abort signal
  if (signal?.aborted) throw new Error('Cancelled')

  const segments = await query(
    'SELECT * FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC',
    [project.id]
  )
  if (!segments.length) throw new Error('Không có transcript để dịch — stage dub.stt chưa chạy hoặc rỗng')

  // Skip translation if all segments already have translations.
  // Task 1: cache identity đã validate ở POST /projects (isCacheCompatible:
  // videoHash + source/target + stylePreset + ocrMode + translationVersion)
  // nên tới đây reuse translation là an toàn. Transcript-only reuse
  // (style khác) copy translation=NULL nên không skip mà dịch lại.
  const untranslated = segments.filter((s) => s.text && !s.translation)
  if (untranslated.length === 0 && segments.length > 0) {
    // Build SRT from existing translations
    const cues = segments
      .filter((s) => s.translation)
      .map((s) => ({ start: Number(s.start_sec), end: Number(s.end_sec), text: s.translation }))
    if (cues.length) await writeSrt(project, cues)
    return {
      translatedCount: segments.length,
      segmentCount: segments.length,
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

  // Lấy Google Translate provider (keyless, dùng Apps Script URL)
  const gt = await getProvider(project.user_id, 'translate').catch(() => null)
  // LLM provider cho bước restyle (chỉ cần khi có style preset)
  const llm = hasStyle ? await getProvider(project.user_id, 'llm').catch(() => null) : null

  if (!gt) {
    throw new Error(
      'Không có Google Translate provider. Kiểm tra GOOGLE_TRANSLATE_SCRIPT_URL trong file .env'
    )
  }

  const system = buildSystemPrompt(preset, targetLanguage)
  setProgress(5)

  // BƯỚC 1: Google Translate — dịch sát nghĩa từng câu.
  // Mỗi segment độc lập: segment lỗi không làm hỏng segment khác.
  // CONFIGURATION (404/missing) → sau 3 lỗi liên tiếp đánh dấu provider unhealthy
  // cho job hiện tại, không gọi lại vô hạn (endpoint hỏng thì mọi segment đều 404).
  // Lỗi CONFIGURATION rời rạc (1-2 segment) vẫn fault-isolated, LLM-direct cứu từng câu.
  // TRANSIENT → retry bounded exponential backoff (tối đa 2 lần retry / segment).
  const gtResults = new Map() // index_num → bản dịch Google Translate (base)
  const gtErrors = new Map() // index_num → error kind (diagnostic)
  const segmentsToTranslate = segments.filter((s) => s.text && s.text.trim())
  let googleUnhealthy = false
  let consecutiveConfig = 0

  for (let i = 0; i < segmentsToTranslate.length; i++) {
    const seg = segmentsToTranslate[i]
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
        console.warn(`[dubTranslate] Google Translate lỗi segment #${seg.index_num} [${cls.kind}]${where} attempt=${attempt + 1}: ${String(err.message || err).slice(0, 200)}`)
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
      consecutiveConfig = 0
    } else if (translated && translated === text && lastCls) {
      // Giữ nguyên diagnostic; untranslated copy không tính là base hợp lệ.
    } else if (!translated && !lastCls) {
      consecutiveConfig = 0
    }
    setProgress(5 + Math.round(((i + 1) / segmentsToTranslate.length) * 40))
  }

  // BƯỚC 1b: LLM DIRECT TRANSLATION fallback cho segment chưa có base.
  // Không chỉ restyle — dịch trực tiếp source → target, có validate + repair bounded.
  const missingAfterGt = segmentsToTranslate.filter((s) => !gtResults.has(s.index_num))
  let usedLlmDirect = false
  if (missingAfterGt.length > 0) {
    let fallbackLlm = llm
    if (!fallbackLlm) {
      fallbackLlm = await getProvider(project.user_id, 'llm').catch(() => null)
    }
    if (fallbackLlm) {
      const directMap = await translateMissingWithLlm(fallbackLlm, missingAfterGt, {
        system, targetLanguage, job, projectId: project.id, userId: project.user_id,
      })
      for (const [idx, txt] of directMap) {
        if (!gtResults.has(idx)) {
          gtResults.set(idx, txt)
          usedLlmDirect = true
        }
      }
    } else {
      console.warn(`[dubTranslate] Thiếu LLM fallback cho ${missingAfterGt.length} segment Google lỗi (indexes: ${missingAfterGt.map((s) => s.index_num).join(',')})`)
    }
  }

  if (!gtResults.size) throw new Error('Google Translate không trả về bản dịch hợp lệ nào (kèm LLM fallback cũng thất bại)')

  // BƯỚC 2: LLM restyle (chỉ khi có style preset VÀ có LLM)
  const translations = new Map() // segment id → bản dịch cuối cùng
  let noStyleUnresolved = []

  if (hasStyle && llm) {
    // Có style preset + có LLM → LLM viết lại theo style.
    // Style là lớp optional: restyle lỗi → fallback bản GT/LLM-direct đã validate,
    // KHÔNG fail cả stage vì style. Nhưng mọi segment required đều phải có
    // translation hợp lệ — còn unresolved thì stage FAILED (không defer cho render).
    const restyleSystem = buildRestyleSystemPrompt(preset, targetLanguage)
    const groups = groupByWindow(segments, getContextWindowSec(project))
    let styleFallback = false
    const unresolved = []
    for (let g = 0; g < groups.length; g++) {
      const group = groups[g]
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

      for (const seg of group) {
        const final = resolveFinalTranslation({
          source: seg.text,
          base: gtResults.get(seg.index_num),
          styled: restyledGroup.get(seg.index_num),
          targetLanguage,
        })
        if (final) {
          await updateById('transcript_segments', seg.id, { translation: final.text })
          translations.set(seg.id, final.text)
          if (final.via === 'base') styleFallback = true
        } else if (seg.text && seg.text.trim()) {
          unresolved.push(seg.index_num)
          const bErr = (validateTranslation(seg.text, gtResults.get(seg.index_num) || '', targetLanguage).errors || []).join(';')
          const sErr = (validateTranslation(seg.text, restyledGroup.get(seg.index_num) || '', targetLanguage).errors || []).join(';')
          console.warn(`[dubTranslate] Block segment #${seg.index_num}: restyle+GT đều fail gate (base:[${bErr}] styled:[${sErr}])`)
        }
      }
      setProgress(45 + Math.round(((g + 1) / groups.length) * 45))
    }
    if (!translations.size) {
      throw new Error(
        `LLM không trả về bản dịch restyle hợp lệ nào` +
        (unresolved.length ? ` (unresolved: ${unresolved.join(',')})` : '')
      )
    }
    // Invariant: COMPLETED chỉ khi 100% required translations hợp lệ.
    assertTranslateComplete(segments, translations, unresolved)
    // Sinh SRT từ timing gốc + bản dịch (docs/05 FR-T6)
    const styleCues = segments
      .filter((s) => translations.has(s.id))
      .map((s) => ({ start: Number(s.start_sec), end: Number(s.end_sec), text: translations.get(s.id) }))
    if (styleCues.length) await writeSrt(project, styleCues)

    return {
      translatedCount: translations.size,
      segmentCount: segments.length,
      presetSlug: preset?.slug || null,
      targetLanguage,
      method: usedLlmDirect ? 'google_translate + llm_direct + llm_restyle' : 'google_translate + llm_restyle',
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
    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si]
      let gtText = gtResults.get(seg.index_num)
      if (!gtText) {
        if (seg.text && seg.text.trim()) noStyleUnresolved.push(seg.index_num)
        continue
      }
      const gate = hasHardTranslationError(seg.text, gtText, targetLanguage)
      if (gate.hard) {
        const fixed = repairLlm ? await repairTranslationWithLlm(repairLlm, {
          source: seg.text, badTranslation: gtText,
          prev: segments[si - 1]?.text || '', next: segments[si + 1]?.text || '',
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
      await updateById('transcript_segments', seg.id, { translation: gtText })
      translations.set(seg.id, gtText)
    }
    setProgress(90)
  }

  if (!translations.size) throw new Error('Không có bản dịch hợp lệ nào')

  // Invariant: COMPLETED chỉ khi 100% required translations hợp lệ.
  assertTranslateComplete(segments, translations, noStyleUnresolved)

  // Sinh SRT từ timing gốc + bản dịch (docs/05 FR-T6)
  const cues = segments
    .filter((s) => translations.has(s.id))
    .map((s) => ({ start: Number(s.start_sec), end: Number(s.end_sec), text: translations.get(s.id) }))
  if (cues.length) await writeSrt(project, cues)

  return {
    translatedCount: translations.size,
    segmentCount: segments.length,
    presetSlug: preset?.slug || null,
    targetLanguage,
    method: usedLlmDirect ? 'google_translate + llm_direct' : (hasStyle ? 'google_translate + llm_restyle' : 'google_translate'),
    styleFallback: false,
    unresolved: noStyleUnresolved,
  }
}

// Invariant: dub.translate COMPLETED chỉ khi mọi transcript segment có text
// đều có translation hợp lệ. Còn unresolved → throw FAILED, không success giả.
export function assertTranslateComplete(segments, translations, unresolved) {
  const required = (segments || []).filter((s) => s.text && String(s.text).trim())
  const requiredCount = required.length
  const translatedCount = translations?.size || 0
  const unresolvedList = Array.isArray(unresolved) ? unresolved : []
  if (unresolvedList.length > 0 || translatedCount !== requiredCount) {
    throw new Error(
      `dub.translate incomplete: ${translatedCount}/${requiredCount} translations` +
      (unresolvedList.length ? ` (unresolved: ${unresolvedList.join(',')})` : '')
    )
  }
}

// LLM DIRECT TRANSLATION fallback cho segment Google lỗi (404/configuration).
// Dịch trực tiếp source → target (không phải restyle), có validate + repair bounded.
// Không bịa translation, không copy source. Preserve index_num. Bounded: mỗi group
// tối đa 2 attempts cho TRANSIENT, PERMANENT/CONFIGURATION → dừng ngay.
export async function translateMissingWithLlm(llm, missingSegments, { system, targetLanguage, job, projectId, userId }) {
  const out = new Map() // index_num → validated translation
  if (!llm || !missingSegments?.length) return out
  const list = [...missingSegments].sort((a, b) => (a.index_num || 0) - (b.index_num || 0))
  // Nhóm theo window để giảm số LLM calls, giữ thứ tự/timing ở caller.
  const groups = []
  let cur = []
  let winStart = 0
  for (const s of list) {
    if (!cur.length) winStart = Number(s.start_sec) || 0
    if (cur.length && (Number(s.end_sec) - winStart) > 45) {
      groups.push(cur)
      cur = [s]
      winStart = Number(s.start_sec) || 0
    } else {
      cur.push(s)
    }
  }
  if (cur.length) groups.push(cur)

  for (const group of groups) {
    const requiredIndexes = group.map((s) => s.index_num)
    const prompt =
      `Dịch các câu sau sang ${languageName(targetLanguage)}. GIỮ ĐÚNG nghĩa, tên riêng, con số, phủ định, nghi vấn. Không bịa thêm, không copy nguyên văn nguồn.\n` +
      `Mỗi dòng có định dạng "index|src:câu nguồn". Giữ nguyên index.\n\n` +
      group.map((s) => `${s.index_num}|src:${s.text}`).join('\n') +
      `\n\nTrả về DUY NHẤT JSON: {"segments":[{"index":int,"translation":string}]}`

    const estTokens = group.reduce((n, s) => n + Math.max(8, Math.ceil(String(s.text || '').length * 2.5)), 0) + 256
    const maxOutputTokens = Math.min(65536, Math.max(1024, Math.ceil(estTokens * 1.5)))

    let collected = new Map()
    let lastErr = null
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        collected = await translateGroup(llm, system, prompt, job, projectId, {
          requiredIndexes, maxOutputTokens, userId,
        })
        lastErr = null
        break
      } catch (err) {
        lastErr = err
        const cls = classifyProviderError(err)
        console.warn(`[dubTranslate] llm-direct attempt ${attempt} failed [${cls.kind}]: ${String(err.message || err).slice(0, 200)}`)
        if (cls.kind === ERROR_KINDS.TRANSIENT && attempt < 2) {
          await sleepMs(1000 * attempt)
          continue
        }
        break
      }
    }
    if (lastErr && collected.size === 0) continue

    for (const seg of group) {
      let txt = collected.get(seg.index_num)
      if (txt) txt = String(txt).trim()
      // Từ chối JSON artifact lọt qua gate yếu (không phải bản dịch thật).
      if (txt && !/[{}[\]]/.test(txt) && !hasHardTranslationError(seg.text, txt, targetLanguage).hard) {
        out.set(seg.index_num, txt)
        continue
      }
      // Semantic fail → repair bounded 1 lần. Vẫn fail → để unresolved (caller fail stage).
      if (txt) {
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
  }
  return out
}

// ── Fault isolation cho style transformation ─────────────────────────
// sourceText → baseTranslation (Google, đã validate) → styledTranslation
// (LLM, phải qua validate) → finalTranslation.
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
      console.warn(`[dubTranslate] restyle attempt ${attempt} failed [${classification.kind}]: ${String(err.message || err).slice(0, 200)}`)
      if (classification.kind === ERROR_KINDS.TRANSIENT && attempt < 2) {
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
    `Mỗi dòng có định dạng "index|src:nguồn|tgt:bản dịch". Giữ nguyên index, CHỈ viết lại phần bản dịch (sau "tgt:").\n\n` +
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

async function writeSrt(project, cues) {
  if (!cues.length) return
  const dir = projectDir(project.id)
  fs.mkdirSync(dir, { recursive: true })
  const srtPath = path.join(dir, 'subtitles.srt')
  const body = cues
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`)
    .join('\n')
  fs.writeFileSync(srtPath, body, 'utf8')

  await run(`DELETE FROM subtitles WHERE project_id = ?`, [project.id])
  await insert('subtitles', {
    id: uuidv4(),
    project_id: project.id,
    format: 'srt',
    language: parseParams(project.params).targetLanguage || 'vi',
    storage_key: null,
    cues: JSON.stringify(cues),
  })
}

// Giữ lại translateGroup làm fallback (nếu Google Translate lỗi)
export async function translateGroup(llm, system, prompt, job, projectId, opts = {}) {
  const { requiredIndexes = null, maxOutputTokens = null, userId = null } = opts
  const call = (p) =>
    callProvider({
      provider: llm.id,
      type: 'llm',
      model: llm.provider.model || llm.id,
      input: { system, prompt: p, json: true, temperature: 0.4, maxOutputTokens },
      fn: () => llm.provider.complete({ system, prompt: p, json: true, temperature: 0.4, maxOutputTokens }),
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

const NEG_EN = ['not', 'no', 'never', "n't", 'without', 'none']
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
  if (hasNegation(s, 'en') !== hasNegation(t, 'vi') && /[a-z]/i.test(s)) {
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
  const ratio = t.length / Math.max(1, s.length)
  // CJK chars expand ~3-8x into Vietnamese; the latin 0.3-3 band would reject
  // every correct zh->vi translation (live GT ratios 3.4-7.7).
  const maxRatio = countCjk(s) > 0 ? 8 : 3
  if (ratio < 0.3 || ratio > maxRatio) errors.push('length implausible (hallucination?)')
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
    if (out && validateTranslation(source, out, targetLanguage).ok) return out
  } catch (_) {}
  return null
}

function buildSystemPrompt(preset, targetLanguage) {
  const base =
    `Bạn là biên tập viên lồng tiếng chuyên nghiệp. Nhiệm vụ: viết lại câu lồng tiếng sang ${languageName(targetLanguage)}.` +
    ` Luôn giữ ý nghĩa gốc, không bịa thêm chi tiết.`
  if (preset?.system_prompt) return `${base} Văn phong bắt buộc — ${preset.name}: ${preset.system_prompt}`
  return `${base} Văn phong trung tính tự nhiên.`
}

function buildRestyleSystemPrompt(preset, targetLanguage) {
  const base =
    `Bạn là biên tập viên lồng tiếng chuyên nghiệp. Nhiệm vụ: VIẾT LẠI câu lồng tiếng đã được dịch sẵn sang ${languageName(targetLanguage)}.` +
    ` BẢN DỊCH GỐC ĐÃ ĐÚNG NGHĨA — bạn CHỈ thay đổi văn phong, KHÔNG được thay đổi ý nghĩa.` +
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
