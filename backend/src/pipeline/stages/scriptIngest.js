import fs from 'node:fs'
import path from 'node:path'
import { prepareScriptText } from '../../services/scriptService.js'
import { updateProjectOwned } from '../../services/projectAdmission.js'
import { projectDir, ensureDir, resolveStorageKey, toStorageKey } from '../context.js'

// script.ingest — normalize the staged upload into the project's private
// script/source.txt, verify integrity, and persist provenance. Idempotent:
// re-running with the same normalized hash reuses the existing copy.
export async function scriptIngest(ctx) {
  const { project, runToken } = ctx
  if (!project.script_key) throw new Error('SCRIPT_NOT_FOUND: project chưa có script_key — hãy tạo lại project')
  const sourceAbs = resolveStorageKey(project.script_key)
  if (!sourceAbs || !fs.existsSync(sourceAbs)) {
    throw new Error(`SCRIPT_NOT_FOUND: tệp kịch bản không tồn tại (${project.script_key})`)
  }

  const prepared = prepareScriptText(fs.readFileSync(sourceAbs))
  if (project.script_hash && project.script_hash !== prepared.sha256) {
    throw new Error('SCRIPT_INTEGRITY_MISMATCH: nội dung kịch bản không khớp hash đã lưu — upload lại kịch bản')
  }

  const targetDir = ensureDir(path.join(projectDir(project.id), 'script'))
  const targetAbs = path.join(targetDir, 'source.txt')
  const targetKey = toStorageKey(targetAbs)
  const alreadyThere = path.resolve(sourceAbs) === path.resolve(targetAbs)

  if (!alreadyThere) fs.writeFileSync(targetAbs, prepared.text, 'utf8')
  // Verify what will actually be read by downstream stages.
  const persisted = prepareScriptText(fs.readFileSync(targetAbs))
  if (persisted.sha256 !== prepared.sha256) {
    throw new Error('SCRIPT_INTEGRITY_MISMATCH: bản sao kịch bản không khớp nội dung đã upload')
  }

  const nextVersion = Number(project.script_version ?? 0) > 0 ? Number(project.script_version) : 1
  const updated = await updateProjectOwned(project.id, runToken, {
    script_key: targetKey,
    script_hash: persisted.sha256,
    script_version: nextVersion,
  })
  if (runToken && !updated) {
    const e = new Error('RUN_ABORTED'); e.code = 'RUN_ABORTED'; throw e
  }

  return {
    charCount: persisted.charCount,
    sha256: persisted.sha256,
    scriptKey: targetKey,
  }
}

export default scriptIngest
