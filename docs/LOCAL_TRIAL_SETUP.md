# Chạy thử Video_AI bằng Docker (dành cho bạn bè / người phỏng vấn)

Mục tiêu: **clone repo về máy → chạy 1 lệnh → mở `http://localhost` → xem/dùng thử ngay, không cần xin API key.**

---

## 1. Yêu cầu

- Docker Desktop (Windows/macOS) hoặc Docker Engine + Compose plugin v2 (Linux). Kiểm tra: `docker --version` và `docker compose version`.
- RAM ≥ 8 GB (khuyến nghị), dung lượng trống ≥ 10 GB.
- Kết nối mạng **lần đầu** để tải image và `npm ci` bên trong build. Sau đó demo chạy offline (trừ giọng nói Edge-TTS — xem mục 4).

Không cần Node.js, Redis, PostgreSQL hay FFmpeg cài trên máy host: tất cả nằm trong container.

---

## 2. Khởi động (3 bước)

```bash
git clone <URL_REPO> Video_AI
cd Video_AI
docker compose -f docker-compose.trial.yml up -d --build
```

Lần đầu build mất vài phút. Theo dõi tiến trình:

```bash
docker compose -f docker-compose.trial.yml logs -f api
```

Khi API báo `ready`, mở trình duyệt: **http://localhost**

> Nếu port 80 đã bị chiếm: đặt biến `TRIAL_WEB_PORT=8080` rồi chạy lại, mở `http://localhost:8080`.
> Ví dụ (PowerShell): `$env:TRIAL_WEB_PORT=8080; docker compose -f docker-compose.trial.yml up -d --build`

### Đăng nhập tài khoản demo

| Trường | Giá trị |
|---|---|
| Email | `demo@local.test` |
| Mật khẩu | `demo12345678` |

Tài khoản này được tạo sẵn bởi `seed.js`. Đăng ký tài khoản mới đi qua OTP/SMTP nên **không dùng** trong bản trial nếu chưa cấu hình SMTP.

---

## 3. Demo mode là gì?

`docker-compose.trial.yml` đặt `DEFAULT_PROVIDER_MODE=mock`. Khi người dùng **chưa có API key**, backend tự động dùng các provider mô phỏng (`MockLlm`, `MockAsr`, `MockTts`, `MockVision`, `MockTranslate`) thay vì báo lỗi "chưa cấu hình key".

Điều này nghĩa là:

- ✅ Chạy được toàn bộ pipeline (tóm tắt / dịch-lồng tiếng / script-to-video / media composer) để xem luồng xử lý, giao diện, SSE, timeline, render video.
- ⚠️ **Nội dung sinh ra là mô phỏng** (kịch bản, lời dịch, mô tả cảnh). Không phải dịch/thông tin thật. Không dùng để đánh giá chất lượng AI.
- Provider thật vẫn được ưu tiên nếu bạn có key: mock chỉ là phương án cuối cùng khi provider thật thiếu key / hết quota / lỗi mạng.

Code liên quan: `backend/src/providers/registry.js`, `backend/src/providers/llm/mockLlm.js`, `backend/src/providers/vision/mockVision.js`, `backend/src/providers/translate/mockTranslate.js`.

---

## 4. Dùng AI thật (BYOK — mang key của bạn)

Vào trang **API Keys** trong ứng dụng, thêm key cho các provider bạn muốn dùng:

| Việc cần làm | Provider / key | Ghi chú |
|---|---|---|
| Sinh kịch bản, dịch thuật, sửa lỗi | `gemini` → **Gemini API key** | Có free tier |
| Nhận diện giọng nói (ASR) | `whisper` → **Groq API key** | Compose đã đặt `WHISPER_BASE_URL=https://api.groq.com/openai/v1` |
| Lồng tiếng | `edge_tts` | **Không cần key**, nhưng cần mạng. Nếu mạng lỗi sẽ tự fallback sang `mock` (tiếng im lặng) |
| Dịch qua Google Apps Script (tùy chọn) | `GOOGLE_TRANSLATE_SCRIPT_URL` | Đặt biến môi trường trước khi `up`; không bắt buộc vì LLM đã dịch chính |

Key lưu trong PostgreSQL dưới dạng mã hoá (`MASTER_KEY` dev), **không ghi vào repo**. Sau khi thêm key, pipeline tự dùng provider thật — không cần đổi cài đặt.

Nếu muốn dùng key qua environment thay vì giao diện: tạo file `.env` ở root (không commit) với `GEMINI_API_KEY=...`, `GROQ_API_KEY=...` rồi `docker compose -f docker-compose.trial.yml up -d --build` lại.

---

## 5. Dừng / dọn / troubleshoot

```bash
# Dừng, giữ dữ liệu
docker compose -f docker-compose.trial.yml down

# Dừng và XOÁ toàn bộ dữ liệu demo (DB + storage + Redis)
docker compose -f docker-compose.trial.yml down -v
```

| Triệu chứng | Cách xử lý |
|---|---|
| `Cannot connect to the Docker daemon` | Khởi động Docker Desktop, chạy lại lệnh |
| `port 80 is already in use` | Đặt `TRIAL_WEB_PORT=8080` như mục 2 |
| Trang trắng / 502 lúc đầu | Chờ API healthy (`docker compose ... ps`); lần build đầu chưa xong `npm ci` |
| Đăng nhập fails | Dùng đúng `demo@local.test` / `demo12345678`; kiểm tra log `api` |
| Render chậm / thiếu giọng | Edge-TTS cần mạng; offline → mock TTS tạo âm thanh im lặng, vẫn render được |
| Hết dung lượng | `docker compose -f docker-compose.trial.yml down -v`, sau đó `docker system prune` |

---

## 6. Lưu ý bảo mật

- Trial compose **chỉ bind `127.0.0.1`**, không mở ra LAN/internet.
- Secret trong file compose là **dev/demo secret**, không dùng cho production. Không expose port 3001/5432 ra ngoài máy localhost.
- Không nhúng API key thật vào repo hay image. Key thật chỉ nhập qua giao diện hoặc file `.env` (đã nằm trong `.gitignore`).
- Nếu cần deploy thật sau này, dùng `docker-compose.prod.yml` + Caddyfile có sẵn trong repo (xem README §6.3).
