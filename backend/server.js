import './src/config.js'
import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'node:fs'
import { getDb } from './src/db.js'
import { initSchema } from './src/db/schema.js'
import { seed } from './src/db/seed.js'
import { config } from './src/config.js'
import { ffmpegAvailable } from './src/media/ffmpeg.js'
import v1Router from './src/routes/v1/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = config.port

app.use(cors())
app.use(express.json({ limit: '2gb' }))
app.use(express.urlencoded({ extended: true }))

// Serve uploaded / generated files
app.use('/storage', express.static(path.join(config.storageDir)))

app.use('/api/v1', v1Router)

app.get('/health', (req, res) => {
  res.json({ status: 'ok' })
})

async function tryListen(port, attempt = 0) {
  const maxAttempts = 10
  const p = Number(port)
  return new Promise((resolve, reject) => {
    const server = app.listen(p, () => {
      console.log(`[Server] Backend running at http://localhost:${p}`)
      resolve(server)
    })
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && attempt < maxAttempts) {
        const nextPort = p + 1
        console.log(`[Server] Port ${p} in use, trying ${nextPort}...`)
        server.close(() => tryListen(nextPort, attempt + 1).then(resolve, reject))
      } else if (err.code === 'EADDRINUSE') {
        console.error(`[Server] Could not find an available port after ${maxAttempts} attempts`)
        reject(err)
      } else {
        reject(err)
      }
    })
  })
}

async function start() {
  const ff = await ffmpegAvailable()
  if (ff.ok) console.log(`[Media] ${ff.version}`)
  else console.warn(`[Media] FFmpeg chưa sẵn sàng — pipeline render sẽ thất bại. Cài FFmpeg hoặc đặt FFMPEG_PATH trong backend/.env`)
  await getDb()
  console.log('[DB] SQLite initialized')
  await initSchema()
  await seed()
  await tryListen(PORT)
}

start().catch((e) => {
  console.error('[Server] Failed to start:', e)
  process.exit(1)
})
