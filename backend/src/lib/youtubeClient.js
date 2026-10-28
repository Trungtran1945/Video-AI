import fs from 'node:fs'
import https from 'node:https'
import { URL } from 'node:url'

// Thin, injectable YouTube/Google HTTP client. No token is ever logged, and
// error messages are reduced to provider codes so callers never persist or
// return upstream text that could contain credentials.

export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
]

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const API_BASE = 'https://www.googleapis.com/youtube/v3'
const UPLOAD_BASE = 'https://www.googleapis.com/upload/youtube/v3'

export class YouTubeHttpError extends Error {
  constructor({ status, code, retryable, quota, invalidGrant, message }) {
    super(message || code)
    this.name = 'YouTubeHttpError'
    this.status = status
    this.code = code
    this.retryable = Boolean(retryable)
    this.quota = Boolean(quota)
    this.invalidGrant = Boolean(invalidGrant)
  }
}

export function mapGoogleError(status, bodyText) {
  const text = String(bodyText || '')
  const quota = status === 403 && /quotaExceeded|dailyLimitExceeded|rateLimitExceeded/i.test(text)
  const invalidGrant = /invalid_grant/i.test(text)
  let code = 'YOUTUBE_ERROR'
  if (status === 401) code = 'YOUTUBE_AUTH_FAILED'
  else if (quota) code = 'YOUTUBE_QUOTA_EXCEEDED'
  else if (status === 429) code = 'YOUTUBE_RATE_LIMITED'
  else if (status === 403) code = 'YOUTUBE_FORBIDDEN'
  else if (status === 404) code = 'YOUTUBE_NOT_FOUND'
  else if (status === 400) code = 'YOUTUBE_INVALID_REQUEST'
  else if (status >= 500) code = 'YOUTUBE_UNAVAILABLE'
  return {
    status,
    code,
    retryable: status === 429 || status >= 500 || quota,
    quota,
    invalidGrant,
    message: `${code} (HTTP ${status})`,
  }
}

function formBody(values) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  }
  return params.toString()
}

async function readBody(res) {
  try {
    return await res.text()
  } catch (_) {
    return ''
  }
}

function makeJsonRequest(fetchImpl) {
  return async function requestJson(url, { method = 'GET', headers = {}, body } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60_000)
    let res
    try {
      res = await fetchImpl(url, { method, headers, body, signal: controller.signal })
    } catch (err) {
      throw new YouTubeHttpError({
        status: 0,
        code: err?.name === 'AbortError' ? 'YOUTUBE_TIMEOUT' : 'YOUTUBE_NETWORK_ERROR',
        retryable: true,
        message: err?.name === 'AbortError' ? 'YOUTUBE_TIMEOUT' : 'YOUTUBE_NETWORK_ERROR',
      })
    } finally {
      clearTimeout(timer)
    }
    const text = await readBody(res)
    if (!res.ok) throw new YouTubeHttpError(mapGoogleError(res.status, text))
    if (!text) return { status: res.status, headers: res.headers, data: null }
    try {
      return { status: res.status, headers: res.headers, data: JSON.parse(text) }
    } catch (_) {
      return { status: res.status, headers: res.headers, data: null }
    }
  }
}

function streamUpload(sessionUri, filePath, start, end, total) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(sessionUri)
    } catch (_) {
      reject(new YouTubeHttpError({ status: 0, code: 'YOUTUBE_INVALID_SESSION', retryable: false, message: 'YOUTUBE_INVALID_SESSION' }))
      return
    }
    const length = end - start + 1
    const req = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': length,
        'Content-Range': `bytes ${start}-${end}/${total}`,
      },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.setTimeout(120_000, () => req.destroy(new Error('YOUTUBE_TIMEOUT')))
    req.on('error', (err) => {
      reject(new YouTubeHttpError({
        status: 0,
        code: err?.message === 'YOUTUBE_TIMEOUT' ? 'YOUTUBE_TIMEOUT' : 'YOUTUBE_NETWORK_ERROR',
        retryable: true,
        message: err?.message === 'YOUTUBE_TIMEOUT' ? 'YOUTUBE_TIMEOUT' : 'YOUTUBE_NETWORK_ERROR',
      }))
    })
    const stream = fs.createReadStream(filePath, { start, end })
    stream.on('error', (err) => {
      req.destroy()
      reject(err)
    })
    stream.pipe(req)
  })
}

function querySession(sessionUri, total) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(sessionUri)
    } catch (_) {
      reject(new YouTubeHttpError({ status: 0, code: 'YOUTUBE_INVALID_SESSION', retryable: false, message: 'YOUTUBE_INVALID_SESSION' }))
      return
    }
    const req = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: 'PUT',
      headers: {
        'Content-Range': `bytes */${total}`,
        'Content-Length': 0,
      },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.setTimeout(120_000, () => req.destroy(new Error('YOUTUBE_TIMEOUT')))
    req.on('error', (err) => {
      reject(new YouTubeHttpError({
        status: 0,
        code: err?.message === 'YOUTUBE_TIMEOUT' ? 'YOUTUBE_TIMEOUT' : 'YOUTUBE_NETWORK_ERROR',
        retryable: true,
        message: err?.message === 'YOUTUBE_TIMEOUT' ? 'YOUTUBE_TIMEOUT' : 'YOUTUBE_NETWORK_ERROR',
      }))
    })
    req.end()
  })
}

export function createYouTubeClient({ fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const requestJson = makeJsonRequest(fetchImpl)

  return {
    now,

    buildAuthorizationUrl({ clientId, redirectUri, state, codeChallenge }) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: YOUTUBE_SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      })
      return `${AUTH_URL}?${params.toString()}`
    },

    async exchangeCode({ code, clientId, clientSecret, redirectUri, codeVerifier }) {
      const { data } = await requestJson(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({
          grant_type: 'authorization_code',
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      })
      return data
    },

    async refreshAccessToken({ refreshToken, clientId, clientSecret }) {
      const { data } = await requestJson(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      })
      return data
    },

    async revokeToken({ token }) {
      await requestJson(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '',
      })
    },

    async fetchChannel({ accessToken }) {
      const { data } = await requestJson(`${API_BASE}/channels?part=snippet&mine=true`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      return Array.isArray(data?.items) ? data.items : []
    },

    async initiateResumableUpload({ accessToken, metadata, size }) {
      const res = await requestJson(
        `${UPLOAD_BASE}/videos?uploadType=resumable&part=snippet,status`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': 'video/mp4',
            'X-Upload-Content-Length': String(size),
          },
          body: JSON.stringify(metadata),
        }
      )
      const location = res.headers?.get?.('location') || res.headers?.location || null
      if (!location) {
        throw new YouTubeHttpError({ status: 0, code: 'YOUTUBE_SESSION_MISSING', retryable: true, message: 'YOUTUBE_SESSION_MISSING' })
      }
      return location
    },

    async uploadChunk({ sessionUri, filePath, start, end, total }) {
      const res = await streamUpload(sessionUri, filePath, start, end, total)
      if (res.status === 200 || res.status === 201) {
        let data = null
        try { data = JSON.parse(res.body) } catch (_) {}
        return { status: res.status, complete: true, video: data, range: null }
      }
      if (res.status === 308) {
        const range = res.headers?.range || null
        return { status: res.status, complete: false, video: null, range }
      }
      if (res.status === 401) {
        throw new YouTubeHttpError({ status: 401, code: 'YOUTUBE_AUTH_FAILED', retryable: false, message: 'YOUTUBE_AUTH_FAILED' })
      }
      throw new YouTubeHttpError(mapGoogleError(res.status, res.body))
    },

    async queryUploadStatus({ sessionUri, total }) {
      const res = await querySession(sessionUri, total)
      if (res.status === 200 || res.status === 201) {
        let data = null
        try { data = JSON.parse(res.body) } catch (_) {}
        return { status: res.status, complete: true, video: data, range: null }
      }
      if (res.status === 308) {
        return { status: 308, complete: false, video: null, range: res.headers?.range || null }
      }
      if (res.status === 401) {
        throw new YouTubeHttpError({ status: 401, code: 'YOUTUBE_AUTH_FAILED', retryable: false, message: 'YOUTUBE_AUTH_FAILED' })
      }
      throw new YouTubeHttpError(mapGoogleError(res.status, res.body))
    },

    async fetchVideoStatus({ accessToken, videoId }) {
      const { data } = await requestJson(
        `${API_BASE}/videos?part=status,processingDetails&id=${encodeURIComponent(videoId)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      )
      return Array.isArray(data?.items) ? data.items[0] || null : null
    },

    async setThumbnail({ accessToken, videoId, filePath }) {
      const body = fs.readFileSync(filePath)
      await requestJson(`${UPLOAD_BASE}/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'image/jpeg',
          'Content-Length': String(body.length),
        },
        body,
      })
    },
  }
}

export const youtubeClient = createYouTubeClient()

export default youtubeClient
