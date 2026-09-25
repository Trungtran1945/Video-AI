import { queryOne, withTransaction } from '../db/query.js'

export class OutputRunConflict extends Error {
  constructor() {
    super('Pipeline no longer owns this output run')
    this.name = 'OutputRunConflict'
    this.code = 'RUN_ABORTED'
    this.statusCode = 409
  }
}

function normalizeVersion(value) {
  if (value === null || value === undefined) return null
  const version = Number(value)
  return Number.isInteger(version) && version >= 0 ? version : null
}

// Provenance contract: outputs.transcript_version is the revision the
// GENERATION used (captured at dub.ttsAlign and persisted in its job result),
// never the current project revision at insertion time. When the generation
// recorded a snapshot, publishing anything else is rejected.
async function assertOutputProvenance(tx, projectId, version) {
  const job = await tx.queryOne(
    `SELECT status, result FROM generation_jobs WHERE project_id = ? AND type = 'dub.ttsAlign'`,
    [projectId]
  )
  if (!job || job.status !== 'success') return
  let snapshot = null
  try {
    const parsed = JSON.parse(job.result || '{}')
    if (parsed && parsed.transcriptVersionSnapshot !== null && parsed.transcriptVersionSnapshot !== undefined) {
      snapshot = normalizeVersion(parsed.transcriptVersionSnapshot)
    }
  } catch (_) {
    return
  }
  if (snapshot === null) return // legacy generation without a persisted snapshot
  if (snapshot !== version) {
    throw new Error(
      `Output transcript version ${version} does not match the generation snapshot ${snapshot}`
    )
  }
}

export function outputIsStale(mode, currentTranscriptVersion, output) {
  if (!output || String(mode).toUpperCase() !== 'TRANSLATE_DUB') return false
  const outputVersion = normalizeVersion(output.transcript_version)
  return outputVersion === null || outputVersion !== Number(currentTranscriptVersion ?? 0)
}

async function insertOutput(tx, input) {
  const projectId = input.projectId
  const version = input.transcriptVersion === undefined ? null : normalizeVersion(input.transcriptVersion)
  const project = await tx.queryOne('SELECT mode, transcript_version FROM projects WHERE id = ?', [projectId])
  if (!project) throw new Error('Project not found')
  if (input.runToken) {
    const run = await tx.queryOne('SELECT status, run_token FROM projects WHERE id = ?', [projectId])
    if (!run || run.status !== 'running' || run.run_token !== input.runToken) throw new OutputRunConflict()
  }
  if (String(project.mode).toUpperCase() === 'TRANSLATE_DUB' && (input.transcriptVersion === undefined || version === null)) {
    throw new Error('Dub output requires a valid transcript version snapshot')
  }
  if (String(project.mode).toUpperCase() === 'TRANSLATE_DUB' && version !== null) {
    await assertOutputProvenance(tx, projectId, version)
  }
  return tx.insert('outputs', {
    id: input.id,
    project_id: projectId,
    storage_key: input.storageKey ?? null,
    status: input.status || 'success',
    duration_sec: input.durationSec ?? null,
    thumbnail_key: input.thumbnailKey ?? null,
    transcript_version: version,
  })
}

export async function createOutput(input, transaction = null) {
  if (transaction) return insertOutput(transaction, input)
  return withTransaction((tx) => insertOutput(tx, input), { op: 'output.create' })
}

export async function getOutputState(projectId) {
  const row = await queryOne(
    `SELECT p.id AS project_id, p.mode AS project_mode,
            p.transcript_version AS project_transcript_version,
            o.id AS output_id, o.project_id AS output_project_id,
            o.storage_key AS output_storage_key, o.status AS output_status,
            o.duration_sec AS output_duration_sec, o.thumbnail_key AS output_thumbnail_key,
            o.transcript_version AS output_transcript_version,
            o.created_date AS output_created_date
     FROM projects p
     LEFT JOIN outputs o ON o.rowid = (
       SELECT o2.rowid FROM outputs o2
       WHERE o2.project_id = p.id
       ORDER BY o2.created_date DESC, o2.rowid DESC LIMIT 1
     )
     WHERE p.id = ?`,
    [projectId]
  )
  if (!row) return { output: null, outputStale: false, transcriptVersion: null }
  const project = {
    id: row.project_id,
    mode: row.project_mode,
    transcript_version: row.project_transcript_version,
  }
  const output = row.output_id ? {
    id: row.output_id,
    project_id: row.output_project_id,
    storage_key: row.output_storage_key,
    status: row.output_status,
    duration_sec: row.output_duration_sec,
    thumbnail_key: row.output_thumbnail_key,
    transcript_version: row.output_transcript_version,
    created_date: row.output_created_date,
  } : null
  return {
    project,
    output,
    transcriptVersion: Number(project.transcript_version ?? 0),
    outputStale: outputIsStale(project.mode, project.transcript_version, output),
  }
}

export async function getLatestOutput(projectId) {
  return queryOne(
    `SELECT * FROM outputs WHERE project_id = ? ORDER BY created_date DESC, rowid DESC LIMIT 1`,
    [projectId]
  )
}

export default { OutputRunConflict, createOutput, getOutputState, getLatestOutput, outputIsStale }
