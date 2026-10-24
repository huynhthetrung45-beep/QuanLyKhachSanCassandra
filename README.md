# ChatOTT — Đề tài 09: Lưu trữ lịch sử tin nhắn trên Apache Cassandra

Ứng dụng chat trên máy tính (React + Vite, Node.js + Express, Apache Cassandra 4.1, Docker Compose).
Trọng tâm môn học là bảng `messages_by_conversation` và phân trang bằng **Paging State** của Cassandra driver.
Bên trên là một ứng dụng chat có đăng ký, đăng nhập, hội thoại 1-1, nhóm chat, chưa đọc, ghim và nhận tin trực tiếp.

> **Chức năng mới (PT-01 … PT-26: đổi/quên mật khẩu, 2FA, sửa tin, bình chọn, story, quản trị…)?** Xem [HUONG_DAN_CHUC_NANG_MOI.md](HUONG_DAN_CHUC_NANG_MOI.md).
>
> **Công việc & Lịch, Nhắc nhở, Họp trực tuyến (WebRTC)?** Xem [TAI_LIEU_CONG_VIEC_LICH_HOP.md](TAI_LIEU_CONG_VIEC_LICH_HOP.md).

> **Cài trên máy mới (clone từ Git, Cassandra trống)?** Làm theo [HUONG_DAN_CAI_DAT.md](HUONG_DAN_CAI_DAT.md). Mục 1 bên dưới chỉ dành cho máy đã có sẵn dữ liệu.

---

## 1. Chạy dự án trên Windows

Yêu cầu: Docker Desktop, Node.js ≥ 20. Mọi lệnh chạy trong **CMD** tại `D:\ChatOTT`.

```bat
:: 1) Cassandra (bỏ qua nếu container chatott-cassandra đang chạy)
docker compose up -d
docker ps --filter name=chatott-cassandra

:: 2) Cài thư viện (backend ở thư mục gốc, frontend riêng)
npm install
cd frontend && npm install && cd ..

:: 3) Cấu hình: sao chép mẫu rồi sửa nếu cần
if not exist backend\.env copy backend\.env.example backend\.env

:: 4) Kiểm tra kết nối (chỉ đọc)
npm run check:db

:: 5) Migration không phá hủy (xem trước rồi áp dụng)
npm run migrate:dry
npm run migrate

:: 6) Tài khoản demo cho 8 người dùng mẫu (sau migrate)
set "DEMO_PASSWORD=DatMatKhauCuaBan123"
npm run seed:accounts

:: (Không cần "npm run seed": dữ liệu mẫu đã đủ. Script giữ nguyên bản gốc và sẽ
::  tự dừng, không ghi gì, vì hội thoại 1111... đã có 202 > 200 tin.)

:: 7) Chạy backend (cửa sổ CMD 1) và frontend (cửa sổ CMD 2)
npm run dev
cd frontend && npm run dev
```

Mở <http://localhost:5173>. Frontend gọi `/api/...`; Vite chuyển tiếp sang backend `http://localhost:3000`.
Nhờ vậy, frontend và backend dùng chung origin và cookie đăng nhập hoạt động mà không cần CORS.

### Biến môi trường (`backend/.env`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | 3000 | Cổng backend |
| `CASSANDRA_HOSTS` | 127.0.0.1 | Contact points, cách nhau dấu phẩy |
| `CASSANDRA_LOCAL_DATACENTER` | datacenter1 | DC cục bộ (khớp `docker-compose.yml`) |
| `CASSANDRA_KEYSPACE` | chat_ott | Keyspace đang có dữ liệu |
| `PAGE_TOKEN_SECRET` | (ngẫu nhiên mỗi lần chạy) | Khóa ký HMAC cho `pageToken` |
| `SESSION_TTL_HOURS` | 168 | Thời hạn phiên đăng nhập |
| `COOKIE_SECURE` | false | Đặt `true` khi chạy HTTPS |
| `CORS_ORIGINS` | localhost:5173 | Origin frontend được phép |

`.env` nằm trong `.gitignore`. Không commit mật khẩu hay secret. Mật khẩu demo chỉ đi qua biến `DEMO_PASSWORD` lúc chạy lệnh.

### Tài khoản demo

`npm run seed:accounts` gắn email cho 8 người dùng mẫu sẵn có. Mật khẩu là giá trị `DEMO_PASSWORD` bạn đặt.

| Email | Người dùng |
|---|---|
| an@chatott.demo | user01 — Nguyễn An |
| binh@chatott.demo | user02 — Trần Bình |
| chi@chatott.demo | user03 — Lê Chi |
| dung@chatott.demo | user04 — Phạm Dũng |
| giang@chatott.demo | user05 — Hoàng Giang |
| huy@chatott.demo | user06 — Vũ Huy |
| linh@chatott.demo | user07 — Đặng Linh |
| minh@chatott.demo | user08 — Bùi Minh |

Ngoài ra có thể tự đăng ký tài khoản mới ở màn hình đăng nhập.

---

## 2. Kiểm thử

| Lệnh | Chạy trên | Nội dung |
|---|---|---|
| `npm test` | Cassandra **giả lập** trong bộ nhớ (`backend/tests/fakeCassandra.js`) | 97 ca (gồm kiểm tra 2 file verify CQL và logic triển khai): tài khoản + phục hồi đăng ký, phân quyền, chống giả mạo, phân trang TC-01→TC-14, gửi/thu hồi, nhóm, tìm tên, chưa đọc/ghim, SSE, lỗi 503; migration (dry-run không ghi, chạy lại, dừng giữa chừng, sai cấu trúc) |
| `npm run audit:db` | Cassandra **thật**, chỉ đọc | Schema, index, compaction, đối chiếu cột backend dùng, nhất quán bảng phụ, duyệt phân trang |
| `npm run test:integration` | Cassandra **thật** | Đăng ký/đăng nhập, LWT, 25 tin + phân trang 20/5, thu hồi rồi đọc lại bằng CQL, đăng xuất |
| `npm run bench` | Cassandra **thật**, chỉ đọc | p50/p95 của trang 1→10 (NFR-01, NFR-03) |
| `npm run check:db` | Cassandra **thật**, chỉ đọc | Bảng, khóa, số tin mỗi partition |

Cassandra giả lập đọc lược đồ từ `schema.cql` và áp các quy tắc của Cassandra: phải có đủ partition key, cấm lọc cột ngoài khóa, cấm ALLOW FILTERING/OFFSET.
Nó cũng mô phỏng paging state theo khóa dòng cuối, upsert, LWT và TTL. Đây **không** thay thế kiểm thử trên Cassandra thật.

`test:integration` **tạo thêm** dữ liệu và không xóa gì: 2 tài khoản `it-…@chatott.test` và 1 hội thoại 1-1 có 25 tin.
Muốn kiểm tra thêm phân trang trên hội thoại 200 tin (chỉ đọc):

```bat
set IT_EMAIL=an@chatott.demo
set IT_PASSWORD=DatMatKhauCuaBan123
npm run test:integration
```

---

## 3. Thiết kế dữ liệu (keyspace `chat_ott`)

| Bảng | Khóa chính | Phục vụ truy vấn |
|---|---|---|
| `messages_by_conversation` | `((conversation_id), created_at DESC, message_id DESC)` | Q2 lịch sử theo trang, Q3 gửi, Q4 thu hồi |
| `conversations` | `(conversation_id)` | Q5 thông tin, thành viên (`participant_ids`), trưởng nhóm |
| `conversations_by_user` | `((user_id), last_message_at DESC, conversation_id)` | Q1 danh sách hội thoại, mới nhất trước |
| `users` | `(user_id)` | Hồ sơ công khai |
| `users_by_name_token` *(mới)* | `((token_prefix), name_token, user_id)` | Tìm người theo tiền tố từng từ trong tên. Cột không đặt tên `token` vì đó là từ khóa CQL |
| `accounts_by_email` *(mới)* | `(email)` | Đăng nhập; chống trùng email bằng LWT; `status` PENDING/ACTIVE |
| `sessions` *(mới)* | `(session_hash)` | Phiên đăng nhập, hết hạn bằng TTL |
| `direct_conversations` *(mới)* | `(pair_key)` | Không tạo trùng hội thoại 1-1 |
| `conversation_state_by_user` *(mới)* | `((user_id), conversation_id)` | Đã đọc tới đâu, ghim |

**Cách diễn giải đúng khi báo cáo**
- Mỗi `conversation_id` là **một partition logic riêng**. Cassandra băm partition key thành token và phân bố các partition trên vòng token.
- Không phải mọi hội thoại nằm chung một partition. Chỉ toàn bộ tin của **cùng một** hội thoại nằm liền nhau, trên cùng các replica.
- `message_id` (TimeUUID) là khóa sắp xếp phụ: hai tin cùng mili-giây không ghi đè nhau (BR-07). `created_at` được lấy từ chính TimeUUID nên hai giá trị luôn khớp.

**Phân trang (Q2)**
- Câu lệnh: `SELECT … FROM messages_by_conversation WHERE conversation_id = ?`, **không** có `LIMIT`. Driver chạy với `fetchSize = 20` và `pageState`.
- Backend đóng gói `{ v, cid, ps, sig }` thành `pageToken` dạng base64url. `cid` gắn token với hội thoại; `sig` là HMAC để chống sửa token.
- Token sai định dạng, khác hội thoại hoặc bị sửa đều bị trả về `400 INVALID_PAGE_TOKEN`.
- Không dùng OFFSET, không dùng ALLOW FILTERING, không dùng secondary index và không tải toàn bộ partition để tự chia trang.

**Thu hồi (Q4)**
- Đọc và cập nhật theo **khóa chính đầy đủ**: client gửi kèm `createdAt` của tin.
- Thu hồi là xóa mềm (`is_deleted = true`, `content = null`): dòng giữ nguyên vị trí và không làm lệch phân trang.
- Nếu tin bị thu hồi là tin mới nhất, đoạn trích ở danh sách hội thoại đổi thành "Tin nhắn đã được thu hồi".

**Gửi tin (Q3) và đồng bộ danh sách**
- Ghi tin xong, một `LOGGED BATCH` chạy `UPDATE conversations.last_message_at`.
- Với mỗi thành viên, batch xóa dòng cũ và chèn dòng mới trong `conversations_by_user`, vì `last_message_at` là cột clustering.
- Nếu hai người gửi cùng lúc tạo ra dòng trùng (rủi ro R-04 trong SRS), API danh sách chỉ giữ dòng mới nhất và dọn dòng cũ.

**Tài khoản**
- Mật khẩu băm bằng `scrypt` có sẵn trong Node.js (N=2^14, r=8, p=5, mức tương đương khuyến nghị OWASP), mỗi mật khẩu một salt riêng. Không cần thư viện native trên Windows.
- Không bao giờ trả `password_hash` về frontend.
- Cassandra không có `UNIQUE`. `accounts_by_email` dùng email làm partition key và ghi bằng `INSERT … IF NOT EXISTS` (Lightweight Transaction, Paxos).
- LWT tốn khoảng 4 vòng round-trip thay vì 1, nhưng chỉ dùng khi đăng ký và khi mở hội thoại 1-1 mới, là các thao tác hiếm.
- Phiên đăng nhập: token ngẫu nhiên 32 byte nằm trong cookie `HttpOnly; SameSite=Lax`. Cassandra chỉ lưu **SHA-256** của token. Phiên hết hạn bằng TTL, đăng xuất bằng cách xóa dòng.
- Middleware `requireAuth` lấy danh tính từ phiên. Nếu request gửi `userId`, `senderId` hay `requesterId` khác người đăng nhập, backend trả `403 IDENTITY_MISMATCH`.
- Request thay đổi dữ liệu từ Origin lạ bị chặn. Đăng nhập sai nhiều lần bị giới hạn tốc độ.

### Sao lưu trước migration

```bat
backend\scripts\backup-cassandra.cmd
```

Script này tạo `nodetool snapshot` (thẻ `truoc-migration-<thời điểm>`) và xuất CSV của 4 bảng cũ cùng `DESCRIBE KEYSPACE` vào `_backup\cassandra-<thời điểm>\`. Cuối cùng nó đếm số dòng để đối chiếu: 8 / 10 / 28 / 472.

Khôi phục dữ liệu cũ nếu cần (bảng cũ không bị migration sửa, nên đây là phương án dự phòng): `COPY chat_ott.<bảng> FROM '<file>.csv' WITH HEADER = TRUE`. Lệnh này upsert theo khóa chính nên chạy lại được nhiều lần. Có thể kiểm tra trước trên một keyspace thử nếu được phê duyệt.

Truy vấn xác minh chỉ đọc, hai chế độ:

```bat
backend\scripts\verify-migration.cmd before   :: trước migration - chỉ bảng/cột đang có
backend\scripts\verify-migration.cmd after    :: sau migration - bảng/cột mới và dữ liệu backfill
```

Mỗi file ghi sẵn giá trị kỳ vọng trong comment. Phần "dữ liệu cũ" của hai file giống hệt nhau, nên kết quả trước và sau phải trùng khớp.
Hai file không dùng `COUNT(*)` toàn bảng, vì Cassandra sẽ quét mọi partition và cảnh báo *Aggregation query used without partition key*; thay vào đó chúng đếm theo từng partition.

### Triển khai migration một lệnh (khuyến nghị)

```bat
cd /d D:\ChatOTT
:: dừng backend trước (Ctrl+C ở cửa sổ "npm run dev")
npm run deploy:migration
```

Script `backend/scripts/deploy-migration.js` chạy tuần tự và dừng ngay khi có bước FAIL:

- **A. Môi trường** (chỉ đọc): kiểm tra thư mục, container, backend cổng 3000 đã dừng, kết nối driver.
- **B. Trước khi ghi** (chỉ đọc):
  - chụp toàn bộ dữ liệu cũ (số lượng và SHA-256 từng partition tin nhắn);
  - tính kỳ vọng backfill từ dữ liệu thật;
  - chạy dry-run và `verify before`.
- **C. Xác nhận:** phải gõ đúng `MIGRATE`.
- **D. Ghi:** chạy `npm run migrate` một lần. Nếu lỗi, script dừng, không chạy lại, không seed.
- **E. Sau migration** (chỉ đọc):
  - dry-run lần 2 (không còn gì để tạo);
  - chụp lại và so khớp dữ liệu cũ, replication, TTL, compaction, gc_grace;
  - kiểm tra backfill;
  - chạy `audit:db` và `verify after`.
- **F. Ứng dụng** (không ghi Cassandra): `npm test` (giả lập), khởi động backend tạm ở cổng 3999 để kiểm tra `/api/health` và API cần đăng nhập, build frontend.

Mọi output và mã thoát được lưu ở `logs\deploy-<thời điểm>\` (`deploy.log`, `summary.json`, ảnh chụp trước/sau).

### Migration và rollback
- `db/migrations/001_auth_and_chat_features.cql` chỉ chứa `CREATE TABLE IF NOT EXISTS` và `ALTER TABLE … ADD`.
- `npm run migrate` bỏ qua cột/bảng đã có và từ chối mọi câu chứa DROP/TRUNCATE/DELETE.
- Migration cũng ghi các hội thoại 1-1 cũ vào `direct_conversations`.
- Nên chụp snapshot trước khi chạy: `docker exec chatott-cassandra nodetool snapshot -t truoc-migration chat_ott`.
- Rollback: mã cũ không đọc các cột/bảng mới, nên chỉ cần chạy lại mã cũ (bản sao lưu trong `_backup/`). Không bắt buộc xóa cột.

---

## 4. API (tiền tố `/api/v1`, lỗi dạng `{ "error": { "code", "message" } }`)

| Phương thức | Đường dẫn | Ghi chú |
|---|---|---|
| GET | `/health` (cả `/api/health`) | Không cần đăng nhập; báo bảng còn thiếu |
| POST | `/auth/register` · `/auth/login` · `/auth/logout` | |
| GET | `/auth/me` | Hồ sơ người đang đăng nhập |
| GET | `/me/conversations` | Q1. `/users/:userId/conversations` vẫn giữ nhưng chỉ cho chính mình |
| GET | `/users/search?q=` | Có `@` thì tra chính xác email; còn lại tìm theo tên, không phân biệt dấu (quy mô demo) |
| POST | `/conversations/direct` `{ targetUserId }` | Mở hoặc lấy lại hội thoại 1-1 |
| POST | `/conversations/groups` `{ name, memberIds }` | Tạo nhóm (≥ 3 người) |
| GET / PATCH | `/conversations/:id` | Q5 thông tin; đổi tên nhóm |
| POST / DELETE | `/conversations/:id/members[/:memberId]` | Thêm; trưởng nhóm xóa thành viên; tự rời nhóm |
| GET | `/conversations/:id/messages?limit=20&pageToken=` | Q2, kèm `queryTimeMs` |
| POST | `/conversations/:id/messages` `{ content }` | Q3; người gửi lấy từ phiên |
| DELETE | `/conversations/:id/messages/:messageId?createdAt=` | Q4 thu hồi |
| POST / PUT | `/conversations/:id/read` · `/conversations/:id/pin` | Đã đọc, ghim |
| GET | `/conversations/:id/stats` | Đếm tin trong một partition |
| GET | `/events` | Server-Sent Events: `message:new`, `message:deleted`, … |

---

## 5. Kịch bản demo trước giảng viên

Chuẩn bị ba cửa sổ:
1. Trình duyệt ở <http://localhost:5173>, kèm DevTools tab Network, lọc `messages`.
2. CMD: `docker exec -it chatott-cassandra cqlsh`, rồi `USE chat_ott;`. Bộ lệnh có sẵn trong `db/demo.cql`.
3. Một cửa sổ ẩn danh đăng nhập tài khoản thứ hai, để thấy tin nhắn đến trực tiếp.

| Bước | Thao tác | Điều hội đồng thấy |
|---|---|---|
| 0 | `DESCRIBE TABLE messages_by_conversation;` | `PRIMARY KEY ((conversation_id), created_at, message_id)`, `CLUSTERING ORDER BY (created_at DESC, …)` |
| 1 | Mở web khi chưa đăng nhập; thử mở `/api/v1/me/conversations` | Bị chặn: `401 UNAUTHENTICATED` |
| 2 | Đăng nhập `an@chatott.demo` | Vào giao diện chat |
| 3 | Mở "Nhóm Đồ án NoSQL", gửi "Demo bảo vệ đề tài 09" | Tin hiện ngay; hội thoại nhảy lên đầu danh sách; cửa sổ ẩn danh (Bình) nhận tin không cần tải lại |
| 4 | CQLSH: lệnh (2) trong `db/demo.cql` | Tin vừa gửi là **dòng đầu tiên** của partition |
| 5 | CQLSH: lệnh (1) và `nodetool getendpoints …` | Token cố định của partition và node lưu nó |
| 6 | Cuộn khung chat lên nhiều lần | Mỗi lần có một request `…&pageToken=…` trả 20 tin; góc khung chat hiện `Trang n · 20 tin · Cassandra x ms` |
| 7 | Cuộn tới hết | "Đã hiển thị toàn bộ lịch sử"; không còn request mới |
| 8 | `TRACING ON;` lệnh (4) | Truy vấn chỉ đọc một partition |
| 9 | Thu hồi tin ở bước 3 | Bong bóng hiện "Tin nhắn đã được thu hồi"; CQLSH thấy `is_deleted = True`, dòng ở nguyên vị trí |
| 10 | `npm run bench` | p95 trang 1 và trang 10 xấp xỉ nhau: chi phí mỗi trang không đổi theo độ sâu |
| 11 | (tùy chọn) Đổi `?userId=user02` trên URL API trong DevTools | `403 IDENTITY_MISMATCH`: không giả mạo được |

Mẹo: panel "Thông tin hội thoại" bên phải hiện mã hội thoại (partition key) để sao chép vào CQLSH, cùng số tin trong partition.

---

## 6. Khác biệt so với SRS và giới hạn đã biết

- **Đăng nhập:** SRS v1.0 đặt đăng nhập ngoài phạm vi (Phụ lục B #1). Theo kế hoạch ChatOTT, đăng nhập đã được bổ sung, nên SRS cần nâng lên v1.1. Phần lưu trữ tin nhắn giữ đúng SRS.
- **Keyspace:** SRS ghi `ott_chat`, nhưng dữ liệu thật nằm trong `chat_ott`; dự án giữ `chat_ott`.
- **Seed:** SRS yêu cầu TRUNCATE trước khi nạp. Dự án **không** truncate; seed chỉ bổ sung cho đủ định mức và chấp nhận số tin lớn hơn mục tiêu.
- **Tìm người theo tên:** tìm theo **tiền tố từng từ** (không dấu) trên `users_by_name_token`, không quét bảng `users`. Không tìm chuỗi con ở giữa từ ("inh" không ra "Linh"). Chưa có chức năng đổi tên; khi thêm cần xóa token cũ và ghi token mới trong cùng một batch.
- **Quyền trong nhóm:**
  - Mọi thành viên: đọc/gửi, thêm người, tự rời nhóm.
  - Chỉ trưởng nhóm (`created_by`): đổi tên nhóm, xóa thành viên khác.
  - 3 nhóm cũ có `created_by = null`: không ai đổi tên hay xóa thành viên được (`403 GROUP_OWNER_UNKNOWN`); hệ thống không tự gán trưởng nhóm.
  - Người ngoài nhóm nhận `403 NOT_A_MEMBER`; hội thoại không tồn tại trả `404`.
- **`last_sender_id` của 28 dòng cũ là null:** không được backfill. Hội thoại cũ không hiện "chưa đọc" và không có tiền tố "Bạn:" cho tới tin nhắn kế tiếp.
- **`last_message_at`:** quy tắc là dòng trong `conversations_by_user` luôn có khóa bằng `conversations.last_message_at`, và đoạn trích là của tin tại thời điểm đó. Thu hồi chỉ đổi đoạn trích, không đổi thời điểm. Vì vậy hội thoại 1111 (05:03 ≠ tin đầu partition 05:23 đã thu hồi từ trước) là hợp lệ và không cần sửa.
- **Realtime:** dùng SSE trong bộ nhớ của một tiến trình backend. Chạy nhiều instance thì cần pub/sub (ví dụ Redis).
- **Gửi ảnh/tệp:** chưa làm. Thiết kế đề xuất là lưu tệp ngoài Cassandra (ổ đĩa hoặc object storage) và lưu metadata/đường dẫn trong `messages_by_conversation` với `message_type = 'IMAGE' | 'FILE'`.
- **pageToken:** nếu không đặt `PAGE_TOKEN_SECRET`, token cũ bị từ chối sau khi restart backend. Giao diện tự tải lại trang đầu.

## Migration 002 — trả lời, cảm xúc, chuyển tiếp, xóa phía tôi, tệp đính kèm

Chỉ THÊM 3 bảng mới (`reactions_by_message`, `attachments_by_conversation`, `hidden_messages_by_user`)
và 4 cột mới trên `messages_by_conversation` (`reply_to_id`, `reply_to_created_at`, `attachment_ids`, `forwarded`).
Không xóa, không sửa dữ liệu cũ. Chạy:

```
npm run deploy:migration
```

Kiểm tra thủ công (chỉ đọc): `backend\scripts\verify-migration.cmd before 002` / `after 002`.

### Tệp đính kèm
- Nội dung tệp lưu ở `D:\ChatOTT\storage\uploads` (đổi bằng `UPLOAD_DIR` trong `backend\.env`); Cassandra chỉ lưu metadata.
- Tối đa 20 MB/tệp, 5 tệp/tin. Định dạng: jpg, jpeg, png, gif, webp, mp4, pdf, docx, xlsx, txt, zip (kiểm tra nội dung thật).
- Tải xuống chỉ qua API, cần đăng nhập và là thành viên hội thoại.
- Dọn tệp mồ côi: `npm run attachments:cleanup` (chỉ xem), thêm `-- --apply` để xóa thật.
