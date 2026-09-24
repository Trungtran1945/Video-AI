import fs from 'node:fs'
import path from 'node:path'

export class UnsafeStoragePathError extends Error {
  constructor(message = 'Storage path is unsafe') {
    super(message)
    this.name = 'UnsafeStoragePathError'
    this.code = 'UNSAFE_STORAGE_PATH'
  }
}

export function isPathInside(root, target) {
  const relative = path.relative(root, target)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
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
