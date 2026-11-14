-- =============================================================================
-- Video_AI: Production PostgreSQL Schema Definition (DDL)
-- Generated: 2026-11-13 by @db_architect
-- Target Database: PostgreSQL 16+
-- Encoding: UTF8
-- Description: Full 31-table DDL schema matching Video_AI specifications with
--              strict Foreign Keys, ON DELETE policies, JSONB support,
--              accurate timestamp handling (TIMESTAMPTZ), and complete indexes.
-- =============================================================================

-- Enable UUID extension if needed (keys currently stored as text UUIDs / IDs)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- 1. USERS & SECURITY
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role VARCHAR(32) NOT NULL DEFAULT 'user',
    name VARCHAR(255) DEFAULT '',
    credits INTEGER DEFAULT 0,
    email_verified BOOLEAN DEFAULT FALSE,
    refresh_token TEXT,
    refresh_expires TIMESTAMPTZ,
    created_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reset_tokens (
    id BIGSERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    token TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    created_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_reset_tokens_email ON reset_tokens(email);

CREATE TABLE IF NOT EXISTS email_otps (
    id VARCHAR(64) PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    otp_hash TEXT NOT NULL,
    purpose VARCHAR(64) DEFAULT 'login',
    expires_at TIMESTAMPTZ NOT NULL,
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 5,
    used BOOLEAN DEFAULT FALSE,
    created_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_email_otps_email_used ON email_otps(email, used);

-- Legacy OTP table preserved for backwards compatibility
CREATE TABLE IF NOT EXISTS otp_codes (
    id BIGSERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    code VARCHAR(32) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    created_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS api_keys (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(64) NOT NULL,
    label VARCHAR(128),
    encrypted_key TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    tier VARCHAR(32) DEFAULT 'free',
    priority INTEGER DEFAULT 0,
    last_used_at TIMESTAMPTZ,
    created_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

CREATE TABLE IF NOT EXISTS settings (
    user_id VARCHAR(64) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    default_language VARCHAR(16) DEFAULT 'vi',
    default_style VARCHAR(64) DEFAULT 'cinematic',
    default_duration INTEGER DEFAULT 60,
    max_retries INTEGER DEFAULT 3,
    auto_upload_youtube BOOLEAN DEFAULT FALSE,
    notify_on_complete BOOLEAN DEFAULT TRUE,
    active_llm_provider VARCHAR(64) DEFAULT 'gemini',
    active_image_provider VARCHAR(64) DEFAULT 'slide',
    active_video_provider VARCHAR(64) DEFAULT '',
    active_voice_provider VARCHAR(64) DEFAULT 'edge_tts',
    active_subtitle_provider VARCHAR(64) DEFAULT 'whisper',
    active_translate_provider VARCHAR(64) DEFAULT 'google_translate',
    voice_provider VARCHAR(64) DEFAULT 'edge_tts',
    aspect_ratio VARCHAR(16) DEFAULT '16:9'
);

-- =============================================================================
-- 2. PROJECTS & MEDIA WORKFLOW
-- =============================================================================

CREATE TABLE IF NOT EXISTS projects (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mode VARCHAR(32) NOT NULL,
    title VARCHAR(255) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    language VARCHAR(16) DEFAULT 'vi',
    style VARCHAR(64) DEFAULT 'cinematic',
    target_duration_sec INTEGER DEFAULT 60,
    aspect_ratio VARCHAR(16) DEFAULT '16:9',
    params JSONB DEFAULT '{}'::jsonb,
    source_video_id VARCHAR(64),
    source_video_key TEXT,
    template_video_id VARCHAR(64),
    template_video_key TEXT,
    progress INTEGER DEFAULT 0,
    transcript_version INTEGER DEFAULT 0,
    run_token TEXT,
    lease_expires_at TIMESTAMPTZ,
    copyright_acknowledged BOOLEAN DEFAULT FALSE,
    copyright_ack_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    video_hash VARCHAR(128),
    started_at TIMESTAMPTZ,
    last_heartbeat_at TIMESTAMPTZ,
    recovery_reason TEXT,
    next_cleanup_attempt_at TIMESTAMPTZ,
    script_upload_id VARCHAR(64),
    script_key TEXT,
    script_hash VARCHAR(128),
    script_version INTEGER DEFAULT 0,
    script_review_required BOOLEAN DEFAULT FALSE,
    created_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_user_status ON projects(user_id, status);
CREATE INDEX IF NOT EXISTS idx_projects_status_heartbeat ON projects(status, last_heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_projects_expires_at ON projects(expires_at);
CREATE INDEX IF NOT EXISTS idx_projects_video_hash ON projects(video_hash);
CREATE INDEX IF NOT EXISTS idx_projects_params_gin ON projects USING gin (params);

CREATE TABLE IF NOT EXISTS assets (
    id VARCHAR(64) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind VARCHAR(32) NOT NULL,
    storage_key TEXT NOT NULL,
    meta JSONB DEFAULT '{}'::jsonb,
    duration_sec DOUBLE PRECISION,
    user_id VARCHAR(64),
    name VARCHAR(255),
    mime_type VARCHAR(128),
    byte_size BIGINT,
    thumbnail_key TEXT,
    ocr_text TEXT,
    ocr_data JSONB,
    translation_text TEXT,
    translation_target_lang VARCHAR(16),
    order_index INTEGER DEFAULT 0,
    created_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id);
CREATE INDEX IF NOT EXISTS idx_assets_meta_gin ON assets USING gin (meta);

CREATE TABLE IF NOT EXISTS generation_jobs (
    id VARCHAR(64) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    step VARCHAR(64),
    payload JSONB,
    result JSONB,
    attempts INTEGER DEFAULT 0,
    progress INTEGER DEFAULT 0,
    error_message TEXT,
    cancelled_at TIMESTAMPTZ,
    next_retry_at TIMESTAMPTZ,
    created_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_jobs_project_type ON generation_jobs(project_id, type);

-- =============================================================================
-- 3. TIMELINE & MEDIA COMPOSER
-- =============================================================================

CREATE TABLE IF NOT EXISTS timeline_tracks (
    id VARCHAR(64) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    track_type VARCHAR(32) NOT NULL,
    name VARCHAR(255) NOT NULL,
    order_index INTEGER DEFAULT 0,
    muted BOOLEAN DEFAULT FALSE,
    volume DOUBLE PRECISION DEFAULT 1.0,
    locked BOOLEAN DEFAULT FALSE,
    created_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_timeline_tracks_project ON timeline_tracks(project_id, order_index);

CREATE TABLE IF NOT EXISTS timeline_clips (
    id VARCHAR(64) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    order_index INTEGER DEFAULT 0,
    source_type VARCHAR(32),
    ref_id VARCHAR(64),
    in_sec DOUBLE PRECISION,
    out_sec DOUBLE PRECISION,
    speed DOUBLE PRECISION DEFAULT 1.0,
    transition_in VARCHAR(64),
    transition_out VARCHAR(64),
    voice_audio_id VARCHAR(64),
    start_at_sec DOUBLE PRECISION,
    track_id VARCHAR(64) REFERENCES timeline_tracks(id) ON DELETE SET NULL,
    clip_type VARCHAR(32),
    asset_id VARCHAR(64),
    text_content TEXT,
    style_json JSONB,
    volume DOUBLE PRECISION DEFAULT 1.0,
    fade_in_sec DOUBLE PRECISION DEFAULT 0,
    fade_out_sec DOUBLE PRECISION DEFAULT 0,
    meta JSONB
);
CREATE INDEX IF NOT EXISTS idx_timeline_clips_project_order ON timeline_clips(project_id, order_index);

-- =============================================================================
-- 4. SUMMARY & SCRIPT-TO-VIDEO
-- =============================================================================

CREATE TABLE IF NOT EXISTS scenes (
    id VARCHAR(64) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source_video_id VARCHAR(64),
    start_sec DOUBLE PRECISION,
    end_sec DOUBLE PRECISION,
    thumbnail_key TEXT,
    description TEXT,
    embedding JSONB
);
CREATE INDEX IF NOT EXISTS idx_scenes_project ON scenes(project_id);

CREATE TABLE IF NOT EXISTS script_segments (
    id VARCHAR(64) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    index_num INTEGER DEFAULT 0,
    narration TEXT,
    target_duration_sec DOUBLE PRECISION,
    scene_refs JSONB,
    voice_audio_id VARCHAR(64),
    subtitle_id VARCHAR(64),
    visual_prompt TEXT,
    image_asset_id VARCHAR(64),
    duration_sec DOUBLE PRECISION,
    status VARCHAR(32) DEFAULT 'pending',
    content_hash VARCHAR(128),
    tts_clip_key VARCHAR(64),
    updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_script_segments_project_order ON script_segments(project_id, index_num);

CREATE TABLE IF NOT EXISTS script_uploads (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id VARCHAR(64),
    filename VARCHAR(255) NOT NULL,
    mime VARCHAR(128),
    byte_size BIGINT NOT NULL,
    char_count INTEGER NOT NULL,
    sha256 VARCHAR(128) NOT NULL,
    storage_key TEXT NOT NULL,
    status VARCHAR(32) DEFAULT 'ready',
    created_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    consumed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_script_uploads_user_status ON script_uploads(user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_script_uploads_project ON script_uploads(project_id) WHERE project_id IS NOT NULL;

-- =============================================================================
-- 5. TRANSLATE & DUBBING
-- =============================================================================

CREATE TABLE IF NOT EXISTS transcript_segments (
    id VARCHAR(64) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    index_num INTEGER DEFAULT 0,
    start_sec DOUBLE PRECISION DEFAULT 0,
    end_sec DOUBLE PRECISION DEFAULT 0,
    text TEXT,
    speaker VARCHAR(64),
    language VARCHAR(16),
    translation TEXT,
    tts_audio_id VARCHAR(64),
    subtitle_id VARCHAR(64),
    source VARCHAR(32),
    confidence DOUBLE PRECISION,
    ratio_x DOUBLE PRECISION,
    ratio_y DOUBLE PRECISION,
    ratio_w DOUBLE PRECISION,
    ratio_h DOUBLE PRECISION,
    is_time_manually_adjusted BOOLEAN DEFAULT FALSE,
    is_text_manually_edited BOOLEAN DEFAULT FALSE,
    is_translation_manually_edited BOOLEAN DEFAULT FALSE,
    wpm_warning TEXT,
    tts_clip_key VARCHAR(64),
    tts_duration_ms BIGINT
);
CREATE INDEX IF NOT EXISTS idx_transcript_segments_project ON transcript_segments(project_id, index_num);

CREATE TABLE IF NOT EXISTS ocr_regions (
    id VARCHAR(64) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    start_sec DOUBLE PRECISION DEFAULT 0,
    end_sec DOUBLE PRECISION DEFAULT 0,
    x INTEGER DEFAULT 0,
    y INTEGER DEFAULT 0,
    width INTEGER DEFAULT 0,
    height INTEGER DEFAULT 0,
    ratio_x DOUBLE PRECISION DEFAULT 0,
    ratio_y DOUBLE PRECISION DEFAULT 0,
    ratio_w DOUBLE PRECISION DEFAULT 0,
    ratio_h DOUBLE PRECISION DEFAULT 0,
    mask_strength DOUBLE PRECISION DEFAULT 0.6,
    is_static BOOLEAN DEFAULT FALSE,
    text TEXT,
    confidence DOUBLE PRECISION,
    source VARCHAR(32) DEFAULT 'AUTO',
    type VARCHAR(32) DEFAULT 'blur',
    blur_radius DOUBLE PRECISION DEFAULT 8,
    opacity DOUBLE PRECISION DEFAULT 1,
    enabled BOOLEAN DEFAULT TRUE,
    status VARCHAR(32) DEFAULT 'DRAFT'
);
CREATE INDEX IF NOT EXISTS idx_ocr_regions_project ON ocr_regions(project_id, start_sec);

CREATE TABLE IF NOT EXISTS style_presets (
    id VARCHAR(64) PRIMARY KEY,
    slug VARCHAR(64) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    system_prompt TEXT,
    is_system BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS project_glossaries (
    id VARCHAR(64) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source_term VARCHAR(255) NOT NULL,
    target_term VARCHAR(255) NOT NULL,
    case_sensitive BOOLEAN DEFAULT FALSE,
    note TEXT,
    created_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_glossaries_project ON project_glossaries(project_id);

-- =============================================================================
-- 6. MEDIA ARTIFACTS & OUTPUTS
-- =============================================================================

CREATE TABLE IF NOT EXISTS audios (
    id VARCHAR(64) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind VARCHAR(32),
    storage_key TEXT,
    duration_sec DOUBLE PRECISION,
    provider VARCHAR(64)
);
CREATE INDEX IF NOT EXISTS idx_audios_project ON audios(project_id);

CREATE TABLE IF NOT EXISTS subtitles (
    id VARCHAR(64) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    format VARCHAR(16) DEFAULT 'srt',
    language VARCHAR(16) DEFAULT 'vi',
    storage_key TEXT,
    cues JSONB
);
CREATE INDEX IF NOT EXISTS idx_subtitles_project ON subtitles(project_id);

CREATE TABLE IF NOT EXISTS outputs (
    id VARCHAR(64) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    storage_key TEXT,
    status VARCHAR(32) DEFAULT 'success',
    duration_sec DOUBLE PRECISION,
    thumbnail_key TEXT,
    transcript_version INTEGER,
    script_version INTEGER,
    created_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_outputs_project ON outputs(project_id);
CREATE INDEX IF NOT EXISTS idx_outputs_script_version ON outputs(project_id, script_version);

CREATE TABLE IF NOT EXISTS youtube_uploads (
    id VARCHAR(64) PRIMARY KEY,
    output_id VARCHAR(64) NOT NULL REFERENCES outputs(id) ON DELETE CASCADE,
    project_id VARCHAR(64),
    account_id VARCHAR(64),
    status VARCHAR(32) DEFAULT 'pending',
    youtube_video_id VARCHAR(64),
    privacy VARCHAR(32) DEFAULT 'private',
    error_message TEXT,
    title VARCHAR(255),
    description TEXT,
    tags TEXT,
    category_id VARCHAR(32),
    progress INTEGER DEFAULT 0,
    youtube_url TEXT,
    processing_status VARCHAR(64),
    error_code VARCHAR(64),
    attempts INTEGER DEFAULT 0,
    next_retry_at TIMESTAMPTZ,
    lease_expires_at TIMESTAMPTZ,
    claimed_at TIMESTAMPTZ,
    upload_session_uri TEXT,
    bytes_sent BIGINT DEFAULT 0,
    processing_attempts INTEGER DEFAULT 0,
    cancelled_at TIMESTAMPTZ,
    created_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_youtube_uploads_output ON youtube_uploads(output_id);
CREATE INDEX IF NOT EXISTS idx_youtube_uploads_project ON youtube_uploads(project_id, created_date);
CREATE INDEX IF NOT EXISTS idx_youtube_uploads_due ON youtube_uploads(status, next_retry_at);

CREATE TABLE IF NOT EXISTS youtube_accounts (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id VARCHAR(128),
    channel_title VARCHAR(255),
    access_token_enc TEXT,
    refresh_token_enc TEXT,
    token_expires_at TIMESTAMPTZ,
    scopes TEXT,
    status VARCHAR(32) DEFAULT 'connected',
    connected_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_youtube_accounts_user ON youtube_accounts(user_id);

CREATE TABLE IF NOT EXISTS youtube_oauth_states (
    id VARCHAR(64) PRIMARY KEY,
    state_hash VARCHAR(128) UNIQUE NOT NULL,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_verifier_enc TEXT NOT NULL,
    redirect_to TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_youtube_oauth_states_expiry ON youtube_oauth_states(expires_at);

-- =============================================================================
-- 7. INFRASTRUCTURE, RATE LIMITS, CACHE & LOGS
-- =============================================================================

CREATE TABLE IF NOT EXISTS provider_logs (
    id VARCHAR(64) PRIMARY KEY,
    project_id VARCHAR(64) REFERENCES projects(id) ON DELETE SET NULL,
    job_id VARCHAR(64),
    provider VARCHAR(64),
    type VARCHAR(64),
    model VARCHAR(64),
    tokens_in INTEGER,
    tokens_out INTEGER,
    cost_usd DOUBLE PRECISION,
    duration_ms INTEGER,
    status VARCHAR(32),
    error_message TEXT,
    created_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_provider_logs_created_date ON provider_logs(created_date);
CREATE INDEX IF NOT EXISTS idx_provider_logs_project ON provider_logs(project_id);

CREATE TABLE IF NOT EXISTS provider_rate_limits (
    id VARCHAR(64) PRIMARY KEY,
    provider VARCHAR(64) NOT NULL,
    tier VARCHAR(32) DEFAULT 'free',
    requests_per_minute INTEGER DEFAULT 10,
    requests_per_day INTEGER,
    tokens_per_minute INTEGER,
    concurrency INTEGER DEFAULT 1,
    user_id VARCHAR(64),
    updated_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS provider_cache (
    id VARCHAR(64) PRIMARY KEY,
    provider VARCHAR(64) NOT NULL,
    type VARCHAR(64) NOT NULL,
    input_hash VARCHAR(128) NOT NULL,
    result JSONB,
    created_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    expires_date TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_cache_hash ON provider_cache(provider, type, input_hash);
CREATE INDEX IF NOT EXISTS idx_provider_cache_input ON provider_cache(input_hash);

-- SSE single-use ticket auth
CREATE TABLE IF NOT EXISTS sse_tickets (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    ticket_hash VARCHAR(128) UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    created_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sse_tickets_hash ON sse_tickets(ticket_hash);
CREATE INDEX IF NOT EXISTS idx_sse_tickets_expires ON sse_tickets(expires_at);

-- Project creation idempotency (TTL 7 days)
CREATE TABLE IF NOT EXISTS project_idempotency (
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    idem_key VARCHAR(128) NOT NULL,
    project_id VARCHAR(64) NOT NULL,
    created_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ,
    request_fingerprint VARCHAR(128),
    PRIMARY KEY (user_id, idem_key)
);

-- Filesystem cleanup outbox queue after project deletion
-- NOTE: project_id intentionally does NOT have an FK constraint to projects(id)
-- because this row is written when/after a project is deleted to schedule storage file wipe.
CREATE TABLE IF NOT EXISTS project_cleanup_tasks (
    id VARCHAR(64) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL,
    keys_json JSONB NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL,
    last_error TEXT,
    operation VARCHAR(64) DEFAULT 'PROJECT_DELETE',
    operation_key VARCHAR(128),
    created_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_date TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cleanup_tasks_due ON project_cleanup_tasks(status, next_attempt_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cleanup_tasks_active_unique ON project_cleanup_tasks(operation_key) WHERE status = 'pending';

-- Resumable TUS-style upload sessions
CREATE TABLE IF NOT EXISTS upload_sessions (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename VARCHAR(255),
    size BIGINT DEFAULT 0,
    mime VARCHAR(128),
    tmp_path TEXT,
    bytes_received BIGINT DEFAULT 0,
    status VARCHAR(32) DEFAULT 'pending',
    storage_key TEXT,
    video_hash VARCHAR(128),
    last_activity_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_status_expires ON upload_sessions(status, expires_at);
