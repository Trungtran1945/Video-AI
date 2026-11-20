# BÁO CÁO ĐÁNH GIÁ BẢO MẬT BAN ĐẦU (SECURITY BASELINE AUDIT)
**Dự án:** Video AI Platform  
**Phiên bản kiểm toán:** v1.0.0-baseline  
**Ngày thực hiện:** 18/11/2026  
**Chuyên gia thực hiện:** Security Architect & Lead Auditor (`sec_architect`)  
**Phạm vi:** Toàn bộ hệ thống (`backend/src`, `backend/tests`, `frontend/src`, `backend/server.js`, `config.js`, `db.js`, `query.js`, `schema.js`, `postgresSchema.sql`, `middleware`, `routes`, `services`, `docker-compose.yml`, `docker/`, `.github/workflows/`)

---

## 1. TỔNG QUAN & PHẠM VI KIỂM TOÁN

Báo cáo này đánh giá hiện trạng an toàn thông tin của nền tảng Video AI trước khi triển khai quy trình làm cứng bảo mật 20 hạng mục (Security Hardening).

### Tiêu chuẩn đối chiếu:
- **OWASP Top 10 2021** (A01 đến A10)
- **OWASP API Security Top 10 2023** (API1 đến API10)
- **CWE / SANS Top 25 Most Dangerous Software Weaknesses**
- **CIS Docker Benchmark v1.6.0**

### Tổng hợp định lượng lỗ hổng phát hiện:
| Mức độ nghiêm trọng (Severity) | Số lượng phát hiện | Trạng thái |
|---|---|---|
| **CRITICAL (P0)** | 5 | Cần xử lý khẩn cấp trước khi public / release |
| **HIGH (P1)** | 11 | Cần xử lý trong chu kỳ hardening chuẩn |
| **MEDIUM (P2)** | 8 | Cần cải tiến kiến trúc và refactor an toàn |
| **LOW (P3)** | 4 | Tối ưu hóa phòng thủ chiều sâu |
| **INFORMATIONAL (P4)** | 3 | Khuyến nghị vận hành & tài liệu |
| **TỔNG CỘNG** | **31** | **Bao quát toàn diện 20 hạng mục** |

---

## 2. BẢNG TỔNG HỢP CÁC LỖ HỔNG THEO DANH MỤC

| Mã ID | Hạng mục / Lỗ hổng | Severity | OWASP / CWE | File & Vị trí chính |
|---|---|---|---|---|
| **SEC-01** | Mật khẩu Database mặc định được hardcode trong code & compose | **CRITICAL** | CWE-798 / A07:2021 | `backend/src/db.js:29`, `docker-compose.yml:25`, `ci.yml:19` |
| **SEC-02** | PostgreSQL & API ports bind `0.0.0.0` lộ ra mạng công cộng | **CRITICAL** | CWE-668 / A05:2021 | `docker-compose.yml:21,41,101` |
| **SEC-03** | Lộ Timing / User Enumeration trong luồng đăng nhập (Short-circuit bcrypt) | **HIGH** | CWE-208 / API2:2023 | `backend/src/routes/v1/auth.js:407-412` |
| **SEC-04** | Cho phép đăng ký trực tiếp không cần xác thực OTP email | **HIGH** | CWE-306 / API6:2023 | `backend/src/routes/v1/auth.js:167-178` |
| **SEC-05** | Thiếu chuẩn hóa Canonical Email (Bypass rate limit & email alias spam) | **HIGH** | CWE-20 / API8:2023 | `backend/src/routes/v1/auth.js:161,211,291` |
| **SEC-06** | Không kiểm tra độ dài tối thiểu và tối đa 72-byte của mật khẩu khi register | **HIGH** | CWE-521 / A07:2021 | `backend/src/routes/v1/auth.js:157-180` |
| **SEC-07** | IDOR / Object Existence Oracle: trả về `403 Forbidden` thay vì `404` | **HIGH** | CWE-639 / API1:2023 | `backend/src/middleware/projectAccess.js:18,30`, `projects.js:465,1259` |
| **SEC-08** | CSRF bypass khi request không có header `Origin` & `Referer` | **HIGH** | CWE-352 / A01:2021 | `backend/src/middleware/cookieCsrf.js:14` |
| **SEC-09** | Cookie Refresh Token dùng `SameSite=Lax` & tồn tại fallback đọc body/header | **HIGH** | CWE-384 / API2:2023 | `backend/src/routes/v1/auth.js:57,70-76` |
| **SEC-10** | Lộ chi tiết lỗi cơ sở dữ liệu (`lastSaveError`) qua public endpoint `/health` & `/ready` | **HIGH** | CWE-209 / API3:2023 | `backend/server.js:103,129` |
| **SEC-11** | Thiếu toàn bộ Security Headers (CSP, HSTS, X-Frame-Options, Helmet) ở Express & Nginx | **HIGH** | CWE-693 / A05:2021 | `backend/server.js`, `docker/nginx.conf` |
| **SEC-12** | Chưa có HTTPS Enforcement / SSL Redirect và HSTS Policy | **HIGH** | CWE-319 / A02:2021 | `backend/server.js`, `docker/nginx.conf`, `docker-compose.yml` |
| **SEC-13** | Docker Container API chạy với quyền `root` (Chưa có unprivileged user) | **HIGH** | CWE-250 / CIS 4.1 | `docker/api.Dockerfile:14-16` |
| **SEC-14** | Lỗ hổng Critical & High trong dependencies (`proxy-addr`, `form-data`, `nodemailer`, `dompurify`, `axios`) | **CRITICAL** | CWE-1395 / A06:2021 | `backend/package.json`, `frontend/package.json` |
| **SEC-15** | CI Workflow thiếu hoàn toàn bước quét bảo mật (SAST, Secret Scan, Dependency Audit) | **HIGH** | CWE-1188 / A08:2021 | `.github/workflows/ci.yml` |
| **SEC-16** | Hàm `decrypt` trả về plaintext thô khi payload sai định dạng (Fail-open) | **MEDIUM** | CWE-755 / A04:2021 | `backend/src/lib/crypto.js:34` |
| **SEC-17** | Chưa áp dụng PostgreSQL Row-Level Security (RLS) để cô lập dữ liệu người dùng | **MEDIUM** | CWE-284 / API1:2023 | `backend/src/db/postgresSchema.sql` |
| **SEC-18** | Thiếu xác thực dịch vụ nội bộ (Internal Service Token / HMAC) giữa API và Workers | **MEDIUM** | CWE-306 / API2:2023 | `backend/src/config.js:133-169`, `docker-compose.yml:98-112` |
| **SEC-19** | Mass Assignment nguy cơ cao tại `PUT /admin/users/:id` và `POST /projects` | **MEDIUM** | CWE-915 / API3:2023 | `backend/src/routes/v1/admin.js:27-31`, `projects.js:197-207` |
| **SEC-20** | Admin duy nhất có thể tự hạ quyền chính mình thành `user` gây mất quyền quản trị | **MEDIUM** | CWE-269 / A01:2021 | `backend/src/routes/v1/admin.js:26-33` |
| **SEC-21** | Rate limiting chỉ lưu in-memory `Map` (Mất khi restart, không đồng bộ cluster) | **MEDIUM** | CWE-770 / API4:2023 | `backend/src/routes/v1/auth.js:80-91` |
| **SEC-22** | Các endpoint tốn nhiều tài nguyên AI/FFmpeg chưa được giới hạn Rate Limit | **MEDIUM** | CWE-400 / API4:2023 | `backend/src/routes/v1/projects.js`, `confirmPreview.js`, `composerAssets.js` |
| **SEC-23** | Câu lệnh SQL trong `providers.js` sử dụng cú pháp SQLite gây lỗi ngầm | **MEDIUM** | CWE-754 / A05:2021 | `backend/src/routes/v1/providers.js:24` |
| **SEC-24** | Nối chuỗi tên bảng nội bộ trong DDL / helper schema (`query.js`) | **LOW** | CWE-89 / A03:2021 | `backend/src/db/query.js:74,84,91,188,200` |
| **SEC-25** | Thiếu CSP chống XSS khi render biểu đồ (`dangerouslySetInnerHTML`) | **LOW** | CWE-79 / A03:2021 | `frontend/src/components/ui/chart.jsx:61` |
| **SEC-26** | Chưa có giới hạn hạn ngạch tổng dung lượng lưu trữ (Storage Quota) cho từng user | **LOW** | CWE-770 / API4:2023 | `backend/src/routes/v1/upload.js`, `composerAssets.js` |
| **SEC-27** | Header `X-Powered-By: Express` làm lộ thông tin framework | **LOW** | CWE-200 / A05:2021 | `backend/server.js:28` |
| **SEC-28** | Server tokens của Nginx chưa được tắt (`server_tokens off;`) | **INFO** | CWE-200 / A05:2021 | `docker/nginx.conf` |
| **SEC-29** | Thiếu file cấu hình Dependabot cho kho mã nguồn | **INFO** | CWE-1188 / A08:2021 | `.github/dependabot.yml` |
| **SEC-30** | Cơ chế sinh mã OTP và token reset dùng chung cấu hình dev in ra response | **INFO** | CWE-489 / A05:2021 | `backend/src/config.js:179-180`, `emailService.js:97` |
| **SEC-31** | Redis chưa đặt mật khẩu truy cập nội bộ (`requirepass`) | **MEDIUM** | CWE-306 / A07:2021 | `docker-compose.yml:3-14` |

---

## 3. PHÂN TÍCH CHI TIẾT CÁC LỖ HỔNG TRỌNG YẾU

### 3.1. Nhóm Xác thực & Quản lý Phiên (Authentication & Session Management)

#### SEC-03: Lỗ hổng Timing Attack / User Enumeration trong luồng Login (Severity: HIGH)
- **Vị trí:** `backend/src/routes/v1/auth.js#L407-L412`
- **Mã nguồn hiện tại:**
  ```javascript
  const user = await queryOne(`SELECT * FROM users WHERE email = ?`, [normalizedEmail])
  if (!user || !(await bcrypt.compare(password, user.password))) {
    recordRateLimitHit(loginFailHitsByIp, String(ip), 15 * 60 * 1000, now)
    recordRateLimitHit(loginFailHitsByEmail, normalizedEmail, 15 * 60 * 1000, now)
    return sendError(res, 401, 'INVALID_CREDENTIALS', 'Invalid email or password')
  }
  ```
- **Cơ chế rủi ro:** Phép so sánh ngắn mạch (`!user || ...`) khiến trường hợp email không tồn tại trả về kết quả sau ~1-2ms, trong khi trường hợp email tồn tại phải chạy `bcrypt.compare` mất ~80-100ms. Kẻ tấn công có thể đo thời gian phản hồi (timing attack) để dò quét toàn bộ danh sách email người dùng đã đăng ký.
- **Giải pháp:** Khi `!user`, hệ thống phải thực hiện một phép tính `bcrypt.compare` giả lập với một hash BCrypt cố định (precomputed dummy hash) để đảm bảo thời gian xử lý đồng nhất bất kể email có tồn tại hay không.

#### SEC-04: Cho phép đăng ký trực tiếp không bắt buộc xác thực OTP Email (Severity: HIGH)
- **Vị trí:** `backend/src/routes/v1/auth.js#L149-L198`
- **Cơ chế rủi ro:** API cung cấp endpoint đăng ký `/register` chấp nhận request không có `otp`, chỉ gán `email_verified: false` nhưng vẫn tạo tài khoản, cấp `accessToken` và `refreshToken` đầy đủ quyền. Điều này tạo điều kiện cho bot tự động tạo hàng triệu tài khoản rác spam hệ thống mà không cần sở hữu email thật.
- **Giải pháp:** Bắt buộc luồng đăng ký phải đi qua xác thực OTP (`POST /register/send-otp` -> `POST /register/verify-otp`), hoặc `/register` chỉ kích hoạt tài khoản khi có OTP hợp lệ.

#### SEC-05: Thiếu chuẩn hóa Email Alias Canonical (Severity: HIGH)
- **Vị trí:** `backend/src/routes/v1/auth.js#L161, L211, L291`
- **Cơ chế rủi ro:** Email chỉ được `trim().toLowerCase()`. Người dùng có thể đăng ký vô hạn tài khoản với các biến thể Gmail: `user+1@gmail.com`, `user+2@gmail.com`, hoặc `u.s.e.r@gmail.com` trỏ về cùng một hòm thư Gmail, qua mặt rate limit và quota người dùng mới.
- **Giải pháp:** Thêm tiện ích `normalizeCanonicalEmail`: với `@gmail.com` và `@googlemail.com`, loại bỏ dấu chấm `.` và phần đuôi `+tag`; với các domain khác, loại bỏ `+tag`. Lưu cột `email_canonical` với chỉ mục `UNIQUE`.

#### SEC-06: Thiếu chính sách mật khẩu và giới hạn 72-byte của BCrypt (Severity: HIGH)
- **Vị trí:** `backend/src/routes/v1/auth.js#L157-L180`
- **Cơ chế rủi ro:**
  1. Trong endpoint `/register`, mật khẩu không được kiểm tra độ dài tối thiểu (cho phép mật khẩu 1 ký tự).
  2. Mật khẩu không có giới hạn độ dài tối đa: Thuật toán BCrypt chỉ xử lý tối đa 72 bytes. Các ký tự vượt quá 72 bytes bị cắt cụt âm thầm mà người dùng không biết, hoặc nếu kẻ tấn công gửi chuỗi mật khẩu 1MB sẽ gây nghẽn CPU (ReDoS / CPU Exhaustion DoS).
- **Giải pháp:** Enforce Password Policy: Tối thiểu 8 ký tự, tối đa 72 bytes, yêu cầu chữ hoa, chữ thường, chữ số; từ chối mật khẩu nằm trong danh sách phổ biến.

#### SEC-08 & SEC-09: Bảo mật Cookie & CSRF Middleware Bypass (Severity: HIGH)
- **Vị trí:** `backend/src/middleware/cookieCsrf.js#L14`, `backend/src/routes/v1/auth.js#L56-L76`
- **Cơ chế rủi ro:**
  1. `cookieCsrf.js` có đoạn mã: `if (!origin && !referer) return next()`. Kẻ tấn công trên trang web độc hại có thể kích hoạt gửi request không kèm `Referer` (ví dụ thông qua `<meta name="referrer" content="no-referrer">`), qua mặt lớp bảo vệ CSRF.
  2. `refresh_token` cookie được cấu hình `sameSite: 'lax'` thay vì `sameSite: 'strict'`.
  3. `readRefreshToken` vẫn chấp nhận đọc refresh token từ `req.body.refreshToken` và header `x-refresh-token`, mở rộng bề mặt tấn công.
- **Giải pháp:**
  - Cấu hình cookie `SameSite=Strict; HttpOnly; Secure; Path=/api/v1/auth`.
  - Từ chối các request thay đổi trạng thái có mang cookie nếu thiếu cả `Origin` và `Referer` khi kiểm tra CSRF.
  - Loại bỏ các fallback không an toàn từ body/header cho browser client.

---

### 3.2. Nhóm Cơ sở dữ liệu & Phân quyền Truy cập (Database & Access Control)

#### SEC-01: Mật khẩu mặc định Database được hardcode (Severity: CRITICAL)
- **Vị trí:** `backend/src/db.js#L29`, `docker-compose.yml#L25`, `.github/workflows/ci.yml#L19`
- **Chi tiết:** Mật khẩu `VideoAI_Secure_Db_2026!` xuất hiện dạng mặc định trực tiếp trong mã nguồn và file cấu hình commit. Nếu người triển khai quên cấu hình `DB_PASSWORD` trong production, hệ thống sẽ chạy với mật khẩu mặc định đã bị lộ này.
- **Giải pháp:**
  - Bổ sung `SecretsStartupValidator`: Trong môi trường production hoặc khi cờ `STRICT_SECRETS=true`, ứng dụng từ chối khởi động nếu `DB_PASSWORD` trùng với giá trị mặc định hoặc độ dài < 16 ký tự.
  - Loại bỏ chuỗi mật khẩu khỏi các file mẫu công khai.

#### SEC-02: Các port dữ liệu và dịch vụ Bind `0.0.0.0` (Severity: CRITICAL)
- **Vị trí:** `docker-compose.yml#L21, L41, L101`
- **Chi tiết:**
  - `postgres`: ports `"${POSTGRES_PORT:-5433}:5432"` bind toàn bộ interface `0.0.0.0`.
  - `api`: ports `"3001:3001"` bind `0.0.0.0`.
  - `voicestudio`: ports `"3900:3900"` bind `0.0.0.0` mà không hề có lớp bảo vệ xác thực nào.
- **Giải pháp:**
  - Chuyển toàn bộ port bind về `127.0.0.1` (`127.0.0.1:${POSTGRES_PORT:-5433}:5432`, `127.0.0.1:3001:3001`, `127.0.0.1:3900:3900`).
  - Trong production, các container nội bộ (postgres, redis, voicestudio, api) chỉ giao tiếp qua mạng bridge nội bộ Docker, chỉ có `web` (nginx :80/:443) được expose ra ngoài.

#### SEC-07: IDOR / Object Existence Oracle Leaking 403 Forbidden (Severity: HIGH)
- **Vị trí:** `backend/src/middleware/projectAccess.js#L18, L30`, `backend/src/routes/v1/projects.js#L465, L1259`, `outputs.js#L95`
- **Chi tiết:** Khi người dùng truy cập một tài nguyên (project, output) thuộc về người khác, API kiểm tra:
  ```javascript
  if (project.user_id !== req.user.id && req.user.role !== 'admin') {
    return sendError(res, 403, ERR.AUTH_FORBIDDEN, 'Forbidden')
  }
  ```
  Việc trả về `403 Forbidden` thay vì `404 Not Found` xác nhận cho kẻ tấn công biết rằng tài nguyên có ID đó thực sự tồn tại trong hệ thống, cho phép enumeration quét ID tài nguyên của các khách hàng khác.
- **Giải pháp:** Trả về `404 Not Found` thống nhất khi tài nguyên không thuộc sở hữu của người dùng hiện tại (trừ admin), che giấu hoàn toàn sự tồn tại của record.

#### SEC-16: Hàm `decrypt` trả về plaintext thô khi payload sai định dạng (Severity: MEDIUM)
- **Vị trí:** `backend/src/lib/crypto.js#L34`
- **Mã nguồn:**
  ```javascript
  export function decrypt(payload) {
    if (!payload) return null
    const [ivHex, tagHex, dataHex] = payload.split(':')
    if (!ivHex || !tagHex || !dataHex) return payload
  ```
- **Cơ chế rủi ro:** Nếu payload không có định dạng `iv:tag:data`, hàm trả về chính `payload`. Đây là cơ chế fail-open nguy hiểm, có thể dẫn đến việc ứng dụng xử lý dữ liệu chưa được mã hóa mà không phát hiện ra lỗi, hoặc che giấu các key bị corrupt/tampered.
- **Giải pháp:** Ném lỗi `CryptoDecryptionError` hoặc trả về `null` thay vì trả về plaintext thô.

---

### 3.3. Nhóm Bảo vệ Dữ liệu & Giảm thiểu Rò rỉ (Data Protection & Minimization)

#### SEC-10: Lộ chi tiết lỗi cơ sở dữ liệu (`lastSaveError`) qua public endpoint `/health` (Severity: HIGH)
- **Vị trí:** `backend/server.js#L103, L129`
- **Mã nguồn:**
  ```javascript
  app.get('/health', async (req, res) => {
    ...
    database: {
      ...persistence,
      lastSaveError: health.lastSaveError, // Lộ chi tiết lỗi nội bộ
    }
  ```
- **Rủi ro:** Khi database gặp lỗi kết nối, chuỗi lỗi (bao gồm IP, port, tên người dùng, stack trace, chi tiết truy vấn) sẽ được hiển thị công khai cho bất kỳ ai gọi `GET /health` hoặc `GET /ready` mà không cần đăng nhập.
- **Giải pháp:** Ẩn `lastSaveError` khỏi response công khai; chỉ ghi log nội bộ hoặc chỉ trả cờ boolean `hasError: true/false`.

#### SEC-11 & SEC-12: Thiếu Security Headers và HTTPS Enforcement (Severity: HIGH)
- **Vị trí:** `backend/server.js`, `docker/nginx.conf`
- **Rủi ro:**
  1. Thiếu thư viện `helmet`: API không có `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security`.
  2. Nginx không có cấu hình TLS/HTTPS redirect (`REQUIRE_HTTPS`), toàn bộ lưu lượng có thể bị nghe lén (Sniffing / Man-in-the-Middle) trên đường truyền.
  3. Header `X-Powered-By: Express` tiết lộ thông tin công nghệ cho kẻ tấn công thu thập fingerprint.
- **Giải pháp:**
  - Tích hợp `helmet` và middleware bảo mật headers cho Express.
  - Tắt `app.disable('x-powered-by')`.
  - Cấu hình Nginx với bộ header chuẩn ngân hàng/doanh nghiệp và HTTP->HTTPS redirect.

---

### 3.4. Nhóm Cơ sở hạ tầng & DevSecOps (Infrastructure & Dependencies)

#### SEC-13: Docker Container chạy dưới quyền `root` (Severity: HIGH)
- **Vị trí:** `docker/api.Dockerfile`
- **Rủi ro:** Image Docker `api.Dockerfile` chạy `CMD ["node", "server.js"]` dưới tài khoản mặc định `root` của container. Nếu ứng dụng có lỗ hổng thực thi mã từ xa (RCE) thông qua xử lý video FFmpeg hoặc thư viện bên ngoài, kẻ tấn công sẽ có quyền root ngay trong container và dễ dàng tìm cách thoát sandbox (container escape).
- **Giải pháp:** Thêm chỉ thị `USER node` sau khi cài đặt các phụ thuộc hệ thống.

#### SEC-14: Lỗ hổng bảo mật trong các thư viện phụ thuộc (Severity: CRITICAL)
- **Vị trí:** `backend/package.json` và `frontend/package.json`
- **Chi tiết kiểm toán:**
  - **Backend:** 12 vulnerabilities (3 Critical, 3 High).
    - `proxy-addr` (Critical - CVE GHSA-jqcg-44mw-7w3h): Cho phép IP spoofing, qua mặt hệ thống rate-limiting dựa trên IP.
    - `form-data` (Critical - GHSA-fjxv-7rqg-78g4 & GHSA-hmw2-7cc7-3qxx): CRLF injection trong multipart upload.
    - `nodemailer` (High - 12 CVEs): DoS, credential disclosure, stack exhaustion.
    - `body-parser` (High): DoS trailing bytes sau compressed body.
    - `multer` (High): DoS pending fileFilter.
  - **Frontend:** 28 vulnerabilities (1 Critical, 19 High).
    - `dompurify` (Critical - GHSA-55q2-fjhq-7xh7): Lỗ hổng bypass XSS nghiêm trọng.
    - `axios` (High - 12 CVEs): Prototype pollution, SSRF bypass qua `maxRedirects`, ReDoS.
- **Giải pháp:** Nâng cấp các dependencies, thay thế các thư viện đã deprecated (loại bỏ `gtts`/`request` cũ, nâng cấp `nodemailer`, `axios`, `dompurify`).

#### SEC-15: Thiếu quy trình quét an toàn tự động trên CI/CD (Severity: HIGH)
- **Vị trí:** `.github/workflows/ci.yml`
- **Rủi ro:** Workflow CI hiện tại chỉ chạy `npm run lint` và `npm test`. Không có bước kiểm tra tự động nào để ngăn chặn lập trình viên commit API key thật (`gitleaks`), không có quét lỗ hổng phụ thuộc định kỳ (`npm audit`), không quét container (`trivy`).
- **Giải pháp:** Thiết lập workflow `.github/workflows/security.yml` chạy trên mỗi Push/PR và định kỳ hàng tuần.

---

## 4. MA TRẬN 20 HẠNG MỤC BẢO MẬT & CHIẾN LƯỢC TRIỂN KHAI

Để đảm bảo quy trình làm cứng bảo mật diễn ra trật tự, không xung đột và không phá vỡ bất kỳ tính năng nghiệp vụ nào (Zero Breaking Changes), 20 hạng mục sẽ được thực thi theo thứ tự tuần tự tuyệt đối:
**MỘT TASK -> TRIỂN KHAI -> VIẾT TEST -> REVIEW ĐỘC LẬP -> ĐẠT (PASS) -> CHUYỂN TASK TIẾP THEO.**

| Task # | Tên hạng mục | Mục tiêu chính & Tiêu chí nghiệm thu | Kỹ sư thực hiện | QA & Reviewer |
|---|---|---|---|---|
| **TASK 1** | Ẩn & bảo vệ API Key / Secrets | Bắt buộc `STRICT_SECRETS`, cấm fallback mật khẩu mặc định DB trong prod, mã hóa BYOK. | `sec_engineer` | `sec_qa` |
| **TASK 2** | Git Secrets & Push Protection | Quét sạch lịch sử git bằng gitleaks, thiết lập `.gitleaks.toml`, chặn commit key. | `sec_engineer` | `sec_qa` |
| **TASK 3** | Bảo mật Database | Bind `127.0.0.1`, đặt mật khẩu Redis `requirepass`, chuẩn bị phân quyền role DB. | `sec_engineer` | `sec_qa` |
| **TASK 4** | Row-Level Security / Tenant Isolation | Cô lập tenant tầng service 100%, chuẩn bị kiến trúc RLS cho PostgreSQL. | `sec_engineer` | `sec_qa` |
| **TASK 5** | Mã hoá Dữ liệu | Fix hàm `decrypt` fail-safe, đảm bảo mã hóa AES-256-GCM toàn bộ sensitive tokens. | `sec_engineer` | `sec_qa` |
| **TASK 6** | Kiểm tra & Chuẩn hoá Input | Chuẩn hóa `email_canonical` (chống alias), validate độ dài mật khẩu và avatar. | `sec_engineer` | `sec_qa` |
| **TASK 7** | Xác thực Server Nội bộ | Thêm `X-Internal-Token` / HMAC cho các dịch vụ nội bộ (ZeroTTS, VoiceStudio, worker). | `sec_engineer` | `sec_qa` |
| **TASK 8** | Khoá quyền truy cập Record | IDOR prevention: trả về chuẩn `404 Not Found` trên mọi endpoints (che giấu existence). | `sec_engineer` | `sec_qa` |
| **TASK 9** | Chặn Mass Assignment | Whitelist parameters nghiêm ngặt cho toàn bộ API body (User role, settings, project). | `sec_engineer` | `sec_qa` |
| **TASK 10** | Bảo mật Cookie & CSRF | Cookie `SameSite=Strict; HttpOnly; Secure`, fix CSRF origin check, bỏ fallback body/header. | `sec_engineer` | `sec_qa` |
| **TASK 11** | Băm Password & Password Policy | Giới hạn 72-byte cho BCrypt, yêu cầu độ phức tạp, chống DoS password dài. | `sec_engineer` | `sec_qa` |
| **TASK 12** | Giới hạn Đăng nhập & Chống Timing Attack | Dummy BCrypt compare khi user không tồn tại, chống user enumeration. | `sec_engineer` | `sec_qa` |
| **TASK 13** | Chặn Bot & Rate Limiting | Rate limiting phân tầng (Global, Auth, Pipeline Heavy), bắt buộc OTP khi đăng ký. | `sec_engineer` | `sec_qa` |
| **TASK 14** | Tham số hoá Query & Chống SQLi | Khử hoàn toàn template literal trong DDL/query, sửa câu lệnh SQLite cũ trong `providers.js`. | `sec_engineer` | `sec_qa` |
| **TASK 15** | Escape Nội dung & Chống XSS | Đảm bảo output encoding, thiết lập CSP header chặt chẽ ngăn chặn XSS. | `sec_engineer` | `sec_qa` |
| **TASK 16** | Giới hạn File Upload | Kiểm tra magic bytes, chặn path traversal, giới hạn kích thước file và MIME chuẩn. | `sec_engineer` | `sec_qa` |
| **TASK 17** | Giảm Dữ liệu Trả về | Ẩn `lastSaveError` khỏi `/health`, che giấu stacktrace của lỗi 500 với correlation ID. | `sec_engineer` | `sec_qa` |
| **TASK 18** | Security Headers | Cài đặt `helmet`, tắt `x-powered-by`, cấu hình headers chuẩn OWASP trên Nginx. | `sec_engineer` | `sec_qa` |
| **TASK 19** | Bắt buộc HTTPS | Middleware ép buộc HTTPS, header HSTS max-age 1 năm, Nginx 301 redirect. | `sec_engineer` | `sec_qa` |
| **TASK 20** | Quét Dependencies & DevSecOps | Vá các CVE High/Critical của npm, tạo `security.yml` và `dependabot.yml`. | `sec_engineer` | `sec_qa` |

---

## 5. KẾ HOẠCH BÀN GIAO & ĐIỀU PHỐI

1. Báo cáo này chính thức thiết lập đường cơ sở bảo mật (Security Baseline) cho toàn bộ dự án.
2. File ma trận tiến độ `docs/security/SECURITY_HARDENING_PROGRESS.md` được khởi tạo đồng thời để giám sát 20 tasks.
3. Kỹ sư backend (`sec_engineer`) và kiểm thử viên độc lập (`sec_qa`) sẽ phối hợp thực hiện theo đúng hợp đồng bàn giao.

*Ký duyệt bởi:*  
**Lead Security Architect & Auditor**  
`@sec_architect`
