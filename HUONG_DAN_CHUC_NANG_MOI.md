# ChatOTT – Chức năng mới theo SRS (PT-01 … PT-26, NFR-13 … NFR-19)

Tài liệu này mô tả phần **bổ sung** theo mục 4.2 và 5.2 của SRS. Chức năng cũ (HT-01 … HT-36) giữ nguyên.

## 1. Nguyên tắc: chỉ thêm, không sửa chức năng cũ

- Toàn bộ backend mới nằm trong `backend/src/extensions/`. Toàn bộ frontend mới nằm trong `frontend/src/extensions/`.
- Cơ sở dữ liệu: **4 migration mới 009–012, chỉ tạo 32 bảng mới**. Không có `ALTER` nào trên bảng cũ, không ghi dữ liệu cũ.
  Thông tin thêm của tin nhắn (đã sửa, bình chọn, sticker, nhắc tên, link) nằm ở bảng riêng `message_meta_by_conversation`.
- Route và service cũ **không bị sửa**. Chức năng mới gắn vào bằng 3 cơ chế:
  1. Route mới (`/api/v1/...`) trong `extensions/routes.js`.
  2. Bổ sung phản hồi của route cũ (`decorateJson`, `afterJson` trong `extensions/lib/intercept.js`), ví dụ gắn `extra` cho trang tin nhắn,
     hoặc gửi thông báo @mention sau khi route gửi tin cũ trả về.
  3. Bọc hàm xuất khẩu (`notificationService.notifySafe`, `realtime.presenceOf`, `realtime.publish`) để thêm cài đặt thông báo,
     tắt thông báo hội thoại, Web Push, "lần cuối truy cập" bền vững, Redis.
- Những file cũ chỉ được **chèn thêm dòng** (import, prop, nút/menu, một dòng gọi component mới):
  - Backend: `src/app.js` (7 dòng gọi `extensions`), `src/config/cassandra.js` (mức nhất quán cấu hình được), `schema.cql` (nối 32 bảng mới vào cuối),
    `package.json` (script mới, `optionalDependencies`).
  - Kiểm thử: `tests/migrate.test.js` (test "008 sau 007" giới hạn đúng thư mục 001–008 vì giờ đã có 009+),
    `tests/fakeCassandra.js` (hỗ trợ thêm kiểu `list<text>`, `set<int>`).
  - Frontend: `api.js`, `hooks/useEventStream.js`, `App.jsx`, `main.jsx`, `index.html` và các component
    `Avatar, AuthScreen, ChatApp, NavRail, Sidebar, ChatWindow, Composer, MessageItem, Attachments, InfoPanel,
    NotificationsPage, PostCard, PostsPage, ProfileModal, FriendsPage, CommentThread`.

### Kết quả đối chiếu với mã gốc (so từng byte với bản sao lưu trước khi phát triển)

- 155 file gốc: **126 file giữ nguyên tuyệt đối**, 0 file bị xóa, 29 file có thêm dòng.
- Trong 29 file đó chỉ có **18 dòng gốc được thay**, đều là mở rộng tại chỗ, không đổi hành vi cũ:
  thêm tham số vào chữ ký hàm (`ChatApp`, `Composer`, `send` trong `ChatWindow`), thêm phần tử vào danh sách tab của `InfoPanel`,
  thêm `style` ảnh bìa cho thẻ `profile-cover` (`PostsPage`, `ProfileModal`), Avatar hiện ảnh thật nếu có (không có thì vẫn chữ cái đầu),
  `MessageItem` ẩn chữ thay thế khi tin là sticker/bình chọn, `Sidebar` thêm bộ lọc "Lưu trữ",
  `package.json` nối thêm file test và script mới, `migrate.test.js` giới hạn test "008 sau 007" đúng thư mục 001–008.
- `README.md` và `.gitignore` (không có trong bản sao lưu) chỉ được chèn thêm dòng.

## 2. Cập nhật CSDL và chạy

```bat
npm install
cd frontend && npm install && cd ..
npm run deploy:migration            REM gõ MIGRATE để xác nhận (dùng db/verify-012-before/after.cql)
npm run hashtags:backfill -- --apply REM (tuỳ chọn) lập chỉ mục hashtag cho bài viết cũ
npm run admin:grant -- an@chatott.demo
npm run dev                          REM backend
cd frontend && npm run dev           REM frontend
```

Backend từ chối khởi động nếu chưa chạy migration 009–012 (giống các bảng cũ).
Cấu hình mới: xem cuối `backend/.env.example`.

## 3. Bảng chức năng

| Mã | Chức năng | API chính | Giao diện |
|---|---|---|---|
| PT-01 | Đổi mật khẩu, hủy phiên khác | `POST /me/password` | Cài đặt tài khoản › Bảo mật |
| PT-02 | Quên mật khẩu (link 30 phút, 1 lần) | `POST /auth/password/forgot`, `/auth/password/reset` | "Quên mật khẩu?" ở màn đăng nhập; link `/?reset=` |
| PT-03 | Đổi tên hiển thị (cập nhật chỉ mục tìm tên trong 1 batch) | `PATCH /me/display-name` | Cài đặt › Hồ sơ |
| PT-04 | Ảnh đại diện (cắt khung), ảnh bìa | `POST/DELETE /me/avatar`, `/me/cover`, `GET /avatars?ids=` | Cài đặt › Hồ sơ; ảnh hiện ở mọi Avatar |
| PT-05 | Trưởng/phó nhóm, chuyển quyền, nhận quyền nhóm cũ | `GET /conversations/:id/roles`, `PUT …/members/:uid/role`, `POST …/claim-owner` | Thông tin hội thoại › Quản lý |
| PT-06 | Sửa tin trong 15 phút, nhãn + lịch sử | `PATCH …/messages/:mid`, `GET …/messages/:mid/edits` | Menu tin › Sửa / Lịch sử chỉnh sửa |
| PT-07 | Báo cáo bài, bình luận, tin, tài khoản | `POST /reports` | Menu tin, cờ trên bài, "Báo cáo" ở bình luận và hồ sơ |
| PT-08 | Kiểm duyệt: ẩn/khôi phục, khóa/mở khóa, nhật ký | `/admin/reports…`, `/admin/content/hide|restore`, `/admin/users/:id/lock|unlock` | Trang Quản trị (biểu tượng khiên) |
| PT-09 | Xác minh email bằng mã 6 số | `POST /me/email/verification`, `/me/email/verify` | Cài đặt › Bảo mật; bắt buộc nếu `REQUIRE_EMAIL_VERIFICATION=true` |
| PT-10 | Ảnh và mô tả nhóm | `GET/PATCH …/profile`, `POST/DELETE …/avatar` | Quản lý nhóm |
| PT-11 | Tắt thông báo 1h/8h/đến khi bật, lưu trữ | `PUT …/prefs`, `GET /me/conversation-prefs` | Quản lý; bộ lọc "Lưu trữ" ở danh sách |
| PT-12 | Tin nhắn thoại ≤ 2 phút | `POST …/voice` (nhị phân, `X-Duration-Ms`) | Nút micro trên khung soạn |
| PT-13 | @mention + thông báo riêng | trường `mentions` khi gửi tin, `GET /me/mentions` | Gõ `@` trong khung soạn |
| PT-14 | Web Push | `GET /push/status`, `POST/DELETE /push/subscriptions` | Cài đặt › Thông báo (cần `npm i web-push`, đã có trong optionalDependencies) |
| PT-15 | Nhắc hạn công việc AI đã xác nhận | tự động (bộ hẹn giờ), `POST /admin/reminders/run` | Thông báo "Nhắc hạn công việc" |
| PT-16 | Trang quản trị: người dùng, tin/ngày, kết nối realtime, Cassandra | `GET /admin/overview` | Quản trị › Tổng quan |
| PT-17 | Thiết bị đăng nhập, đăng xuất từ xa | `GET/DELETE /me/sessions[/:id]` | Cài đặt › Bảo mật |
| PT-18 | Gợi ý kết bạn theo bạn chung | `GET /friends/suggestions` | Trang Bạn bè |
| PT-19 | Link mời nhóm, thu hồi, duyệt thành viên | `…/invites`, `/invites/:code[/join]`, `…/join-requests/:uid/approve|decline` | Quản lý nhóm; link `/?invite=` |
| PT-20 | Bình chọn, kết quả tức thời | `POST …/polls`, `PUT …/polls/:pid/vote`, `POST …/close` | Nút biểu đồ trên khung soạn (nhóm) |
| PT-21 | Sticker, xem trước liên kết (chống SSRF) | `GET /stickers`, `POST …/stickers` | Nút mặt cười; thẻ link dưới tin |
| PT-22 | Lưu bài viết | `PUT/DELETE /posts/:id/save`, `GET /me/saved-posts` | Dấu trang trên bài; menu tài khoản › Bài viết đã lưu |
| PT-23 | Story 24 giờ (TTL Cassandra) | `GET/POST /stories`, `POST /stories/media`, xem/xóa/người xem | Thanh story trên Bảng tin |
| PT-24 | Hashtag | `GET /hashtags/:tag/posts` | Chip `#tag` dưới bài; nút `#` |
| PT-25 | Cài đặt loại thông báo | `GET/PUT /me/notification-settings` | Cài đặt › Thông báo |
| PT-26 | AI gợi ý trả lời, dịch tin | `POST …/ai/reply-suggestions`, `POST …/messages/:mid/translate` | Nút lấp lánh; menu tin › Dịch (AI) |

Phi chức năng:

| Mã | Đã làm |
|---|---|
| NFR-13 | `REDIS_URL` → realtime đồng bộ giữa nhiều tiến trình (`extensions/realtime-redis.js`). Bộ đếm giới hạn tốc độ cũ vẫn trong bộ nhớ. |
| NFR-14 | `docker-compose.cluster.yml` (3 nút), `npm run cluster:replication` (RF = 3), `CASSANDRA_CONSISTENCY=localQuorum`. |
| NFR-15 | **Chưa làm**: lưu tệp nằm trong `attachment.service.js` cũ; chuyển sang S3/MinIO bắt buộc sửa mã cũ. |
| NFR-16 | `npm run start:https` (HTTPS + HSTS + chuyển hướng HTTP) và xác thực hai lớp TOTP (Cài đặt › Bảo mật). |
| NFR-17 | Chế độ tối/sáng/theo hệ thống, giao diện ≥ 360 px, PWA (`manifest.webmanifest`, `sw.js`). |
| NFR-18 | `GET /metrics` (Prometheus), `LOG_FORMAT=json`. |
| NFR-19 | `backend/Dockerfile`, `frontend/Dockerfile`, `docker-compose.full.yml`, `.github/workflows/ci.yml`. |

## 4. Kiểm thử

`npm test` chạy 15 bộ (thêm `backend/tests/extensions.test.js`, 23 test cho chức năng mới) trên Cassandra giả lập – 257 test.
Chưa kiểm thử trên Cassandra thật / Docker trong lần phát triển này.
