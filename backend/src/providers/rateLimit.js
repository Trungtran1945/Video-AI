// Bộ giới hạn tốc độ (rate limiter) chia sẻ giữa tất cả cuộc gọi Gemini
// (LLM + Vision/OCR) dùng chung một API key, để không vượt quá giới hạn
// free-tier "20 requests/minute".
//
// Dùng mô hình sliding-window: tối đa `rpm` yêu cầu trong bất kỳ cửa sổ 60 giây nào.
// Mọi instance GeminiLlm / GeminiVision (dù được tạo mới mỗi lần getProvider)
// đều chia sẻ chung một bucket theo apiKey, nên OCR/translation không cạnh tranh
// vượt quota của nhau.

function defaultRpm() {
  return Number(process.env.GEMINI_RPM) || 10 // an toàn dưới mức 20 free-tier
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

class SlidingWindow {
  constructor(rpm) {
    this.rpm = Math.max(1, rpm)
    this.windowMs = 60_000
    this.ts = []
  }

  async acquire() {
    for (;;) {
      const now = Date.now()
      // Loại bỏ các yêu cầu đã nằm ngoài cửa sổ 60s.
      while (this.ts.length && now - this.ts[0] >= this.windowMs) this.ts.shift()
      if (this.ts.length < this.rpm) {
        this.ts.push(now)
        return
      }
      // Đã đủ quota trong cửa sổ này → chờ đến khi yêu cầu cũ nhất rơi khỏi cửa sổ.
      const wait = this.windowMs - (now - this.ts[0]) + 50
      await sleep(wait)
    }
  }
}

const buckets = new Map()

export function acquireGeminiQuota(apiKey) {
  const key = apiKey || '__default__'
  let bucket = buckets.get(key)
  if (!bucket) {
    bucket = new SlidingWindow(defaultRpm())
    buckets.set(key, bucket)
  }
  return bucket.acquire()
}

export default { acquireGeminiQuota }
