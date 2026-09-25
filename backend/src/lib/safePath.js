import fs from 'node:fs'
import path from 'node:path'

export class UnsafeStoragePathError extends Error {
  constructor(message = 'Storage path is unsafe') {
    super(message)
    this.name = 'UnsafeStoragePathError'
    this.code = 'UNSAFE_STORAGE_PATH'
  }
}

// Canonical filesystem containment check — the ONLY sanctioned way to decide
// "is target inside root" in this codebase.
// Invariants:
// - both sides are canonicalized with path.resolve()
// - containment is decided with path.relative(), never startsWith(root)
//   (startsWith lets a sibling like /app/storage_backup pass for root /app/storage)
// - root === target counts as inside only when { allowRoot: true }
// - symlinks are NOT resolved here; use findSymlinkInPath() when link escape matters
export function isPathInside(root, target, { allowRoot = false } = {}) {
  const absoluteRoot = path.resolve(root)
  const absoluteTarget = path.resolve(target)
  const relative = path.relative(absoluteRoot, absoluteTarget)
  if (relative === '') return allowRoot
  if (path.isAbsolute(relative)) return false
  return relative !== '..' && !relative.startsWith(`..${path.sep}`)
}

// Resolve a (relative) path against root and reject anything that escapes it.
// Returns the canonical absolute path, or null when the path is unsafe
// (traversal with ../, absolute external path, sibling-prefix, empty input).
export function resolveSafePath(root, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath) return null
  const absoluteRoot = path.resolve(root)
  const absolute = path.resolve(absoluteRoot, relativePath)
  return isPathInside(absoluteRoot, absolute) ? absolute : null
}

export async function ensureSafeDirectory({ root, relativeDirectory, fileSystem = fs }) {
  if (typeof relativeDirectory !== 'string' || path.isAbsolute(relativeDirectory)) throw new UnsafeStoragePathError()
  const parts = relativeDirectory.split(/[\\/]+/).filter(Boolean)
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) throw new UnsafeStoragePathError()
  const absoluteRoot = path.resolve(root)
  let current = absoluteRoot
  for (const part of parts) {
    const next = path.join(current, part)
    if (!isPathInside(absoluteRoot, next) || await findSymlinkInPath(absoluteRoot, next, fileSystem)) throw new UnsafeStoragePathError()
    try {
      await fileSystem.promises.mkdir(next)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    const stat = await fileSystem.promises.lstat(next)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new UnsafeStoragePathError()
    current = next
  }
  return current
}

export async function findSymlinkInPath(root, target, fileSystem = fs) {
  const absoluteRoot = path.resolve(root)
  const absoluteTarget = path.resolve(target)
  if (!isPathInside(absoluteRoot, absoluteTarget)) return absoluteTarget
  const parts = path.relative(absoluteRoot, absoluteTarget).split(path.sep).filter(Boolean)
  let current = absoluteRoot
  for (const part of parts) {
    current = path.join(current, part)
    try {
      const stat = await fileSystem.promises.lstat(current)
      if (stat.isSymbolicLink()) return current
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }
  return null
}
