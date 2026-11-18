import { getPool } from '../src/db.js'

export async function setupTestTriggers(pool = getPool()) {
  const client = await pool.connect()
  try {
    await client.query(`
      CREATE OR REPLACE FUNCTION auto_provision_test_user()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.user_id IS NOT NULL THEN
          IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id) THEN
            INSERT INTO users (id, email, password, role)
            VALUES (NEW.user_id, NEW.user_id || '@test.local', 'hash', 'user')
            ON CONFLICT DO NOTHING;
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `)

    const userTables = ['projects', 'upload_sessions', 'settings', 'api_keys', 'sse_tickets']
    for (const t of userTables) {
      await client.query(`DROP TRIGGER IF EXISTS trg_auto_provision_user ON ${t}`)
      await client.query(`CREATE TRIGGER trg_auto_provision_user BEFORE INSERT ON ${t} FOR EACH ROW EXECUTE FUNCTION auto_provision_test_user()`)
    }

    await client.query(`
      CREATE OR REPLACE FUNCTION auto_provision_test_project()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.project_id IS NOT NULL THEN
          IF NOT EXISTS (SELECT 1 FROM users WHERE id = 'test-auto-user') THEN
            INSERT INTO users (id, email, password, role)
            VALUES ('test-auto-user', 'test-auto-user@test.local', 'hash', 'user')
            ON CONFLICT DO NOTHING;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id) THEN
            INSERT INTO projects (id, user_id, mode, title, status)
            VALUES (NEW.project_id, 'test-auto-user', 'TRANSLATE_DUB', 'Auto Test Project', 'completed')
            ON CONFLICT DO NOTHING;
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `)

    await client.query(`DROP TRIGGER IF EXISTS trg_auto_provision_project ON project_idempotency`)
    const projectTables = ['sse_tickets', 'timeline_clips', 'transcript_segments', 'generation_jobs', 'outputs', 'audios', 'assets', 'subtitles']
    for (const t of projectTables) {
      await client.query(`DROP TRIGGER IF EXISTS trg_auto_provision_project ON ${t}`)
      await client.query(`CREATE TRIGGER trg_auto_provision_project BEFORE INSERT ON ${t} FOR EACH ROW EXECUTE FUNCTION auto_provision_test_project()`)
    }

    console.log('[Test Setup] Auto-provision triggers installed successfully.')
  } finally {
    client.release()
  }
}

if (process.argv[1] && process.argv[1].endsWith('setup-test-triggers.mjs')) {
  await setupTestTriggers()
  process.exit(0)
}
