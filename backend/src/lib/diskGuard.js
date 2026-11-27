import fs from 'node:fs/promises'
import { config } from '../config.js'
import { evaluateDiskSpace } from './storagePolicy.js'

const GB = 1024 ** 3

/**
 * Đọc dung lượng trống thực tế của filesystem chứa `dir`.
 * Dùng fs.statfs (Node >= 18.15, có trên Linux + Windows).
 * Lỗi statfs → trả ok:true kèm error (không chặn ghi vì lỗi đo đạc).
 */
export async function checkDiskSpace(dir = config.storageDir) {
  const minFreeBytes = Math.max(0, Number(config.minFreeDiskGb || 0)) * GB
  if (minFreeBytes === 0) {
    return { ok: true, freeBytes: null, minFreeBytes: 0 }
  }
  try {
    const stat = await fs.statfs(dir)
    const freeBytes = Number(stat.bavail) * Number(stat.bsize)
    return evaluateDiskSpace({ freeBytes, minFreeBytes })
  } catch (err) {
    return { ok: true, freeBytes: null, minFreeBytes, error: err?.message || String(err) }
  }
}
