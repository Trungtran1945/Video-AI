// Browser E2E Test with Playwright: AI Media Composer Playback Clock & Timeline Playhead
// Run: node backend/tests/composerPlaybackClockBrowser.test.mjs
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '../..')
const distDir = path.join(rootDir, 'frontend/dist')
const evidenceDir = path.join(rootDir, 'backend/storage/evidence')
if (!fs.existsSync(evidenceDir)) fs.mkdirSync(evidenceDir, { recursive: true })

console.log('=== Playwright Browser Testing: Composer Playback Clock ===')

if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.log('SKIP: frontend/dist/index.html does not exist. Run "npm --prefix frontend run build" first.')
  process.exit(0)
}

const projId = 'test-composer-proj-123'
const app = express()
app.use(express.json())

// Mock Auth
app.get('/api/v1/auth/me', (req, res) => {
  res.json({ id: 'u1', email: 'composer-test@local', role: 'user' })
})
app.post('/api/v1/auth/refresh', (req, res) => {
  res.json({ accessToken: 'mock-access-token', user: { id: 'u1', email: 'composer-test@local' } })
})

// Mock Health & System APIs
app.get('/api/v1/health', (req, res) => {
  res.json({ status: 'ok', database: { persistenceState: 'HEALTHY' } })
})
app.get('/api/v1/system/public-settings', (req, res) => {
  res.json({ registrationEnabled: true, maintenanceMode: false })
})

// Mock Project
const mockClips = [
  {
    id: 'clip-audio-1',
    project_id: projId,
    clip_type: 'voiceover',
    type: 'voiceover',
    track_id: 'tr-vo',
    trackId: 'tr-vo',
    name: 'voiceover.mp3',
    start_at_sec: 0,
    start: 0,
    out_sec: 8,
    duration: 8,
    audio_id: 'asset-audio-1',
    asset_id: 'asset-audio-1',
    volume: 1.0,
    meta: {},
  },
]

const mockProject = {
  id: projId,
  user_id: 'u1',
  title: 'Test Audio Composer Project',
  mode: 'MEDIA_COMPOSER',
  status: 'completed',
  aspect_ratio: '16:9',
  duration: 10,
  created_at: new Date().toISOString(),
  clips: mockClips,
  timeline: mockClips,
  tracks: [
    { id: 'tr-bg', project_id: projId, track_type: 'background', name: 'Nền', order_index: 0, muted: 0, volume: 1.0 },
    { id: 'tr-vo', project_id: projId, track_type: 'voiceover', name: 'Lồng tiếng', order_index: 4, muted: 0, volume: 1.0 },
    { id: 'tr-bgm', project_id: projId, track_type: 'music', name: 'Nhạc nền', order_index: 5, muted: 0, volume: 1.0 },
  ],
  jobs: [],
}

app.get(`/api/v1/projects/${projId}`, (req, res) => {
  res.json(mockProject)
})

app.get(`/api/v1/projects/${projId}/assets`, (req, res) => {
  res.json({
    assets: [
      {
        id: 'asset-audio-1',
        projectId: projId,
        project_id: projId,
        kind: 'voiceover',
        name: 'voiceover.mp3',
        url: '/storage/test-audio.mp3',
        durationSec: 8,
        duration_sec: 8,
        byteSize: 1024,
        mimeType: 'audio/mpeg',
      },
    ],
  })
})

app.post(`/api/v1/projects/${projId}/sse-ticket`, (req, res) => {
  res.json({ ticket: 'test-sse-ticket' })
})

app.get(`/api/v1/projects/${projId}/events`, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.write(': keepalive\n\n')
  // Keep connection open without emitting errors
  const timer = setInterval(() => {
    res.write(': keepalive\n\n')
  }, 10000)
  req.on('close', () => clearInterval(timer))
})

app.get('/api/v1/style-presets', (req, res) => {
  res.json([])
})

// Serve empty MP3 buffer
const minimalMp3 = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00])
app.get('/storage/test-audio.mp3', (req, res) => {
  res.setHeader('Content-Type', 'audio/mpeg')
  res.send(minimalMp3)
})

// Serve static dist
app.use(express.static(distDir))
app.get('*', (req, res) => {
  res.sendFile(path.join(distDir, 'index.html'))
})

const server = http.createServer(app)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}`
console.log(`Playback test server active at ${baseUrl}`)

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

  // Track console errors
  const consoleErrors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const txt = msg.text()
      if (!txt.includes('401') && !txt.includes('Failed to load resource')) {
        consoleErrors.push(txt)
      }
    }
  })

  // Set mock access token before page load
  await page.addInitScript(() => {
    // Write fake token store
    window.__mock_auth = true
  })

  console.log(`Navigating to ${baseUrl}/projects/${projId}...`)
  await page.goto(`${baseUrl}/projects/${projId}`, { waitUntil: 'domcontentloaded', timeout: 15000 })

  const playButton = page.locator('button:has(svg.lucide-play)').first()
  await playButton.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})

  // Verify page loaded Composer Studio layout
  const mediaLibraryTitle = await page.textContent('body')
  assert(
    mediaLibraryTitle.includes('AI Media Composer') || mediaLibraryTitle.includes('Thư viện Media') || mediaLibraryTitle.includes('Timeline'),
    'Project detail rendered in MEDIA_COMPOSER studio mode'
  )

  // Find Play button in preview or timeline
  console.log('Finding Play / Pause button...')
  // Button can be in ComposerPreview or VideoTimeline
  const isPlayVisible = await playButton.isVisible({ timeout: 5000 }).catch(() => false)
  assert(isPlayVisible, 'Play button is visible in Composer Studio')

  // Capture initial playhead position
  const playhead = page.locator('.playhead, [data-testid="playhead"], div:has(> div[class*="bg-primary"])').first()
  
  // Read initial time indicator text (e.g., 00:00.00 / 00:10.00 or 00:00)
  const initialBodyText = await page.innerText('body')
  console.log('Initial page ready, clicking Play...')
  await playButton.click()

  // Wait 1200ms to allow Master Clock to tick
  await page.waitForTimeout(1200)

  // Inspect if time moved or Pause button appeared
  const pauseButton = page.locator('button:has(svg.lucide-pause)').first()
  const isPauseVisible = await pauseButton.isVisible({ timeout: 2000 }).catch(() => false)
  assert(isPauseVisible, 'Play state toggled: Pause icon visible while playing')

  // Check that current time text is greater than 00:00.00
  const afterPlayText = await page.innerText('body')
  const timeRegex = /00:0[1-9]\.[0-9]{2}|00:0[1-9]|00:00\.[2-9][0-9]/
  const hasTimeAdvanced = timeRegex.test(afterPlayText)
  console.log('Has time advanced past 0s?', hasTimeAdvanced)
  assert(hasTimeAdvanced, 'Master Software Clock ticked and advanced currentTime forward')

  // Take screenshot evidence
  const evidencePath = path.join(evidenceDir, 'composer_playback_clock_running.png')
  await page.screenshot({ path: evidencePath, fullPage: false })
  console.log(`✓ Screenshot evidence saved to: ${evidencePath}`)

  // Pause playback
  await pauseButton.click()
  await page.waitForTimeout(300)
  const isPlayBackAgain = await playButton.isVisible({ timeout: 2000 }).catch(() => false)
  assert(isPlayBackAgain, 'Pause clicked: Play button returns and playback halts cleanly')

  assert(consoleErrors.length === 0, `0 unexpected console errors (found ${consoleErrors.length}: ${consoleErrors.join(', ')})`)

  console.log(`\n================================================================`)
  console.log(`PLAYBACK CLOCK BROWSER TEST COMPLETE: ${failures === 0 ? 'ALL PASS (100%)' : failures + ' FAILED'}`)
  console.log(`================================================================\n`)

  process.exit(failures === 0 ? 0 : 1)
} catch (err) {
  console.error('Test execution failed:', err)
  process.exit(1)
} finally {
  if (browser) await browser.close()
  server.close()
}
