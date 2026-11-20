/**
 * Centralized XSS Sanitization & Protection Module.
 * Provides robust HTML escaping, strict URL validation, and subtitle payload sanitization.
 */

const HTML_ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

const HTML_UNESCAPE_MAP = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
}

/**
 * Encodes special HTML characters to prevent XSS in HTML contexts.
 *
 * @param {any} str
 * @returns {string} Escaped string
 */
export function escapeHtml(str) {
  if (str === null || str === undefined) return ''
  return String(str).replace(/[&<>"']/g, (m) => HTML_ESCAPE_MAP[m])
}

/**
 * Decodes HTML entities back to their raw characters.
 *
 * @param {any} str
 * @returns {string} Unescaped string
 */
export function unescapeHtml(str) {
  if (str === null || str === undefined) return ''
  return String(str).replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => HTML_UNESCAPE_MAP[m])
}

/**
 * Sanitizes URLs to prevent javascript:, data:text/html, vbscript:, and file: XSS vectors.
 *
 * @param {string} rawUrl - Target URL string
 * @param {string[]} [allowedProtocols=['http:', 'https:']] - Permitted URL protocols
 * @returns {string} Safe URL or empty string if invalid or dangerous
 */
export function sanitizeUrl(rawUrl, allowedProtocols = ['http:', 'https:']) {
  if (!rawUrl || typeof rawUrl !== 'string') return ''
  const trimmed = rawUrl.trim()
  if (!trimmed) return ''

  // Normalize allowedProtocols to lowercase ending with ':'
  const validProtocols = new Set(
    allowedProtocols.map((p) => (p.endsWith(':') ? p.toLowerCase() : `${p.toLowerCase()}:`))
  )

  // Strip control characters, null bytes, and inner whitespace that attackers use for protocol evasion
  const cleaned = trimmed.replace(/[\u0000-\u001F\u007F-\u009F\s]/g, '')

  // Immediately reject dangerous pseudo-protocols
  if (/^(javascript|vbscript|data|file|blob):/i.test(cleaned)) {
    return ''
  }

  // Reject protocol-relative URLs (//evil.com) and backslash paths (/\\evil.com)
  if (cleaned.startsWith('//') || cleaned.startsWith('/\\') || cleaned.startsWith('\\\\')) {
    return ''
  }

  // Allow legitimate root-relative paths (/storage/..., /api/...)
  if (cleaned.startsWith('/')) {
    return cleaned
  }

  try {
    const parsed = new URL(cleaned)
    if (validProtocols.has(parsed.protocol.toLowerCase())) {
      // Disallow data:text/html or executable data MIME types even if 'data:' is ever whitelisted
      if (parsed.protocol.toLowerCase() === 'data:') {
        if (/^data:\s*text\/(?:html|javascript|xml)/i.test(cleaned)) {
          return ''
        }
      }
      return cleaned
    }
    return ''
  } catch (_) {
    return ''
  }
}

/**
 * Sanitizes subtitle text for ASS and SRT/VTT formats.
 * Prevents ASS override tag injection ({\pos...}, {\clip...}) and SRT HTML script injection,
 * while preserving 100% of Vietnamese accents, CJK characters, and international UTF-8 text.
 *
 * @param {string} text - Subtitle cue text
 * @param {'ass'|'srt'|'vtt'} [format='srt'] - Target subtitle format
 * @returns {string} Sanitized subtitle text
 */
export function sanitizeSubtitleText(text, format = 'srt') {
  if (text === null || text === undefined) return ''
  const s = String(text)
  const fmt = String(format || 'srt').toLowerCase()

  if (fmt === 'ass') {
    // In ASS format, curly braces control style overrides (e.g. {\pos(100,100)}).
    // Escaping { and } neutralizes override tags without altering the visible text.
    return s
      .replace(/\\/g, '\\\\')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}')
      .replace(/\r?\n/g, '\\N')
  }

  // For SRT / VTT formats:
  // 1. Strip executable script, iframe, object, embed, and style tags entirely
  let sanitized = s
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
    .replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, '')

  // 2. Strip event handlers (e.g. onerror=..., onload=...)
  sanitized = sanitized.replace(/\bon\w+\s*=\s*(['"]).*?\1/gi, '')
  sanitized = sanitized.replace(/\bon\w+\s*=\s*[^>\s]+/gi, '')
  sanitized = sanitized.replace(/\s+>/g, '>')

  // 3. Neutralize non-formatting HTML tags while permitting safe SRT tags <b>, <i>, <u>
  sanitized = sanitized.replace(/<\/?([a-zA-Z0-9]+)([^>]*)>/g, (match, tag, attrs) => {
    const cleanTag = tag.toLowerCase()
    if (['b', 'i', 'u'].includes(cleanTag) && !/\bon\w+/i.test(attrs) && !/javascript:/i.test(attrs)) {
      return match.startsWith('</') ? `</${cleanTag}>` : `<${cleanTag}>`
    }
    return match.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  })

  return sanitized
}

const XSS_ATTEMPT_REGEX = /<\/?(?:script|iframe|img|svg|object|embed|style|link|html|body|div|span|p|a|input|button|form)\b|\bon\w+\s*=|javascript:/i

/**
 * Sanitizes API error message strings to prevent reflected XSS.
 * If message contains executable script or HTML tags, encodes them safely.
 *
 * @param {string} message
 * @returns {string} Safe error message
 */
export function sanitizeErrorMessage(message) {
  if (typeof message !== 'string') return message
  if (XSS_ATTEMPT_REGEX.test(message)) {
    return escapeHtml(message)
  }
  return message
}

export default {
  escapeHtml,
  unescapeHtml,
  sanitizeUrl,
  sanitizeSubtitleText,
  sanitizeErrorMessage,
}
