// Task 1: cache identity (videoHash + source/target + style + ocrMode + version)
// Run: node backend/tests/cacheIdentity.test.mjs
import { TRANSLATION_VERSION, buildCacheKey, isCacheCompatible, parseProjectParams } from '../src/lib/cacheKey.js'

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const base = {
  videoHash: 'abc123',
  sourceLanguage: 'zh',
  targetLanguage: 'vi',
  stylePreset: 'phim-hanh-dong',
  ocrMode: false,
  translationVersion: TRANSLATION_VERSION,
}

// Full match -> compatible + key bằng nhau
assert(isCacheCompatible(base, { ...base }) === true, 'full match -> compatible')
assert(buildCacheKey(base) === buildCacheKey({ ...base }), 'full match -> key equal')

// Style khác -> key khác + incompatible
const diffStyle = { ...base, stylePreset: 'tinh-cam' }
assert(buildCacheKey(base) !== buildCacheKey(diffStyle), 'style khác -> key khác')
assert(isCacheCompatible(base, diffStyle) === false, 'style khác -> incompatible')

// Source zh vs en -> incompatible (và 'auto' != 'zh')
assert(isCacheCompatible(base, { ...base, sourceLanguage: 'en' }) === false, 'source zh vs en -> incompatible')
assert(isCacheCompatible(base, { ...base, sourceLanguage: 'auto' }) === false, "source 'auto' != 'zh' -> incompatible")

// ocrMode true vs false -> incompatible
assert(isCacheCompatible(base, { ...base, ocrMode: true }) === false, 'ocrMode true vs false -> incompatible')

// Version khác -> incompatible
assert(isCacheCompatible(base, { ...base, translationVersion: TRANSLATION_VERSION + 1 }) === false, 'version khác -> incompatible')
assert(isCacheCompatible(base, {}) === false, 'cached rỗng (thiếu version) -> incompatible')

// parseProjectParams an toàn
assert(JSON.stringify(parseProjectParams(null)) === '{}', 'parse null -> {}')
assert(JSON.stringify(parseProjectParams('not-json')) === '{}', 'parse invalid JSON -> {}')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
