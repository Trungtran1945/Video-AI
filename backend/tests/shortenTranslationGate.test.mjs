// Test that shortenTranslation enforces semantic validation and clean output
// Run: node backend/tests/shortenTranslationGate.test.mjs
import path from 'node:path'
import os from 'node:os'

// Hermetic DB: fresh checkout (CI) has no data.db, so create the schema on a
// temp database instead of relying on a developer's existing one.
process.env.DB_PATH = path.join(os.tmpdir(), `vidai_shorten_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { shortenTranslation } = await import('../src/pipeline/stages/dubTtsAlign.js')
const { run } = await import('../src/db/query.js')

await initSchema()

let failures = 0
const assert = (c, m) => {
  if (c) console.log('PASS:', m)
  else { failures++; console.error('FAIL:', m) }
}

// Clean test cache
await run("DELETE FROM provider_cache WHERE provider LIKE 'test_shorten%'")

// Case 1: LLM returns explanation / leaked heading with number mismatch
{
  const fakeLlm = {
    id: 'test_shorten_1',
    provider: {
      model: 'm1',
      complete: async () => ({ text: '**Restyled Versions:**\n(Mục tiêu: 2 câu)' })
    }
  }
  const result = await shortenTranslation(fakeLlm, '快换个方向', 'Đổi hướng lẹ lẹ đi nào câu 1', 0.8, { id: 'job1' }, 'p1', 'vi')
  assert(result === null, 'Rejects explanation and number mismatch (returns null)')
}

// Case 2: LLM returns conversational junk with missing negation
{
  const fakeLlm = {
    id: 'test_shorten_2',
    provider: {
      model: 'm2',
      complete: async () => ({ text: 'Bạn cứ làm đi nhé' })
    }
  }
  const result = await shortenTranslation(fakeLlm, 'do not touch', 'đừng chạm vào nha', 0.8, { id: 'job2' }, 'p2', 'vi')
  assert(result === null, 'Rejects shortened text when negation is lost')
}

// Case 3: LLM returns valid shortened translation with quotes/markdown
{
  const fakeLlm = {
    id: 'test_shorten_3',
    provider: {
      model: 'm3',
      complete: async () => ({ text: '  "Đổi hướng mau!"  ' })
    }
  }
  const result = await shortenTranslation(fakeLlm, '快换个方向', 'Đổi hướng lẹ lẹ đi nào câu 3', 0.8, { id: 'job3' }, 'p3', 'vi')
  assert(result === 'Đổi hướng mau!', `Accepts valid shortened text stripped of quotes (got: ${result})`)
}

// Case 4: LLM throws or fails
{
  const fakeLlm = {
    id: 'test_shorten_4',
    provider: {
      model: 'm4',
      complete: async () => { throw new Error('LLM rate limit') }
    }
  }
  const result = await shortenTranslation(fakeLlm, '快换个方向', 'Đổi hướng lẹ lẹ đi nào câu 4', 0.8, { id: 'job4' }, 'p4', 'vi')
  assert(result === null, 'Gracefully returns null on LLM failure without crashing')
}

await run("DELETE FROM provider_cache WHERE provider LIKE 'test_shorten%'")

if (failures > 0) {
  console.error(`\n${failures} tests failed!`)
  process.exit(1)
} else {
  console.log('\nALL PASS')
  process.exit(0)
}
