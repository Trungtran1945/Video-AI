// Friendly mapping for backend provider error codes (TransFlow behavior).
// Backend sends `[PROVIDER_QUOTA_EXCEEDED] ...` / `[NO_PROVIDER_AVAILABLE] ...`
// or ZeroTTS admission/limit errors — show root cause, never a raw stage timeout.
export function friendlyJobError(raw) {
  let msg = ''
  let aggregate = null

  if (typeof raw === 'object' && raw !== null) {
    aggregate = raw.aggregate || raw.details?.aggregate || null
    msg = String(raw.message || raw.error_message || raw.error || raw.code || '')
  } else {
    msg = String(raw || '')
  }

  if (!msg) return ''

  // 1. Translate review / quarantine (BE-E03, FE-E01)
  if (/TRANSLATE_NEEDS_REVIEW/i.test(msg)) {
    const unresMatch = msg.match(/unresolved:\s*([0-9,\s]+)/i)
    const unresStr = unresMatch ? ` (câu: ${unresMatch[1].trim()})` : ''
    const ratioMatch = msg.match(/incomplete:\s*([0-9]+)\/([0-9]+)/i)
    const ratioStr = ratioMatch ? ` (${ratioMatch[1]}/${ratioMatch[2]} câu hoàn tất)` : ''
    const isOverloaded = /quá tải|outage|restyle đang quá tải/i.test(msg)
    if (isOverloaded) {
      return `Mô hình AI dịch thuật đang quá tải — các câu chưa đạt chuẩn cần xem xét${unresStr}. Vui lòng thử Chạy lại sau ít phút hoặc sửa câu lỗi trong tab Transcript.`
    }
    return `Còn câu chưa dịch đạt chuẩn hoặc cần xem xét${ratioStr}${unresStr} — Mở tab Transcript sửa câu lỗi rồi Chạy lại từ bước Dịch thuật (dub.translate).`
  }

  // 2. BLOCK_RENDER codes with actionable guidance (FE-E01)
  if (/BLOCK_RENDER/i.test(msg)) {
    if (/MISSING_TTS_AUDIO/i.test(msg)) {
      return 'Thiếu file âm thanh lồng tiếng cho một số câu — Vui lòng nhấn Thử lại ở bước Lồng tiếng (dub.ttsAlign) để tạo bổ sung.'
    }
    if (/SEMANTIC_BLOCK/i.test(msg)) {
      return 'Bản dịch có câu vi phạm quy tắc ngữ nghĩa hoặc lỗi nặng — Vui lòng mở tab Transcript kiểm tra và sửa câu lỗi trước khi xuất video.'
    }
    if (/UNTRANSLATED_SEGMENTS/i.test(msg)) {
      return 'Còn câu chưa có bản dịch — Vui lòng bổ sung bản dịch trong tab Transcript rồi bấm Chạy lại.'
    }
    if (/MASK_DATA_UNAVAILABLE/i.test(msg)) {
      return 'Không thể đọc dữ liệu vùng che chữ từ cơ sở dữ liệu — Vui lòng kiểm tra lại tab Che chữ.'
    }
    if (/MASK_INVALID/i.test(msg)) {
      return 'Toạ độ hoặc mốc thời gian vùng che chữ không hợp lệ — Vui lòng kiểm tra và chỉnh sửa lại trong tab Che chữ.'
    }
    if (/OVERLAP|TIMELINE_OVERLAP/i.test(msg)) {
      return 'Phát hiện đoạn âm thanh hoặc phụ đề bị chồng lấn mốc thời gian — Vui lòng kiểm tra và điều chỉnh lại thời gian bắt đầu/kết thúc.'
    }
    if (/DUPLICATE_SUBTITLE/i.test(msg)) {
      return 'Phát hiện phụ đề trùng lặp liên tiếp — Vui lòng kiểm tra lại nội dung phụ đề trong tab Transcript.'
    }
    if (/INVALID_TIMING/i.test(msg)) {
      return 'Thời gian phụ đề không hợp lệ (thời gian kết thúc phải lớn hơn thời gian bắt đầu) — Vui lòng sửa lại mốc thời gian.'
    }
    if (/INVALID_DURATION/i.test(msg)) {
      return 'Độ dài phân đoạn phụ đề không hợp lệ (phải > 0 và <= 300s) — Vui lòng kiểm tra lại mốc thời gian.'
    }
    if (/DUPLICATE_AUDIO/i.test(msg)) {
      return 'Phát hiện nhiều phân đoạn dùng chung file âm thanh — Vui lòng bấm Thử lại bước Lồng tiếng.'
    }
    if (/INVALID_TTS_DURATION/i.test(msg)) {
      return 'Thời lượng âm thanh lồng tiếng lệch quá nhiều so với độ dài phân đoạn — Vui lòng tạo lại giọng đọc cho phân đoạn này.'
    }
    if (/MISSING_TTS_FILE/i.test(msg)) {
      return 'Thiếu tệp âm thanh WAV của phân đoạn — Vui lòng bấm Thử lại bước Lồng tiếng để tạo lại tệp.'
    }
    if (/NO_SEGMENTS/i.test(msg)) {
      return 'Không tìm thấy phân đoạn lời thoại nào — Vui lòng kiểm tra lại video gốc hoặc bước nhận dạng giọng nói.'
    }
    return `Xuất video bị chặn do chưa thoả điều kiện kiểm định: ${msg.replace(/^BLOCK_RENDER:\s*/i, '')}`
  }

  // 3. TTS partial completion (BE-E02, FE-E01)
  if (/dub\.ttsAlign incomplete/i.test(msg)) {
    const ratioMatch = msg.match(/incomplete:\s*([0-9]+)\/([0-9]+)/i)
    const ratioStr = ratioMatch ? ` (${ratioMatch[1]}/${ratioMatch[2]} câu thành công)` : ''
    return `Tạo giọng đọc chưa hoàn tất${ratioStr} — Vui lòng kiểm tra câu lỗi trong Transcript và bấm Thử lại bước Lồng tiếng (dub.ttsAlign).`
  }

  // 4. Transcript / Generation snapshot missing (FE-E01)
  if (/TRANSCRIPT_SNAPSHOT_MISSING|GENERATION_SNAPSHOT_MISSING/i.test(msg)) {
    return 'Dữ liệu bản ghi phiên bản bị thiếu hoặc đã thay đổi — Vui lòng bấm Thử lại từ bước Lồng tiếng (dub.ttsAlign).'
  }

  // 5. ASR / STT API key missing (PROV_001, FE-E01)
  if (/PROV_001/i.test(msg) || /Chưa cấu hình API key cho ASR\/STT/i.test(msg)) {
    return 'Chưa cấu hình API key cho nhận dạng giọng nói (ASR/STT) — Vui lòng kiểm tra API Key trong trang Cài đặt.'
  }

  // 6. ZeroTTS backpressure & admission queue limits (429 / 503 SERVER_BUSY / QUEUE_FULL)
  if (
    /SERVER_BUSY|QUEUE_FULL|admission queue full|concurrency limit reached|Server is stopping/i.test(msg) ||
    (/TTS/i.test(msg) && /(429|503)/.test(msg))
  ) {
    return 'Máy chủ TTS đang bận, thử lại sau'
  }

  // 7. Request body / text length limits (413 BODY_TOO_LARGE / TEXT_TOO_LONG)
  if (/413|BODY_TOO_LARGE|TEXT_TOO_LONG|body too large|text too long/i.test(msg)) {
    return 'Văn bản quá dài'
  }

  // 8. Voice not found / invalid text — keep meaningful server message as-is
  if (/Voice '.*' không tồn tại/i.test(msg)) {
    return msg
  }
  if (/VOICE_NOT_FOUND/i.test(msg)) {
    return 'Giọng đọc không tồn tại hoặc không được hỗ trợ.'
  }
  if (/Text is required and must not be empty|TTS text rỗng/i.test(msg)) {
    return 'Văn bản yêu cầu không được để trống.'
  }
  if (/INVALID_TEXT/i.test(msg)) {
    return 'Văn bản không hợp lệ.'
  }

  // 9. Failover aggregate classifications (BE-F02: root-cause classification instead of raw timeout)
  if (
    aggregate === 'ALL_TRANSIENT' ||
    (msg.includes('NO_PROVIDER_AVAILABLE') && /ALL_TRANSIENT|PROVIDER_RATE_LIMITED|PROVIDER_TIMEOUT|PROVIDER_NETWORK_ERROR/i.test(msg))
  ) {
    return 'Các nhà cung cấp AI đang bận hoặc gặp lỗi tạm thời. Vui lòng thử lại sau.'
  }
  if (
    aggregate === 'ALL_AUTH' ||
    (msg.includes('NO_PROVIDER_AVAILABLE') && /ALL_AUTH|PROVIDER_AUTH_FAILED/i.test(msg))
  ) {
    return 'Xác thực API thất bại trên các nhà cung cấp AI. Vui lòng kiểm tra lại API Key trong cài đặt.'
  }
  if (
    aggregate === 'ALL_PERMISSION' ||
    (msg.includes('NO_PROVIDER_AVAILABLE') && /ALL_PERMISSION|PROVIDER_PERMISSION_DENIED/i.test(msg))
  ) {
    return 'Không có quyền truy cập mô hình AI trên các nhà cung cấp. Vui lòng kiểm tra lại quyền tài khoản API.'
  }
  if (
    aggregate === 'ALL_CONFIGURATION' ||
    (msg.includes('NO_PROVIDER_AVAILABLE') && /ALL_CONFIGURATION|PROVIDER_MODEL_NOT_FOUND|PROVIDER_INVALID_REQUEST/i.test(msg))
  ) {
    return 'Cấu hình yêu cầu AI không hợp lệ hoặc mô hình không tồn tại.'
  }

  // 10. Quota exceeded (single provider or ALL_QUOTA)
  const isQuota =
    aggregate === 'ALL_QUOTA' ||
    /PROVIDER_QUOTA_EXCEEDED|ALL_QUOTA|hết quota|quota exceeded|quota exhausted/i.test(msg)
  if (isQuota) {
    return 'AI provider đã hết quota. Hệ thống đã thử provider dự phòng nếu có. Vui lòng thử lại sau hoặc cấu hình provider khác.'
  }

  // 11. Generic failover exhaustion with context
  if (/NO_PROVIDER_AVAILABLE/i.test(msg)) {
    if (/stt|asr|audio chunks/i.test(msg)) {
      return 'Không có dịch vụ nhận dạng giọng nói (ASR/STT) khả dụng. Vui lòng kiểm tra API Key trong trang Cài đặt.'
    }
    if (/tts|speech/i.test(msg)) {
      return 'Không có dịch vụ tạo giọng đọc (TTS) khả dụng. Vui lòng kiểm tra API Key trong trang Cài đặt.'
    }
    if (/translate|llm/i.test(msg)) {
      return 'Không có dịch vụ AI dịch thuật khả dụng. Vui lòng kiểm tra API Key trong trang Cài đặt.'
    }
    return 'Tất cả nhà cung cấp AI đều không khả dụng. Vui lòng thử lại sau hoặc cấu hình provider khác.'
  }

  // FE-E01: Do not truncate to 220 chars when unmapped so diagnostic details and actions are preserved.
  return msg
}

export default { friendlyJobError }
