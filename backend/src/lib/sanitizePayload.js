/**
 * Mass Assignment Protection & Payload Sanitization
 *
 * Defines global and entity-specific protected fields,
 * and provides utility functions to filter or strip forbidden properties
 * preventing privilege escalation and record tampering (OWASP API3:2023 - Broken Object Property Level Authorization).
 */

export const GLOBAL_FORBIDDEN_FIELDS = Object.freeze([
  'id',
  'user_id',
  'owner_id',
  'role',
  'password',
  'refresh_token',
  'refresh_expires',
  'is_admin',
  'credits',
  'created_date',
  'created_at',
  'updated_date',
])

export const ENTITY_PROTECTED_FIELDS = Object.freeze({
  projects: [
    'id',
    'user_id',
    'status',
    'run_token',
    'lease_expires_at',
    'created_date',
    'video_hash',
    'source_video_id',
    'source_video_key',
  ],
  settings: [
    'user_id',
  ],
  users: [
    'id',
    'role',
    'password',
    'refresh_token',
    'refresh_expires',
    'is_admin',
    'credits',
    'created_date',
  ],
  api_keys: [
    'id',
    'user_id',
    'created_date',
  ],
})

export const ENTITY_ALLOWED_FIELDS = Object.freeze({
  projectUpdate: [
    'title',
    'description',
    'target_language',
    'language',
    'style',
    'aspect_ratio',
    'aspectRatio',
    'params',
    'resolution',
  ],
  apiKeyUpdate: [
    'isActive',
    'is_active',
    'label',
    'tier',
    'priority',
  ],
  settingsUpdate: [
    'default_language',
    'default_style',
    'default_duration',
    'max_retries',
    'auto_upload_youtube',
    'notify_on_complete',
    'active_llm_provider',
    'active_image_provider',
    'active_video_provider',
    'active_voice_provider',
    'active_subtitle_provider',
    'active_translate_provider',
    'voice_provider',
    'aspect_ratio',
  ],
})

/**
 * Retains only keys in `allowedFields` from payload.
 * Returns a new sanitized object.
 */
export function filterAllowedFields(payload, allowedFields = []) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {}
  }
  const allowedSet = new Set(allowedFields)
  const result = {}
  for (const key of Object.keys(payload)) {
    if (allowedSet.has(key)) {
      result[key] = payload[key]
    }
  }
  return result
}

/**
 * Removes any keys in `forbiddenFields` from payload.
 * Returns a new sanitized object.
 */
export function stripForbiddenFields(payload, forbiddenFields = GLOBAL_FORBIDDEN_FIELDS) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload
  }
  const forbiddenSet = new Set(forbiddenFields)
  const result = {}
  for (const key of Object.keys(payload)) {
    if (!forbiddenSet.has(key)) {
      result[key] = payload[key]
    }
  }
  return result
}

/**
 * Identifies if any forbidden fields exist in payload.
 * Returns array of offending field names (empty if clean).
 */
export function getForbiddenFieldsPresent(payload, forbiddenFields = GLOBAL_FORBIDDEN_FIELDS) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return []
  }
  const forbiddenSet = new Set(forbiddenFields)
  const found = []
  for (const key of Object.keys(payload)) {
    if (forbiddenSet.has(key)) {
      found.push(key)
    }
  }
  return found
}

/**
 * Asserts that no forbidden fields are present in payload.
 * Throws an Error with statusCode=400 and code='FORBIDDEN_FIELD' if any are detected.
 */
export function assertNoForbiddenFields(payload, forbiddenFields = GLOBAL_FORBIDDEN_FIELDS) {
  const found = getForbiddenFieldsPresent(payload, forbiddenFields)
  if (found.length > 0) {
    const err = new Error(`Modification of protected fields is not allowed: ${found.join(', ')}`)
    err.code = 'FORBIDDEN_FIELD'
    err.statusCode = 400
    err.fields = found
    throw err
  }
  return true
}

export default {
  GLOBAL_FORBIDDEN_FIELDS,
  ENTITY_PROTECTED_FIELDS,
  ENTITY_ALLOWED_FIELDS,
  filterAllowedFields,
  stripForbiddenFields,
  getForbiddenFieldsPresent,
  assertNoForbiddenFields,
}
