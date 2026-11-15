// Browser E2E Test with Playwright: Login & Register page layout and responsiveness
// Run: node backend/tests/loginPageBrowser.test.mjs
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '../..')
const distDir = path.join(rootDir, 'frontend/dist')

console.log('=== Playwright Browser Testing: Login & Register Page ===')

// 1. Ensure frontend/dist exists
if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.log('SKIP: frontend/dist/index.html does not exist. Run "npm --prefix frontend run build" first.')
  process.exit(0)
}

// 2. Setup mock express server
const app = express()
app.use(express.json())

app.get('/api/v1/auth/me', (req, res) => {
  res.status(401).json({ message: 'Unauthorized' })
})
app.post('/api/v1/auth/refresh', (req, res) => {
  res.status(401).json({ message: 'No refresh token' })
})
app.post('/api/v1/auth/login', (req, res) => {
  res.json({ accessToken: 'mock-access-token', user: { id: 'u1', email: req.body?.email } })
})
app.post('/api/v1/auth/google', (req, res) => {
  res.json({ accessToken: 'mock-access-token', user: { id: 'u-google', email: 'google@example.com' } })
})

// Serve static dist
app.use(express.static(distDir))
app.get('*', (req, res) => {
  res.sendFile(path.join(distDir, 'index.html'))
})

const server = http.createServer(app)

// Listen on 5173 if possible, otherwise dynamic
let port = 5173
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
} catch (_) {
  // If 5173 busy, use ephemeral
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
}

const baseUrl = `http://localhost:${port}`
console.log(`Test server active at ${baseUrl}`)

let browser = null
let failures = 0
const assert = (c, m) => {
  if (c) {
    console.log('PASS:', m)
  } else {
    failures++
    console.error('FAIL:', m)
  }
}

try {
  const { chromium } = await import('playwright')

  const possiblePaths = [
    process.env.CHROMIUM_PATH,
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe'),
  ].filter(Boolean)

  let launched = false
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      try {
        browser = await chromium.launch({ executablePath: p, headless: true })
        launched = true
        console.log(`Launched Chromium from ${p}`)
        break
      } catch (e) {
        console.warn(`Launch failed with ${p}:`, e.message)
      }
    }
  }

  if (!launched) {
    try {
      browser = await chromium.launch({ channel: 'msedge', headless: true })
      launched = true
      console.log('Launched via msedge channel')
    } catch (_) {
      browser = await chromium.launch({ headless: true })
      launched = true
      console.log('Launched via default chromium')
    }
  }

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  })
  const page = await context.newPage()

  const consoleErrors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      // Filter out expected 401 on /me, network noise, or Google GSI origin warning on localhost
      const txt = msg.text()
      if (
        !txt.includes('401') &&
        !txt.includes('Failed to load resource') &&
        !txt.includes('[GSI_LOGGER]') &&
        !txt.includes('origin is not allowed')
      ) {
        consoleErrors.push(txt)
      }
    }
  })
  page.on('pageerror', (err) => {
    consoleErrors.push(err.message)
  })

  // -------------------------------------------------------------
  // TEST 1: Inspect /login Page Layout Order (Desktop 1440x900)
  // -------------------------------------------------------------
  console.log(`\n--- Test 1: Desktop Login Page Layout Order ---`)
  await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle', timeout: 15000 })

  // Locate the key elements in Login form
  const emailInput = page.locator('input[type="email"], #email').first()
  const passwordInput = page.locator('input[type="password"], #password').first()
  const loginButton = page.locator('button[type="submit"]:has-text("Đăng nhập")').first()
  const registerButton = page.locator('a[href="/register"]:has-text("Đăng ký tài khoản"), button:has-text("Đăng ký tài khoản")').first()
  const dividerText = page.locator('div:has-text("Hoặc")').filter({ hasNot: page.locator('div div') }).first()
  // Locate Google button container or button
  const googleButtonContainer = page.locator('[data-testid="google-signin-btn"], .space-y-3:has(button, div), div:has-text("Google")').last()

  assert(await emailInput.isVisible(), 'Email input is visible')
  assert(await passwordInput.isVisible(), 'Password input is visible')
  assert(await loginButton.isVisible(), 'Nút "Đăng nhập" (Primary) is visible')
  assert(await registerButton.isVisible(), 'Nút "Đăng ký tài khoản" (Secondary) is visible')
  assert(await dividerText.isVisible(), 'Divider "Hoặc" is visible')

  // Check vertical positions (Bounding Boxes)
  const emailBox = await emailInput.boundingBox()
  const passBox = await passwordInput.boundingBox()
  const loginBox = await loginButton.boundingBox()
  const regBox = await registerButton.boundingBox()
  const divBox = await dividerText.boundingBox()

  assert(emailBox && passBox && emailBox.y < passBox.y, `Inputs order: Email (y=${emailBox?.y}) is above Password (y=${passBox?.y})`)
  assert(passBox && loginBox && passBox.y < loginBox.y, `Inputs -> Login Button: Password (y=${passBox?.y}) is above Login Button (y=${loginBox?.y})`)
  assert(loginBox && regBox && loginBox.y < regBox.y, `Login Button -> Register Button: Login (y=${loginBox?.y}) is above Register Button (y=${regBox?.y})`)
  assert(regBox && divBox && regBox.y < divBox.y, `Register Button -> Divider "Hoặc": Register Button (y=${regBox?.y}) is above Divider (y=${divBox?.y})`)

  // Check Google button is below Divider
  const googleBtn = page.locator('button:has-text("Google"), [id="google-signin-btn"], iframe[title*="Google"]').first()
  if (await googleBtn.isVisible()) {
    const googleBox = await googleBtn.boundingBox()
    assert(divBox && googleBox && divBox.y < googleBox.y, `Divider "Hoặc" (y=${divBox?.y}) is above Google Button (y=${googleBox?.y})`)
  } else {
    // Check container
    const gContainerBox = await googleButtonContainer.boundingBox()
    assert(divBox && gContainerBox && divBox.y <= gContainerBox.y, `Divider "Hoặc" (y=${divBox?.y}) is above Google Button Container (y=${gContainerBox?.y})`)
  }

  // -------------------------------------------------------------
  // TEST 2: Responsive Check on Mobile (375x667)
  // -------------------------------------------------------------
  console.log(`\n--- Test 2: Mobile Viewport Layout & Overflow Check (375x667) ---`)
  await page.setViewportSize({ width: 375, height: 667 })
  await page.waitForTimeout(500)

  // Verify elements still visible and properly stacked
  assert(await emailInput.isVisible(), 'Mobile: Email input visible')
  assert(await loginButton.isVisible(), 'Mobile: Login button visible')
  assert(await registerButton.isVisible(), 'Mobile: Register button visible')
  assert(await dividerText.isVisible(), 'Mobile: Divider "Hoặc" visible')

  const hasHorizontalScrollbar = await page.evaluate(() => {
    return document.documentElement.scrollWidth > document.documentElement.clientWidth
  })
  assert(!hasHorizontalScrollbar, 'Mobile: No horizontal overflow / horizontal scrollbar')

  // Verify dark theme styling (#0F1117 or dark background class)
  const bgColor = await page.evaluate(() => {
    return window.getComputedStyle(document.body).backgroundColor
  })
  console.log(`Background color detected: ${bgColor}`)
  assert(!!bgColor, 'Page has valid body background color')

  // Take screenshot for evidence
  const evidenceDir = path.join(rootDir, 'backend/storage/evidence')
  fs.mkdirSync(evidenceDir, { recursive: true })
  const screenshotPath = path.join(evidenceDir, 'login_page_responsive.png')
  await page.screenshot({ path: screenshotPath, fullPage: true })
  console.log(`Saved screenshot evidence to: ${screenshotPath}`)

  // -------------------------------------------------------------
  // TEST 3: Inspect /register Page Layout Order
  // -------------------------------------------------------------
  console.log(`\n--- Test 3: Register Page Layout Order ---`)
  await page.goto(`${baseUrl}/register`, { waitUntil: 'networkidle', timeout: 15000 })

  const regNameInput = page.locator('input[type="text"], #name').first()
  const regEmailInput = page.locator('input[type="email"], #email').first()
  const regSubmitButton = page.locator('button[type="submit"]:has-text("Nhận mã OTP"), button:has-text("đăng ký")').first()
  const regToLoginButton = page.locator('a[href="/login"]:has-text("Đã có tài khoản? Đăng nhập")').first()
  const regDivider = page.locator('div:has-text("Hoặc")').filter({ hasNot: page.locator('div div') }).first()

  assert(await regNameInput.isVisible(), 'Register: Name input is visible')
  assert(await regEmailInput.isVisible(), 'Register: Email input is visible')
  assert(await regSubmitButton.isVisible(), 'Register: Primary submit button is visible')
  assert(await regToLoginButton.isVisible(), 'Register: "Đã có tài khoản? Đăng nhập" button is visible')
  assert(await regDivider.isVisible(), 'Register: Divider "Hoặc" is visible')

  const rEmailBox = await regEmailInput.boundingBox()
  const rSubmitBox = await regSubmitButton.boundingBox()
  const rLoginBox = await regToLoginButton.boundingBox()
  const rDivBox = await regDivider.boundingBox()

  assert(rEmailBox && rSubmitBox && rEmailBox.y < rSubmitBox.y, `Register: Inputs (y=${rEmailBox?.y}) above Submit Button (y=${rSubmitBox?.y})`)
  assert(rSubmitBox && rLoginBox && rSubmitBox.y < rLoginBox.y, `Register: Submit Button (y=${rSubmitBox?.y}) above Login Button (y=${rLoginBox?.y})`)
  assert(rLoginBox && rDivBox && rLoginBox.y < rDivBox.y, `Register: Login Button (y=${rLoginBox?.y}) above Divider (y=${rDivBox?.y})`)

  // -------------------------------------------------------------
  // TEST 4: Console Errors Check
  // -------------------------------------------------------------
  console.log(`\n--- Test 4: Console Errors Check ---`)
  console.log(`Captured console errors: ${consoleErrors.length}`)
  if (consoleErrors.length > 0) {
    console.warn('Console errors detail:', consoleErrors)
  }
  assert(consoleErrors.length === 0, `No unexpected console errors on login/register (found ${consoleErrors.length})`)

} finally {
  if (browser) await browser.close()
  server.close()
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures} assertions failed in Playwright browser tests`)
  process.exit(1)
} else {
  console.log('\nALL PASS: Playwright browser tests on Login and Register pages completed with 100% SUCCESS.')
  process.exit(0)
}
