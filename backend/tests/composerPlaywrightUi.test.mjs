import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert'
import express from 'express'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '../..')
const distDir = path.join(rootDir, 'frontend/dist')

console.log('=== AI Media Composer Playwright UI Test ===')

// 1. Verify frontend dist exists
if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.log('SKIP: frontend/dist/index.html does not exist. Run "npm --prefix frontend run build" first.')
  process.exit(0)
}

// 2. Setup Express test server
const app = express()
app.use(express.json())

const mockProject = {
  id: 'test-composer-proj',
  title: 'Dự án AI Composer Mẫu',
  mode: 'MEDIA_COMPOSER',
  status: 'queued',
  aspect_ratio: '16:9',
  resolution: '1080p',
  fps: 30,
  created_date: new Date().toISOString(),
  params: {
    aspectRatio: '16:9',
    resolution: '1080p',
    fps: 30,
    defaultBackground: '#0F1117',
  },
  tracks: [
    { id: 'tr-bg', track_type: 'background', name: 'Rãnh Nền', order_index: 0, muted: 0, volume: 1.0, locked: 0 },
    { id: 'tr-img', track_type: 'image', name: 'Rãnh Ảnh', order_index: 1, muted: 0, volume: 1.0, locked: 0 },
    { id: 'tr-vo', track_type: 'voiceover', name: 'Rãnh Giọng đọc', order_index: 2, muted: 0, volume: 1.0, locked: 0 },
    { id: 'tr-bgm', track_type: 'music', name: 'Rãnh Nhạc nền', order_index: 3, muted: 0, volume: 0.8, locked: 0 },
    { id: 'tr-txt', track_type: 'text', name: 'Rãnh Phụ đề / Chữ', order_index: 4, muted: 0, volume: 1.0, locked: 0 },
  ],
  assets: [
    { id: 'asset-1', kind: 'image', name: 'slide1.jpg', url: '/placeholder.png', order_index: 0 },
    { id: 'asset-2', kind: 'image', name: 'slide2.jpg', url: '/placeholder.png', order_index: 1 },
    { id: 'asset-3', kind: 'voiceover', name: 'voice_ai.mp3', url: '/placeholder.mp3', duration_sec: 8.0, order_index: 0 },
    { id: 'asset-4', kind: 'music', name: 'ambient.mp3', url: '/placeholder.mp3', duration_sec: 15.0, order_index: 0 },
  ],
  clips: [
    { id: 'c-img-1', track_id: 'tr-img', trackId: 'tr-img', clip_type: 'image', type: 'image', start_at_sec: 0, start: 0, out_sec: 4, duration: 4, asset_id: 'asset-1' },
    { id: 'c-img-2', track_id: 'tr-img', trackId: 'tr-img', clip_type: 'image', type: 'image', start_at_sec: 4, start: 4, out_sec: 4, duration: 4, asset_id: 'asset-2' },
    { id: 'c-vo-1', track_id: 'tr-vo', trackId: 'tr-vo', clip_type: 'voiceover', type: 'voiceover', start_at_sec: 0, start: 0, out_sec: 8, duration: 8, asset_id: 'asset-3' },
    { id: 'c-bgm-1', track_id: 'tr-bgm', trackId: 'tr-bgm', clip_type: 'music', type: 'music', start_at_sec: 0, start: 0, out_sec: 8, duration: 8, asset_id: 'asset-4', volume: 0.25 },
    { id: 'c-txt-1', track_id: 'tr-txt', trackId: 'tr-txt', clip_type: 'text', type: 'text', start_at_sec: 0.5, start: 0.5, out_sec: 3.5, duration: 3.5, text_content: 'Chào mừng bạn đến với Video AI', textContent: 'Chào mừng bạn đến với Video AI', style_json: JSON.stringify({ fontSize: 28, color: '#FFFFFF', position: 'bottom', fontFamily: 'Montserrat' }) },
  ],
}

let currentClips = [...mockProject.clips]

// Mock Auth APIs
app.post('/api/v1/auth/refresh', (req, res) => {
  res.json({
    accessToken: 'mock-test-access-token',
    user: { id: 'u-tester', email: 'tester@videoai.local', name: 'Tester Pro', role: 'admin' },
  })
})
app.get('/api/v1/auth/me', (req, res) => {
  res.json({ id: 'u-tester', email: 'tester@videoai.local', name: 'Tester Pro', role: 'admin' })
})

// Mock Health & System APIs
app.get('/api/v1/health', (req, res) => {
  res.json({ status: 'ok', database: { persistenceState: 'HEALTHY' } })
})
app.get('/api/v1/system/public-settings', (req, res) => {
  res.json({ registrationEnabled: true, maintenanceMode: false })
})

// Mock Project APIs
app.get('/api/v1/projects/:id', (req, res) => {
  res.json({
    ...mockProject,
    clips: currentClips,
    extras: {
      tracks: mockProject.tracks,
      assets: mockProject.assets,
    },
  })
})
app.get('/api/v1/projects/:id/assets', (req, res) => {
  res.json(mockProject.assets)
})
app.get('/api/v1/projects/:id/jobs', (req, res) => {
  res.json([])
})
app.post('/api/v1/projects/:id/sse-ticket', (req, res) => {
  res.json({ ticket: 'mock-sse-ticket' })
})
app.get('/api/v1/projects/:id/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.write('data: {"type":"connected"}\n\n')
  setTimeout(() => res.end(), 1000)
})

// Mock Save & Auto Arrange
app.put('/api/v1/projects/:id/timeline', (req, res) => {
  currentClips = req.body.clips || []
  res.json({ success: true, count: currentClips.length })
})
app.post('/api/v1/projects/:id/auto-arrange', (req, res) => {
  currentClips = [...mockProject.clips]
  res.json({ success: true, clips: currentClips, totalDuration: 8.0 })
})

// Serve static frontend dist
app.use(express.static(distDir))
app.get('*', (req, res) => {
  res.sendFile(path.join(distDir, 'index.html'))
})

// 3. Start server
const server = http.createServer(app)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}`
console.log(`Test server running at ${baseUrl}`)

// 4. Launch Playwright
let browser = null
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
        console.log(`Launched Playwright with executable: ${p}`)
        break
      } catch (e) {
        console.warn(`Launch failed for ${p}:`, e.message)
      }
    }
  }

  if (!launched) {
    try {
      browser = await chromium.launch({ channel: 'msedge', headless: true })
      launched = true
      console.log('Launched Playwright with msedge channel')
    } catch (_) {
      browser = await chromium.launch({ headless: true })
      launched = true
      console.log('Launched Playwright default chromium')
    }
  }

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  })
  const page = await context.newPage()

  console.log(`Navigating to ${baseUrl}/projects/test-composer-proj ...`)
  await page.goto(`${baseUrl}/projects/test-composer-proj`, { waitUntil: 'networkidle', timeout: 15000 })

  // Verify Studio elements
  console.log('--- Verifying Studio Toolbar ---')
  await page.waitForSelector('text=AI Media Composer', { timeout: 8000 })
  console.log('PASS: Header badge "AI Media Composer" visible')

  const hasAutoArrange = await page.locator('button:has-text("Tự động sắp xếp")').isVisible()
  assert.ok(hasAutoArrange, 'Toolbar has "Tự động sắp xếp" button')
  console.log('PASS: "Tự động sắp xếp" button present')

  const hasResetTimeline = await page.locator('button:has-text("Đặt lại Timeline")').isVisible()
  assert.ok(hasResetTimeline, 'Toolbar has "Đặt lại Timeline" button')
  console.log('PASS: "Đặt lại Timeline" button present')

  const hasSaveTimeline = await page.locator('button:has-text("Lưu Timeline")').isVisible()
  assert.ok(hasSaveTimeline, 'Toolbar has "Lưu Timeline" button')
  console.log('PASS: "Lưu Timeline" button present')

  const hasExportVideo = await page.locator('button:has-text("Xuất Video")').isVisible()
  assert.ok(hasExportVideo, 'Toolbar has "Xuất Video" button')
  console.log('PASS: "Xuất Video" button present')

  // Verify Media Library Tabs
  console.log('--- Verifying Media Library Panels ---')
  const hasImagesTab = await page.locator('button:has-text("Hình ảnh")').first().isVisible()
  assert.ok(hasImagesTab, 'Media library has "Hình ảnh" tab')
  console.log('PASS: Media library tabs rendered')

  // Test Reset Timeline Dialog
  console.log('--- Testing Reset Timeline Confirmation Dialog ---')
  await page.locator('button:has-text("Đặt lại Timeline")').click()
  await page.waitForSelector('text=Đặt lại toàn bộ Timeline?', { timeout: 5000 })
  console.log('PASS: AlertDialog "Đặt lại toàn bộ Timeline?" opened')

  // Cancel dialog to keep clips
  await page.locator('[role="alertdialog"] button:has-text("Huỷ")').click()
  console.log('PASS: AlertDialog cancelled gracefully')

  // Take full screenshot for review evidence
  const screenshotPath = path.join(rootDir, 'media_composer_studio.png')
  await page.screenshot({ path: screenshotPath, fullPage: true })
  console.log(`PASS: Studio screenshot saved to: ${screenshotPath}`)

  assert.ok(fs.existsSync(screenshotPath), 'Screenshot file exists on disk')
  const stats = fs.statSync(screenshotPath)
  assert.ok(stats.size > 10000, `Screenshot file has valid image size (${stats.size} bytes)`)

  console.log('\n=================================================')
  console.log('ALL PLAYWRIGHT UI CHECKS & SCREENSHOT COMPLETED!')
  console.log('=================================================\n')
} catch (err) {
  console.error('Playwright UI test error:', err)
  process.exit(1)
} finally {
  if (browser) await browser.close()
  server.close()
}
