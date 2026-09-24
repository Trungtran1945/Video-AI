import { v4 as uuidv4 } from 'uuid'
import { query, withTransaction } from '../db/query.js'
import { computeProposedState, validateProposedState, TIMING_GAP } from '../lib/transcriptTiming.js'

const TRANSCRIPT_FIELDS = [
  'text',
  'translation',
  'start_sec',
  'end_sec',
  'is_time_manually_adjusted',
  'is_text_manually_edited',
  'is_translation_manually_edited',
  'source',
  'confidence',
  'ratio_x',
  'ratio_y',
  'ratio_w',
  'ratio_h',
]

const COPY_FIELDS = [
  'index_num',
  'start_sec',
  'end_sec',
  'text',
  'speaker',
  'language',
  'translation',
  'is_time_manually_adjusted',
  'is_text_manually_edited',
  'is_translation_manually_edited',
  'source',
  'confidence',
  'ratio_x',
  'ratio_y',
  'ratio_w',
  'ratio_h',
  'wpm_warning',
]

export class TranscriptRevisionRequired extends Error {
  constructor() {
    super('Transcript revision is required')
    this.name = 'TranscriptRevisionRequired'
    this.code = 'REVISION_REQUIRED'
    this.statusCode = 400
  }
}

export class TranscriptRevisionConflict extends Error {
  constructor(currentRevision) {
    super('Transcript revision is stale')
    this.name = 'TranscriptRevisionConflict'
    this.code = 'REVISION_CONFLICT'
    this.statusCode = 409
    this.currentRevision = Number(currentRevision)
  }
}

export class TranscriptRunConflict extends Error {
  constructor() {
    super('Pipeline no longer owns this transcript run')
    this.name = 'TranscriptRunConflict'
    this.code = 'RUN_ABORTED'
    this.statusCode = 409
  }
}

export class TranscriptValidationError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'TranscriptValidationError'
    this.code = 'VALIDATION'
    this.statusCode = 400
    Object.assign(this, details)
  }
}

function sameValue(left, right) {
  if (left === null || left === undefined) return right === null || right === undefined
  if (right === null || right === undefined) return false
  if (typeof left === 'number' || typeof right === 'number') return Number(left) === Number(right)
  return left === right
}

export function transcriptRowChanged(current, proposed) {
  return TRANSCRIPT_FIELDS.some((field) => !sameValue(current?.[field], proposed?.[field]))
}

function requireRevision(expectedRevision) {
  if (expectedRevision === undefined || expectedRevision === null) throw new TranscriptRevisionRequired()
  const revision = Number(expectedRevision)
  if (!Number.isInteger(revision) || revision < 0) throw new TranscriptValidationError('revision phải là số nguyên không âm', { field: 'revision' })
  return revision
}

function assertRevision(current, expectedRevision) {
  const expected = requireRevision(expectedRevision)
  if (Number(current) !== expected) throw new TranscriptRevisionConflict(current)
  return expected
}

function normalizeTranslation(value) {
  return typeof value === 'string' ? value.trim() : value
}

function projectVersion(project) {
  return Number(project?.transcript_version ?? 0)
}

async function loadProject(tx, projectId) {
  const project = await tx.queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
  if (!project) throw new TranscriptValidationError('Project not found', { field: 'projectId' })
  return project
}

async function assertRunOwner(tx, projectId, runToken) {
  if (!runToken) return
  const project = await tx.queryOne('SELECT status, run_token FROM projects WHERE id = ?', [projectId])
  if (!project || project.status !== 'running' || project.run_token !== runToken) throw new TranscriptRunConflict()
}

async function bumpVersion(tx, projectId, currentRevision) {
  const affected = await tx.runAffected(
    'UPDATE projects SET transcript_version = transcript_version + 1 WHERE id = ? AND transcript_version = ?',
    [projectId, currentRevision]
  )
  if (affected !== 1) {
    const fresh = await tx.queryOne('SELECT transcript_version FROM projects WHERE id = ?', [projectId])
    throw new TranscriptRevisionConflict(fresh?.transcript_version ?? currentRevision)
  }
  return currentRevision + 1
}

export async function getTranscriptSnapshot(projectId) {
  const rows = await query(
    `SELECT p.id AS project_id, p.mode AS project_mode,
            p.transcript_version AS project_transcript_version,
            s.id AS segment_id, s.index_num, s.start_sec, s.end_sec, s.text,
            s.speaker, s.language, s.translation,
            s.is_time_manually_adjusted, s.is_text_manually_edited,
            s.is_translation_manually_edited
     FROM projects p
     LEFT JOIN transcript_segments s ON s.project_id = p.id
     WHERE p.id = ?
     ORDER BY s.index_num ASC`,
    [projectId]
  )
  if (!rows.length) return null
  const first = rows[0]
  return {
    project: {
      id: first.project_id,
      mode: first.project_mode,
      transcript_version: first.project_transcript_version,
    },
    segments: rows.filter((row) => row.segment_id !== null).map((row) => ({
      id: row.segment_id,
      index_num: row.index_num,
      start_sec: row.start_sec,
      end_sec: row.end_sec,
      text: row.text,
      speaker: row.speaker,
      language: row.language,
      translation: row.translation,
      is_time_manually_adjusted: row.is_time_manually_adjusted,
      is_text_manually_edited: row.is_text_manually_edited,
      is_translation_manually_edited: row.is_translation_manually_edited,
    })),
  }
}

export async function applyTranscriptEdits(projectId, incoming, expectedRevision, options = {}) {
  const expected = requireRevision(expectedRevision)
  return withTransaction(async (tx) => {
    const project = await loadProject(tx, projectId)
    const currentRevision = projectVersion(project)
    if (currentRevision !== expected) throw new TranscriptRevisionConflict(currentRevision)

    const allSegments = await tx.query(
      `SELECT id, index_num, start_sec, end_sec, text, translation, is_time_manually_adjusted,
              is_text_manually_edited, is_translation_manually_edited
       FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC`,
      [projectId]
    )
    if (!allSegments.length) throw new TranscriptValidationError('Không có transcript để sửa', { field: 'segments' })

    const durationSec = options.durationSec ?? project.target_duration_sec ?? null
    const computed = computeProposedState(allSegments, incoming, { gap: TIMING_GAP, durationSec })
    if (computed.errors.length) {
      throw new TranscriptValidationError(computed.errors[0].message, computed.errors[0])
    }
    if (computed.conflicts.length) {
      const error = new TranscriptValidationError(computed.conflicts[0].message, {
        code: 'OVERLAP_CONFLICT',
        conflicts: computed.conflicts,
      })
      error.statusCode = 400
      throw error
    }
    const validation = validateProposedState(computed.ordered, { gap: TIMING_GAP, durationSec })
    if (!validation.ok) throw new TranscriptValidationError(validation.errors[0].message, validation.errors[0])

    const currentById = new Map(allSegments.map((row) => [String(row.id), row]))
    const changedIds = []
    const ttsInvalidate = new Set(computed.ttsInvalidate || [])
    for (const row of computed.ordered) {
      const current = currentById.get(String(row.id))
      if (!current || transcriptRowChanged(current, row)) changedIds.push(String(row.id))
      if (sameValue(current?.start_sec, row.start_sec) === false || sameValue(current?.end_sec, row.end_sec) === false) {
        ttsInvalidate.add(String(row.id))
      }
    }

    if (changedIds.length === 0) {
      return {
        changed: false,
        revision: currentRevision,
        updated: 0,
        adjustedSegments: [],
        segments: allSegments,
      }
    }

    for (const id of changedIds) {
      const row = computed.proposed.get(id)
      if (!row) continue
      const fields = [
        'text = ?',
        'translation = ?',
        'start_sec = ?',
        'end_sec = ?',
        'is_time_manually_adjusted = ?',
        'is_text_manually_edited = ?',
        'is_translation_manually_edited = ?',
      ]
      const values = [
        row.text,
        row.translation,
        row.start_sec,
        row.end_sec,
        row.is_time_manually_adjusted,
        row.is_text_manually_edited,
        row.is_translation_manually_edited,
      ]
      if (ttsInvalidate.has(id)) {
        fields.push('tts_audio_id = NULL')
      }
      values.push(id, projectId)
      await tx.run(
        `UPDATE transcript_segments SET ${fields.join(', ')} WHERE id = ? AND project_id = ?`,
        values
      )
    }

    const revision = await bumpVersion(tx, projectId, currentRevision)
    const segments = await tx.query(
      `SELECT id, index_num, start_sec, end_sec, text, speaker, language, translation,
              is_time_manually_adjusted, is_text_manually_edited, is_translation_manually_edited
       FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC`,
      [projectId]
    )
    return {
      changed: true,
      revision,
      updated: changedIds.length,
      adjustedSegments: (computed.adjusted || []).filter((item) => changedIds.includes(String(item.id))),
      segments,
    }
  }, { op: 'transcript.user.update' })
}

export async function updateSegmentTranslation(projectId, segmentId, translation, expectedRevision) {
  const expected = requireRevision(expectedRevision)
  const nextTranslation = normalizeTranslation(translation)
  if (typeof nextTranslation !== 'string' || !nextTranslation) {
    throw new TranscriptValidationError('translation is required', { field: 'translation' })
  }
  return withTransaction(async (tx) => {
    const project = await loadProject(tx, projectId)
    const currentRevision = projectVersion(project)
    if (currentRevision !== expected) throw new TranscriptRevisionConflict(currentRevision)
    const segment = await tx.queryOne(
      'SELECT * FROM transcript_segments WHERE id = ? AND project_id = ?',
      [segmentId, projectId]
    )
    if (!segment) throw new TranscriptValidationError('Segment not found in this project', { field: 'segmentId' })
    if (sameValue(segment.translation, nextTranslation)) {
      if (Number(segment.is_translation_manually_edited) === 1) {
        return { changed: false, revision: currentRevision, segment }
      }
      await tx.run(
        `UPDATE transcript_segments SET is_translation_manually_edited = 1
         WHERE id = ? AND project_id = ?`,
        [segmentId, projectId]
      )
      const revision = await bumpVersion(tx, projectId, currentRevision)
      const updated = await tx.queryOne('SELECT * FROM transcript_segments WHERE id = ?', [segmentId])
      return { changed: true, revision, segment: updated }
    }
    await tx.run(
      `UPDATE transcript_segments SET translation = ?, tts_audio_id = NULL,
       is_translation_manually_edited = 1 WHERE id = ? AND project_id = ?`,
      [nextTranslation, segmentId, projectId]
    )
    const revision = await bumpVersion(tx, projectId, currentRevision)
    const updated = await tx.queryOne('SELECT * FROM transcript_segments WHERE id = ?', [segmentId])
    return { changed: true, revision, segment: updated }
  }, { op: 'transcript.translation.update' })
}

export async function applyGeneratedTranslations(projectId, updates, expectedRevision, options = {}) {
  const expected = requireRevision(expectedRevision)
  const list = Array.isArray(updates) ? updates.filter((item) => item && item.id) : []
  return withTransaction(async (tx) => {
    const project = await loadProject(tx, projectId)
    await assertRunOwner(tx, projectId, options.runToken)
    const currentRevision = projectVersion(project)
    if (currentRevision !== expected) throw new TranscriptRevisionConflict(currentRevision)
    let changed = 0
    for (const update of list) {
      const segment = await tx.queryOne(
        'SELECT * FROM transcript_segments WHERE id = ? AND project_id = ?',
        [update.id, projectId]
      )
      if (!segment) throw new TranscriptValidationError('Segment not found in this project', { field: 'segmentId' })
      const hasManualTranslation = Number(segment.is_translation_manually_edited) === 1 && String(segment.translation || '').trim()
      if (hasManualTranslation) continue
      const nextTranslation = normalizeTranslation(update.translation)
      if (sameValue(segment.translation, nextTranslation)) continue
      await tx.run(
        `UPDATE transcript_segments SET translation = ?, tts_audio_id = NULL,
         is_translation_manually_edited = 0 WHERE id = ? AND project_id = ?`,
        [nextTranslation, update.id, projectId]
      )
      changed += 1
    }
    if (changed === 0) return { changed: false, revision: currentRevision, updated: 0 }
    const revision = await bumpVersion(tx, projectId, currentRevision)
    return { changed: true, revision, updated: changed }
  }, { op: 'transcript.generated.update' })
}

function normalizeImportedSegment(segment, projectId) {
  const translation = segment.translation ?? null
  return {
    id: segment.id || uuidv4(),
    project_id: projectId,
    index_num: segment.index_num ?? segment.index ?? 0,
    start_sec: segment.start_sec ?? segment.startSec ?? 0,
    end_sec: segment.end_sec ?? segment.endSec ?? 0,
    text: segment.text ?? null,
    speaker: segment.speaker ?? null,
    language: segment.language ?? null,
    translation,
    tts_audio_id: null,
    subtitle_id: null,
    source: segment.source ?? null,
    confidence: segment.confidence ?? null,
    ratio_x: segment.ratio_x ?? null,
    ratio_y: segment.ratio_y ?? null,
    ratio_w: segment.ratio_w ?? null,
    ratio_h: segment.ratio_h ?? null,
    is_time_manually_adjusted: segment.is_time_manually_adjusted ?? 0,
    is_text_manually_edited: segment.is_text_manually_edited ?? 0,
    is_translation_manually_edited: translation && String(translation).trim() ? (segment.is_translation_manually_edited ?? 0) : 0,
    wpm_warning: segment.wpm_warning ?? null,
  }
  }

export async function replaceTranscript(projectId, segments, options = {}) {
  const expected = options.expectedRevision === undefined || options.expectedRevision === null
    ? null
    : requireRevision(options.expectedRevision)
  const list = Array.isArray(segments) ? segments : []
  return withTransaction(async (tx) => {
    const project = await loadProject(tx, projectId)
    await assertRunOwner(tx, projectId, options.runToken)
    const currentRevision = projectVersion(project)
    if (expected !== null && currentRevision !== expected) throw new TranscriptRevisionConflict(currentRevision)
    const existing = await tx.query('SELECT * FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC', [projectId])
    const imported = list.map((segment) => normalizeImportedSegment(segment, projectId))
    const sameState = existing.length === imported.length && imported.every((row, index) => {
      const current = existing[index]
      return current && ['id', 'index_num', 'speaker', 'language', ...TRANSCRIPT_FIELDS, 'wpm_warning'].every((field) => sameValue(current[field], row[field]))
    })
    if (sameState) {
      return { changed: false, revision: currentRevision, inserted: 0, removed: 0 }
    }
    await tx.run('DELETE FROM transcript_segments WHERE project_id = ?', [projectId])
    for (const segment of imported) await tx.insert('transcript_segments', segment)
    const shouldBump = options.bumpVersion !== false && existing.length > 0
    const revision = shouldBump ? await bumpVersion(tx, projectId, currentRevision) : currentRevision
    return { changed: true, revision, inserted: list.length, removed: existing.length }
  }, { op: 'transcript.replace' })
}

export async function clearTranscript(projectId, expectedRevision = null, options = {}) {
  return replaceTranscript(projectId, [], {
    expectedRevision,
    bumpVersion: true,
    runToken: options.runToken,
  })
}

export async function copyTranscript(sourceProjectId, targetProjectId, options = {}) {
  return withTransaction(async (tx) => {
    const sourceProject = await loadProject(tx, sourceProjectId)
    if (!sourceProject) throw new TranscriptValidationError('Source project not found')
    const targetProject = await loadProject(tx, targetProjectId)
    const existing = await tx.query('SELECT id FROM transcript_segments WHERE project_id = ?', [targetProjectId])
    if (existing.length) return { changed: false, inserted: 0, revision: projectVersion(targetProject) }
    const sourceRows = await tx.query('SELECT * FROM transcript_segments WHERE project_id = ? ORDER BY index_num ASC', [sourceProjectId])
    for (const source of sourceRows) {
      const row = { id: uuidv4(), project_id: targetProjectId }
      for (const field of COPY_FIELDS) row[field] = source[field] ?? null
      row.translation = options.includeTranslation === false ? null : (source.translation ?? null)
      row.is_translation_manually_edited = row.translation && String(row.translation).trim()
        ? (options.includeTranslation === false ? 0 : (source.is_translation_manually_edited ?? 0))
        : 0
      row.tts_audio_id = null
      row.subtitle_id = null
      await tx.insert('transcript_segments', row)
    }
    return { changed: sourceRows.length > 0, inserted: sourceRows.length, revision: projectVersion(targetProject) }
  }, { op: 'transcript.cache.copy' })
}

function normalizeDupText(value) {
  return String(value ?? '').trim()
}

export function findDuplicateGroups(sortedSegments) {
  const groups = []
  let current = []
  for (const segment of sortedSegments || []) {
    const previous = current.length ? current[current.length - 1] : null
    const text = normalizeDupText(segment.text)
    if (
      previous &&
      text &&
      text === normalizeDupText(previous.text) &&
      Math.abs(Number(segment.start_sec) - Number(previous.end_sec)) < 1.0
    ) {
      current.push(segment)
    } else {
      if (current.length >= 2) groups.push(current)
      current = [segment]
    }
  }
  if (current.length >= 2) groups.push(current)
  return groups
}

export async function dedupeTranscriptSegments(projectId, expectedRevision = null, options = {}) {
  return withTransaction(async (tx) => {
    const project = await loadProject(tx, projectId)
    await assertRunOwner(tx, projectId, options.runToken)
    const currentRevision = projectVersion(project)
    if (expectedRevision !== null && expectedRevision !== undefined) assertRevision(currentRevision, expectedRevision)
    const rows = await tx.query(
      `SELECT id, start_sec, end_sec, text, translation, is_translation_manually_edited
       FROM transcript_segments WHERE project_id = ? ORDER BY start_sec ASC`,
      [projectId]
    )
    const groups = findDuplicateGroups(rows)
    const removedIds = []
    let changed = false
    for (const group of groups) {
      const keeper = group[0]
      const newEnd = Math.max(...group.map((segment) => Number(segment.end_sec) || 0))
      let newTranslation = keeper.translation
      let manual = Number(keeper.is_translation_manually_edited) === 1
      if (!newTranslation || !String(newTranslation).trim()) {
        const donor = group.find((segment) => segment.translation && String(segment.translation).trim())
        if (donor) {
          newTranslation = donor.translation
          manual = manual || Number(donor.is_translation_manually_edited) === 1
        }
      }
      const keeperChanged = Number(keeper.end_sec) !== newEnd || !sameValue(keeper.translation, newTranslation) || Number(keeper.is_translation_manually_edited) !== (manual ? 1 : 0)
      if (keeperChanged) changed = true
      await tx.run(
        `UPDATE transcript_segments SET end_sec = ?, translation = ?, is_translation_manually_edited = ?${keeperChanged ? ', tts_audio_id = NULL' : ''} WHERE id = ?`,
        [newEnd, newTranslation || null, manual ? 1 : 0, keeper.id]
      )
      for (const duplicate of group.slice(1)) {
        await tx.run('DELETE FROM transcript_segments WHERE id = ?', [duplicate.id])
        removedIds.push(duplicate.id)
        changed = true
      }
    }
    let revision = currentRevision
    if (changed) revision = await bumpVersion(tx, projectId, currentRevision)
    return { mergedGroups: groups.length, removedCount: removedIds.length, removedIds, changed, revision }
  }, { op: 'transcript.dedupe' })
}

export async function clearTtsLinks(projectId, expectedRevision = null, options = {}) {
  return withTransaction(async (tx) => {
    const project = await loadProject(tx, projectId)
    await assertRunOwner(tx, projectId, options.runToken)
    if (expectedRevision !== null && expectedRevision !== undefined) assertRevision(projectVersion(project), expectedRevision)
    const changed = await tx.runAffected(
      'UPDATE transcript_segments SET tts_audio_id = NULL WHERE project_id = ? AND tts_audio_id IS NOT NULL',
      [projectId]
    )
    return { changed: changed > 0, updated: changed }
  }, { op: 'transcript.tts.invalidate' })
}

export async function attachTtsAudio(projectId, segmentId, audioId, expectedRevision, runToken = null) {
  const expected = requireRevision(expectedRevision)
  return withTransaction(async (tx) => {
    const project = await loadProject(tx, projectId)
    await assertRunOwner(tx, projectId, runToken)
    const currentRevision = projectVersion(project)
    if (currentRevision !== expected) throw new TranscriptRevisionConflict(currentRevision)
    const segment = await tx.queryOne('SELECT id FROM transcript_segments WHERE id = ? AND project_id = ?', [segmentId, projectId])
    if (!segment) throw new TranscriptValidationError('Segment not found in this project', { field: 'segmentId' })
    await tx.run('UPDATE transcript_segments SET tts_audio_id = ? WHERE id = ? AND project_id = ?', [audioId, segmentId, projectId])
    return { changed: true, revision: currentRevision }
  }, { op: 'transcript.tts.attach' })
}

export async function deleteProjectTranscript(projectId) {
  return withTransaction(async (tx) => {
    const changed = await tx.runAffected('DELETE FROM transcript_segments WHERE project_id = ?', [projectId])
    return { changed: changed > 0, removed: changed }
  }, { op: 'transcript.project.delete' })
}

export default {
  TranscriptRevisionRequired,
  TranscriptRevisionConflict,
  TranscriptRunConflict,
  TranscriptValidationError,
  getTranscriptSnapshot,
  applyTranscriptEdits,
  updateSegmentTranslation,
  applyGeneratedTranslations,
  replaceTranscript,
  clearTranscript,
  copyTranscript,
  findDuplicateGroups,
  dedupeTranscriptSegments,
  clearTtsLinks,
  attachTtsAudio,
  deleteProjectTranscript,
}
