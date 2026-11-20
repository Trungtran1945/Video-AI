// Security Hardening TASK-04: Tenant Isolation & Row-Level Security (RLS)
// Run: node backend/tests/securityTask04Rls.test.mjs
import { v4 as uuidv4 } from 'uuid'
import {
  query,
  queryOne,
  run,
  insert,
  withUserContext,
  getTenantContext,
} from '../src/db/query.js'
import { getPool, closePool } from '../src/db.js'

let failures = 0
function assert(cond, msg) {
  if (cond) {
    console.log('PASS:', msg)
  } else {
    failures++
    console.error('FAIL:', msg)
  }
}

console.log('=== TASK 4: Tenant Isolation & Row-Level Security (RLS) Test Suite ===\n')

const userAId = `usr_a_${uuidv4().slice(0, 8)}`
const userBId = `usr_b_${uuidv4().slice(0, 8)}`
const adminId = `usr_adm_${uuidv4().slice(0, 8)}`

const projectAId = `proj_a_${uuidv4().slice(0, 8)}`
const projectBId = `proj_b_${uuidv4().slice(0, 8)}`

const assetAId = `ast_a_${uuidv4().slice(0, 8)}`
const assetBId = `ast_b_${uuidv4().slice(0, 8)}`

const outputAId = `out_a_${uuidv4().slice(0, 8)}`
const outputBId = `out_b_${uuidv4().slice(0, 8)}`

// Setup test users & data via system context (unconstrained)
await insert('users', { id: userAId, email: `${userAId}@example.com`, password: 'hashed_password', role: 'user' })
await insert('users', { id: userBId, email: `${userBId}@example.com`, password: 'hashed_password', role: 'user' })
await insert('users', { id: adminId, email: `${adminId}@example.com`, password: 'hashed_password', role: 'admin' })

await insert('projects', { id: projectAId, user_id: userAId, mode: 'TRANSLATE_DUB', title: 'Project A by User A' })
await insert('projects', { id: projectBId, user_id: userBId, mode: 'TRANSLATE_DUB', title: 'Project B by User B' })

await insert('assets', { id: assetAId, project_id: projectAId, kind: 'video', storage_key: `projects/${projectAId}/v.mp4`, user_id: userAId })
await insert('assets', { id: assetBId, project_id: projectBId, kind: 'video', storage_key: `projects/${projectBId}/v.mp4`, user_id: userBId })

await insert('outputs', { id: outputAId, project_id: projectAId, storage_key: `outputs/${outputAId}.mp4`, status: 'success' })
await insert('outputs', { id: outputBId, project_id: projectBId, storage_key: `outputs/${outputBId}.mp4`, status: 'success' })

// 1. Session Context Setting & Inspection
console.log('--- 1. Session Context Activation ---')
{
  // 1.1 Positional signature
  await withUserContext(userAId, 'user', async (tx) => {
    const ctx = await getTenantContext(tx)
    assert(ctx.userId === userAId, `tenant context sets app.current_user_id (got ${ctx.userId})`)
    assert(ctx.role === 'user', `tenant context sets app.current_user_role (got ${ctx.role})`)
  })

  // 1.2 Object signature { userId, role }
  await withUserContext({ userId: userAId, role: 'admin' }, async (tx) => {
    const ctx = await getTenantContext(tx)
    assert(ctx.userId === userAId, `object context sets app.current_user_id (got ${ctx.userId})`)
    assert(ctx.role === 'admin', `object context sets app.current_user_role (got ${ctx.role})`)
  })
}

// 2. Strict Tenant Isolation on Projects Table
console.log('\n--- 2. Project Isolation under Tenant RLS ---')
{
  // 2.1 User A can see only Project A
  await withUserContext(userAId, 'user', async (tx) => {
    const myProject = await tx.queryOne('SELECT * FROM projects WHERE id = ?', [projectAId])
    assert(myProject && myProject.id === projectAId, 'User A can read own project')

    const otherProject = await tx.queryOne('SELECT * FROM projects WHERE id = ?', [projectBId])
    assert(otherProject === null, 'User A CANNOT read User B project (RLS filters it out)')

    const allProjects = await tx.query('SELECT * FROM projects WHERE id IN (?, ?)', [projectAId, projectBId])
    assert(allProjects.length === 1 && allProjects[0].id === projectAId, 'SELECT IN query returns only User A project')
  })

  // 2.2 User B can see only Project B
  await withUserContext(userBId, 'user', async (tx) => {
    const myProject = await tx.queryOne('SELECT * FROM projects WHERE id = ?', [projectBId])
    assert(myProject && myProject.id === projectBId, 'User B can read own project')

    const otherProject = await tx.queryOne('SELECT * FROM projects WHERE id = ?', [projectAId])
    assert(otherProject === null, 'User B CANNOT read User A project')
  })

  // 2.3 User A cannot modify User B project
  await withUserContext(userAId, 'user', async (tx) => {
    const affected = await tx.runAffected('UPDATE projects SET title = ? WHERE id = ?', ['Hacked Title', projectBId])
    assert(affected === 0, 'User A cannot update User B project (0 rows affected)')

    const deleted = await tx.runAffected('DELETE FROM projects WHERE id = ?', [projectBId])
    assert(deleted === 0, 'User A cannot delete User B project (0 rows affected)')
  })

  // 2.4 User A cannot insert a project claiming User B as owner
  let spoofThrew = false
  try {
    await withUserContext(userAId, 'user', async (tx) => {
      await tx.insert('projects', {
        id: `spoof_${uuidv4().slice(0, 8)}`,
        user_id: userBId, // attempting to impersonate User B
        mode: 'TRANSLATE_DUB',
        title: 'Spoofed Project',
      })
    })
  } catch (err) {
    spoofThrew = true
  }
  assert(spoofThrew, 'User A cannot insert project belonging to User B (RLS WITH CHECK blocks it)')
}

// 3. Child Resource Isolation (Assets & Outputs)
console.log('\n--- 3. Child Resource Isolation (Assets & Outputs) ---')
{
  await withUserContext(userAId, 'user', async (tx) => {
    const myAsset = await tx.queryOne('SELECT * FROM assets WHERE id = ?', [assetAId])
    assert(myAsset && myAsset.id === assetAId, 'User A can read own project asset')

    const otherAsset = await tx.queryOne('SELECT * FROM assets WHERE id = ?', [assetBId])
    assert(otherAsset === null, 'User A CANNOT read User B asset')

    const myOutput = await tx.queryOne('SELECT * FROM outputs WHERE id = ?', [outputAId])
    assert(myOutput && myOutput.id === outputAId, 'User A can read own project output')

    const otherOutput = await tx.queryOne('SELECT * FROM outputs WHERE id = ?', [outputBId])
    assert(otherOutput === null, 'User A CANNOT read User B output')
  })
}

// 4. Admin Role Bypass
console.log('\n--- 4. Admin Role Bypass ---')
{
  await withUserContext(adminId, 'admin', async (tx) => {
    const projA = await tx.queryOne('SELECT * FROM projects WHERE id = ?', [projectAId])
    const projB = await tx.queryOne('SELECT * FROM projects WHERE id = ?', [projectBId])
    assert(projA && projB, 'Admin context can read projects of both User A and User B')

    const outA = await tx.queryOne('SELECT * FROM outputs WHERE id = ?', [outputAId])
    const outB = await tx.queryOne('SELECT * FROM outputs WHERE id = ?', [outputBId])
    assert(outA && outB, 'Admin context can read outputs of both User A and User B')
  })
}

// 5. Connection Pool Cleanliness & Context Zero-Leakage
console.log('\n--- 5. Connection Pool Zero-Leakage ---')
{
  // Outside withUserContext, the session context must be empty
  const globalCtx = await getTenantContext()
  assert(globalCtx.userId === '' && globalCtx.role === '', 'session context is empty outside withUserContext')

  // System context can access both projects (background queue / cron requirement)
  const allProjects = await query('SELECT * FROM projects WHERE id IN (?, ?)', [projectAId, projectBId])
  assert(allProjects.length === 2, 'system / unconstrained context can access projects for background workers')
}

// Cleanup test rows
await run('DELETE FROM projects WHERE id IN (?, ?)', [projectAId, projectBId])
await run('DELETE FROM users WHERE id IN (?, ?, ?)', [userAId, userBId, adminId])

await closePool()

console.log(failures === 0 ? '\nALL TASK 4 TESTS PASS' : `\n${failures} FAILURES IN TASK 4`)
process.exit(failures === 0 ? 0 : 1)
