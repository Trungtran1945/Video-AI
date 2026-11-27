// Pure, side-effect-free storage policy helpers (unit-testable).
// Không import config/db để test không cần môi trường.

/**
 * So sánh dung lượng trống với ngưỡng tối thiểu.
 * freeBytes null/không hợp lệ → coi như không đánh giá được, KHÔNG chặn
 * (tránh biến lỗi observability thành outage).
 */
export function evaluateDiskSpace({ freeBytes, minFreeBytes }) {
  const min = Number(minFreeBytes)
  if (!Number.isFinite(freeBytes) || !Number.isFinite(min) || min <= 0) {
    return {
      ok: true,
      freeBytes: Number.isFinite(freeBytes) ? freeBytes : null,
      minFreeBytes: Number.isFinite(min) ? min : 0,
    }
  }
  return { ok: freeBytes >= min, freeBytes, minFreeBytes: min }
}

/**
 * User còn được tạo project không?
 * maxStored <= 0 → không giới hạn.
 */
export function evaluateStoredProjectCap({ storedCount, maxStored }) {
  const stored = Number(storedCount)
  const max = Number(maxStored)
  if (!Number.isFinite(max) || max <= 0) {
    return { ok: true, storedCount: Number.isFinite(stored) ? stored : 0, maxStored: 0 }
  }
  return {
    ok: (Number.isFinite(stored) ? stored : 0) < max,
    storedCount: Number.isFinite(stored) ? stored : 0,
    maxStored: max,
  }
}
