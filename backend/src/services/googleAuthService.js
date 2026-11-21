import { OAuth2Client } from 'google-auth-library'
import { config } from '../config.js'

const VALID_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com'])

let defaultClient = null
let customClientForTest = null

export function getGoogleOAuthClient() {
  if (customClientForTest && process.env.NODE_ENV === 'test') {
    return customClientForTest
  }
  if (!defaultClient) {
    const clientId = config.googleClientId || config.google?.clientId || process.env.GOOGLE_CLIENT_ID || ''
    defaultClient = new OAuth2Client(clientId)
  }
  return defaultClient
}

export function __setGoogleOAuthClientForTest(client) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Cannot set mock OAuth2Client outside test environment')
  }
  customClientForTest = client
}

export function __resetGoogleOAuthClientForTest() {
  customClientForTest = null
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

/**
 * Strictly verifies a Google ID Token using OAuth2Client.verifyIdToken.
 * Enforces:
 * - Valid cryptographic signature
 * - Valid issuer (accounts.google.com or https://accounts.google.com)
 * - Audience matches backend GOOGLE_CLIENT_ID
 * - Token not expired
 * - Valid sub (Google user ID)
 * - Valid email
 * - email_verified === true
 * Fail-closed: Never fall back to unverified decoding.
 *
 * @param {string} idToken
 * @param {object} [options]
 * @returns {Promise<{ sub: string, email: string, name: string, avatar: string|null, emailVerified: boolean }>}
 */
export async function verifyGoogleIdToken(idToken, options = {}) {
  if (!idToken || typeof idToken !== 'string') {
    return null
  }

  const tokenStr = idToken.trim()
  if (!tokenStr) {
    return null
  }

  const expectedAudience = options.audience || config.googleClientId || config.google?.clientId || process.env.GOOGLE_CLIENT_ID || ''
  if (!expectedAudience && process.env.NODE_ENV === 'production') {
    console.error('[GoogleAuth] Server misconfigured: GOOGLE_CLIENT_ID is missing in production')
    return null
  }

  const client = options.client || getGoogleOAuthClient()

  let ticket
  try {
    ticket = await client.verifyIdToken({
      idToken: tokenStr,
      audience: expectedAudience || undefined,
    })
  } catch (_err) {
    // Verification failed (signature invalid, expired, aud mismatch, etc.)
    return null
  }

  if (!ticket || typeof ticket.getPayload !== 'function') {
    return null
  }

  const payload = ticket.getPayload()
  if (!payload || typeof payload !== 'object') {
    return null
  }

  // 1. Enforce issuer
  if (!payload.iss || !VALID_ISSUERS.has(payload.iss)) {
    return null
  }

  // 2. Enforce audience if expectedAudience is configured
  if (expectedAudience && payload.aud !== expectedAudience) {
    return null
  }

  // 3. Enforce expiration
  const nowSec = Math.floor(Date.now() / 1000)
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
    return null
  }

  // 4. Enforce sub
  if (!payload.sub || typeof payload.sub !== 'string' || !payload.sub.trim()) {
    return null
  }

  // 5. Enforce email
  if (!payload.email || typeof payload.email !== 'string' || !isValidEmail(payload.email)) {
    return null
  }

  // 6. Enforce email_verified === true
  const isEmailVerified = payload.email_verified === true || payload.email_verified === 'true'
  if (!isEmailVerified) {
    return null
  }

  return {
    sub: String(payload.sub).trim(),
    email: String(payload.email).trim().toLowerCase(),
    name: payload.name ? String(payload.name).trim() : String(payload.email).split('@')[0],
    avatar: payload.picture ? String(payload.picture).trim() : null,
    emailVerified: true,
  }
}
