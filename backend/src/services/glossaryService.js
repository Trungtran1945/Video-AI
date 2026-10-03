// Minimal per-project glossary (TransFlow-inspired, phase 1).
// Table project_glossaries(source_term, target_term, case_sensitive, note).
// No CSV import, no cross-project packs — prompt injection only.
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne, insert, runAffected } from '../db/query.js'

export async function listGlossary(projectId) {
  try {
    return await query(
      `SELECT id, project_id, source_term AS source, target_term AS target,
              case_sensitive, note, created_date
       FROM project_glossaries WHERE project_id = ? ORDER BY created_date ASC`,
      [projectId]
    )
  } catch (err) {
    // Table missing on old data.db files before migration — treat as empty.
    if (String(err?.message || '').includes('no such table')) return []
    throw err
  }
}

export async function addGlossaryTerm(projectId, { source, target, caseSensitive = false, note = null }) {
  const s = String(source || '').trim()
  const t = String(target || '').trim()
  if (!s || !t) {
    const e = new Error('source and target are required')
    e.statusCode = 400
    throw e
  }
  if (s.length > 200 || t.length > 200) {
    const e = new Error('glossary term too long (max 200 chars)')
    e.statusCode = 400
    throw e
  }
  const row = {
    id: uuidv4(),
    project_id: projectId,
    source_term: s,
    target_term: t,
    case_sensitive: caseSensitive ? 1 : 0,
    note: note ? String(note).slice(0, 500) : null,
  }
  await insert('project_glossaries', row)
  return { id: row.id, source: s, target: t, case_sensitive: Boolean(caseSensitive), note: row.note }
}

export async function deleteGlossaryTerm(projectId, termId) {
  const affected = await runAffected('DELETE FROM project_glossaries WHERE id = ? AND project_id = ?', [termId, projectId])
  return Number(affected ?? 0) > 0
}

export async function loadGlossaryForPrompt(projectId, limit = 100) {
  const rows = await listGlossary(projectId)
  return (rows || []).slice(0, limit).map((r) => ({
    source: r.source ?? r.source_term,
    target: r.target ?? r.target_term,
    case_sensitive: Boolean(r.case_sensitive ?? r.caseSensitive),
    note: r.note || null,
  })).filter((t) => t.source && t.target)
}

export default { listGlossary, addGlossaryTerm, deleteGlossaryTerm, loadGlossaryForPrompt }
