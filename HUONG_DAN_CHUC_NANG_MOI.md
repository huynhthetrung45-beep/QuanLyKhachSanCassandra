# ChatOTT – Chức năng mới theo SRS (PT-01 … PT-26, NFR-13 … NFR-19)

Tài liệu này mô tả phần **bổ sung** theo mục 4.2 và 5.2 của SRS. Chức năng cũ (HT-01 … HT-36) giữ nguyên.

## 1. Nguyên tắc: chỉ thêm, không sửa chức năng cũ

- Toàn bộ backend mới nằm trong `backend/src/extensions/`. Toàn bộ frontend mới nằm trong `frontend/src/extensions/`.
- Cơ sở dữ liệu: **7 migration mới 009–015, chỉ tạo 56 bảng mới** (009–012: 32 bảng, 013: 3 bảng, 014–015: 21 bảng). Không có `ALTER` nào trên bảng cũ, không ghi dữ liệu cũ.
  Thông tin thêm của tin nhắn (đã sửa, bình chọn, sticker, nhắc tên, link) nằm ở bảng riêng `message_meta_by_conversation`.
- Route và service cũ **không bị sửa**. Chức năng mới gắn vào bằng 3 cơ chế:
  1. Route mới (`/api/v1/...`) trong `extensions/routes.js`.
  2. Bổ sung phản hồi của route cũ (`decorateJson`, `afterJson` trong `extensions/lib/intercept.js`), ví dụ gắn `extra` cho trang tin nhắn,
     hoặc gửi thông báo @mention sau khi route gửi tin cũ trả về.
  3. Bọc hàm xuất khẩu (`notificationService.notifySafe`, `realtime.presenceOf`, `realtime.publish`) để thêm cài đặt thông báo,
     tắt thông báo hội thoại, Web Push, "lần cuối truy cập" bền vững, Redis.
- Những file cũ chỉ được **chèn thêm dòng** (import, prop, nút/menu, một dòng gọi component mới):
  - Backend: `src/middleware/security.js` (chèn 4 dòng: `rateLimit` dùng Redis khi có, NFR-13), `src/app.js` (7 dòng gọi `extensions`), `src/config/cassandra.js` (mức nhất quán cấu hình được), `schema.cql` (nối 32 bảng mới vào cuối),
    `package.json` (script mới, `optionalDependencies`).
  - Kiểm thử: `tests/migrate.test.js` (test "008 sau 007" giới hạn đúng thư mục 001–008 vì giờ đã có 009+),
    `tests/fakeCassandra.js` (hỗ trợ thêm kiểu `list<text>`, `set<int>`).
  - Frontend: `api.js`, `hooks/useEventStream.js`, `App.jsx`, `main.jsx`, `index.html` và các component
    `Avatar, AuthScreen, ChatApp, NavRail, Sidebar, ChatWindow, Composer, MessageItem, Attachments, InfoPanel,
    NotificationsPage, PostCard, PostsPage, ProfileModal, FriendsPage, CommentThread`.

### Kết quả đối chiếu với mã gốc (so từng byte với bản sao lưu trước khi phát triển)

- 155 file gốc: **125 file giữ nguyên tuyệt đối**, 0 file bị xóa, 30 file có thêm dòng.
- Trong 30 file đó chỉ có **21 dòng gốc được thay**, đều là mở rộng tại chỗ, không đổi hành vi cũ:
  thêm tham số vào chữ ký hàm (`ChatApp`, `Composer`, `send` trong `ChatWindow`), thêm phần tử vào danh sách tab của `InfoPanel`,
  thêm `style` ảnh bìa cho thẻ `profile-cover` (`PostsPage`, `ProfileModal`), Avatar hiện ảnh thật nếu có (không có thì vẫn chữ cái đầu),
  `MessageItem` ẩn chữ thay thế khi tin là sticker/bình chọn, `Sidebar` thêm bộ lọc "Lưu trữ",
  `package.json` nối thêm file test và script mới, `migrate.test.js` giới hạn test "008 sau 007" đúng thư mục 001–008.
- `README.md` và `.gitignore` (không có trong bản sao lưu) chỉ được chèn thêm dòng.

## 2. Cập nhật CSDL và chạy

```bat
npm install
cd frontend && npm install && cd ..
npm run deploy:migration            REM gõ MIGRATE để xác nhận (dùng db/verify-015-before/after.cql, gồm migration 009–015)
npm run hashtags:backfill -- --apply REM (tuỳ chọn) lập chỉ mục hashtag cho bài viết cũ
npm run admin:grant -- an@chatott.demo
npm run dev                          REM backend
cd frontend && npm run dev           REM frontend
```

Backend từ chối khởi động nếu chưa chạy migration 009–015 (giống các bảng cũ).
Cấu hình mới: xem cuối `backend/.env.example`.

## 3. Bảng chức năng

| Mã | Chức năng | API chính | Giao diện |
|---|---|---|---|
| PT-01 | Đổi mật khẩu, hủy phiên khác | `POST /auth/password/change` (đúng SRS 6.3), giữ cả `POST /me/password` | Cài đặt tài khoản › Bảo mật |
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

### Bổ sung đợt 2 (migration 013: story_reactions, story_styles, ai_chat_by_user)

| Chức năng | API chính | Giao diện |
|---|---|---|
| Thông báo khi bạn bè đăng bài (Công khai/Bạn bè) và đăng tin (tối đa 1 lần/ngày/người) | tự động; loại `FRIEND_POST`, `FRIEND_STORY` | Mục Thông báo; bấm để mở bài / mở tin |
| Bấm ảnh đại diện ở mọi nơi để xem hồ sơ | – | Mọi ảnh đại diện người dùng |
| Cảm xúc về tin, trả lời tin bằng tin nhắn, chia sẻ tin (lên tin của mình hoặc vào chat) | `PUT /stories/:author/:id/reaction`, `POST …/reply`, `POST …/share` | Trình xem tin |
| Khung tạo tin kiểu Facebook: tin ảnh / tin văn bản, 4 phông chữ, 14 phông nền, màu chữ, căn lề, xem trước | `POST /stories`, `POST /stories/media` | Bảng tin › Tạo tin |
| Trình xem tin kiểu Facebook: danh sách tin bên trái, thanh tiến độ, tạm dừng, người xem + cảm xúc | `GET /stories`, `GET /stories/mine/:id/viewers` | Bảng tin › bấm thẻ tin |
| Trợ lý AI dùng **Google Gemini** (lưu lịch sử, gửi kèm ngữ cảnh 20 lượt) | `GET/DELETE /assistant`, `POST /assistant/messages` | Nút robot trên thanh điều hướng |

Gemini: đặt `GEMINI_API_KEY` (lấy tại aistudio.google.com/apikey) trong `backend/.env`. Khóa chỉ nằm ở backend.
Khi chưa có `ANTHROPIC_API_KEY`, chức năng gợi ý trả lời và dịch tin cũng dùng Gemini.

### Bổ sung đợt 3: Công việc & Lịch, Nhắc nhở, Họp trực tuyến (migration 014–015, 21 bảng mới)

Đặc tả chi tiết (ca sử dụng, quy tắc, ma trận quyền, lược đồ, API, nhất quán, kiến trúc họp, kết quả kiểm chứng): **`TAI_LIEU_CONG_VIEC_LICH_HOP.md`**.

| Chức năng | API chính | Giao diện |
|---|---|---|
| Công việc cá nhân / nhóm, giao nhiều người, người phụ trách chính, ưu tiên, nhãn, trạng thái, bình luận, lịch sử | `/tasks`, `/tasks/:id/status`, `/tasks/:id/comments`, `/tasks/:id/history`, `/groups/:cid/tasks` | Nút lịch ✔ trên thanh điều hướng › Công việc |
| Lịch cá nhân & lịch nhóm (ngày / tuần / tháng / danh sách), lịch bận thành viên, xung đột | `/calendar`, `/groups/:cid/calendar` | › Lịch |
| Chống trùng lịch (khoảng nửa mở, khóa theo người, gợi ý giờ trống), kéo thả đổi giờ, trả về khi trùng | `POST /calendar/check`, `PATCH /calendar/events/:id` | Lịch, form công việc / cuộc họp |
| Nhắc nhở bền vững (worker, không trùng, thử lại, đổi giờ theo đối tượng) | `/reminders` | › Nhắc nhở; chi tiết công việc |
| Họp trực tuyến WebRTC: lên lịch / họp ngay, lời mời, link mời, âm thanh, hình, chia sẻ màn hình, chat, kết thúc | `/meetings`, `/meetings/:id/join|signal|chat|end` | › Cuộc họp; phòng họp toàn màn hình |
| Thông báo công việc / cuộc họp / nhắc nhở mở đúng màn hình | `ref` trong `GET /notifications` | Mục Thông báo |

Biến môi trường mới: `MEETING_TOKEN_SECRET`, `STUN_URLS`, `TURN_URLS`, `TURN_SECRET`, `REMINDER_INTERVAL_SECONDS`… (cuối `backend/.env.example`).
File cũ được chèn thêm dòng trong đợt này: `NavRail.jsx` (nút Công việc), `ChatApp.jsx` (2 dòng), `NotificationsPage.jsx` (8 loại thông báo),
`package.json` (nối `work.test.js`), `tests/fakeCassandra.js` (kiểu `set<timeuuid>`), `schema.cql` (nối 21 bảng). Không dòng gốc nào bị thay thêm.

Phi chức năng:

| Mã | Đã làm |
|---|---|
| NFR-13 | `REDIS_URL` → realtime đồng bộ giữa nhiều tiến trình (`extensions/realtime-redis.js`) **và** mọi bộ giới hạn tốc độ (cũ và mới) đếm chung qua Redis (`extensions/lib/redisRateLimit.js`, script Lua nguyên tử INCR + PEXPIRE). Redis lỗi → tự đếm cục bộ, không chặn nhầm người dùng. Không có Redis → giữ nguyên như cũ. |
| NFR-14 | `docker-compose.cluster.yml` (3 nút), `npm run cluster:replication` (RF = 3), `CASSANDRA_CONSISTENCY=localQuorum`. |
| NFR-15 | `STORAGE_DRIVER=s3` → tệp chat, tin nhắn thoại, ảnh bài viết, ảnh đại diện/bìa/nhóm, story lưu trên S3/MinIO (`extensions/lib/s3.js` tự ký AWS SigV4, không cần thư viện; `extensions/storage-hooks.js`). `UPLOAD_DIR` chỉ còn là bộ đệm: mất bộ đệm vẫn tải được từ S3. S3 lỗi khi tải lên → 503, không để lại bản ghi. Mặc định `disk`: y như cũ. `attachment.service.js`, `post.service.js` **không bị sửa** (bọc hàm xuất khẩu). Giới hạn: lệnh dọn tệp mồ côi (`attachments:cleanup`, `stories:cleanup`) chỉ dọn bộ đệm cục bộ, chưa dọn object trên S3. |
| NFR-16 | `npm run start:https` (HTTPS + HSTS + chuyển hướng HTTP) và xác thực hai lớp TOTP (Cài đặt › Bảo mật). |
| NFR-17 | Chế độ tối/sáng/theo hệ thống, giao diện ≥ 360 px, PWA (`manifest.webmanifest`, `sw.js`). |
| NFR-18 | `GET /metrics` (Prometheus), `LOG_FORMAT=json`. |
| NFR-19 | `backend/Dockerfile`, `frontend/Dockerfile`, `docker-compose.full.yml`, `.github/workflows/ci.yml`. |

## 4. Kiểm thử

`npm test` chạy 17 bộ (thêm `extensions.test.js`, `work.test.js`, `storage-redis.test.js`) trên Cassandra giả lập – **275 test, tất cả đạt**.
S3 được kiểm bằng máy chủ S3 giả lập chạy thật, kiểm tra chữ ký từng request; chữ ký SigV4 khớp ví dụ chuẩn trong tài liệu AWS. Redis được kiểm bằng client giả lập (chưa chạy Redis/MinIO thật).
WebRTC đã kiểm chứng bằng 2 trình duyệt Chrome thật (camera/micro giả lập): âm thanh và hình ảnh truyền hai chiều, chia sẻ màn hình, chat, kết thúc họp.
Chưa kiểm thử trên Cassandra thật / Docker trong lần phát triển này.
