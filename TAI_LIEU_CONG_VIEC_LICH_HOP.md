# ChatOTT – Đặc tả mở rộng: Công việc & Lịch, Nhắc nhở, Họp trực tuyến

Phần này **bổ sung** vào SRS ChatOTT. Chức năng cũ giữ nguyên.
- Mã mới nằm trong `backend/src/extensions/` và `frontend/src/extensions/`.
- Cơ sở dữ liệu chỉ thêm bảng mới (migration 014, 015).

## 1. Phạm vi và khái niệm

| Khái niệm | Ý nghĩa | Lưu ở |
|---|---|---|
| Công việc (task) | Việc cần làm: tiêu đề, mô tả, người tạo, người giao, người thực hiện (nhiều người), người chịu trách nhiệm chính, mức ưu tiên, trạng thái, nhãn | `tasks` |
| Phiên làm việc | Khoảng thời gian **thực hiện** công việc trên lịch. Một công việc có thể có nhiều phiên. | `calendar_events` (`kind = TASK_SESSION`) |
| Hạn hoàn thành | Thời điểm phải xong (`due_at`). Đây **không** phải khoảng thời gian thực hiện. | `tasks.due_at` |
| Lịch cá nhân | Hoạt động riêng (học, làm thêm…), cũng chiếm thời gian khi kiểm tra trùng | `calendar_events` (`PERSONAL`) |
| Cuộc họp | Lịch họp + phòng họp WebRTC | `meetings` + `calendar_events` (`MEETING`) |
| Nhắc nhở | Thông báo vào thời điểm định trước cho công việc, lịch, cuộc họp hoặc nội dung tự do | `reminders` |

Lịch cá nhân, lịch nhóm, phiên công việc và cuộc họp cùng đọc từ **một bảng nguồn** `calendar_events`, nên không có hai bản ghi lệch nhau.

## 2. Ca sử dụng

| Mã | Ca sử dụng | Tác nhân |
|---|---|---|
| CV-01 | Tạo công việc cá nhân, đặt giờ thực hiện, hạn, ưu tiên, nhãn, nhắc nhở | Người dùng |
| CV-02 | Tạo công việc nhóm, giao cho một hoặc nhiều thành viên, chọn người chịu trách nhiệm chính | Thành viên nhóm |
| CV-03 | Sửa công việc, đổi người thực hiện, đổi giờ (kiểm tra trùng lịch) | Người tạo, người giao, trưởng/phó nhóm |
| CV-04 | Cập nhật tiến độ: Đang thực hiện, Tạm dừng, Chờ xác nhận | Người thực hiện |
| CV-05 | Xác nhận hoàn thành, mở lại, hủy (không xóa vật lý) | Người quản lý công việc |
| CV-06 | Bình luận, xem lịch sử thay đổi | Người xem được công việc |
| CV-07 | Thêm hoặc xóa phiên làm việc | Người quản lý công việc |
| LC-01 | Xem lịch của tôi theo ngày, tuần, tháng hoặc danh sách | Người dùng |
| LC-02 | Xem lịch nhóm, kèm lịch bận của từng thành viên và các xung đột | Thành viên nhóm |
| LC-03 | Kéo thả để đổi giờ. Máy chủ kiểm tra trùng; nếu thất bại, lịch về vị trí cũ và hiện giờ trống gợi ý. | Người có quyền với lịch |
| LC-04 | Kiểm tra trùng trước khi lưu | Người dùng |
| NN-01 | Đặt, sửa, hoãn, hủy nhắc nhở | Người dùng |
| HP-01 | Lên lịch họp, hoặc họp ngay với người được chọn hay với nhóm | Người dùng |
| HP-02 | Nhận hoặc từ chối lời mời | Người được mời |
| HP-03 | Tạo hoặc thu hồi link mời | Người tổ chức |
| HP-04 | Vào phòng: âm thanh, hình ảnh, bật/tắt mic và camera, chọn thiết bị, chia sẻ màn hình, chat, xem người tham gia | Người được phép |
| HP-05 | Đổi lịch, hủy, kết thúc cuộc họp | Người tổ chức |
| HP-06 | Xem lịch sử tham gia | Người tổ chức xem tất cả; người khác chỉ xem của mình |

## 3. Quy tắc nghiệp vụ

1. **Trùng lịch theo khoảng nửa mở `[bắt đầu, kết thúc)`.**
   - A trùng B khi `A.start < B.end` **và** `B.start < A.end`.
   - Lịch 9:00–10:00 và lịch 10:00–11:00 **không** trùng.
2. **Lịch nào chiếm thời gian:** phiên công việc, cuộc họp và lịch cá nhân. Lịch đã hủy thì không còn chiếm.
3. **Kiểm tra trùng chạy ở máy chủ** cho từng người tham gia. Giao diện chỉ kiểm tra trước để tiện người dùng.
   - Khi trùng, máy chủ trả `409 SCHEDULE_CONFLICT` kèm:
     - `conflicts`: người bị trùng, khoảng giờ, loại lịch, tiêu đề;
     - `suggestions`: tối đa 3 khung giờ trống cùng độ dài, tìm trong 3 ngày kể từ giờ đã chọn (bước 15 phút).
   - Tiêu đề lịch của người khác chỉ hiện khi người xem có quyền xem lịch đó; nếu không, hiện “Đang bận”.
4. **Thời gian hợp lệ:**
   - Kết thúc phải sau bắt đầu.
   - Một lịch dài tối đa 7 ngày.
   - Hạn hoàn thành phải sau giờ bắt đầu.
   - Lịch thực hiện không được kết thúc sau hạn hoàn thành.
5. **Công việc cá nhân** chỉ giao cho chính người tạo.
6. **Công việc nhóm** chỉ giao cho thành viên **hiện tại** của nhóm.
   - Có thể để trống người thực hiện; khi đó công việc nằm trong mục “chưa giao”.
   - Người chịu trách nhiệm chính phải nằm trong danh sách người thực hiện.
7. **Chuyển trạng thái hợp lệ** (sai quy tắc → `409 INVALID_TRANSITION`):

   | Từ | Sang |
   |---|---|
   | Chưa bắt đầu | Đang thực hiện, Chờ xác nhận, Hoàn thành, Hủy |
   | Đang thực hiện | Tạm dừng, Chờ xác nhận, Hoàn thành, Hủy |
   | Tạm dừng | Đang thực hiện, Hủy |
   | Chờ xác nhận | Hoàn thành, Đang thực hiện, Hủy |
   | Hoàn thành | Đang thực hiện (mở lại) |
   | Đã hủy | Chưa bắt đầu (mở lại; phải đặt lại lịch) |

   - Người thực hiện công việc **nhóm** chỉ được chuyển sang Đang thực hiện, Tạm dừng, Chờ xác nhận.
   - Hoàn thành, hủy, mở lại do người quản lý công việc làm.
   - Đổi trạng thái dùng LWT `IF status = <trạng thái đang đọc>`. Hai người đổi cùng lúc thì chỉ một người thắng; người kia nhận `409 TASK_CHANGED`.
8. **Hủy công việc:** hủy toàn bộ phiên trên lịch và các nhắc nhở liên quan. Không xóa vật lý.
9. **Rời nhóm** thì mất quyền với công việc và lịch của nhóm đó, kể cả công việc mình từng tạo.
10. **Cuộc họp:**
    - Phòng mở từ 15 phút trước giờ bắt đầu đến giờ kết thúc. Khi đang diễn ra (`LIVE`), phòng mở đến khi người tổ chức bấm kết thúc.
    - Hủy hoặc kết thúc thì không vào được nữa.
    - Họp ngay không chặn khi trùng lịch, chỉ cảnh báo.
    - Lên lịch họp thì chặn khi trùng lịch của người tổ chức hoặc khách mời.
    - Người được mời từ chối thì cuộc họp không còn chiếm lịch của người đó.

## 4. Ma trận quyền

| Thao tác | Người tạo / giao | Trưởng, phó nhóm | Người thực hiện | Thành viên nhóm khác | Người ngoài |
|---|---|---|---|---|---|
| Xem công việc nhóm | ✔ | ✔ | ✔ | ✔ | ✘ (404) |
| Xem công việc cá nhân | ✔ | – | ✔ (chính mình) | ✘ | ✘ (404) |
| Sửa, đổi người, đổi lịch, thêm phiên | ✔ | ✔ | ✘ | ✘ | ✘ |
| Đang thực hiện / Tạm dừng / Chờ xác nhận | ✔ | ✔ | ✔ | ✘ | ✘ |
| Hoàn thành, hủy, mở lại (công việc nhóm) | ✔ | ✔ | ✘ | ✘ | ✘ |
| Bình luận | ✔ | ✔ | ✔ | ✔ | ✘ |
| Đặt nhắc cho mình | ✔ | ✔ | ✔ | ✔ | ✘ |

| Thao tác cuộc họp | Người tổ chức | Người được mời | Thành viên nhóm (cuộc họp nhóm) | Người có link | Người ngoài |
|---|---|---|---|---|---|
| Xem, vào phòng | ✔ | ✔ | ✔ | ✔ (được thêm vào danh sách mời; cuộc họp nhóm phải là thành viên) | ✘ (404) |
| Mời thêm, đổi lịch, hủy, kết thúc, tạo hoặc thu hồi link | ✔ | ✘ | ✘ | ✘ | ✘ |
| Lịch sử tham gia | tất cả | của mình | của mình | của mình | ✘ |

Mọi quyền được kiểm tra ở backend, theo tài nguyên.
- Danh tính lấy từ phiên đăng nhập. Không nhận `userId` của người khác từ body.
- Không có quyền xem thì trả **404**, để không tiết lộ tài nguyên tồn tại khi người khác đoán ID (IDOR).

## 5. Lược đồ dữ liệu (migration 014, 015 – chỉ `CREATE TABLE IF NOT EXISTS`)

| Bảng | Khóa | Truy vấn |
|---|---|---|
| `tasks` | `task_id` | Bảng nguồn công việc |
| `tasks_by_user` | `(user_id), task_id DESC` | Công việc tôi tạo hoặc được giao |
| `tasks_by_group` | `(conversation_id), task_id DESC` | Công việc của nhóm |
| `task_comments_by_task` | `(task_id), comment_id` | Bình luận |
| `task_history_by_task` | `(task_id), event_id DESC` | Lịch sử thay đổi |
| `calendar_events` | `event_id` | Bảng nguồn mọi lịch |
| `events_by_user_day` | `((user_id, day)), start_at, event_id` | Lịch một người trong một ngày UTC (kiểm tra trùng) |
| `events_by_group_day` | `((conversation_id, day)), start_at, event_id` | Lịch nhóm theo ngày |
| `schedule_locks` | `user_id` | Khóa lịch theo người (LWT, TTL 15 giây) |
| `idempotency_keys` | `(user_id), idem_key` | Chống gửi lặp (TTL 24 giờ) |
| `reminders` | `reminder_id` | Bảng nguồn nhắc nhở |
| `reminders_by_user`, `reminders_by_target` | `(user_id)`, `((target_type, target_id))` | Danh sách nhắc; đổi giờ hoặc hủy theo đối tượng |
| `reminders_due` | `(bucket = giờ UTC), fire_at, reminder_id` | Worker lấy nhắc đến hạn |
| `notification_refs` | `(user_id), notification_id` | Liên kết thông báo với công việc hoặc cuộc họp (để mở đúng màn hình) |
| `meetings`, `meetings_by_user`, `meetings_by_group` | | Cuộc họp |
| `meeting_invitations` | `(meeting_id), user_id` | Lời mời và phản hồi |
| `meeting_links` | `invite_code` | Link mời (thu hồi được; hết hạn sau giờ kết thúc 1 giờ) |
| `meeting_participation` | `(meeting_id), session_id` | Lịch sử tham gia |

- Lịch kéo dài nhiều ngày có một dòng chỉ mục cho mỗi ngày nó chạm tới.
- Khi đọc, mỗi dòng chỉ mục được đối chiếu với bảng nguồn (còn hoạt động, đúng giờ, người đó còn tham gia). Dòng lệch bị bỏ qua và được dọn đi.

## 6. Nhất quán và đồng thời (Cassandra không có giao dịch nhiều bảng)

- **Khóa lịch theo người:**
  - Mỗi thao tác tạo hoặc đổi lịch giữ khóa `schedule_locks` (LWT `IF NOT EXISTS USING TTL 15`) cho **tất cả** người tham gia.
  - Khóa lấy theo thứ tự `user_id` tăng dần để tránh deadlock.
  - Sau khi giữ khóa mới kiểm tra trùng và ghi.
  - Hai yêu cầu cùng giờ cho cùng một người: đúng một yêu cầu thành công, yêu cầu kia nhận `409` (đã kiểm thử).
- **Thứ tự ghi:** bảng nguồn trước, chỉ mục sau.
  - Khi tạo công việc, phiên lịch được ghi trước (dưới khóa). Ghi công việc lỗi thì phiên bị hủy.
- **Chống gửi lặp:** header `Idempotency-Key` (hoặc `clientKey`).
  - Khóa được giữ bằng LWT trước khi tạo tài nguyên.
  - Gửi lại cùng khóa thì trả lại đúng tài nguyên đã tạo (`replayed: true`).
- **Giới hạn đã biết:**
  - Khóa có TTL. Nếu một thao tác chạy lâu hơn 15 giây (hiếm), khóa hết hạn trước khi xong.
  - Lỗi giữa chừng có thể để lại dòng chỉ mục lệch. Dòng này được bỏ qua và dọn khi đọc, không gây báo trùng sai.

## 7. Nhắc nhở bền vững

1. Worker chạy trong backend, mặc định mỗi 30 giây (`REMINDER_INTERVAL_SECONDS`). Mỗi lần nó đọc các nhóm giờ UTC trong 48 giờ gần nhất của `reminders_due`.
2. **Nhận việc bằng LWT** `PENDING → PROCESSING`. Nhiều tiến trình chạy cùng lúc thì chỉ một tiến trình gửi.
   - `PROCESSING` quá 5 phút (tiến trình chết giữa chừng) được nhận lại bằng `IF claim_id = <cũ>`.
3. Trước khi gửi, worker kiểm tra lại người nhận còn quyền xem đối tượng.
   - Đối tượng đã hủy, hoàn thành hoặc kết thúc thì nhắc chuyển `CANCELLED`.
4. Gửi qua hệ thống thông báo có sẵn với `dedupe_key = REMINDER:<id>`. Chạy lại sau sự cố **không** tạo thông báo thứ hai.
5. Lỗi thì thử lại sau 2, 4, 8 phút. Sau 3 lần chuyển `FAILED` và lưu `last_error`.
6. Đổi giờ hoặc hạn của công việc, cuộc họp hay lịch thì nhắc liên quan tự đổi theo.
7. Khởi động lại backend không mất nhắc, vì tất cả nằm trong Cassandra.

Đã kiểm thử các trường hợp:
- chưa đến giờ thì không gửi;
- đến giờ gửi đúng một lần;
- hai worker cùng chạy chỉ gửi một lần;
- khởi động lại không gửi lại;
- đổi hạn thì nhắc đổi giờ;
- hủy công việc thì nhắc bị hủy;
- lỗi gửi được thử lại, quá 3 lần thì `FAILED`;
- chỉ đúng người đặt nhắc nhận thông báo.

## 8. Họp trực tuyến – kiến trúc

**Chọn WebRTC mesh**: mỗi người kết nối P2P với từng người khác. Lý do:
- Không cần dịch vụ ngoài và không phát sinh chi phí; chạy được ngay trên máy phát triển (không có Docker).
- Phù hợp nhóm nhỏ 2–8 người (`MEETING_MAX_PARTICIPANTS`, mặc định 8).
- Nhóm lớn hơn nên chuyển sang SFU (LiveKit, mediasoup). Cấu trúc API (join → token, ICE server) đã tách sẵn để thay thế.

Backend **không** truyền âm thanh hay hình ảnh. Backend chỉ:
- **Cấp mã tham gia** (`POST /meetings/:id/join`):
  - HMAC-SHA256, gắn với người dùng, cuộc họp và phiên vào phòng; hạn tối đa 4 giờ.
  - Ký bằng `MEETING_TOKEN_SECRET`. Nếu không đặt, hệ thống sinh ngẫu nhiên mỗi lần khởi động; không hardcode.
  - Mã chỉ gửi trong body và header `X-Meeting-Token`, **không** đưa lên URL, không ghi log.
- **Cấp ICE server:**
  - STUN mặc định (`STUN_URLS`).
  - TURN chỉ khi có cấu hình (`TURN_URLS` + `TURN_SECRET`). Thông tin đăng nhập TURN là loại ngắn hạn kiểu coturn REST (`username = hạn:userId`, `credential = HMAC-SHA1`). `TURN_SECRET` không bao giờ gửi xuống trình duyệt.
- **Chuyển tiếp tín hiệu** offer, answer, ICE: `POST /meetings/:id/signal` gửi tới người nhận qua kênh SSE có sẵn (`meeting:signal`).
  - Người mới vào gửi offer cho từng người đang trong phòng, nên không xảy ra hai bên cùng gửi offer.
- **Quản lý phòng:**
  - Danh sách người trong phòng; heartbeat 15 giây; im lặng quá 45 giây thì bị dọn khỏi phòng.
  - Trạng thái mic, camera, chia sẻ màn hình.
  - Chat trong phòng (chỉ chuyển tiếp, **không lưu**).
  - Kết thúc phòng: chỉ người tổ chức.
- **Kết nối lại:**
  - Tải lại trang thì vào lại với phiên cũ (giữ trong `sessionStorage`), phiên cũ bị thay, không để lại “bóng ma”.
  - Mất mạng rồi có mạng lại thì tự vào lại.
  - ICE thất bại thì bên gửi offer thực hiện ICE restart.

**Giới hạn đã biết:**
- Danh sách người trong phòng nằm trong bộ nhớ tiến trình. Chạy nhiều backend cần chuyển danh sách này sang Redis.
- Mạng NAT nghiêm ngặt (4G, mạng công ty) cần TURN. Lần này chưa cấu hình và chưa thử TURN thật.

## 9. API

| Nhóm | Endpoint |
|---|---|
| Công việc | `GET /work/overview`, `GET/POST /tasks`, `GET/PATCH/DELETE /tasks/:id`, `POST /tasks/:id/status`, `POST/DELETE /tasks/:id/sessions[/:eventId]`, `GET/POST /tasks/:id/comments`, `PATCH/DELETE /tasks/:id/comments/:cid`, `GET /tasks/:id/history`, `GET /groups/:cid/tasks` |
| Lịch | `GET /calendar?from&to`, `GET /groups/:cid/calendar`, `GET /calendar/availability`, `POST /calendar/check`, `POST /calendar/events`, `PATCH/DELETE /calendar/events/:id` |
| Nhắc nhở | `GET/POST /reminders`, `PATCH/DELETE /reminders/:id`, `POST /reminders/:id/snooze` |
| Cuộc họp | `GET/POST /meetings`, `GET/PATCH/DELETE /meetings/:id`, `POST /meetings/:id/invitations`, `POST /meetings/:id/respond`, `POST/DELETE /meetings/:id/link`, `POST /meetings/links/:code`, `POST /meetings/:id/end`, `GET /meetings/:id/participants`, `GET /meetings/:id/history`, `GET /groups/:cid/meetings` |
| Phòng họp | `POST /meetings/:id/join`, `…/signal`, `…/heartbeat`, `…/media`, `…/chat`, `…/leave` (header `X-Meeting-Token`) |

- Lỗi có dạng chung `{ error: { code, message, … } }`.
- Sự kiện realtime: `task:changed`, `calendar:changed`, `meeting:changed`, `meeting:signal|joined|left|media|chat|ended`.
- Thông báo mới: `TASK_ASSIGNED`, `TASK_UPDATED`, `TASK_STATUS`, `TASK_COMMENT`, `MEETING_INVITE`, `MEETING_UPDATED`, `MEETING_CANCELLED`, `REMINDER`. Mỗi thông báo có `ref` để mở đúng công việc hoặc cuộc họp.

## 10. Biến môi trường mới (`backend/.env.example`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `MEETING_TOKEN_SECRET` | ngẫu nhiên mỗi lần chạy | Khóa ký mã tham gia phòng. Nên đặt khi chạy nhiều tiến trình. |
| `MEETING_MAX_PARTICIPANTS` | 8 | Số người tối đa mỗi phòng (mesh) |
| `STUN_URLS` | `stun:stun.l.google.com:19302` | Danh sách STUN, cách nhau dấu phẩy |
| `TURN_URLS`, `TURN_SECRET`, `TURN_TTL_SECONDS` | trống, trống, 3600 | TURN (coturn `use-auth-secret`) |
| `REMINDER_WORKER` | true | `false` để tắt worker nhắc nhở trên tiến trình này |
| `REMINDER_INTERVAL_SECONDS` | 30 | Chu kỳ quét nhắc đến hạn |
| `APP_TIMEZONE` | `Asia/Ho_Chi_Minh` | Múi giờ hiển thị giờ trong nội dung thông báo |
| `WORK_RATE_LIMIT`, `SIGNAL_RATE_LIMIT` | 120, 1200 / phút | Giới hạn tốc độ thao tác và tín hiệu |

## 11. Kết quả kiểm chứng (thực tế đã chạy)

| Hạng mục | Cách kiểm | Kết quả |
|---|---|---|
| Công việc, quyền, IDOR, chuyển trạng thái, bình luận, lịch sử | `backend/tests/work.test.js` | Đạt |
| Trùng lịch nửa mở, gợi ý giờ trống, quyền riêng tư “Đang bận” | như trên | Đạt |
| Đồng thời (2 yêu cầu cùng giờ), Idempotency-Key | như trên | Đạt |
| Kéo thả: dời được, dời vào giờ bận bị từ chối và lịch giữ nguyên | test API và thao tác kéo thả thật trên giao diện | Đạt |
| Nhắc nhở: đúng giờ, không trùng, nhiều worker, khởi động lại, đổi giờ, hủy, thử lại → FAILED | `work.test.js` | Đạt |
| Cuộc họp: mời, trùng lịch, phòng chưa mở, link mời và thu hồi, hủy | `work.test.js` | Đạt |
| Phòng họp: mã gắn người dùng, tín hiệu chỉ tới đúng người, chat, mic, kết thúc chỉ người tổ chức, vào lại thay phiên cũ | `work.test.js` | Đạt |
| **Âm thanh và hình ảnh thật qua WebRTC** | 2 trình duyệt Chrome riêng (2 phiên đăng nhập), camera và micro giả lập của Chrome; đọc `getStats()` | Đạt: kết nối `connected`; byte âm thanh và hình nhận được tăng ở cả hai phía; 173 khung hình được giải mã |
| Chia sẻ màn hình, chat, tắt mic, kết thúc họp, tải lại trang rồi vào lại | cùng phiên kiểm thử trên | Đạt |
| Hồi quy toàn bộ | `npm test` | 269/269 đạt |
| Build giao diện, lint | `vite build`, `oxlint` | Đạt (chỉ còn cảnh báo cùng loại với mã cũ) |

**Chưa kiểm chứng:**
- Chạy trên Apache Cassandra thật: máy phát triển không có Docker; kiểm thử dùng Cassandra giả lập của dự án.
- TURN thật và mạng NAT nghiêm ngặt.
- Thiết bị thật (camera, micro vật lý) và trình duyệt Safari/Firefox.
- Nhiều tiến trình backend cho phòng họp.
