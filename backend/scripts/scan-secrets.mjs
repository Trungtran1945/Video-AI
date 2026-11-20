#!/usr/bin/env node
// Local & CI Secret Scanner for Video AI
// Scans git-tracked files or staged changes for secrets before committing or pushing.
// Run: node backend/scripts/scan-secrets.mjs [--staged|--all]

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..')

const RULES = [
  {
    id: 'private-key',
    description: 'Unencrypted Private Key',
    regex: /-----BEGIN[ A-Z0-9_-]*PRIVATE KEY-----/i,
  },
  {
    id: 'openai-api-key',
    description: 'OpenAI API Key',
    regex: /\b(sk-[a-zA-Z0-9]{48})\b/,
  },
  {
    id: 'google-api-key',
    description: 'Google Cloud / Gemini API Key',
    regex: /\b(AIza[0-9A-Za-z\-_]{35})\b/,
  },
  {
    id: 'aws-access-key',
    description: 'AWS Access Key ID',
    regex: /\b((?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16})\b/,
  },
  {
    id: 'github-pat',
    description: 'GitHub Personal Access Token',
    regex: /\b(ghp_[a-zA-Z0-9]{36})\b/,
  },
  {
    id: 'slack-webhook',
    description: 'Slack Webhook URL',
    regex: /https:\/\/hooks\.slack\.com\/services\/T[a-zA-Z0-9_]{8}\/B[a-zA-Z0-9_]{8,12}\/[a-zA-Z0-9_]{24}/,
  },
]

const ALLOWED_PATH_PATTERNS = [
  /\.env\.example$/i,
  /\.env\.production\.example$/i,
  /\.gitleaks\.toml$/i,
  /package-lock\.json$/i,
  /\.min\.(js|css)$/i,
  /\.(png|jpg|jpeg|gif|webp|ico|svg|mp4|webm|wav|mp3|pdf|ttf|woff|woff2)$/i,
]

const ALLOWED_STOPWORDS = [
  'VideoAI_Secure_Db_2026!',
  'video-ai-dev-access-secret',
  'video-ai-dev-refresh-secret',
  'dev-master-key',
  'change-me-in-production',
  'replace-with-',
  'test-access-secret',
  'test-refresh-secret',
  'test-master-key',
  'AIzaSyD-abc1234567890xyz', // unit test mock
  'example',
  'dummy',
]

function isPathAllowed(relPath) {
  const norm = relPath.replace(/\\/g, '/')
  for (const pattern of ALLOWED_PATH_PATTERNS) {
    if (pattern.test(norm)) return true
  }
  return false
}

function containsStopword(line) {
  for (const word of ALLOWED_STOPWORDS) {
    if (line.includes(word)) return true
  }
  return false
}

function maskMatch(str) {
  if (!str) return '****'
  const s = String(str)
  if (s.length <= 8) return '****'
  return s.slice(0, 3) + '****' + s.slice(-3)
}

export function scanContent(content, filePath = 'unknown') {
  const findings = []
  const lines = content.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (containsStopword(line)) continue

    for (const rule of RULES) {
      const match = line.match(rule.regex)
      if (match) {
        findings.push({
          file: filePath,
          line: i + 1,
          ruleId: rule.id,
          description: rule.description,
          preview: maskMatch(match[1] || match[0]),
        })
      }
    }
  }

  return findings
}

export function getFilesToScan(mode = 'all') {
  try {
    let cmd = ['ls-files']
    if (mode === 'staged') {
      cmd = ['diff', '--cached', '--name-only', '--diff-filter=ACMR']
    }
    const r = spawnSync('git', cmd, { cwd: repoRoot, encoding: 'utf8' })
    if (r.status === 0) {
      return r.stdout
        .split(/\r?\n/)
        .map((f) => f.trim())
        .filter(Boolean)
    }
  } catch (_) {}

  return []
}

export function runSecretScan(mode = 'all') {
  const files = getFilesToScan(mode)
  console.log(`[SecretScan] Scanning ${files.length} file(s) in mode: ${mode}...`)

  const allFindings = []
  let filesScanned = 0

  for (const file of files) {
    if (isPathAllowed(file)) continue
    const fullPath = path.join(repoRoot, file)
    if (!fs.existsSync(fullPath)) continue

    try {
      const stat = fs.statSync(fullPath)
      if (stat.size > 2 * 1024 * 1024) continue // Skip large files > 2MB

      const content = fs.readFileSync(fullPath, 'utf8')
      filesScanned++
      const findings = scanContent(content, file)
      if (findings.length > 0) {
        allFindings.push(...findings)
      }
    } catch (_) {
      // Ignore unreadable / binary files
    }
  }

  return { findings: allFindings, filesScanned }
}

if (process.argv[1] && process.argv[1].endsWith('scan-secrets.mjs')) {
  const mode = process.argv.includes('--staged') ? 'staged' : 'all'
  const { findings, filesScanned } = runSecretScan(mode)

  if (findings.length > 0) {
    console.error(`\n[SecretScan] ❌ FAILED: Found ${findings.length} potential secret(s) in git files:\n`)
    for (const f of findings) {
      console.error(`  - ${f.file}:${f.line} [${f.ruleId}] ${f.description}: ${f.preview}`)
    }
    console.error(`\nPlease remove or mask these secrets before pushing to Git.`)
    process.exit(1)
  } else {
    console.log(`[SecretScan] ✅ PASSED: Clean. Scanned ${filesScanned} files with 0 secrets detected.`)
    process.exit(0)
  }
}
