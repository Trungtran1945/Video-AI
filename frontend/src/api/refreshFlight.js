// Single-flight: N×401 đồng thời → đúng 1 lời gọi refresh; các lời mời còn
// lại await cùng promise. finally xóa inflight để lần refresh sau hoạt động
// (kể cả khi refresh fail — caller nhận cùng rejection).
export function createSingleFlight() {
  let inflight = null
  const run = (fn) => {
    if (inflight) return inflight
    inflight = Promise.resolve()
      .then(fn)
      .finally(() => { inflight = null })
    return inflight
  }
  run.pending = () => inflight !== null
  return run
}
