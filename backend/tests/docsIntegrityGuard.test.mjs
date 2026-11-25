// Guard tests for backend/scripts/check-docs-integrity.mjs
// Run: node backend/tests/docsIntegrityGuard.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  REQUIRED_PIPELINE_CHAINS,
  runAudit,
  validateRootAgents,
} from '../scripts/check-docs-integrity.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const backendRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(backendRoot, '..')

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else {
    failures++
    console.error('FAIL:', msg)
  }
}

function stageIdToFilename(stageId) {
  const [, name] = stageId.split('.')
  const prefix = stageId.split('.')[0]
  return `${prefix}${name[0].toUpperCase()}${name.slice(1)}.js`
}

// 1. Live repository passes check-docs-integrity cleanly (both imported and CLI)
{
  const res = runAudit({ silent: true })
  assert(res.ok === true && res.violationsCount === 0, 'live repository passes runAudit()')
  assert(res.auditedFiles.includes('AGENTS.md'), 'auditedFiles includes root AGENTS.md')
  assert(
    !res.auditedFiles.some((f) => f.includes('/archive/') || f.startsWith('backend/scripts/archive/')),
    'auditedFiles excludes archive paths'
  )

  const cli = spawnSync(process.execPath, ['scripts/check-docs-integrity.mjs'], {
    cwd: backendRoot,
    encoding: 'utf8',
  })
  assert(cli.status === 0, `check-docs-integrity CLI exits 0 (got ${cli.status})`)
}

// 2. Canonical stage chains match runner.js STAGES and existing stage files
{
  const runnerSrc = fs.readFileSync(path.join(backendRoot, 'src', 'pipeline', 'runner.js'), 'utf8')
  const stagesDir = path.join(backendRoot, 'src', 'pipeline', 'stages')
  for (const [mode, stages] of Object.entries(REQUIRED_PIPELINE_CHAINS)) {
    const modePattern = new RegExp(`${mode}:\\s*\\[[\\s\\S]*?${stages.join('[\\s\\S]*?')}[\\s\\S]*?\\]`)
    assert(modePattern.test(runnerSrc), `runner.js STAGES.${mode} matches REQUIRED_PIPELINE_CHAINS`)
    for (const stageId of stages) {
      const stageFile = path.join(stagesDir, stageIdToFilename(stageId))
      assert(fs.existsSync(stageFile), `stage file exists for ${stageId}: ${path.basename(stageFile)}`)
    }
  }
}

// 3. Omitting a mode's stage chain or reordering stages fails validation
{
  const validAgents = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8')
  assert(validateRootAgents(validAgents).length === 0, 'real root AGENTS.md passes validateRootAgents()')

  const missingComposer = validAgents
    .split(/\r?\n/)
    .filter((line) => !line.includes('composer.ingest'))
    .join('\n')
  const composerViolations = validateRootAgents(missingComposer)
  assert(
    composerViolations.some((v) => v.rule === 'PIPELINE_STAGES_INCOMPLETE' && v.reason.includes('MEDIA_COMPOSER')),
    'omitting MEDIA_COMPOSER stage chain triggers PIPELINE_STAGES_INCOMPLETE'
  )

  const missingScriptStage = validAgents.replace(' → script.image', '')
  const scriptViolations = validateRootAgents(missingScriptStage)
  assert(
    scriptViolations.some((v) => v.rule === 'PIPELINE_STAGES_INCOMPLETE' && v.reason.includes('SCRIPT_TO_VIDEO')),
    'omitting script.image triggers PIPELINE_STAGES_INCOMPLETE for SCRIPT_TO_VIDEO'
  )

  const wrongSummaryOrder = validAgents.replace(
    'summary.transcribe → summary.sceneDetect → summary.analyze',
    'summary.transcribe → summary.analyze → summary.sceneDetect'
  )
  const summaryViolations = validateRootAgents(wrongSummaryOrder)
  assert(
    summaryViolations.some((v) => v.rule === 'PIPELINE_STAGES_INCOMPLETE' && v.reason.includes('SUMMARY')),
    'wrong stage order in SUMMARY triggers PIPELINE_STAGES_INCOMPLETE'
  )
}

// 4. Temp repo audit proves archive files (under backend/scripts/archive/ or Video_AI_docs/archive/) are NOT blocked
{
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-docs-guard-'))
  try {
    const validAgents = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8')
    fs.writeFileSync(path.join(tmpRepo, 'AGENTS.md'), validAgents, 'utf8')
    fs.mkdirSync(path.join(tmpRepo, 'backend', 'scripts', 'archive'), { recursive: true })
    fs.mkdirSync(path.join(tmpRepo, 'Video_AI_docs', 'archive'), { recursive: true })

    const legacyEngine = ['sql', 'js'].join('.')
    const legacyDbFile = ['data', 'db'].join('.')
    fs.writeFileSync(
      path.join(tmpRepo, 'backend', 'scripts', 'archive', 'README.md'),
      `Archived tools using ${legacyEngine} and ${legacyDbFile}\n`,
      'utf8'
    )
    fs.writeFileSync(
      path.join(tmpRepo, 'Video_AI_docs', 'archive', 'legacy.md'),
      `Historical notes referencing ${legacyEngine} and ${legacyDbFile}\n`,
      'utf8'
    )

    const archivePass = runAudit({ repoRoot: tmpRepo, silent: true })
    assert(archivePass.ok === true, 'archive files mentioning legacy tokens are NOT blocked by runAudit()')

    // Now omit MEDIA_COMPOSER chain in temp AGENTS.md -> must fail
    const brokenAgents = validAgents.replace(/.*composer\.ingest.*\r?\n/, '')
    fs.writeFileSync(path.join(tmpRepo, 'AGENTS.md'), brokenAgents, 'utf8')
    const missingFail = runAudit({ repoRoot: tmpRepo, silent: true })
    assert(missingFail.ok === false && missingFail.violationsCount === 1, 'temp repo missing composer chain fails runAudit()')
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true })
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
