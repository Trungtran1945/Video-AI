/**
 * Canonicalizes an email address to defend against alias abuse and account multiplication (SEC-05).
 * - Trims whitespace and converts to lowercase.
 * - For Gmail/Googlemail:
 *   - Normalizes domain @googlemail.com -> @gmail.com
 *   - Removes dots from local part: "john.doe@gmail.com" -> "johndoe@gmail.com"
 *   - Removes plus-addressing (sub-addressing): "johndoe+promo1@gmail.com" -> "johndoe@gmail.com"
 * - For other domains (Outlook, Yahoo, Proton, iCloud, custom):
 *   - Trims and lowercases
 *   - Removes plus-addressing tags: "user+alias@domain.com" -> "user@domain.com"
 *
 * @param {string} email
 * @returns {string} canonical email
 */
export function canonicalizeEmail(email) {
  if (typeof email !== 'string') return ''
  const trimmed = email.trim().toLowerCase()
  const atIndex = trimmed.lastIndexOf('@')
  if (atIndex <= 0 || atIndex === trimmed.length - 1) return trimmed

  let local = trimmed.slice(0, atIndex)
  let domain = trimmed.slice(atIndex + 1)

  // Normalize googlemail.com to gmail.com
  if (domain === 'googlemail.com') {
    domain = 'gmail.com'
  }

  if (domain === 'gmail.com') {
    // Gmail ignores all dots in the username
    local = local.replace(/\./g, '')
    // Gmail plus addressing
    const plusIndex = local.indexOf('+')
    if (plusIndex !== -1) {
      local = local.slice(0, plusIndex)
    }
  } else {
    // Standard plus-addressing removal
    const plusIndex = local.indexOf('+')
    if (plusIndex !== -1) {
      local = local.slice(0, plusIndex)
    }
  }

  return `${local}@${domain}`
}

/**
 * Checks if two email addresses resolve to the same canonical inbox
 */
export function isEmailCanonicalEquivalent(email1, email2) {
  return canonicalizeEmail(email1) === canonicalizeEmail(email2)
}

export default {
  canonicalizeEmail,
  isEmailCanonicalEquivalent,
}
