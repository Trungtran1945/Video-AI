#!/usr/bin/env node
/**
 * Documentation Integrity & Architecture Consistency Guard
 *
 * Verifies that active documentation adheres to root AGENTS.md single source of truth:
 * - Pure PostgreSQL 16+ (pg.Pool, postgresSchema.sql)
 * - No active references to legacy SQLite architecture ('sql.js', 'data.db')
 * - No unauthorized active usage of 'AI_VIDEO' mode (only allowed with alias/normalization explanation)
 * - Complete mode matrix consistency: SUMMARY, TRANSLATE_DUB, SCRIPT_TO_VIDEO, MEDIA_COMPOSER
 * - Complete canonical pipeline stage chains in root AGENTS.md for all 4 modes
 *
 * Run: node backend/scripts/check-docs-integrity.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const defaultRepoRoot = path.resolve(__dirname, '..', '..')

// Target files & directories containing active project documentation
const DOCS_TARGET_DIRS = ['Video_AI_docs']
const STANDALONE_DOCS = ['AGENTS.md', 'README.md']

// Specific files & directories to exclude (historical/archive artifacts and task prompts)
const EXCLUDED_FILES = new Set([
  'task.md', // Master task prompt describing historical migration issues
])
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'archive'])

// Required project modes in mode matrix
export const REQUIRED_MODES = [
  'SUMMARY',
  'TRANSLATE_DUB',
  'SCRIPT_TO_VIDEO',
  'MEDIA_COMPOSER',
]

// Canonical stage order mirrored from backend/src/pipeline/runner.js (STAGES)
export const REQUIRED_PIPELINE_CHAINS = {
  SUMMARY: [
    'summary.transcribe',
    'summary.sceneDetect',
    'summary.analyze',
    'summary.script',
    'summary.align',
    'summary.tts',
    'summary.subtitle',
    'summary.render',
  ],
  TRANSLATE_DUB: [
    'dub.ingest',
    'dub.stt',
    'dub.merge',
    'dub.translate',
    'dub.mask',
    'dub.ttsAlign',
    'dub.render',
  ],
  SCRIPT_TO_VIDEO: [
    'script.ingest',
    'script.analyze',
    'script.tts',
    'script.image',
    'script.align',
    'script.subtitle',
    'script.render',
  ],
  MEDIA_COMPOSER: [
    'composer.ingest',
    'composer.prepare',
    'composer.render',
  ],
}

// Forbidden token rules with contextual allowlists
const FORBIDDEN_RULES = [
  {
    name: 'sql.js',
    pattern: /\bsql\.js\b/i,
    reason: "Active documentation must specify PostgreSQL 16+ (pg.Pool), not legacy 'sql.js'",
    isAllowed: (line) =>
      /completely removed|không còn sử dụng|ARCHIVED|gỡ bỏ|legacy SQLite/i.test(line),
  },
  {
    name: 'data.db',
    pattern: /\bdata\.db\b/i,
    reason: "Active documentation must specify PostgreSQL 16+ (pg.Pool), not legacy 'data.db' file",
    isAllowed: (line) =>
      /\.gitignore[`\s]+covers|ARCHIVED|gỡ bỏ|legacy|completely removed/i.test(line),
  },
  {
    name: 'AI_VIDEO',
    pattern: /\bAI_VIDEO\b/,
    reason: "Active documentation must not list 'AI_VIDEO' as a primary mode without explaining it as a legacy alias for SCRIPT_TO_VIDEO",
    isAllowed: (line) =>
      /alias|normalized to|SCRIPT_TO_VIDEO|tiền thân|giá trị không tồn tại/i.test(line),
  },
]

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isArchiveRelPath(relPath) {
  const normalized = relPath.replace(/\\/g, '/')
  return normalized.startsWith('backend/scripts/archive/') || /(?:^|\/)archive\//.test(normalized)
}

function collectFiles(dir, rootDir) {
  const results = []
  if (!fs.existsSync(dir)) return results

  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/')
    if (isArchiveRelPath(relPath)) continue

    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue
      results.push(...collectFiles(fullPath, rootDir))
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase()
      if (ext === '.md' || ext === '.txt') {
        if (!EXCLUDED_FILES.has(entry.name)) {
          results.push(fullPath)
        }
      }
    }
  }
  return results
}

export function extractPipelineStagesSection(content) {
  const lines = String(content || '').split(/\r?\n/)
  const startIdx = lines.findIndex((line) => /^\s*-\s+\*\*Pipeline stages\*\*/i.test(line))
  if (startIdx < 0) return null

  const sectionLines = [lines[startIdx]]
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^\S/.test(line)) break
    sectionLines.push(line)
  }
  return {
    lineNum: startIdx + 1,
    text: sectionLines.join('\n'),
  }
}

export function validateRootAgents(rootAgentsContent) {
  const violations = []
  const missingModes = REQUIRED_MODES.filter((m) => !rootAgentsContent.includes(m))
  if (missingModes.length > 0) {
    violations.push({
      lineNum: 1,
      rule: 'MODE_MATRIX_INCOMPLETE',
      reason: `Root AGENTS.md missing mode(s): ${missingModes.join(', ')}`,
      snippet: `Required modes: ${REQUIRED_MODES.join(', ')}`,
    })
  }

  const pipelineSection = extractPipelineStagesSection(rootAgentsContent)
  if (!pipelineSection) {
    violations.push({
      lineNum: 1,
      rule: 'PIPELINE_STAGES_MISSING',
      reason: 'Root AGENTS.md missing "- **Pipeline stages**" section',
      snippet: 'Expected canonical stage chains for all 4 modes',
    })
    return violations
  }

  for (const [mode, stages] of Object.entries(REQUIRED_PIPELINE_CHAINS)) {
    const chainRegex = new RegExp(stages.map(escapeRegExp).join('\\s*(?:→|->)\\s*'))
    if (!pipelineSection.text.includes(mode) || !chainRegex.test(pipelineSection.text)) {
      violations.push({
        lineNum: pipelineSection.lineNum,
        rule: 'PIPELINE_STAGES_INCOMPLETE',
        reason: `Root AGENTS.md Pipeline stages section missing or out-of-order stage chain for mode ${mode}`,
        snippet: `Expected ${mode}: ${stages.join(' → ')}`,
      })
    }
  }

  return violations
}

export function runAudit({ repoRoot = defaultRepoRoot, silent = false } = {}) {
  const log = silent ? () => {} : (...args) => console.log(...args)

  log('--- Documentation Integrity Guard (PostgreSQL & Mode Alignment) ---')
  log(`Repository root: ${repoRoot}`)

  const allFiles = []
  for (const rel of STANDALONE_DOCS) {
    const file = path.join(repoRoot, rel)
    if (fs.existsSync(file)) {
      allFiles.push(file)
    }
  }

  for (const relDir of DOCS_TARGET_DIRS) {
    const dir = path.join(repoRoot, relDir)
    if (fs.existsSync(dir)) {
      allFiles.push(...collectFiles(dir, repoRoot))
    }
  }

  log(`Auditing ${allFiles.length} active documentation files...\n`)

  let violationsCount = 0
  const violationsByFile = new Map()
  const addViolation = (relPath, item) => {
    violationsCount++
    if (!violationsByFile.has(relPath)) {
      violationsByFile.set(relPath, [])
    }
    violationsByFile.get(relPath).push(item)
  }

  for (const filePath of allFiles) {
    const relPath = path.relative(repoRoot, filePath).replace(/\\/g, '/')
    if (isArchiveRelPath(relPath)) continue

    const content = fs.readFileSync(filePath, 'utf8')
    const lines = content.split(/\r?\n/)

    lines.forEach((line, lineIndex) => {
      for (const rule of FORBIDDEN_RULES) {
        if (rule.pattern.test(line)) {
          if (rule.isAllowed && rule.isAllowed(line)) {
            // Contextually permitted (negative assertion or alias explanation)
            continue
          }
          addViolation(relPath, {
            lineNum: lineIndex + 1,
            rule: rule.name,
            reason: rule.reason,
            snippet: line.trim(),
          })
        }
      }
    })
  }

  // Verify Mode Matrix and canonical 4-mode Pipeline stages presence in root AGENTS.md
  const rootAgentsPath = path.join(repoRoot, 'AGENTS.md')
  if (fs.existsSync(rootAgentsPath)) {
    const rootAgentsContent = fs.readFileSync(rootAgentsPath, 'utf8')
    for (const violation of validateRootAgents(rootAgentsContent)) {
      addViolation('AGENTS.md', violation)
    }
  }

  return {
    ok: violationsCount === 0,
    violationsCount,
    violationsByFile,
    auditedFiles: allFiles.map((f) => path.relative(repoRoot, f).replace(/\\/g, '/')),
  }
}

function main() {
  const result = runAudit()

  if (!result.ok) {
    console.error(`[FAIL] Found ${result.violationsCount} documentation integrity violation(s):\n`)
    for (const [file, items] of result.violationsByFile.entries()) {
      console.error(`File: ${file}`)
      for (const item of items) {
        console.error(`  Line ${item.lineNum} [${item.rule}]: ${item.snippet}`)
        console.error(`    -> ${item.reason}`)
      }
      console.error('')
    }
    process.exit(1)
  }

  console.log(`[PASS] All ${result.auditedFiles.length} documentation files are clean!`)
  console.log('✓ No active documentation references to legacy SQLite architecture (sql.js / data.db).')
  console.log('✓ No unapproved usage of AI_VIDEO token.')
  console.log(`✓ Mode matrix contains all 4 canonical modes: ${REQUIRED_MODES.join(', ')}.`)
  console.log(`✓ Root AGENTS.md Pipeline stages match all 4 modes: ${Object.keys(REQUIRED_PIPELINE_CHAINS).join(', ')}.`)
  console.log('✓ Documentation is fully aligned with root AGENTS.md (PostgreSQL 16+).\n')
  process.exit(0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
