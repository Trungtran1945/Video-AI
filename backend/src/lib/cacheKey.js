// Cache identity cho TRANSLATE_DUB reuse (Task 1).
// Mọi field ảnh hưởng tới transcript/translation đều phải khớp thì mới
// được reuse bản dịch: videoHash, sourceLanguage, targetLanguage,
// stylePreset, ocrMode, translationVersion.
// Bump TRANSLATION_VERSION mỗi khi đổi logic dub.translate (gate,
// prompt restyle, Google Translate fallback...) để cache cũ không reuse nhầm.
export const TRANSLATION_VERSION = 2

const normHash = (v) => String(v ?? '').toLowerCase().trim()
const normLang = (v, fallback) => String(v ?? fallback).toLowerCase().trim()

export function parseProjectParams(raw) {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (_) {
    return {}
  }
}

// Key ổn định cho cache lookup / log. stylePreset giữ nguyên case
// (so sánh case-sensitive slug); các field còn lại lowercase normalize.
export function buildCacheKey({ videoHash, sourceLanguage, targetLanguage, stylePreset, ocrMode, translationVersion } = {}) {
  const key = {
    ocrMode: Boolean(ocrMode),
    sourceLanguage: normLang(sourceLanguage, 'auto'),
    stylePreset: String(stylePreset ?? ''),
    targetLanguage: normLang(targetLanguage, 'vi'),
    translationVersion: Number.isFinite(Number(translationVersion))
      ? Number(translationVersion)
      : TRANSLATION_VERSION,
    videoHash: normHash(videoHash),
  }
  return JSON.stringify(key)
}

// True chỉ khi mọi field đều bằng nhau. Chấp nhận object hoặc JSON string.
export function isCacheCompatible(newParams, cachedParams) {
  const a = parseProjectParams(newParams)
  const b = parseProjectParams(cachedParams)
  const hashA = normHash(a.videoHash ?? a.video_hash)
  const hashB = normHash(b.videoHash ?? b.video_hash)
  if (!hashA || !hashB || hashA !== hashB) return false
  if (normLang(a.sourceLanguage, 'auto') !== normLang(b.sourceLanguage, 'auto')) return false
  if (normLang(a.targetLanguage, 'vi') !== normLang(b.targetLanguage, 'vi')) return false
  if (String(a.stylePreset ?? '') !== String(b.stylePreset ?? '')) return false
  if (Boolean(a.ocrMode) !== Boolean(b.ocrMode)) return false
  if (Number(a.translationVersion) !== Number(b.translationVersion)) return false
  if (!Number.isFinite(Number(a.translationVersion))) return false
  return true
}

export default { TRANSLATION_VERSION, buildCacheKey, isCacheCompatible, parseProjectParams }
