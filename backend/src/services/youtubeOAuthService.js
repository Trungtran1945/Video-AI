import crypto from 'node:crypto'
import { v4 as uuidv4 } from 'uuid'
import { queryOne, run, runAffected, insert } from '../db/query.js'
import { config } from '../config.js'
import { encrypt, decrypt } from '../lib/crypto.js'
import { youtubeClient, YOUTUBE_SCOPES } from '../lib/youtubeClient.js'

// YouTube OAuth: state is single-use and stored hashed; the PKCE verifier and
// both tokens are encrypted at rest. No token, code or secret is ever logged.

const STATE_TTL_MS = 10 * 60 * 1000
const REFRESH_WINDOW_MS = 60 * 1000
const stateLocks = new Map()

export class YoutubeError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message || code)
    this.name = 'YoutubeError'
    this.code = code
    this.statusCode = statusCode
  }
}

export function isYoutubeConfigured() {
  const y = config.youtube || {}
  return Boolean(y.clientId && y.clientSecret && y.redirectUri)
}

function requireConfigured() {
  if (!isYoutubeConfigured()) {
    throw new YoutubeError('YOUTUBE_NOT_CONFIGURED', 'YouTube OAuth chưa được cấu hình (YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET / YOUTUBE_REDIRECT_URI)', 503)
  }
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

export function isPlausibleState(state) {
  return typeof state === 'string' && /^[A-Za-z0-9_-]{20,200}$/.test(state)
}

export async function startOAuth(userId, { client = youtubeClient, now = Date.now() } = {}) {
  requireConfigured()
  const y = config.youtube
  const state = base64url(crypto.randomBytes(32))
  const verifier = base64url(crypto.randomBytes(64))
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
  const nowIso = new Date(now).toISOString()
  const expiresAt = new Date(now + STATE_TTL_MS).toISOString()

  await run(
    `DELETE FROM youtube_oauth_states WHERE user_id = ? AND (used_at IS NOT NULL OR expires_at <= ?)`,
    [userId, nowIso],
    { op: 'youtube.oauth.cleanup' }
  )
  await insert('youtube_oauth_states', {
    id: uuidv4(),
    state_hash: sha256Hex(state),
    user_id: userId,
    code_verifier_enc: encrypt(verifier),
    redirect_to: y.redirectUri,
    expires_at: expiresAt,
    used_at: null,
    created_date: nowIso,
  })

  return {
    authorizationUrl: client.buildAuthorizationUrl({
      clientId: y.clientId,
      redirectUri: y.redirectUri,
      state,
      codeChallenge: challenge,
    }),
    expiresInSec: STATE_TTL_MS / 1000,
  }
}

export async function completeOAuth({ code, state }, { client = youtubeClient, now = Date.now() } = {}) {
  requireConfigured()
  if (!code || typeof code !== 'string' || !isPlausibleState(state)) {
    throw new YoutubeError('invalid_state', 'OAuth state không hợp lệ')
  }
  const stateHash = sha256Hex(state)
  const row = await queryOne('SELECT * FROM youtube_oauth_states WHERE state_hash = ?', [stateHash])
  const nowIso = new Date(now).toISOString()
  if (!row || row.used_at || new Date(row.expires_at).getTime() <= now) {
    throw new YoutubeError('invalid_state', 'OAuth state không hợp lệ hoặc đã hết hạn')
  }
  const claimed = await runAffected(
    `UPDATE youtube_oauth_states SET used_at = ? WHERE state_hash = ? AND used_at IS NULL AND expires_at > ?`,
    [nowIso, stateHash, nowIso],
    { op: 'youtube.oauth.claim' }
  )
  if (claimed !== 1) throw new YoutubeError('invalid_state', 'OAuth state đã được sử dụng')

  let verifier
  try {
    verifier = decrypt(row.code_verifier_enc)
  } catch (_) {
    throw new YoutubeError('invalid_state', 'OAuth state không đọc được')
  }

  let token
  try {
    token = await client.exchangeCode({
      code,
      clientId: config.youtube.clientId,
      clientSecret: config.youtube.clientSecret,
      redirectUri: row.redirect_to || config.youtube.redirectUri,
      codeVerifier: verifier,
    })
  } catch (err) {
    throw new YoutubeError('token_exchange_failed', `Đổi OAuth code thất bại (${err?.code || 'YOUTUBE_ERROR'})`)
  }
  const scopes = String(token?.scope || '')
  if (!scopes.includes('youtube.upload')) {
    throw new YoutubeError('scope_missing', 'Tài khoản chưa cấp quyền youtube.upload')
  }
  if (!token?.access_token) {
    throw new YoutubeError('token_exchange_failed', 'Google không trả access token')
  }

  let channel = null
  try {
    const items = await client.fetchChannel({ accessToken: token.access_token })
    channel = items[0] || null
  } catch (err) {
    throw new YoutubeError('channel_not_found', `Không lấy được kênh YouTube (${err?.code || 'YOUTUBE_ERROR'})`)
  }
  if (!channel?.id) throw new YoutubeError('channel_not_found', 'Không tìm thấy kênh YouTube')

  const expiresAt = new Date(now + Number(token.expires_in || 3600) * 1000).toISOString()
  const existing = await queryOne('SELECT * FROM youtube_accounts WHERE user_id = ?', [row.user_id])
  const refreshEnc = token.refresh_token
    ? encrypt(token.refresh_token)
    : (existing?.refresh_token_enc || null)
  const accessEnc = encrypt(token.access_token)
  const title = channel.snippet?.title || null
  if (existing) {
    await run(
      `UPDATE youtube_accounts SET channel_id = ?, channel_title = ?, access_token_enc = ?, refresh_token_enc = ?,
       token_expires_at = ?, scopes = ?, status = 'connected', connected_at = ?, updated_at = ? WHERE id = ?`,
      [channel.id, title, accessEnc, refreshEnc, expiresAt, scopes, nowIso, nowIso, existing.id],
      { op: 'youtube.account.update' }
    )
  } else {
    await insert('youtube_accounts', {
      id: uuidv4(),
      user_id: row.user_id,
      channel_id: channel.id,
      channel_title: title,
      access_token_enc: accessEnc,
      refresh_token_enc: refreshEnc,
      token_expires_at: expiresAt,
      scopes,
      status: 'connected',
      connected_at: nowIso,
      updated_at: nowIso,
    })
  }

  return { channelId: channel.id, channelTitle: title }
}

export async function getAccount(userId) {
  const row = await queryOne('SELECT * FROM youtube_accounts WHERE user_id = ?', [userId])
  if (!row || row.status !== 'connected') return { connected: false }
  return {
    connected: true,
    channelId: row.channel_id,
    channelTitle: row.channel_title,
    connectedAt: row.connected_at,
    scopes: String(row.scopes || '').split(/\s+/).filter(Boolean),
  }
}

export async function getAccountRow(userId) {
  return queryOne('SELECT * FROM youtube_accounts WHERE user_id = ?', [userId])
}

export async function disconnectAccount(userId, { client = youtubeClient } = {}) {
  const row = await queryOne('SELECT * FROM youtube_accounts WHERE user_id = ?', [userId])
  if (!row) return { disconnected: true }
  try {
    const refreshToken = row.refresh_token_enc ? decrypt(row.refresh_token_enc) : null
    if (refreshToken) await client.revokeToken({ token: refreshToken })
  } catch (err) {
    // Local disconnect always wins; never block on revoke.
    console.warn(`[YouTube] revoke failed code=${err?.code || 'YOUTUBE_ERROR'}`)
  }
  await run('DELETE FROM youtube_accounts WHERE user_id = ?', [userId], { op: 'youtube.account.delete' })
  return { disconnected: true }
}

async function refreshAccount(account, { client, now }) {
  if (!account.refresh_token_enc) {
    throw new YoutubeError('YOUTUBE_REAUTH_REQUIRED', 'Tài khoản YouTube chưa có refresh token — hãy kết nối lại')
  }
  let token
  try {
    token = await client.refreshAccessToken({
      refreshToken: decrypt(account.refresh_token_enc),
      clientId: config.youtube.clientId,
      clientSecret: config.youtube.clientSecret,
    })
  } catch (err) {
    if (err?.invalidGrant || err?.status === 400 || err?.status === 401) {
      await run(
        `UPDATE youtube_accounts SET status = 'revoked', updated_at = ? WHERE id = ?`,
        [new Date(now).toISOString(), account.id],
        { op: 'youtube.account.revoke' }
      )
      throw new YoutubeError('YOUTUBE_REAUTH_REQUIRED', 'Refresh token đã bị thu hồi — hãy kết nối lại YouTube')
    }
    throw err
  }
  if (!token?.access_token) {
    throw new YoutubeError('YOUTUBE_REAUTH_REQUIRED', 'Google không trả access token mới')
  }
  const expiresAt = new Date(now + Number(token.expires_in || 3600) * 1000).toISOString()
  await run(
    `UPDATE youtube_accounts SET access_token_enc = ?, token_expires_at = ?, status = 'connected', updated_at = ? WHERE id = ?`,
    [encrypt(token.access_token), expiresAt, new Date(now).toISOString(), account.id],
    { op: 'youtube.account.refresh' }
  )
  return token.access_token
}

export async function getValidAccessToken(account, { client = youtubeClient, now = Date.now() } = {}) {
  if (!account || account.status !== 'connected') {
    throw new YoutubeError('YOUTUBE_NOT_CONNECTED', 'Chưa kết nối kênh YouTube', 409)
  }
  const expiresAt = new Date(account.token_expires_at || 0).getTime()
  if (expiresAt > now + REFRESH_WINDOW_MS && account.access_token_enc) {
    return decrypt(account.access_token_enc)
  }
  const existing = stateLocks.get(account.id)
  if (existing) return existing
  const pending = refreshAccount(account, { client, now })
    .finally(() => stateLocks.delete(account.id))
  stateLocks.set(account.id, pending)
  return pending
}

// Used after a provider 401: force a refresh even when the stored expiry still
// looks valid. Shares the single-flight lock to avoid refresh storms.
export async function forceRefreshAccessToken(account, { client = youtubeClient, now = Date.now() } = {}) {
  if (!account || account.status !== 'connected') {
    throw new YoutubeError('YOUTUBE_NOT_CONNECTED', 'Chưa kết nối kênh YouTube', 409)
  }
  const existing = stateLocks.get(account.id)
  if (existing) return existing
  const pending = refreshAccount(account, { client, now })
    .finally(() => stateLocks.delete(account.id))
  stateLocks.set(account.id, pending)
  return pending
}

export default {
  YoutubeError,
  YOUTUBE_SCOPES,
  isYoutubeConfigured,
  isPlausibleState,
  startOAuth,
  completeOAuth,
  getAccount,
  getAccountRow,
  disconnectAccount,
  getValidAccessToken,
  forceRefreshAccessToken,
}
