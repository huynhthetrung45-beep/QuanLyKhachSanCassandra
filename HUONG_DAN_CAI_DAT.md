# Hướng dẫn cài đặt và chạy ChatOTT (máy mới, lấy mã từ Git)

Tài liệu này dành cho người **chưa từng chạy ChatOTT**: clone mã nguồn về, Cassandra còn trống, và muốn mở được giao diện hiện tại với dữ liệu mẫu.
Nếu máy bạn đã có dữ liệu từ bản cũ, xem mục 5. **Không** chạy `db:init` hay `seed` trên máy đó.

---

## 1. Cần cài trước

| Phần mềm | Phiên bản | Ghi chú |
|---|---|---|
| Docker Desktop | mới | Chạy Cassandra 4.1 trong container `chatott-cassandra` |
| Node.js | **20.19+** hoặc **22.12+** | Vite 8 không chạy trên Node 20.0–20.18. Kiểm tra: `node -v` |
| Git | bất kỳ | |

Máy cần khoảng 3 GB RAM trống cho Cassandra. Cổng **9042** (Cassandra), **3000** (backend) và **5173** (frontend) phải còn trống.

Các lệnh bên dưới dùng **CMD trên Windows**. Trên macOS/Linux, thay `copy` bằng `cp` và `set "X=..."` bằng `export X=...`.

---

## 2. Cài đặt lần đầu (làm một lần)

```bat
:: 1) Lấy mã nguồn
git clone <địa-chỉ-repo> ChatOTT
cd ChatOTT

:: 2) Bật Cassandra
docker compose up -d
```

Chờ tới khi cột STATUS hiện **`(healthy)`**. Lần đầu mất khoảng 1–2 phút, vì Docker còn phải tải image.

```bat
docker ps --filter name=chatott-cassandra
```

```bat
:: 3) Cài thư viện (backend ở thư mục gốc, frontend riêng)
npm install
cd frontend
npm install
cd ..

:: 4) Tạo file cấu hình từ mẫu (giữ nguyên giá trị mặc định là chạy được)
copy backend\.env.example backend\.env

:: 5) Tạo CSDL: keyspace chat_ott, toàn bộ bảng trong schema.cql, 8 hồ sơ người dùng mẫu
npm run db:init

:: 6) Nạp hội thoại + khoảng 470 tin nhắn mẫu, rồi dựng các bảng chỉ mục từ dữ liệu đó
npm run seed
npm run migrate

:: 7) Tạo tài khoản đăng nhập cho 8 người dùng mẫu (tự chọn mật khẩu, mật khẩu không được ghi vào file nào)
set "DEMO_PASSWORD=MatKhauCuaBan123"
npm run seed:accounts

:: 8) Kiểm tra nhanh (chỉ đọc)
npm run check:db
```

Kết quả mong đợi ở từng bước:
- `db:init`: "Đã tạo keyspace chat_ott và 40 bảng…" và "Đã thêm 8 hồ sơ người dùng mẫu".
- `migrate`: kết thúc không có `[LỖI]`. Chạy lại lần hai sẽ không còn gì để ghi.
- `seed:accounts`: liệt kê 8 email đã tạo.

---

## 3. Chạy ứng dụng (mỗi lần dùng)

Mở **hai** cửa sổ CMD tại thư mục `ChatOTT`:

```bat
:: Cửa sổ 1 — backend (cổng 3000). Chờ dòng "Backend đang chạy tại http://localhost:3000"
npm run dev
```

```bat
:: Cửa sổ 2 — frontend (cổng 5173)
cd frontend
npm run dev
```

Mở trình duyệt tại **http://localhost:5173**.

Nếu Docker Desktop vừa khởi động lại máy, hãy chạy `docker compose up -d` và chờ `(healthy)` trước khi chạy backend.

---

## 4. Đăng nhập và thử nhanh

Mật khẩu của mọi tài khoản demo là giá trị `DEMO_PASSWORD` đã đặt ở bước 7.

| Email | Người dùng |
|---|---|
| an@chatott.demo | Nguyễn An |
| binh@chatott.demo | Trần Bình |
| chi@chatott.demo | Lê Chi |
| dung@chatott.demo | Phạm Dũng |
| giang@chatott.demo | Hoàng Giang |
| huy@chatott.demo | Vũ Huy |
| linh@chatott.demo | Đặng Linh |
| minh@chatott.demo | Bùi Minh |

Để thấy cập nhật realtime, dùng hai trình duyệt: một cửa sổ thường đăng nhập `an@…`, một cửa sổ ẩn danh đăng nhập `binh@…`.

1. **Chat:** mở "Nhóm Đồ án NoSQL" và gửi tin. Bên kia nhận ngay. Cuộn lên để tải lịch sử cũ, mỗi lần 20 tin.
2. **Tìm trong cuộc trò chuyện:** bấm kính lúp trên tiêu đề, gõ một từ, rồi bấm kết quả. Khung chat nhảy tới đúng tin và tô sáng tin đó.
3. **Ghim tin nhắn:** chuột phải một tin và chọn **Ghim tin nhắn**. Thanh ghim hiện ở cả hai bên. Nút **+N ghim** mở danh sách các tin đã ghim.
4. **Bảng tin:** vào biểu tượng Bảng tin, đăng bài Công khai, thả cảm xúc. Bấm vào số cảm xúc để xem ai đã bày tỏ. Dưới bình luận có nút **Trả lời**.
5. **Bạn bè và thông báo:** gửi lời mời kết bạn từ trang cá nhân; bên kia thấy chuông thông báo.

Có thể tự đăng ký tài khoản mới ở màn hình đăng nhập. Tài khoản mới chưa có hội thoại nào; hãy kết bạn hoặc nhắn tin với người dùng mẫu.

**Tab AI** cần khóa API riêng: đặt `ANTHROPIC_API_KEY` trong `backend\.env`. Không đặt thì tab AI báo "chưa cấu hình", các chức năng khác vẫn chạy bình thường.

---

## 5. Máy đã có dữ liệu từ bản cũ (cập nhật lên bản mới)

```bat
git pull
npm install
cd frontend
npm install
cd ..
:: dừng backend (Ctrl+C ở cửa sổ npm run dev) rồi chạy:
npm run deploy:migration
```

Lệnh này áp dụng các migration còn thiếu (`db/migrations/001` → `008`) và chỉ **thêm** bảng/cột, không xóa dữ liệu.
Trước khi ghi, lệnh kiểm tra và yêu cầu gõ `MIGRATE` để xác nhận. Xong thì chạy lại backend như mục 3.

`npm run db:init` cũng an toàn nếu lỡ chạy trên máy này: khi keyspace đã có bảng, lệnh **không ghi gì** và chỉ nhắc dùng `migrate`.

---

## 6. Gặp lỗi thì làm gì

| Hiện tượng | Cách xử lý |
|---|---|
| Vite báo `http proxy error: /api/v1/... ECONNREFUSED` | Backend chưa chạy hoặc đã dừng. Xem cửa sổ 1 (`npm run dev`) |
| Backend báo `Schema chưa đủ, thiếu: …` rồi thoát | Máy mới: làm lại bước 5–6. Máy cũ: `npm run deploy:migration` |
| `migrate` báo `Keyspace chat_ott không tồn tại` | Chưa chạy `npm run db:init` |
| `seed` báo thiếu người dùng trong bảng users | Chạy `npm run db:init` trước `seed` |
| `NoHostAvailableError` / `All host(s) tried` | Cassandra chưa sẵn sàng. Chờ `(healthy)` trong `docker ps` |
| `seed:accounts` báo thiếu `DEMO_PASSWORD` | Chạy `set "DEMO_PASSWORD=..."` trong **cùng** cửa sổ CMD rồi chạy lại |
| Đăng nhập demo báo sai mật khẩu | Lệnh `seed:accounts` không đổi mật khẩu của tài khoản đã có. Dùng đúng mật khẩu lần đầu, hoặc tự đăng ký tài khoản mới |
| Vite báo cần Node 20.19+ | Nâng cấp Node.js |
| Cổng 3000 / 5173 / 9042 đang bị dùng | Tắt chương trình đang chiếm cổng, hoặc đổi `PORT` trong `backend\.env` |

---

## 7. Những gì không có trong Git

Các mục sau không nằm trong Git, nên người clone sẽ không có:
- `backend\.env`: mỗi máy tự tạo ở bước 4.
- Dữ liệu Cassandra: nằm trong volume Docker. Máy mới bắt đầu từ dữ liệu mẫu ở bước 5–7, **không** có tin nhắn, bài viết hay tài khoản bạn tự tạo trên máy khác.
- Tệp đính kèm và ảnh bài viết đã tải lên: nằm ở `storage\`.
- `node_modules`, `logs`, `_backup`.

Muốn mang cả dữ liệu thật sang máy khác thì dùng `backend\scripts\backup-cassandra.cmd`, chép thư mục `storage\`, rồi khôi phục bằng `COPY … FROM` như mô tả trong README.
