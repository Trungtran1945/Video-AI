import { getDb, save } from '../db.js'
import { config } from '../config.js'

// Initialize all tables for the two-mode system (sql.js / SQLite).
// Mirrors docs/02_THIET_KE_CO_SO_DU_LIEU.md but uses sql.js (no Prisma).
// Deviations kept intentionally for the MVP:
// - Enum values stored lowercase ('user', 'pending', ...) — matches API/frontend contract
//   (docs use Prisma enums UPPERCASE; SQLite has no native enums).
//   project.mode is stored as posted ('SUMMARY' | 'TRANSLATE_DUB').
// - reset_tokens is an extension table (forgot-password flow) not present in the doc schema.
// - projects stores both source_video_id (doc) and source_video_key (API contract);
//   template_video_* columns are legacy from the removed STYLE_EDIT mode (kept inert).
// - users.credits column is legacy/inert — never exposed through the API.
export async function initSchema() {
  const db = await getDb()

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    name TEXT DEFAULT '',
    credits INTEGER DEFAULT 0,
    refresh_token TEXT,
    refresh_expires TEXT,
    created_date TEXT DEFAULT (datetime('now')),
    updated_date TEXT DEFAULT (datetime('now'))
  )`)

  // Add new columns if upgrading from an older schema
  try { db.run(`ALTER TABLE users ADD COLUMN refresh_token TEXT`) } catch (_) {}
  try { db.run(`ALTER TABLE users ADD COLUMN refresh_expires TEXT`) } catch (_) {}
  try { db.run(`ALTER TABLE users ADD COLUMN credits INTEGER DEFAULT 0`) } catch (_) {}

  db.run(`CREATE TABLE IF NOT EXISTS reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    created_date TEXT DEFAULT (datetime('now'))
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS settings (
    user_id TEXT PRIMARY KEY,
    default_language TEXT DEFAULT 'vi',
    default_style TEXT DEFAULT 'cinematic',
    default_duration INTEGER DEFAULT 60,
    max_retries INTEGER DEFAULT 3,
    auto_upload_youtube INTEGER DEFAULT 0,
    notify_on_complete INTEGER DEFAULT 1,
    active_llm_provider TEXT DEFAULT 'gemini',
    active_image_provider TEXT DEFAULT 'flux',
    active_video_provider TEXT DEFAULT '',
    active_voice_provider TEXT DEFAULT 'edge_tts',
    active_subtitle_provider TEXT DEFAULT 'whisper',
    voice_provider TEXT DEFAULT 'edge_tts',
    aspect_ratio TEXT DEFAULT '16:9'
  )`)

  // Add new columns if upgrading from an older schema
  for (const col of [
    `ALTER TABLE settings ADD COLUMN default_duration INTEGER DEFAULT 60`,
    `ALTER TABLE settings ADD COLUMN max_retries INTEGER DEFAULT 3`,
    `ALTER TABLE settings ADD COLUMN auto_upload_youtube INTEGER DEFAULT 0`,
    `ALTER TABLE settings ADD COLUMN notify_on_complete INTEGER DEFAULT 1`,
    `ALTER TABLE settings ADD COLUMN active_llm_provider TEXT DEFAULT 'gemini'`,
    `ALTER TABLE settings ADD COLUMN active_image_provider TEXT DEFAULT 'flux'`,
    `ALTER TABLE settings ADD COLUMN active_video_provider TEXT DEFAULT ''`,
    `ALTER TABLE settings ADD COLUMN active_subtitle_provider TEXT DEFAULT 'whisper'`,
    `ALTER TABLE settings ADD COLUMN active_translate_provider TEXT DEFAULT 'google_translate'`,
    `ALTER TABLE settings ADD COLUMN active_voice_provider TEXT DEFAULT 'edge_tts'`,
    `ALTER TABLE settings ADD COLUMN voice_provider TEXT DEFAULT 'edge_tts'`,
    `ALTER TABLE settings ADD COLUMN aspect_ratio TEXT DEFAULT '16:9'`,
  ]) {
    try { db.run(col) } catch (_) {}
  }

  db.run(`CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    language TEXT DEFAULT 'vi',
    style TEXT DEFAULT 'cinematic',
    target_duration_sec INTEGER DEFAULT 60,
    aspect_ratio TEXT DEFAULT '16:9',
    params TEXT,
    source_video_id TEXT,
    source_video_key TEXT,
    template_video_id TEXT,
    template_video_key TEXT,
    progress INTEGER DEFAULT 0,
    transcript_version INTEGER DEFAULT 0,
    run_token TEXT,
    lease_expires_at TEXT,
    created_date TEXT DEFAULT (datetime('now'))
  )`)

  // Add new columns if upgrading from an older schema
  try { db.run(`ALTER TABLE projects ADD COLUMN progress INTEGER DEFAULT 0`) } catch (_) {}
  try { db.run(`ALTER TABLE projects ADD COLUMN source_video_id TEXT`) } catch (_) {}
  try { db.run(`ALTER TABLE projects ADD COLUMN template_video_id TEXT`) } catch (_) {}
  // Group 1: Copyright & lifecycle columns
  try { db.run(`ALTER TABLE projects ADD COLUMN copyright_acknowledged INTEGER DEFAULT 0`) } catch (_) {}
  try { db.run(`ALTER TABLE projects ADD COLUMN copyright_ack_at TEXT`) } catch (_) {}
  try { db.run(`ALTER TABLE projects ADD COLUMN cancelled_at TEXT`) } catch (_) {}
  try { db.run(`ALTER TABLE projects ADD COLUMN expires_at TEXT`) } catch (_) {}
  try { db.run(`ALTER TABLE projects ADD COLUMN video_hash TEXT`) } catch (_) {}
  // Heartbeat for stale detection (replaces created_date proxy):
  // started_at = when the current run began; last_heartbeat_at = last
  // observed activity (stage success / claim / progress tick).
  // recovery_reason = why the last recovery parked this project (audit).
  try { db.run(`ALTER TABLE projects ADD COLUMN started_at TEXT`) } catch (_) {}
  try { db.run(`ALTER TABLE projects ADD COLUMN last_heartbeat_at TEXT`) } catch (_) {}
  try { db.run(`ALTER TABLE projects ADD COLUMN recovery_reason TEXT`) } catch (_) {}
  // Optimistic concurrency for transcript edits (§4.4): incremented on every
  // successful PUT/PATCH; outputs stamp the version they were rendered from.
  try { db.run(`ALTER TABLE projects ADD COLUMN transcript_version INTEGER DEFAULT 0`) } catch (_) {}
  try { db.run(`ALTER TABLE projects ADD COLUMN run_token TEXT`) } catch (_) {}
  try { db.run(`ALTER TABLE projects ADD COLUMN lease_expires_at TEXT`) } catch (_) {}
  try { db.run(`UPDATE projects SET transcript_version = 0 WHERE transcript_version IS NULL`) } catch (_) {}
  try { db.run(`ALTER TABLE outputs ADD COLUMN transcript_version INTEGER`) } catch (_) {}

  db.run(`CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    meta TEXT,
    duration_sec REAL
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS generation_jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    step TEXT,
    payload TEXT,
    result TEXT,
    attempts INTEGER DEFAULT 0,
    progress INTEGER DEFAULT 0,
    error_message TEXT,
    created_date TEXT DEFAULT (datetime('now'))
  )`)

  // Add new columns if upgrading from an older schema
  try { db.run(`ALTER TABLE generation_jobs ADD COLUMN progress INTEGER DEFAULT 0`) } catch (_) {}
  // Group 1: Cancel timestamp
  try { db.run(`ALTER TABLE generation_jobs ADD COLUMN cancelled_at TEXT`) } catch (_) {}
  // Group 5: Retry scheduling for rate-limited jobs (docs/11 §4.2)
  try { db.run(`ALTER TABLE generation_jobs ADD COLUMN next_retry_at TEXT`) } catch (_) {}

  db.run(`CREATE TABLE IF NOT EXISTS scenes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    source_video_id TEXT,
    start_sec REAL,
    end_sec REAL,
    thumbnail_key TEXT,
    description TEXT,
    embedding TEXT
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS script_segments (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    index_num INTEGER DEFAULT 0,
    narration TEXT,
    target_duration_sec REAL,
    scene_refs TEXT,
    voice_audio_id TEXT,
    subtitle_id TEXT
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS timeline_clips (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    order_index INTEGER DEFAULT 0,
    source_type TEXT,
    ref_id TEXT,
    in_sec REAL,
    out_sec REAL,
    speed REAL DEFAULT 1.0,
    transition_in TEXT,
    transition_out TEXT,
    voice_audio_id TEXT,
    start_at_sec REAL
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS audios (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    kind TEXT,
    storage_key TEXT,
    duration_sec REAL,
    provider TEXT
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS subtitles (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    format TEXT DEFAULT 'srt',
    language TEXT DEFAULT 'vi',
    storage_key TEXT,
    cues TEXT
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS outputs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    storage_key TEXT,
    status TEXT DEFAULT 'success',
    duration_sec REAL,
    thumbnail_key TEXT,
    transcript_version INTEGER,
    created_date TEXT DEFAULT (datetime('now'))
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS youtube_uploads (
    id TEXT PRIMARY KEY,
    output_id TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    youtube_video_id TEXT,
    privacy TEXT DEFAULT 'private',
    error_message TEXT
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    label TEXT,
    encrypted_key TEXT,
    is_active INTEGER DEFAULT 1,
    created_date TEXT DEFAULT (datetime('now'))
  )`)
  // Group 4: Multi-API-key round-robin fields
  try { db.run(`ALTER TABLE api_keys ADD COLUMN tier TEXT DEFAULT 'free'`) } catch (_) {}
  try { db.run(`ALTER TABLE api_keys ADD COLUMN priority INTEGER DEFAULT 0`) } catch (_) {}
  try { db.run(`ALTER TABLE api_keys ADD COLUMN last_used_at TEXT`) } catch (_) {}

  db.run(`CREATE TABLE IF NOT EXISTS provider_logs (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    job_id TEXT,
    provider TEXT,
    type TEXT,
    model TEXT,
    tokens_in INTEGER,
    tokens_out INTEGER,
    cost_usd REAL,
    duration_ms INTEGER,
    status TEXT,
    error_message TEXT,
    created_date TEXT DEFAULT (datetime('now'))
  )`)

  // Group 5: ProviderRateLimit (docs/11 §2.1)
  db.run(`CREATE TABLE IF NOT EXISTS provider_rate_limits (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    tier TEXT DEFAULT 'free',
    requests_per_minute INTEGER DEFAULT 10,
    requests_per_day INTEGER,
    tokens_per_minute INTEGER,
    concurrency INTEGER DEFAULT 1,
    user_id TEXT,
    updated_date TEXT DEFAULT (datetime('now'))
  )`)

  // Group 5: ProviderCache (docs/11 §3.2)
  db.run(`CREATE TABLE IF NOT EXISTS provider_cache (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    type TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    result TEXT,
    created_date TEXT DEFAULT (datetime('now')),
    expires_date TEXT
  )`)
  try { db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_cache_hash ON provider_cache(provider, type, input_hash)`) } catch (_) {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_provider_cache_input ON provider_cache(input_hash)`) } catch (_) {}

  // ── TRANSLATE_DUB tables (docs/02) ────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS transcript_segments (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    index_num INTEGER DEFAULT 0,
    start_sec REAL DEFAULT 0,
    end_sec REAL DEFAULT 0,
    text TEXT,
    speaker TEXT,
    language TEXT,
    translation TEXT,
    tts_audio_id TEXT,
    subtitle_id TEXT,
    source TEXT, -- 'ocr' | 'asr' | NULL (legacy, coi như asr)
    confidence REAL, -- OCR track avgConf; ASR để NULL
    ratio_x REAL, -- bbox chữ theo TỶ LỆ (OCR), NULL khi không có (ASR)
    ratio_y REAL,
    ratio_w REAL,
    ratio_h REAL
  )`)
  // Group 1: Overlap detection fields
  try { db.run(`ALTER TABLE transcript_segments ADD COLUMN is_time_manually_adjusted INTEGER DEFAULT 0`) } catch (_) {}
  try { db.run(`ALTER TABLE transcript_segments ADD COLUMN wpm_warning TEXT`) } catch (_) {}
  // Subtitle-mask pipeline: nguồn segment + confidence + bbox chữ
  try { db.run(`ALTER TABLE transcript_segments ADD COLUMN source TEXT`) } catch (_) {}
  try { db.run(`ALTER TABLE transcript_segments ADD COLUMN confidence REAL`) } catch (_) {}
  try { db.run(`ALTER TABLE transcript_segments ADD COLUMN ratio_x REAL`) } catch (_) {}
  try { db.run(`ALTER TABLE transcript_segments ADD COLUMN ratio_y REAL`) } catch (_) {}
  try { db.run(`ALTER TABLE transcript_segments ADD COLUMN ratio_w REAL`) } catch (_) {}
  try { db.run(`ALTER TABLE transcript_segments ADD COLUMN ratio_h REAL`) } catch (_) {}

  db.run(`CREATE TABLE IF NOT EXISTS ocr_regions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    start_sec REAL DEFAULT 0,
    end_sec REAL DEFAULT 0,
    ratio_x REAL DEFAULT 0,  -- tọa độ TỶ LỆ (0..1) scale-invariant thay vì pixel
    ratio_y REAL DEFAULT 0,
    ratio_w REAL DEFAULT 0,
    ratio_h REAL DEFAULT 0,
    mask_strength REAL DEFAULT 0.6, -- 0..1: cường độ blur + độ đục lớp phủ
    is_static INTEGER DEFAULT 0,    -- hardsub tĩnh: áp dụng cho toàn bộ video (1 record)
    text TEXT,
    confidence REAL,
    source TEXT DEFAULT 'AUTO',
    type TEXT DEFAULT 'blur', -- 'blur' | 'solid'
    blur_radius REAL DEFAULT 8, -- 1..50, chỉ dùng khi type='blur'
    opacity REAL DEFAULT 1, -- 0..1, độ đục lớp phủ (solid)
    enabled INTEGER DEFAULT 1, -- 0 = tắt mask nhưng vẫn giữ row
    status TEXT DEFAULT 'DRAFT' -- mask lifecycle: DRAFT | APPROVED | DISABLED (render chỉ dùng APPROVED)
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS style_presets (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    system_prompt TEXT,
    is_system INTEGER DEFAULT 1
  )`)

  // SSE tickets: short-lived single-use auth for EventSource (no long-lived JWT in URL).
  // ticket_hash = sha256(ticket); TTL 60s; bound to user+project; consumed on first use.
  db.run(`CREATE TABLE IF NOT EXISTS sse_tickets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    ticket_hash TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    created_date TEXT DEFAULT (datetime('now'))
  )`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_sse_tickets_hash ON sse_tickets(ticket_hash)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_sse_tickets_expires ON sse_tickets(expires_at)`)

  // Resumable upload sessions (TUS-style, docs/06 §2.1)
  db.run(`CREATE TABLE IF NOT EXISTS upload_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    filename TEXT,
    size INTEGER DEFAULT 0,
    mime TEXT,
    tmp_path TEXT,
    bytes_received INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',
    storage_key TEXT,
    video_hash TEXT,
    last_activity_at TEXT,
    expires_at TEXT,
    created_date TEXT DEFAULT (datetime('now'))
  )`)

  // ── Indexes (docs/02 §3) ─────────────────────────────────────────────
  // Unique (project_id, type) doubles as the idempotency constraint:
  // BullMQ jobId = `${projectId}:${stage}` (docs/03 §7). If legacy rows
  // contain duplicates, fall back to a plain index instead of crashing.
  try {
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_jobs_project_type ON generation_jobs(project_id, type)`)
  } catch (_) {
    try { db.run(`CREATE INDEX IF NOT EXISTS idx_generation_jobs_project_type ON generation_jobs(project_id, type)`) } catch (_) {}
  }
  db.run(`CREATE INDEX IF NOT EXISTS idx_timeline_clips_project_order ON timeline_clips(project_id, order_index)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_provider_logs_created_date ON provider_logs(created_date)`)
  // Supporting indexes for the hot queries used by the API routes
  db.run(`CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_scenes_project ON scenes(project_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_transcript_segments_project ON transcript_segments(project_id, index_num)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_ocr_regions_project ON ocr_regions(project_id, start_sec)`)
  // Group 1: Indexes for concurrency limit and cleanup
  db.run(`CREATE INDEX IF NOT EXISTS idx_projects_user_status ON projects(user_id, status)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_projects_status_heartbeat ON projects(status, last_heartbeat_at)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_projects_expires_at ON projects(expires_at)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_projects_video_hash ON projects(video_hash)`)

  // Group 5: Seed default provider rate limits (docs/11 §2.1)
  // Safety margin: ~20% below published limits
  const seedRateLimit = (provider, tier, rpm, rpd, concurrency) => {
    const existing = db.exec(`SELECT COUNT(*) as cnt FROM provider_rate_limits WHERE provider = '${provider}' AND tier = '${tier}'`)
    if (!existing.length || existing[0].values[0][0] === 0) {
      db.run(`INSERT INTO provider_rate_limits (id, provider, tier, requests_per_minute, requests_per_day, concurrency) VALUES (?, ?, ?, ?, ?, ?)`,
        [`${provider}-${tier}`, provider, tier, rpm, rpd, concurrency])
    }
  }
  seedRateLimit('gemini', 'free', 10, 250, 1)
  seedRateLimit('openai', 'free', 3, 200, 1)
  seedRateLimit('elevenlabs', 'free', 2, null, 1)
  seedRateLimit('huggingface', 'free', 5, null, 1)
  seedRateLimit('azure_tts', 'free', 20, null, 2)

  // Migrate: thêm cột tỷ lệ / maskStrength / isStatic cho DB cũ (giữ nguyên cột pixel cũ nếu có).
  const addCol = (t, c, def) => { try { db.run(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`) } catch (_) {} }
  addCol('ocr_regions', 'ratio_x', 'REAL DEFAULT 0')
  addCol('ocr_regions', 'ratio_y', 'REAL DEFAULT 0')
  addCol('ocr_regions', 'ratio_w', 'REAL DEFAULT 0')
  addCol('ocr_regions', 'ratio_h', 'REAL DEFAULT 0')
  addCol('ocr_regions', 'mask_strength', 'REAL DEFAULT 0.6')
  addCol('ocr_regions', 'is_static', 'INTEGER DEFAULT 0')
  // Subtitle-mask pipeline: loại mask + tham số blur/opacity + bật/tắt
  addCol('ocr_regions', 'type', "TEXT DEFAULT 'blur'")
  addCol('ocr_regions', 'blur_radius', 'REAL DEFAULT 8')
  addCol('ocr_regions', 'opacity', 'REAL DEFAULT 1')
  addCol('ocr_regions', 'enabled', 'INTEGER DEFAULT 1')
  // Mask approve lifecycle (§2): DRAFT (đang chỉnh) | APPROVED (render dùng) | DISABLED.
  // Backfill giữ nguyên hành vi cũ: manual đang bật → APPROVED, đang tắt → DISABLED.
  addCol('ocr_regions', 'status', "TEXT DEFAULT 'DRAFT'")
  try { db.run(`UPDATE ocr_regions SET status = 'APPROVED' WHERE source = 'MANUAL' AND enabled = 1 AND (status IS NULL OR status = '' OR status = 'DRAFT')`) } catch (_) {}
  try { db.run(`UPDATE ocr_regions SET status = 'DISABLED' WHERE source = 'MANUAL' AND enabled = 0 AND (status IS NULL OR status = '' OR status = 'DRAFT')`) } catch (_) {}
  try { db.run(`UPDATE ocr_regions SET status = 'DRAFT' WHERE status IS NULL OR status = ''`) } catch (_) {}
  // Manual-edit source of truth (§8): phân biệt user sửa tay với AI-generated.
  addCol('transcript_segments', 'is_text_manually_edited', 'INTEGER DEFAULT 0')
  addCol('transcript_segments', 'is_translation_manually_edited', 'INTEGER DEFAULT 0')
  // Transcript source discriminator + OCR evidence (bbox/confidence)
  addCol('transcript_segments', 'source', 'TEXT')
  addCol('transcript_segments', 'confidence', 'REAL')
  addCol('transcript_segments', 'ratio_x', 'REAL')
  addCol('transcript_segments', 'ratio_y', 'REAL')
  addCol('transcript_segments', 'ratio_w', 'REAL')
  addCol('transcript_segments', 'ratio_h', 'REAL')
  // Upload sessions created before 2026-09-12 lack video_hash (only projects
  // got an ALTER migration). Without this, POST /uploads/:id/complete throws
  // "no such column: video_hash" on old data.db files.
  addCol('upload_sessions', 'storage_key', 'TEXT')
  addCol('upload_sessions', 'video_hash', 'TEXT')
  addCol('upload_sessions', 'last_activity_at', 'TEXT')
  addCol('upload_sessions', 'expires_at', 'TEXT')
  const uploadExpiryModifier = `+${config.uploadSessionTtlMinutes} minutes`
  db.run(`UPDATE upload_sessions SET last_activity_at = CASE WHEN last_activity_at GLOB '????-??-??T??:??:??.???Z' THEN last_activity_at ELSE strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(created_date, 'now')) END, expires_at = CASE WHEN expires_at GLOB '????-??-??T??:??:??.???Z' THEN expires_at ELSE strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(created_date, 'now'), ?) END WHERE status IN ('pending', 'completing')`, [uploadExpiryModifier])
  db.run(`CREATE INDEX IF NOT EXISTS idx_upload_sessions_status_expires ON upload_sessions(status, expires_at)`)

  save()
  console.log('[DB] Schema initialized (sql.js)')
}

export default { initSchema }
