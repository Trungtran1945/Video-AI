import assert from 'node:assert/strict'
import {
  validatePublishPayload,
  YoutubePublishError,
  YOUTUBE_PRIVACY,
  YOUTUBE_ACTIVE_STATUSES,
  YOUTUBE_TERMINAL_STATUSES,
} from '../src/services/youtubePublishService.js'
import { isPlausibleState } from '../src/services/youtubeOAuthService.js'

console.log('=== YouTube Publish & OAuth Workflow Tests ===\n')

// 1. validatePublishPayload
{
  console.log('--- 1. validatePublishPayload ---')
  // Happy path
  const valid = validatePublishPayload({
    title: 'Video giới thiệu trí tuệ nhân tạo',
    description: 'Mô tả chi tiết về video bài giảng AI.',
    tags: ['ai', 'cong nghe', 'video'],
    categoryId: '22',
    privacy: 'unlisted',
    confirmed: true,
  })
  assert.equal(valid.title, 'Video giới thiệu trí tuệ nhân tạo')
  assert.equal(valid.categoryId, '22')
  assert.equal(valid.privacy, 'unlisted')
  assert.equal(valid.tags.length, 3)

  // Title required
  assert.throws(
    () => validatePublishPayload({ title: '', confirmed: true }),
    (err) => err instanceof YoutubePublishError && err.code === 'YOUTUBE_TITLE_REQUIRED',
    'Rejects missing title'
  )

  // Title too long (>100)
  assert.throws(
    () => validatePublishPayload({ title: 'A'.repeat(101), confirmed: true }),
    (err) => err instanceof YoutubePublishError && err.code === 'YOUTUBE_TITLE_TOO_LONG',
    'Rejects title > 100 chars'
  )

  // Description too long (>5000)
  assert.throws(
    () => validatePublishPayload({ title: 'Valid', description: 'D'.repeat(5001), confirmed: true }),
    (err) => err instanceof YoutubePublishError && err.code === 'YOUTUBE_DESCRIPTION_TOO_LONG',
    'Rejects description > 5000 chars'
  )

  // Invalid tags
  assert.throws(
    () => validatePublishPayload({ title: 'Valid', tags: 'not-an-array', confirmed: true }),
    (err) => err instanceof YoutubePublishError && err.code === 'YOUTUBE_TAGS_INVALID',
    'Rejects non-array tags'
  )

  // Tag too long (>100)
  assert.throws(
    () => validatePublishPayload({ title: 'Valid', tags: ['T'.repeat(101)], confirmed: true }),
    (err) => err instanceof YoutubePublishError && err.code === 'YOUTUBE_TAG_TOO_LONG',
    'Rejects individual tag > 100 chars'
  )

  // Too many tags (>30)
  const thirtyOneTags = Array.from({ length: 31 }, (_, i) => `tag${i}`)
  assert.throws(
    () => validatePublishPayload({ title: 'Valid', tags: thirtyOneTags, confirmed: true }),
    (err) => err instanceof YoutubePublishError && err.code === 'YOUTUBE_TOO_MANY_TAGS',
    'Rejects > 30 tags'
  )

  // Category ID bounds
  assert.throws(
    () => validatePublishPayload({ title: 'Valid', categoryId: '99', confirmed: true }),
    (err) => err instanceof YoutubePublishError && err.code === 'YOUTUBE_CATEGORY_INVALID',
    'Rejects category ID > 44'
  )

  // Privacy enum
  assert.throws(
    () => validatePublishPayload({ title: 'Valid', privacy: 'secret', confirmed: true }),
    (err) => err instanceof YoutubePublishError && err.code === 'YOUTUBE_PRIVACY_INVALID',
    'Rejects invalid privacy value'
  )

  // Confirmation required
  assert.throws(
    () => validatePublishPayload({ title: 'Valid', confirmed: false }),
    (err) => err instanceof YoutubePublishError && err.code === 'YOUTUBE_CONFIRM_REQUIRED',
    'Rejects unconfirmed publish request'
  )

  console.log('PASS: validatePublishPayload validation gates')
}

// 2. OAuth State Plausibility
{
  console.log('--- 2. OAuth State validation ---')
  assert(isPlausibleState('a'.repeat(43)), '43-char base64url is plausible state')
  assert(isPlausibleState('A_B-C1234567890abcdef1234567890abcdef123456'), 'Valid base64url state accepted')
  assert(!isPlausibleState('short'), 'Short state (<20 chars) rejected')
  assert(!isPlausibleState('has spaces and special characters!@#$%'), 'Invalid characters rejected')
  assert(!isPlausibleState(null), 'Null state rejected')
  assert(!isPlausibleState(12345), 'Non-string state rejected')
  console.log('PASS: isPlausibleState')
}

// 3. Status sets consistency
{
  console.log('--- 3. Status consistency ---')
  assert.deepEqual(YOUTUBE_PRIVACY, ['private', 'unlisted', 'public'])
  assert.deepEqual(YOUTUBE_ACTIVE_STATUSES, ['queued', 'uploading', 'processing'])
  assert.deepEqual(YOUTUBE_TERMINAL_STATUSES, ['completed', 'failed', 'cancelled'])

  // Active and terminal sets must be disjoint
  for (const s of YOUTUBE_ACTIVE_STATUSES) {
    assert(!YOUTUBE_TERMINAL_STATUSES.includes(s), `Status ${s} cannot be both active and terminal`)
  }
  console.log('PASS: Youtube status set consistency')
}

console.log('\nALL YOUTUBE PUBLISH & OAUTH WORKFLOW TESTS PASS')
