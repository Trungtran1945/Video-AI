// Minimal glossary regression: CRUD + prompt loading + isolation.
// Run: node tests/glossary.test.mjs
import path from 'node:path'
import os from 'node:os'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_glossary_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { insert } = await import('../src/db/query.js')
const { listGlossary, addGlossaryTerm, deleteGlossaryTerm, loadGlossaryForPrompt } = await import('../src/services/glossaryService.js')

await initSchema()

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const projectId = 'glossary-project'
await insert('projects', { id: projectId, user_id: 'u1', mode: 'TRANSLATE_DUB', title: 'g', status: 'pending' })

// 1. Empty project → empty list (table exists after migration)
assert((await listGlossary(projectId)).length === 0, 'empty project -> empty glossary')

// 2. Add + list round-trip
const t1 = await addGlossaryTerm(projectId, { source: 'Sensei', target: 'Thầy', caseSensitive: true, note: 'respect' })
assert(t1.source === 'Sensei' && t1.target === 'Thầy' && t1.case_sensitive === true, 'add returns term')
const rows = await listGlossary(projectId)
assert(rows.length === 1 && rows[0].source === 'Sensei', 'list returns term')

// 3. Prompt loader shape
const forPrompt = await loadGlossaryForPrompt(projectId)
assert(forPrompt.length === 1 && forPrompt[0].source === 'Sensei' && forPrompt[0].target === 'Thầy', 'prompt loader shape')

// 4. Validation: empty source/target rejected
let threw = false
try { await addGlossaryTerm(projectId, { source: '', target: 'x' }) } catch (e) { threw = e?.statusCode === 400 }
assert(threw, 'empty source -> 400')

// 5. Delete + isolation across projects
assert(await deleteGlossaryTerm(projectId, t1.id) === true, 'delete existing -> true')
assert(await deleteGlossaryTerm(projectId, t1.id) === false, 'delete missing -> false')
const other = 'glossary-other'
await insert('projects', { id: other, user_id: 'u1', mode: 'TRANSLATE_DUB', title: 'o', status: 'pending' })
const t2 = await addGlossaryTerm(other, { source: 'A', target: 'B' })
assert(await deleteGlossaryTerm(projectId, t2.id) === false, 'cross-project delete blocked')
assert((await listGlossary(other)).length === 1, 'other project keeps its term')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
