-- =============================================================================
-- Video_AI: Row-Level Security (RLS) & Tenant Isolation Policies
-- Task: TASK-04 (Tenant Isolation & RLS Readiness)
-- =============================================================================

-- 0. Provision unprivileged application role for strict RLS enforcement
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'video_ai_app') THEN
        CREATE ROLE video_ai_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO video_ai_app;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO video_ai_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO video_ai_app;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO video_ai_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO video_ai_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO video_ai_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO video_ai_app;

-- 1. Helper function to get current tenant ID safely
CREATE OR REPLACE FUNCTION current_app_user_id() RETURNS TEXT AS $$
BEGIN
    RETURN COALESCE(current_setting('app.current_user_id', true), '');
EXCEPTION WHEN OTHERS THEN
    RETURN '';
END;
$$ LANGUAGE plpgsql STABLE;

-- 2. Helper function to check if current session is admin
CREATE OR REPLACE FUNCTION is_app_admin() RETURNS BOOLEAN AS $$
BEGIN
    RETURN COALESCE(current_setting('app.current_user_role', true), '') = 'admin';
EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE;

-- 3. Projects Table RLS
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS projects_tenant_isolation_policy ON projects;
CREATE POLICY projects_tenant_isolation_policy ON projects
    FOR ALL
    USING (
        current_app_user_id() = ''
        OR is_app_admin()
        OR user_id = current_app_user_id()
    )
    WITH CHECK (
        current_app_user_id() = ''
        OR is_app_admin()
        OR user_id = current_app_user_id()
    );

-- 4. Settings Table RLS
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS settings_tenant_isolation_policy ON settings;
CREATE POLICY settings_tenant_isolation_policy ON settings
    FOR ALL
    USING (
        current_app_user_id() = ''
        OR is_app_admin()
        OR user_id = current_app_user_id()
    )
    WITH CHECK (
        current_app_user_id() = ''
        OR is_app_admin()
        OR user_id = current_app_user_id()
    );

-- 5. API Keys Table RLS
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS api_keys_tenant_isolation_policy ON api_keys;
CREATE POLICY api_keys_tenant_isolation_policy ON api_keys
    FOR ALL
    USING (
        current_app_user_id() = ''
        OR is_app_admin()
        OR user_id = current_app_user_id()
    )
    WITH CHECK (
        current_app_user_id() = ''
        OR is_app_admin()
        OR user_id = current_app_user_id()
    );

-- 6. Assets Table RLS
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS assets_tenant_isolation_policy ON assets;
CREATE POLICY assets_tenant_isolation_policy ON assets
    FOR ALL
    USING (
        current_app_user_id() = ''
        OR is_app_admin()
        OR (user_id IS NOT NULL AND user_id = current_app_user_id())
        OR EXISTS (
            SELECT 1 FROM projects
            WHERE projects.id = assets.project_id
              AND projects.user_id = current_app_user_id()
        )
    )
    WITH CHECK (
        current_app_user_id() = ''
        OR is_app_admin()
        OR (user_id IS NOT NULL AND user_id = current_app_user_id())
        OR EXISTS (
            SELECT 1 FROM projects
            WHERE projects.id = assets.project_id
              AND projects.user_id = current_app_user_id()
        )
    );

-- 7. Outputs Table RLS
ALTER TABLE outputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE outputs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outputs_tenant_isolation_policy ON outputs;
CREATE POLICY outputs_tenant_isolation_policy ON outputs
    FOR ALL
    USING (
        current_app_user_id() = ''
        OR is_app_admin()
        OR EXISTS (
            SELECT 1 FROM projects
            WHERE projects.id = outputs.project_id
              AND projects.user_id = current_app_user_id()
        )
    )
    WITH CHECK (
        current_app_user_id() = ''
        OR is_app_admin()
        OR EXISTS (
            SELECT 1 FROM projects
            WHERE projects.id = outputs.project_id
              AND projects.user_id = current_app_user_id()
        )
    );

-- 8. Upload Sessions Table RLS
ALTER TABLE upload_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE upload_sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS upload_sessions_tenant_isolation_policy ON upload_sessions;
CREATE POLICY upload_sessions_tenant_isolation_policy ON upload_sessions
    FOR ALL
    USING (
        current_app_user_id() = ''
        OR is_app_admin()
        OR user_id = current_app_user_id()
    )
    WITH CHECK (
        current_app_user_id() = ''
        OR is_app_admin()
        OR user_id = current_app_user_id()
    );
