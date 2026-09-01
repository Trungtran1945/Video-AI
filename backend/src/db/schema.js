import { getDb, save } from '../db.js'

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
    created_date TEXT DEFAULT (datetime('now'))
  )`)

  // Add new columns if upgrading from an older schema
  try { db.run(`ALTER TABLE projects ADD COLUMN progress INTEGER DEFAULT 0`) } catch (_) {}
  try { db.run(`ALTER TABLE projects ADD COLUMN source_video_id TEXT`) } catch (_) {}
  try { db.run(`ALTER TABLE projects ADD COLUMN template_video_id TEXT`) } catch (_) {}

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
    subtitle_id TEXT
  )`)

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
    source TEXT DEFAULT 'AUTO'
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS style_presets (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    system_prompt TEXT,
    is_system INTEGER DEFAULT 1
  )`)

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

  // Migrate: thêm cột tỷ lệ / maskStrength / isStatic cho DB cũ (giữ nguyên cột pixel cũ nếu có).
  const addCol = (t, c, def) => { try { db.run(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`) } catch (_) {} }
  addCol('ocr_regions', 'ratio_x', 'REAL DEFAULT 0')
  addCol('ocr_regions', 'ratio_y', 'REAL DEFAULT 0')
  addCol('ocr_regions', 'ratio_w', 'REAL DEFAULT 0')
  addCol('ocr_regions', 'ratio_h', 'REAL DEFAULT 0')
  addCol('ocr_regions', 'mask_strength', 'REAL DEFAULT 0.6')
  addCol('ocr_regions', 'is_static', 'INTEGER DEFAULT 0')

  save()
  console.log('[DB] Schema initialized (sql.js)')
}

export default { initSchema }
