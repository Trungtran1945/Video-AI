// Unit tests cho storage policy thuần (không DB, không network).
// Run: node backend/tests/storagePolicy.test.mjs
import { evaluateDiskSpace, evaluateStoredProjectCap } from '../src/lib/storagePolicy.js'

let failures = 0
const assert = (cond, msg) => {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

// evaluateDiskSpace
assert(evaluateDiskSpace({ freeBytes: 31 * 1024 ** 3, minFreeBytes: 30 * 1024 ** 3 }).ok === true, 'disk: 31GB free >= 30GB -> ok')
assert(evaluateDiskSpace({ freeBytes: 29 * 1024 ** 3, minFreeBytes: 30 * 1024 ** 3 }).ok === false, 'disk: 29GB free < 30GB -> blocked')
assert(evaluateDiskSpace({ freeBytes: 30 * 1024 ** 3, minFreeBytes: 30 * 1024 ** 3 }).ok === true, 'disk: boundary equal -> ok')
assert(evaluateDiskSpace({ freeBytes: null, minFreeBytes: 30 * 1024 ** 3 }).ok === true, 'disk: unknown free -> fail-open')
assert(evaluateDiskSpace({ freeBytes: 1, minFreeBytes: 0 }).ok === true, 'disk: guard disabled -> ok')
assert(evaluateDiskSpace({ freeBytes: 1, minFreeBytes: -1 }).ok === true, 'disk: negative threshold -> ok')

// evaluateStoredProjectCap
assert(evaluateStoredProjectCap({ storedCount: 9, maxStored: 10 }).ok === true, 'cap: 9/10 -> allowed')
assert(evaluateStoredProjectCap({ storedCount: 10, maxStored: 10 }).ok === false, 'cap: 10/10 -> blocked')
assert(evaluateStoredProjectCap({ storedCount: 11, maxStored: 10 }).ok === false, 'cap: 11/10 -> blocked')
assert(evaluateStoredProjectCap({ storedCount: 999, maxStored: 0 }).ok === true, 'cap: 0 -> unlimited')
assert(evaluateStoredProjectCap({ storedCount: 0, maxStored: 10 }).ok === true, 'cap: 0/10 -> allowed')

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`)
  process.exit(1)
}
console.log('\nAll storagePolicy tests passed')
