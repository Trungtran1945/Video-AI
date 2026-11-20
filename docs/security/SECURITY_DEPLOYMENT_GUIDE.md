# HƯỚNG DẪN TRIỂN KHAI HỆ THỐNG AN TOÀN (SECURE DEPLOYMENT GUIDE)
## (PRODUCTION DEPLOYMENT & SECURITY RUNBOOK)
**Dự án:** Video AI Platform  
**Tiêu chuẩn bảo mật:** OWASP ASVS 4.0 Level 2  
**Nhánh Git:** `security/hardening`  
**Đối tượng áp dụng:** DevSecOps Engineers, SysAdmins, Lead Architect & Security Operators  

---

## I. TỔNG QUAN KIẾN TRÚC TRIỂN KHAI (ARCHITECTURE OVERVIEW)

Hệ thống Video AI Platform được thiết kế để triển khai sản xuất an toàn theo mô hình phân tầng sâu (Defense-in-Depth):

```
[ Internet Traffic ]
        │
        ▼ (Port 80 HTTP -> 301 Redirect)
[ Nginx Reverse Proxy (Port 443 HTTPS) ]
  ├── TLS 1.2 / 1.3 only, Modern AEAD Ciphers
  ├── HSTS (1 year + preload + includeSubDomains)
  ├── Static Media: /storage/* (CORP: cross-origin + CORS *)
  └── SPA Frontend (Vite Static Files)
        │
        ▼ (Reverse Proxy qua Docker Internal Network)
[ Node.js Express Backend API (Port 3001) ]
  ├── User: unprivileged 'node' (Non-root container)
  ├── SecurityHeaders (nosniff, SAMEORIGIN, CSP, COOP)
  ├── RateLimiter & Bot Protection (Sliding window + Turnstile)
  ├── ResponseSanitizer (Tự động lọc DTO nhạy cảm)
  └── Error Masking (Lỗi 500 ẩn stack trace, gắn errorId)
        │
        ├──► [ Redis 7+ Cache & Queue (Port 6379, bind 127.0.0.1, requirepass) ]
        │
        └──► [ PostgreSQL 16+ Database (Port 5433, bind 127.0.0.1, RLS Enabled) ]
```

---

## II. CHECKLIST BIẾN MÔI TRƯỜNG BẮT BUỘC (ENVIRONMENT VARIABLES CHECKLIST)

Trước khi khởi động hệ thống trên máy chủ Production, quản trị viên bắt buộc phải thiết lập các biến môi trường trong tệp bí mật `backend/.env` (hoặc Secret Manager / Vault). **Tuyệt đối không sử dụng các giá trị mặc định.**

### 1. Cấu hình Môi trường & Chế độ Bảo mật Bắt buộc:
```ini
# Chế độ chạy: bắt buộc là production
NODE_ENV=production

# Cổng lắng nghe nội bộ của Backend API
PORT=3001

# Chế độ ép buộc bảo vệ Secret nghiêm ngặt (Fail-closed nếu thiếu key hoặc dùng mật khẩu mặc định)
STRICT_SECRETS=true

# Ép buộc HTTPS trên toàn hệ thống
FORCE_HTTPS=true

# Kích hoạt cờ Secure cho toàn bộ Cookie phiên (HttpOnly, SameSite=Lax, Secure)
COOKIE_SECURE=true

# Số lượng reverse proxy phía trước (1 nếu chỉ qua Nginx, 2 nếu qua Cloudflare + Nginx)
TRUST_PROXY=1

# Danh sách domain Frontend được phép truy cập (ngăn chặn CORS trái phép)
CORS_ORIGINS=https://videoai.yourdomain.com,https://api.yourdomain.com
```

### 2. Khóa Bí Mật Mã Hóa & JWT (Bắt buộc sinh ngẫu nhiên mạnh):
```ini
# Secret ký Access Token (Tối thiểu 32 bytes ngẫu nhiên)
JWT_ACCESS_SECRET=c2VjdXJlX2FjY2Vzc19zZWNyZXRfa2V5XzIwMjZfIT8kKi4=

# Secret ký Refresh Token (Tối thiểu 32 bytes ngẫu nhiên, khác với Access Secret)
JWT_REFRESH_SECRET=c2VjdXJlX3JlZnJlc2hfc2VjcmV0X2tleV8yMDI2XyE/JCou

# Master Key mã hóa AES-256-GCM cho BYOK API Keys (Chính xác 64 ký tự Hex / 32 bytes)
MASTER_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

# Danh sách Master Key cũ dùng để xoay vòng giải mã (nếu có, phân tách bằng dấu phẩy)
PREVIOUS_MASTER_KEYS=
```

### 3. Kết Nối Cơ Sở Dữ Liệu & Redis:
```ini
# Chuỗi kết nối PostgreSQL 16+ (Mật khẩu phải phức tạp > 20 ký tự, không dùng 'VideoAI_Secure_Db_2026!')
DATABASE_URL=postgresql://video_ai_user:A_Very_Strong_Random_Password_Here@127.0.0.1:5433/video_ai

# Bật kết nối SSL đến DB nếu dùng Managed Database (AWS RDS / Supabase / GCP Cloud SQL)
DATABASE_SSL=false

# Mật khẩu Redis bắt buộc
REDIS_PASSWORD=A_Strong_Redis_Secret_Password_2026!
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
```

### 4. Chặn Bot & Xác Thực Đăng Ký (Anti-Abuse):
```ini
# Bắt buộc xác thực OTP 2 bước qua email khi đăng ký tài khoản (SEC-04 / SEC-05)
REQUIRE_REGISTRATION_OTP=true

# Khóa bí mật Cloudflare Turnstile phục vụ kiểm tra bot server-side
TURNSTILE_SECRET_KEY=0x4AAAAAAAxXxXxXxXxXxXxXxXxXxXxXxXx
```

---

## III. QUY TRÌNH TẠO & XOAY VÒNG KHÓA MÃ HÓA (MASTER KEY MANAGEMENT)

### 1. Quy Trình Cấp Phát Master Key Mới (AES-256-GCM):
Để sinh một khóa mã hóa đạt chuẩn mã hóa AES-256 bit:
```bash
# Trên terminal máy chủ Linux / macOS:
openssl rand -hex 32

# Kết quả là chuỗi 64 ký tự hex (ví dụ: a8f5c3d2e1b4...9f0a), gán vào MASTER_KEY trong .env
```

### 2. Quy Trình Xoay Vòng Khóa Không Gián Đoạn (Zero-Downtime Key Rotation):
Khi có yêu cầu định kỳ đổi khóa mã hóa hoặc nghi ngờ lộ khóa:
1. Sinh một khóa mới 32-byte hex: `NEW_KEY=$(openssl rand -hex 32)`.
2. Lấy giá trị `MASTER_KEY` hiện tại chuyển vào biến `PREVIOUS_MASTER_KEYS`:
   ```ini
   PREVIOUS_MASTER_KEYS=old_key_1,old_key_2
   MASTER_KEY=new_generated_key_here
   ```
3. Khởi động lại dịch vụ Backend:
   * Tất cả dữ liệu mới sẽ được mã hóa bằng `MASTER_KEY` mới (tiền tố `v1:`).
   * Dữ liệu cũ đã lưu sẽ được giải mã an toàn thông qua danh sách `PREVIOUS_MASTER_KEYS` mà không bị gián đoạn nghiệp vụ.
4. (Tùy chọn) Chạy script di trú re-encrypt toàn bộ bản ghi sang khóa mới.

---

## IV. TRIỂN KHAI CƠ SỞ DỮ LIỆU & ROW-LEVEL SECURITY (POSTGRESQL & RLS)

### 1. Chạy Migrations và Kích Hoạt RLS:
Hệ thống tự động kích hoạt các migration khi khởi động:
- Migration `001_initial_postgres_schema`: Tạo toàn bộ cấu trúc bảng, constraints, indexes.
- Migration `002_rls_tenant_isolation`: Tự động nạp file `backend/src/db/rlsPolicies.sql`.

### 2. Kiểm Tra Trạng Thái RLS Trong PostgreSQL:
Để xác minh các bảng đã được bật RLS thành công, chạy câu lệnh sau trên `psql`:
```sql
SELECT relname, relrowsecurity, relforcerowsecurity 
FROM pg_class 
WHERE relname IN ('projects', 'settings', 'api_keys', 'assets', 'outputs', 'upload_sessions');
```
*Kết quả kỳ vọng:* Cả hai cột `relrowsecurity` và `relforcerowsecurity` đều hiển thị `true`.

---

## V. CẤU HÌNH NGINX & CHỨNG CHỈ SỐ TLS (SSL/TLS SETUP)

### 1. Cấu Hình Chứng Chỉ Số Thật (Let's Encrypt / Production Certs):
Trong tệp `docker/nginx.conf`, đường dẫn chứng chỉ mặc định là:
- File chứng chỉ (Certificate): `/etc/nginx/ssl/server.crt` (hoặc `fullchain.pem`).
- File khóa riêng (Private Key): `/etc/nginx/ssl/server.key` (hoặc `privkey.pem`).

Nếu dùng Certbot trên máy chủ Host:
```bash
sudo certbot certonly --standalone -d videoai.yourdomain.com
```
Sau đó mount thư mục `/etc/letsencrypt/live/videoai.yourdomain.com/` vào container Nginx trong `docker-compose.yml`:
```yaml
web:
  volumes:
    - /etc/letsencrypt/live/videoai.yourdomain.com/fullchain.pem:/etc/nginx/ssl/server.crt:ro
    - /etc/letsencrypt/live/videoai.yourdomain.com/privkey.pem:/etc/nginx/ssl/server.key:ro
```

### 2. Kiểm Tra Cấu Hình TLS:
Kiểm tra cấu hình Nginx trước khi reload:
```bash
docker compose exec web nginx -t
docker compose exec web nginx -s reload
```

---

## VI. QUY TRÌNH KHỞI ĐỘNG HỆ THỐNG VỚI DOCKER COMPOSE

### 1. Build & Khởi Động Các Dịch Vụ:
```bash
# 1. Build lại toàn bộ container với cờ không dùng cache cũ
docker compose build --no-cache

# 2. Khởi động hệ thống ở chế độ nền
docker compose up -d

# 3. Kiểm tra trạng thái hoạt động của các container
docker compose ps
```
*Kỳ vọng các container đều ở trạng thái `running` hoặc `healthy`:*
- `redis`: running (chỉ lắng nghe `127.0.0.1:6379`)
- `api`: running (tiến trình Node.js chạy dưới người dùng `node`)
- `web`: running (lắng nghe `80` và `443`)

### 2. Xác Minh Liveness & Readiness:
```bash
# Kiểm tra liveness
curl -k https://127.0.0.1/health

# Kiểm tra readiness (phải trả về HTTP 200)
curl -k -i https://127.0.0.1/ready
```

---

## VII. CHECKLIST KIỂM TOÁN AN NINH SAU KHI TRIỂN KHAI (POST-DEPLOYMENT AUDIT)

Sau khi hệ thống khởi động thành công, kỹ sư DevSecOps cần thực hiện checklist sau để đảm bảo không có lỗ hổng nào còn sót lại:

### 1. Kiểm Tra Chuyển Hướng HTTP sang HTTPS:
```bash
curl -I http://videoai.yourdomain.com/
```
*Kỳ vọng:* Trả về `HTTP/1.1 301 Moved Permanently` kèm tiêu đề `Location: https://videoai.yourdomain.com/`.

### 2. Kiểm Tra Tiêu Đề Bảo Mật HTTP (Security Headers):
```bash
curl -I https://videoai.yourdomain.com/api/v1/projects
```
*Kỳ vọng có đầy đủ các tiêu đề sau:*
- `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()`
- `Cross-Origin-Opener-Policy: same-origin-allow-popups`
- `Cross-Origin-Resource-Policy: same-origin`
- `Content-Security-Policy: default-src 'self' ...`
- **Tuyệt đối KHÔNG có `X-Powered-By`.**

### 3. Kiểm Tra Cache-Control Trên Endpoint Xác Thực:
```bash
curl -I https://videoai.yourdomain.com/api/v1/auth/me
```
*Kỳ vọng:* `Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate`.

### 4. Kiểm Tra Tệp Tin Tĩnh Media (CORP Cross-Origin):
```bash
curl -I https://videoai.yourdomain.com/storage/uploads/sample.mp4
```
*Kỳ vọng:* `Cross-Origin-Resource-Policy: cross-origin` và `Access-Control-Allow-Origin: *`.

### 5. Kiểm Tra Che Giấu Lỗi 500:
Gửi request gây lỗi nội bộ:
*Kỳ vọng:* Phản hồi trả về `{ "code": "INTERNAL_ERROR", "message": "Internal server error", "errorId": "uuid-..." }`, hoàn toàn không có stack trace hay câu lệnh SQL.

---

## VIII. KẾ HOẠCH ỨNG PHÓ SỰ CỐ & RÀ SỐÁT ĐỊNH KỲ (INCIDENT RESPONSE PLAYBOOK)

1. **Rò Rỉ Khóa Bí Mật (Secret Leak Incident):**
   - Ngay lập tức đổi `MASTER_KEY` theo quy trình mục III.
   - Thu hồi toàn bộ Access/Refresh Token bằng cách xóa trường `refresh_token` trong bảng `users`:
     ```sql
     UPDATE users SET refresh_token = NULL;
     ```
   - Tạo lại `JWT_ACCESS_SECRET` và `JWT_REFRESH_SECRET` mới trong `.env`, khởi động lại container backend để buộc toàn bộ người dùng đăng nhập lại.
2. **Tấn Công Brute-Force / DoS:**
   - Hệ thống Rate Limiter sẽ tự động chặn IP và Email vi phạm qua Redis.
   - Quản trị viên có thể kiểm tra danh sách IP bị giới hạn trong Redis: `redis-cli KEYS "rl:*"` hoặc tạm thời chặn IP tại tầng firewall máy chủ (UFW/iptables).
3. **Quét Lỗ Hổng Định Kỳ:**
   - Hàng tuần: Theo dõi các PR tự động từ Dependabot (`.github/dependabot.yml`).
   - Trước mỗi lần release: Chạy `cd backend && npm audit --audit-level=high` và `npm run check:secrets`.
