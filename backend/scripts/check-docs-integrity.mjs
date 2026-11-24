#!/usr/bin/env node
/**
 * Documentation Integrity & Architecture Consistency Guard
 *
 * Verifies that active documentation adheres to root AGENTS.md single source of truth:
 * - Pure PostgreSQL 16+ (pg.Pool, postgresSchema.sql)
 * - No active references to legacy SQLite architecture ('sql.js', 'data.db')
 * - No unauthorized active usage of 'AI_VIDEO' mode (only allowed with alias/normalization explanation)
 * - Complete mode matrix consistency: SUMMARY, TRANSLATE_DUB, SCRIPT_TO_VIDEO, MEDIA_COMPOSER
 *
 * Run: node backend/scripts/check-docs-integrity.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..')

// Target files & directories containing active project documentation
const DOCS_TARGET_DIRS = [
  path.join(repoRoot, 'Video_AI_docs'),
]

const STANDALONE_DOCS = [
  path.join(repoRoot, 'AGENTS.md'),
  path.join(repoRoot, 'README.md'),
]

// Specific files to exclude (historical audit/migration artifacts and task prompts)
const EXCLUDED_FILES = new Set([
  'task.md', // Master task prompt describing historical migration issues
])

// Required project modes in mode matrix
const REQUIRED_MODES = [
  'SUMMARY',
  'TRANSLATE_DUB',
  'SCRIPT_TO_VIDEO',
  'MEDIA_COMPOSER',
]

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

function collectFiles(dir) {
  const results = []
  if (!fs.existsSync(dir)) return results

  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      results.push(...collectFiles(fullPath))
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

function runAudit() {
  console.log('--- Documentation Integrity Guard (PostgreSQL & Mode Alignment) ---')
  console.log(`Repository root: ${repoRoot}`)

  let allFiles = []
  for (const file of STANDALONE_DOCS) {
    if (fs.existsSync(file)) {
      allFiles.push(file)
    }
  }

  for (const dir of DOCS_TARGET_DIRS) {
    if (fs.existsSync(dir)) {
      allFiles.push(...collectFiles(dir))
    }
  }

  console.log(`Auditing ${allFiles.length} active documentation files...\n`)

  let violationsCount = 0
  const violationsByFile = new Map()

  for (const filePath of allFiles) {
    const relPath = path.relative(repoRoot, filePath).replace(/\\/g, '/')
    const content = fs.readFileSync(filePath, 'utf8')
    const lines = content.split(/\r?\n/)

    lines.forEach((line, lineIndex) => {
      for (const rule of FORBIDDEN_RULES) {
        if (rule.pattern.test(line)) {
          if (rule.isAllowed && rule.isAllowed(line)) {
            // Contextually permitted (negative assertion or alias explanation)
            continue
          }
          violationsCount++
          if (!violationsByFile.has(relPath)) {
            violationsByFile.set(relPath, [])
          }
          violationsByFile.get(relPath).push({
            lineNum: lineIndex + 1,
            rule: rule.name,
            reason: rule.reason,
            snippet: line.trim(),
          })
        }
      }
    })
  }

  // Verify Mode Matrix presence in root AGENTS.md
  const rootAgentsPath = path.join(repoRoot, 'AGENTS.md')
  if (fs.existsSync(rootAgentsPath)) {
    const rootAgentsContent = fs.readFileSync(rootAgentsPath, 'utf8')
    const missingModes = REQUIRED_MODES.filter((m) => !rootAgentsContent.includes(m))
    if (missingModes.length > 0) {
      violationsCount++
      const relPath = 'AGENTS.md'
      if (!violationsByFile.has(relPath)) violationsByFile.set(relPath, [])
      violationsByFile.get(relPath).push({
        lineNum: 1,
        rule: 'MODE_MATRIX_INCOMPLETE',
        reason: `Root AGENTS.md missing mode(s): ${missingModes.join(', ')}`,
        snippet: `Required modes: ${REQUIRED_MODES.join(', ')}`,
      })
    }
  }

  if (violationsCount > 0) {
    console.error(`[FAIL] Found ${violationsCount} documentation integrity violation(s):\n`)
    for (const [file, items] of violationsByFile.entries()) {
      console.error(`File: ${file}`)
      for (const item of items) {
        console.error(`  Line ${item.lineNum} [${item.rule}]: ${item.snippet}`)
        console.error(`    -> ${item.reason}`)
      }
      console.error('')
    }
    process.exit(1)
  }

  console.log(`[PASS] All ${allFiles.length} documentation files are clean!`)
  console.log('✓ No active documentation references to legacy SQLite architecture (sql.js / data.db).')
  console.log('✓ No unapproved usage of AI_VIDEO token.')
  console.log(`✓ Mode matrix contains all 4 canonical modes: ${REQUIRED_MODES.join(', ')}.`)
  console.log('✓ Documentation is fully aligned with root AGENTS.md (PostgreSQL 16+).\n')
  process.exit(0)
}

runAudit()
