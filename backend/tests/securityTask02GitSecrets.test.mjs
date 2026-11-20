// Security Hardening TASK-02: Git Secrets & Push Protection
// Run: node backend/tests/securityTask02GitSecrets.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { scanContent, runSecretScan } from '../scripts/scan-secrets.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..')

let failures = 0
function assert(cond, msg) {
  if (cond) {
    console.log('PASS:', msg)
  } else {
    failures++
    console.error('FAIL:', msg)
  }
}

console.log('=== TASK 2: Git Secrets & Push Protection Test Suite ===\n')

// 1. .gitignore Contract
console.log('--- 1. .gitignore Contract ---')
{
  const gitignorePath = path.join(repoRoot, '.gitignore')
  assert(fs.existsSync(gitignorePath), '.gitignore exists in repo root')
  const content = fs.readFileSync(gitignorePath, 'utf8')

  assert(content.includes('.env'), '.gitignore ignores .env')
  assert(content.includes('.env.*'), '.gitignore ignores .env.*')
  assert(content.includes('!.env.example'), '.gitignore allows .env.example')
  assert(content.includes('!.env.production.example'), '.gitignore allows .env.production.example')
  assert(content.includes('*.pem'), '.gitignore ignores *.pem')
  assert(content.includes('*.key'), '.gitignore ignores *.key')
  assert(content.includes('*.cert'), '.gitignore ignores *.cert')
  assert(content.includes('*.crt'), '.gitignore ignores *.crt')
  assert(content.includes('*.pfx'), '.gitignore ignores *.pfx')
  assert(content.includes('id_rsa'), '.gitignore ignores id_rsa')
}

// 2. .gitleaks.toml Contract
console.log('\n--- 2. .gitleaks.toml Contract ---')
{
  const gitleaksPath = path.join(repoRoot, '.gitleaks.toml')
  assert(fs.existsSync(gitleaksPath), '.gitleaks.toml exists in repo root')
  const content = fs.readFileSync(gitleaksPath, 'utf8')

  assert(content.includes('generic-private-key'), '.gitleaks.toml defines private key rule')
  assert(content.includes('openai-api-key'), '.gitleaks.toml defines openai rule')
  assert(content.includes('google-gemini-api-key'), '.gitleaks.toml defines gemini rule')
  assert(content.includes('aws-access-key-id'), '.gitleaks.toml defines aws access key rule')
  assert(content.includes('allowlist'), '.gitleaks.toml defines allowlist')
  assert(/env.*example/.test(content), '.gitleaks.toml allowlist covers .env.example')
}

// 3. Secret Scanner Logic & Detection Capability
console.log('\n--- 3. Secret Scanner Logic & Unit Tests ---')
{
  // 3.1 Detecting private key
  const privKeySample = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0\n-----END RSA PRIVATE KEY-----'
  const privKeyFindings = scanContent(privKeySample, 'test.pem')
  assert(privKeyFindings.length === 1 && privKeyFindings[0].ruleId === 'private-key', 'scanner detects RSA private key')

  // 3.2 Detecting OpenAI API key
  const openaiSample = 'const key = "sk-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJKL"'
  const openaiFindings = scanContent(openaiSample, 'test.js')
  assert(openaiFindings.length === 1 && openaiFindings[0].ruleId === 'openai-api-key', 'scanner detects OpenAI API key')

  // 3.3 Detecting AWS Access key
  const awsSample = 'const awsKey = "AKIAIOSFODNN7EXAMPLE"'
  const awsFindings = scanContent(awsSample, 'config.js')
  assert(awsFindings.length === 1 && awsFindings[0].ruleId === 'aws-access-key', 'scanner detects AWS access key')

  // 3.4 Ignoring allowed stopwords
  const stopwordSample = 'const pass = "VideoAI_Secure_Db_2026!"\nconst mock = "replace-with-something"'
  const stopwordFindings = scanContent(stopwordSample, 'mock.js')
  assert(stopwordFindings.length === 0, 'scanner ignores allowed placeholders and stopwords')

  // 3.5 Clean code passes
  const cleanCode = 'export const PORT = 3001\nconsole.log("Server running")'
  const cleanFindings = scanContent(cleanCode, 'server.js')
  assert(cleanFindings.length === 0, 'scanner passes clean code without findings')
}

// 4. Repository Scan Verification (Zero Real Leaks in Git)
console.log('\n--- 4. Repository Live Git Scan ---')
{
  const result = runSecretScan('all')
  assert(result.filesScanned > 100, `scanner scanned tracked repository files (scanned ${result.filesScanned})`)
  assert(result.findings.length === 0, `0 secret leaks detected across tracked files (got ${result.findings.length})`)
}

// 5. CI / GitHub Actions Contract
console.log('\n--- 5. CI Workflow Contract ---')
{
  const ciPath = path.join(repoRoot, '.github', 'workflows', 'ci.yml')
  assert(fs.existsSync(ciPath), 'ci.yml exists')
  const content = fs.readFileSync(ciPath, 'utf8')

  assert(content.includes('Gitleaks Secret Scanner') || content.includes('gitleaks/gitleaks-action'), 'ci.yml runs Gitleaks scanner')
  assert(content.includes('scan-secrets.mjs'), 'ci.yml runs repository secret scan script')
}

console.log(failures === 0 ? '\nALL TASK 2 TESTS PASS' : `\n${failures} FAILURES IN TASK 2`)
process.exit(failures === 0 ? 0 : 1)
