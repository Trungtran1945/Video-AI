#!/usr/bin/env node
/**
 * Legacy SQLite Artifacts Guard
 *
 * Ensures active backend source, scripts, tests, and package manifests remain
 * pure PostgreSQL 16+ (pg.Pool) and contain no leftover SQLite / sql.js / DB_PATH
 * references outside `backend/scripts/archive/`.
 *
 * Run: node backend/scripts/check-legacy-artifacts.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const defaultBackendRoot = path.resolve(__dirname, '..')

const GUARD_SCRIPTS = new Set([
  'backend/scripts/check-docs-integrity.mjs',
  'backend/scripts/check-legacy-artifacts.mjs',
  'backend/scripts/verify_criteria_matrix.mjs',
])

const CODE_EXTS = new Set(['.js', '.mjs', '.cjs'])
const SRC_EXTS = new Set(['.js', '.mjs', '.cjs', '.sql'])

function collectFiles(dir, allowedExts, { excludeDirs = new Set() } = {}) {
  const results = []
  if (!fs.existsSync(dir)) return results
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || excludeDirs.has(entry.name)) {
        continue
      }
      results.push(...collectFiles(fullPath, allowedExts, { excludeDirs }))
    } else if (entry.isFile() && allowedExts.has(path.extname(entry.name).toLowerCase())) {
      results.push(fullPath)
    }
  }
  return results
}

function addViolation(violationsByFile, relPath, lineNum, rule, reason, snippet) {
  if (!violationsByFile.has(relPath)) violationsByFile.set(relPath, [])
  violationsByFile.get(relPath).push({ lineNum, rule, reason, snippet })
}

function stripCommentsByLine(content, { isSql = false } = {}) {
  const codeChars = []
  let i = 0
  const n = content.length
  let state = 'code' // 'code' | 'single' | 'double' | 'template' | 'regex' | 'lineComment' | 'blockComment'
  let inRegexClass = false
  let prevNonSpace = ''

  while (i < n) {
    const ch = content[i]
    const next = content[i + 1]

    if (ch === '\n' || ch === '\r') {
      if (state === 'lineComment' || state === 'regex') state = 'code'
      codeChars.push(ch)
      i++
      continue
    }

    if (state === 'lineComment') {
      i++
      continue
    }

    if (state === 'blockComment') {
      if (ch === '*' && next === '/') {
        state = 'code'
        i += 2
      } else {
        i++
      }
      continue
    }

    if (state === 'single' || state === 'double' || state === 'template') {
      codeChars.push(ch)
      if (ch === '\\' && next !== undefined) {
        codeChars.push(next)
        i += 2
        continue
      }
      if (
        (state === 'single' && ch === "'") ||
        (state === 'double' && ch === '"') ||
        (state === 'template' && ch === '`')
      ) {
        state = 'code'
        prevNonSpace = ch
      }
      i++
      continue
    }

    if (state === 'regex') {
      codeChars.push(ch)
      if (ch === '\\' && next !== undefined) {
        codeChars.push(next)
        i += 2
        continue
      }
      if (ch === '[' && !inRegexClass) inRegexClass = true
      else if (ch === ']' && inRegexClass) inRegexClass = false
      else if (ch === '/' && !inRegexClass) {
        state = 'code'
        prevNonSpace = '/'
      }
      i++
      continue
    }

    // state === 'code'
    if (isSql && ch === '-' && next === '-') {
      state = 'lineComment'
      i += 2
      continue
    }
    if (!isSql && ch === '/' && next === '/') {
      state = 'lineComment'
      i += 2
      continue
    }
    if (ch === '/' && next === '*') {
      state = 'blockComment'
      i += 2
      continue
    }

    if (ch === "'") {
      state = 'single'
      codeChars.push(ch)
      i++
      continue
    }
    if (ch === '"') {
      state = 'double'
      codeChars.push(ch)
      i++
      continue
    }
    if (!isSql && ch === '`') {
      state = 'template'
      codeChars.push(ch)
      i++
      continue
    }
    if (!isSql && ch === '/' && (!prevNonSpace || '=(,[!:!&|?;{}+-*~^%<>'.includes(prevNonSpace))) {
      state = 'regex'
      inRegexClass = false
      codeChars.push(ch)
      i++
      continue
    }

    codeChars.push(ch)
    if (ch !== ' ' && ch !== '\t') prevNonSpace = ch
    i++
  }

  return codeChars.join('').split(/\r?\n/)
}

export function runLegacyAudit({ backendRoot = defaultBackendRoot, silent = false } = {}) {
  const repoRoot = path.resolve(backendRoot, '..')
  const violationsByFile = new Map()
  let violationsCount = 0

  const record = (relPath, lineNum, rule, reason, snippet) => {
    violationsCount++
    addViolation(violationsByFile, relPath, lineNum, rule, reason, snippet)
  }

  // 1. Check backend/package.json & backend/package-lock.json
  const pkgPath = path.join(backendRoot, 'package.json')
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    const hasSqlJs = Boolean(
      pkg.dependencies?.['sql.js'] ||
      pkg.devDependencies?.['sql.js'] ||
      pkg.optionalDependencies?.['sql.js']
    )
    if (hasSqlJs) {
      record('backend/package.json', 1, 'SQLJS_DEPENDENCY', 'sql.js must not be declared in package.json', '"sql.js"')
    }
  }

  const lockPath = path.join(backendRoot, 'package-lock.json')
  if (fs.existsSync(lockPath)) {
    const lock = fs.readFileSync(lockPath, 'utf8')
    if (lock.includes('"sql.js"') || lock.includes('node_modules/sql.js')) {
      record('backend/package-lock.json', 1, 'SQLJS_LOCKFILE', 'sql.js must not appear in package-lock.json', '"sql.js"')
    }
  }

  // 2. Collect active backend files (excluding backend/scripts/archive/)
  const srcFiles = collectFiles(path.join(backendRoot, 'src'), SRC_EXTS)
  const scriptFiles = collectFiles(path.join(backendRoot, 'scripts'), CODE_EXTS, {
    excludeDirs: new Set(['archive']),
  })
  const testFiles = collectFiles(path.join(backendRoot, 'tests'), CODE_EXTS)

  const allFiles = [
    ...srcFiles.map((f) => ({ fullPath: f, kind: 'src' })),
    ...scriptFiles.map((f) => ({ fullPath: f, kind: 'scripts' })),
    ...testFiles.map((f) => ({ fullPath: f, kind: 'tests' })),
  ]

  const sqlJsImportRe = /\bfrom\s+['"]sql\.js['"]|import\s*\(\s*['"]sql\.js['"]\s*\)|require\s*\(\s*['"]sql\.js['"]\s*\)|\binitSqlJs\b/
  const sqlJsTokenRe = /\bsql\.js\b/i
  const dbPathRe = /\bDB_PATH\b/
  const envDbPathRe = /\bprocess\.env\.DB_PATH\b/
  const forceSqliteRe = /\bFORCE_SQLITE\b/
  const envForceSqliteRe = /\bprocess\.env\.FORCE_SQLITE\b/
  const sqliteMasterRe = /\bsqlite_master\b/i
  const dbLiteralRe = /(['"`])[^'"`\r\n]*\.db\1/i

  for (const { fullPath, kind } of allFiles) {
    const relPath = path.relative(repoRoot, fullPath).replace(/\\/g, '/')
    const isGuardScript = GUARD_SCRIPTS.has(relPath)
    const isSelfGuard = relPath === 'backend/scripts/check-legacy-artifacts.mjs'
    const isSql = path.extname(fullPath).toLowerCase() === '.sql'
    const rawContent = fs.readFileSync(fullPath, 'utf8')
    const rawLines = rawContent.split(/\r?\n/)
    const codeLines = stripCommentsByLine(rawContent, { isSql })

    codeLines.forEach((codeLine, idx) => {
      const lineNum = idx + 1
      const snippet = (rawLines[idx] ?? codeLine).trim()

      if (isGuardScript) {
        if (!isSelfGuard && sqlJsImportRe.test(codeLine)) {
          record(relPath, lineNum, 'SQLJS_IMPORT', 'sql.js import is forbidden outside backend/scripts/archive/', snippet)
        }
        if (envDbPathRe.test(codeLine) || envForceSqliteRe.test(codeLine)) {
          record(relPath, lineNum, 'GUARD_ENV_SQLITE', 'Guard scripts must not read/set DB_PATH or FORCE_SQLITE env vars', snippet)
        }
        return
      }

      if (sqlJsImportRe.test(codeLine)) {
        record(relPath, lineNum, 'SQLJS_IMPORT', 'sql.js import is forbidden outside backend/scripts/archive/', snippet)
      }
      if (sqlJsTokenRe.test(codeLine)) {
        record(relPath, lineNum, 'SQLJS_REFERENCE', 'Legacy sql.js reference is forbidden outside backend/scripts/archive/', snippet)
      }
      if (dbPathRe.test(codeLine)) {
        record(relPath, lineNum, 'DB_PATH', 'Legacy DB_PATH env/token is dead in PostgreSQL mode and must not be used', snippet)
      }
      if (forceSqliteRe.test(codeLine)) {
        record(relPath, lineNum, 'FORCE_SQLITE', 'Legacy FORCE_SQLITE token is dead in PostgreSQL mode and must not be used', snippet)
      }
      if (sqliteMasterRe.test(codeLine)) {
        record(relPath, lineNum, 'SQLITE_MASTER', 'sqlite_master query is incompatible with PostgreSQL', snippet)
      }
      if ((kind === 'tests' || kind === 'src' || kind === 'scripts') && dbLiteralRe.test(codeLine)) {
        record(relPath, lineNum, 'SQLITE_DB_FILE', 'Legacy .db file path literal is forbidden outside backend/scripts/archive/', snippet)
      }
    })
  }

  const ok = violationsCount === 0
  if (!silent) {
    console.log('--- Legacy SQLite Artifacts Guard ---')
    console.log(`Scanned ${srcFiles.length} src, ${scriptFiles.length} active script, and ${testFiles.length} test files.\n`)
    if (!ok) {
      console.error(`[FAIL] Found ${violationsCount} legacy SQLite artifact violation(s):\n`)
      for (const [file, items] of violationsByFile.entries()) {
        console.error(`File: ${file}`)
        for (const item of items) {
          console.error(`  Line ${item.lineNum} [${item.rule}]: ${item.snippet}`)
          console.error(`    -> ${item.reason}`)
        }
        console.error('')
      }
    } else {
      console.log(`[PASS] All ${allFiles.length} active backend files are clean of legacy SQLite artifacts!`)
      console.log('✓ Zero sql.js dependencies, imports, or references outside backend/scripts/archive/.')
      console.log('✓ Zero DB_PATH, FORCE_SQLITE, sqlite_master, or .db file literals in src/scripts/tests.\n')
    }
  }

  return {
    ok,
    violationsCount,
    violationsByFile,
    scannedCounts: {
      src: srcFiles.length,
      scripts: scriptFiles.length,
      tests: testFiles.length,
    },
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isCli) {
  const res = runLegacyAudit()
  process.exit(res.ok ? 0 : 1)
}
