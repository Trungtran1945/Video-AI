# 11 — Rate Limiting & Khả năng Vận hành Ổn định với API Key Miễn phí

Tài liệu này bổ sung cho `01_KIEN_TRUC_TONG_THE.md` và `03_THIET_KE_BACKEND.md`, nhằm đảm bảo hệ thống **vận hành trơn tru, liên tục và không bị đứt gãy pipeline** khi người dùng sử dụng các **API key miễn phí** (Google Gemini Free Tier, OpenAI Free Trial, ElevenLabs Free Quota, Edge-TTS miễn phí, v.v.) — vốn có các hạn chế khắt khe về số request/phút (RPM), số request/ngày (RPD) và giới hạn ký tự/tháng.

---

# Current Implementation (CURRENT)

- **`RateLimiter` đa tầng (`backend/src/lib/rateLimiter.js`)**: Kết hợp thuật toán Token Bucket (cho phép burst ngắn) và Sliding Window (giới hạn RPM/RPD) quản lý theo `(userId, provider, apiKeyId)`. Hàm `acquire()` tự động chờ khi gần chạm RPM; ném lỗi `RateLimitExhaustedError` khi chạm trần ngày RPD; `markRateLimited()` đóng băng bucket trong 10s.
- **Giới hạn chuyên biệt cho Gemini (`backend/src/providers/rateLimit.js`, `geminiClient.js`)**: Quản lý sliding window theo từng key (`GEMINI_RPM` mặc định 10), tự động trích xuất độ trễ `Retry-After` / `retry in Xs` kết hợp exponential backoff 1s→30s (cap 60s), số lần retry tối đa `GEMINI_MAX_RETRIES = 5`.
- **Bộ nhớ đệm kết quả AI (`ProviderCache`)**: Lưu tại bảng `provider_cache` với khoá băm SHA-256 từ `(provider + type + model + normalized input)` với thời hạn lưu trữ (TTL) 90 ngày. Bổ sung canonical cache riêng cho ASR Whisper (`buildAsrCacheInput`).
- **Chiến lược dự phòng (Failover)**:
  - TTS: Edge-TTS lỗi → Google TTS → ZeroTTS / ElevenLabs (`backend/src/lib/providerFailover.js`).
  - Translate: Google Translate lỗi → LLM direct translation theo chiến lược 3 vòng (TransFlow).
  - FFmpeg: NVENC lỗi → tự động chuyển sang CPU `libx264`.
  - Ingest: Audio quá ồn hoặc lỗi loudnorm → copy audio thô an toàn.
- **Cơ chế Park Queue khi gặp 429**: Khi gặp lỗi cạn quota tạm thời, pipeline không đánh dấu `failed` mà trích xuất thời điểm reset `next_retry_at`, chuyển trạng thái project về `queued` để tự động chạy tiếp khi quota hồi phục (tối đa 5 lần thử lại).
- **QuotaGuard Pre-check (`quotaGuardService.js`)**: Kiểm tra hạn mức khả dụng của các năng lực AI (`asr`, `vision`, `llm`, `tts`) trước khi bắt đầu thực thi các stage tốn nhiều request (như `dub.translate`, `dub.ttsAlign`, `summary.analyze`, `script.analyze`).

---

## 1. Nguyên tắc Thiết kế Cốt lõi

| Nguyên tắc | Ý nghĩa |
| --- | --- |
| **Throttle chủ động tại nguồn** | Nắm rõ ngưỡng RPM/RPD của từng nhà cung cấp để chủ động giãn cách các request, thay vì gửi dồn dập rồi chờ lỗi 429 |
| **Cache triệt để (Content-based)** | Input giống nhau (SHA-256 băm nội dung) → trả ngay kết quả từ cache, không tốn quota API |
| **Tôn trọng tín hiệu từ Provider** | Đọc chính xác header `Retry-After` hoặc thông báo lỗi từ nhà cung cấp để lên lịch thử lại tối ưu |
| **Cảnh báo sớm ngưỡng Quota** | Cảnh báo trước khi cạn quota (ngưỡng 80%), hiển thị tiến độ quota trên giao diện `ApiKeys` |
| **Suy giảm nhẹ nhàng (Graceful Degradation)** | Tự động chuyển đổi provider dự phòng cùng loại nếu provider chính gặp sự cố |
| **Gom nhóm request (Batching)** | Gom nhiều câu thoại vào 1 request dịch LLM (context window) thay vì gọi từng câu riêng lẻ |

---

## 2. Cấu hình Giới hạn Mặc định (`provider_rate_limits`)

Giá trị mặc định cho các gói free-tier phổ biến (được seed sẵn trong bảng `provider_rate_limits`, người dùng có thể điều chỉnh qua cài đặt):

| Provider | Gói (Tier) | RPM | RPD | Concurrency |
| --- | --- | --- | --- | --- |
| `gemini` | free | 10 | 250 | 1 |
| `openai` | free-trial | 3 | 200 | 1 |
| `elevenlabs`| free | 2 | — (giới hạn theo ký tự) | 1 |
| `edge_tts` | free (unlimited)| 20 | — | 2 |
| `zero_tts` | local (sidecar) | 10 | — | 1 |

---

## 3. Bộ nhớ đệm AI (`ProviderCache`)

Lớp bọc `callProvider()` trong `backend/src/lib/callProvider.js` tự động tra cứu cache trước khi gửi request ra mạng:
- **Chuẩn hóa đầu vào**: Chuẩn hóa khoảng trắng, định dạng JSON và thứ tự thuộc tính trước khi tính toán mã băm SHA-256 `input_hash`.
- **Tái sử dụng kết quả**: Khi chạy lại pipeline (Regenerate) hoặc thử nghiệm nhiều lần trên cùng một video/kịch bản, các đoạn đã dịch hoặc đã nhận dạng STT được lấy trực tiếp từ database mà không tiêu tốn thêm bất kỳ token nào.

---

## 4. QuotaGuard & Quản lý Đa Khóa API (Multi-Key Management)

1. **Giám sát Mức sử dụng (QuotaBar)**:
   - Endpoint `GET /api/v1/providers/quota-summary` tổng hợp mức sử dụng API trong ngày của người dùng, hiển thị trực quan trên trang `ApiKeys.jsx`.
2. **Khai báo Nhiều Key cho cùng 1 Provider**:
   - Cho phép người dùng nhập nhiều API key cho cùng một nhà cung cấp (ví dụ: 3 key Gemini Free Tier), mỗi key có `label` và `priority` riêng biệt.
3. **Môi trường Giả lập Mock cho Kiểm thử (Dev & CI)**:
   - Cung cấp sẵn các mock provider (`mockAsr`, `mockLlm`, `mockTts`, `mockVision`) kích hoạt qua biến môi trường `DEFAULT_PROVIDER_MODE=mock`.
   - Toàn bộ bộ kiểm thử tự động của backend (`npm test`) và CI pipeline chạy hoàn toàn trên các provider mock, đảm bảo luôn xanh 100% mà không phụ thuộc vào kết nối mạng hay hạn mức API bên ngoài.

---

## 5. Chiến lược Bộ nhớ đệm 2 tầng (2-Tier Cache) trong Media Composer

Chế độ `MEDIA_COMPOSER` xử lý nhiều hình ảnh tải lên, trích xuất văn bản (OCR) và dịch thuật song ngữ. Nhằm đảm bảo người dùng gói Free Tier không bị cạn hạn mức API khi thử nghiệm hoặc mở lại các modal nhiều lần, hệ thống áp dụng chiến lược cache 2 tầng:

1. **Tầng 1: Asset-level Cache (Cơ sở dữ liệu cục bộ)**:
   - Khi thực hiện OCR hoặc Dịch thuật cho một asset, kết quả được lưu trực tiếp vào các cột `ocr_text` và `translated_text` của bảng `assets`.
   - Khi người dùng mở lại modal `OcrTranslateModal` hoặc yêu cầu thao tác trên cùng một asset mà không thay đổi, hệ thống trả về ngay kết quả từ DB mà hoàn toàn không thực hiện bất kỳ lời gọi API nào.
2. **Tầng 2: Provider-level Cache (`provider_cache`)**:
   - Khi người dùng gửi yêu cầu OCR hoặc Dịch thuật cho một asset mới, lời gọi AI đi qua `callProvider()` với mã băm SHA-256 từ nội dung hình ảnh hoặc văn bản cần dịch.
   - Nếu trong vòng 90 ngày (TTL mặc định), đã từng có bất kỳ asset nào khác có cùng nội dung ảnh hoặc cùng câu văn bản được xử lý, kết quả được nạp ngay lập tức từ `provider_cache`.
   - Kết quả: Giảm đến 95% số lượng cuộc gọi trùng lặp ra bên ngoài, duy trì trạng thái hoạt động liên tục ngay cả với hạn mức khắt khe của Gemini Free Tier (10 RPM / 250 RPD).
