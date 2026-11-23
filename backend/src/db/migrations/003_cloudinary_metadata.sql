-- =============================================================================
-- Migration: 003_cloudinary_metadata
-- Purpose: Non-destructive addition of Cloudinary and multi-provider storage
--          metadata columns and tracking tables for Video_AI.
-- Target: PostgreSQL 16+
-- Safe for repeated/idempotent execution.
-- =============================================================================

-- 1. Table: assets
ALTER TABLE assets ADD COLUMN IF NOT EXISTS storage_provider VARCHAR(32) NOT NULL DEFAULT 'local';
ALTER TABLE assets ADD COLUMN IF NOT EXISTS cloudinary_asset_id VARCHAR(128);
ALTER TABLE assets ADD COLUMN IF NOT EXISTS cloudinary_public_id TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS secure_url TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS resource_type VARCHAR(32);
ALTER TABLE assets ADD COLUMN IF NOT EXISTS format VARCHAR(32);
ALTER TABLE assets ADD COLUMN IF NOT EXISTS bytes BIGINT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS cloudinary_created_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_assets_storage_provider ON assets(storage_provider);
CREATE INDEX IF NOT EXISTS idx_assets_cloudinary_public_id ON assets(cloudinary_public_id);

-- 2. Table: audios
ALTER TABLE audios ADD COLUMN IF NOT EXISTS storage_provider VARCHAR(32) NOT NULL DEFAULT 'local';
ALTER TABLE audios ADD COLUMN IF NOT EXISTS cloudinary_asset_id VARCHAR(128);
ALTER TABLE audios ADD COLUMN IF NOT EXISTS cloudinary_public_id TEXT;
ALTER TABLE audios ADD COLUMN IF NOT EXISTS secure_url TEXT;
ALTER TABLE audios ADD COLUMN IF NOT EXISTS resource_type VARCHAR(32);
ALTER TABLE audios ADD COLUMN IF NOT EXISTS format VARCHAR(32);
ALTER TABLE audios ADD COLUMN IF NOT EXISTS bytes BIGINT;

CREATE INDEX IF NOT EXISTS idx_audios_storage_provider ON audios(storage_provider);
CREATE INDEX IF NOT EXISTS idx_audios_cloudinary_public_id ON audios(cloudinary_public_id);

-- 3. Table: outputs
ALTER TABLE outputs ADD COLUMN IF NOT EXISTS storage_provider VARCHAR(32) NOT NULL DEFAULT 'local';
ALTER TABLE outputs ADD COLUMN IF NOT EXISTS cloudinary_asset_id VARCHAR(128);
ALTER TABLE outputs ADD COLUMN IF NOT EXISTS cloudinary_public_id TEXT;
ALTER TABLE outputs ADD COLUMN IF NOT EXISTS secure_url TEXT;
ALTER TABLE outputs ADD COLUMN IF NOT EXISTS resource_type VARCHAR(32);
ALTER TABLE outputs ADD COLUMN IF NOT EXISTS format VARCHAR(32);
ALTER TABLE outputs ADD COLUMN IF NOT EXISTS bytes BIGINT;
ALTER TABLE outputs ADD COLUMN IF NOT EXISTS thumbnail_storage_provider VARCHAR(32) DEFAULT 'local';
ALTER TABLE outputs ADD COLUMN IF NOT EXISTS thumbnail_cloudinary_public_id TEXT;
ALTER TABLE outputs ADD COLUMN IF NOT EXISTS thumbnail_secure_url TEXT;

CREATE INDEX IF NOT EXISTS idx_outputs_storage_provider ON outputs(storage_provider);
CREATE INDEX IF NOT EXISTS idx_outputs_cloudinary_public_id ON outputs(cloudinary_public_id);

-- 4. Table: subtitles
ALTER TABLE subtitles ADD COLUMN IF NOT EXISTS storage_provider VARCHAR(32) NOT NULL DEFAULT 'local';
ALTER TABLE subtitles ADD COLUMN IF NOT EXISTS cloudinary_asset_id VARCHAR(128);
ALTER TABLE subtitles ADD COLUMN IF NOT EXISTS cloudinary_public_id TEXT;
ALTER TABLE subtitles ADD COLUMN IF NOT EXISTS secure_url TEXT;
ALTER TABLE subtitles ADD COLUMN IF NOT EXISTS resource_type VARCHAR(32);
ALTER TABLE subtitles ADD COLUMN IF NOT EXISTS format VARCHAR(32);
ALTER TABLE subtitles ADD COLUMN IF NOT EXISTS bytes BIGINT;

CREATE INDEX IF NOT EXISTS idx_subtitles_storage_provider ON subtitles(storage_provider);

-- 5. Table: projects
ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_storage_provider VARCHAR(32) DEFAULT 'local';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_cloudinary_public_id TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_secure_url TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS template_storage_provider VARCHAR(32) DEFAULT 'local';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS template_cloudinary_public_id TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS template_secure_url TEXT;

-- 6. Table: scenes
ALTER TABLE scenes ADD COLUMN IF NOT EXISTS thumbnail_storage_provider VARCHAR(32) DEFAULT 'local';
ALTER TABLE scenes ADD COLUMN IF NOT EXISTS thumbnail_cloudinary_public_id TEXT;
ALTER TABLE scenes ADD COLUMN IF NOT EXISTS thumbnail_secure_url TEXT;

-- 7. Table: script_uploads
ALTER TABLE script_uploads ADD COLUMN IF NOT EXISTS storage_provider VARCHAR(32) DEFAULT 'local';
ALTER TABLE script_uploads ADD COLUMN IF NOT EXISTS cloudinary_asset_id VARCHAR(128);
ALTER TABLE script_uploads ADD COLUMN IF NOT EXISTS cloudinary_public_id TEXT;
ALTER TABLE script_uploads ADD COLUMN IF NOT EXISTS secure_url TEXT;
ALTER TABLE script_uploads ADD COLUMN IF NOT EXISTS resource_type VARCHAR(32);
ALTER TABLE script_uploads ADD COLUMN IF NOT EXISTS format VARCHAR(32);
ALTER TABLE script_uploads ADD COLUMN IF NOT EXISTS bytes BIGINT;

-- 8. Table: upload_sessions
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS storage_provider VARCHAR(32) DEFAULT 'local';
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS cloudinary_asset_id VARCHAR(128);
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS cloudinary_public_id TEXT;
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS secure_url TEXT;

-- 9. Centralized Cloudinary Asset Registry
CREATE TABLE IF NOT EXISTS cloudinary_assets (
    id VARCHAR(64) PRIMARY KEY,
    storage_key TEXT UNIQUE NOT NULL,
    storage_provider VARCHAR(32) NOT NULL DEFAULT 'cloudinary',
    cloudinary_asset_id VARCHAR(128),
    cloudinary_public_id TEXT NOT NULL,
    secure_url TEXT NOT NULL,
    resource_type VARCHAR(32) NOT NULL,
    format VARCHAR(32),
    bytes BIGINT,
    checksum_sha256 VARCHAR(64),
    entity_type VARCHAR(64),
    entity_id VARCHAR(64),
    project_id VARCHAR(64),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cloudinary_assets_key ON cloudinary_assets(storage_key);
CREATE INDEX IF NOT EXISTS idx_cloudinary_assets_project ON cloudinary_assets(project_id);
CREATE INDEX IF NOT EXISTS idx_cloudinary_assets_public_id ON cloudinary_assets(cloudinary_public_id);

-- 10. Migration Manifest for Tracking Batch Progress & Idempotency
CREATE TABLE IF NOT EXISTS media_migration_manifest (
    id VARCHAR(64) PRIMARY KEY,
    storage_key TEXT UNIQUE NOT NULL,
    local_path TEXT NOT NULL,
    file_size BIGINT NOT NULL,
    checksum_sha256 VARCHAR(64) NOT NULL,
    entity_table VARCHAR(64) NOT NULL,
    entity_id VARCHAR(64) NOT NULL,
    project_id VARCHAR(64),
    storage_provider VARCHAR(32) NOT NULL DEFAULT 'local',
    cloudinary_asset_id VARCHAR(128),
    cloudinary_public_id TEXT,
    secure_url TEXT,
    resource_type VARCHAR(32),
    format VARCHAR(32),
    bytes BIGINT,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    attempts INTEGER DEFAULT 0,
    last_error TEXT,
    migrated_at TIMESTAMPTZ,
    verified_at TIMESTAMPTZ,
    created_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_media_migration_status ON media_migration_manifest(status);
CREATE INDEX IF NOT EXISTS idx_media_migration_entity ON media_migration_manifest(entity_table, entity_id);
CREATE INDEX IF NOT EXISTS idx_media_migration_project ON media_migration_manifest(project_id);

-- Grant privileges to video_ai_app role if it exists (RLS compliance)
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'video_ai_app') THEN
        GRANT USAGE ON SCHEMA public TO video_ai_app;
        GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO video_ai_app;
        GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO video_ai_app;
    END IF;
END $$;
