
-- =====================================================
-- Chat OTT - Apache Cassandra 4.1
-- Keyspace: chat_ott
-- Dung cho moi truong demo 1 node, RF = 1
--
-- File nay mo ta TOAN BO luoc do (ban cai moi).
-- Voi CSDL dang chay co du lieu, KHONG can chay lai file nay:
-- hay chay "npm run migrate" (chi them bang/cot, khong DROP/TRUNCATE).
-- =====================================================

CREATE KEYSPACE IF NOT EXISTS chat_ott
WITH replication = {
    'class': 'SimpleStrategy',
    'replication_factor': 1
};

USE chat_ott;

-- 1. Danh sach nguoi dung (ho so cong khai)
--    email: bo sung o migration 001 (chi de hien thi trong /auth/me)
CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    display_name TEXT,
    avatar_url TEXT,
    email TEXT,
    created_at TIMESTAMP
);

-- 2. Thong tin cuoc tro chuyen
--    created_by: bo sung o migration 001 (truong nhom)
CREATE TABLE IF NOT EXISTS conversations (
    conversation_id UUID PRIMARY KEY,
    conversation_name TEXT,
    conversation_type TEXT,
    participant_ids SET<TEXT>,
    created_by TEXT,
    last_message_at TIMESTAMP,
    created_at TIMESTAMP
);

-- 3. Danh sach cuoc tro chuyen theo nguoi dung (phi chuan hoa)
--    last_sender_id: bo sung o migration 001 (tinh trang thai chua doc)
CREATE TABLE IF NOT EXISTS conversations_by_user (
    user_id TEXT,
    last_message_at TIMESTAMP,
    conversation_id UUID,
    conversation_name TEXT,
    conversation_type TEXT,
    last_message_preview TEXT,
    last_sender_name TEXT,
    last_sender_id TEXT,
    PRIMARY KEY ((user_id), last_message_at, conversation_id)
) WITH CLUSTERING ORDER BY (
    last_message_at DESC,
    conversation_id ASC
);

-- 4. Lich su tin nhan theo cuoc tro chuyen (BANG TRONG TAM)
--    Moi conversation_id la mot partition logic rieng.
--    message_id (TimeUUID) la khoa sap xep phu: phan biet 2 tin cung mili-giay.
CREATE TABLE IF NOT EXISTS messages_by_conversation (
    conversation_id UUID,
    created_at TIMESTAMP,
    message_id TIMEUUID,
    sender_id TEXT,
    sender_name TEXT,
    content TEXT,
    message_type TEXT,
    is_deleted BOOLEAN,
    deleted_at TIMESTAMP,
    reply_to_id TIMEUUID,          -- migration 002
    reply_to_created_at TIMESTAMP, -- migration 002
    attachment_ids LIST<UUID>,     -- migration 002
    forwarded BOOLEAN,             -- migration 002
    shared_post_id TIMEUUID,       -- migration 004
    PRIMARY KEY ((conversation_id), created_at, message_id)
) WITH CLUSTERING ORDER BY (
    created_at DESC,
    message_id DESC
);

-- ===== Migration 001: tai khoan, phien dang nhap, tinh nang chat =====

-- 5. Tai khoan dang nhap, tra cuu theo email.
--    Cassandra khong co UNIQUE: email la partition key va ban ghi duoc tao
--    bang INSERT ... IF NOT EXISTS (Lightweight Transaction) de chong trung.
CREATE TABLE IF NOT EXISTS accounts_by_email (
    email TEXT PRIMARY KEY,
    user_id TEXT,
    password_hash TEXT,
    status TEXT,              -- PENDING (dang dang ky) | ACTIVE
    created_at TIMESTAMP
);

-- 6. Phien dang nhap. Khoa la SHA-256 cua token (khong luu token goc).
--    Het han tu dong bang TTL; dang xuat = DELETE dong.
CREATE TABLE IF NOT EXISTS sessions (
    session_hash TEXT PRIMARY KEY,
    user_id TEXT,
    created_at TIMESTAMP,
    expires_at TIMESTAMP
);

-- 7. Chong tao trung hoi thoai 1-1: pair_key = "userA|userB" (da sap xep).
CREATE TABLE IF NOT EXISTS direct_conversations (
    pair_key TEXT PRIMARY KEY,
    conversation_id UUID,
    created_at TIMESTAMP
);

-- 8. Trang thai rieng cua tung nguoi voi tung hoi thoai: da doc toi dau, ghim.
CREATE TABLE IF NOT EXISTS conversation_state_by_user (
    user_id TEXT,
    conversation_id UUID,
    last_read_at TIMESTAMP,
    pinned BOOLEAN,
    PRIMARY KEY ((user_id), conversation_id)
);

-- 9. Tim nguoi theo tien to cua tung tu trong ten (da bo dau, chu thuong).
--    Partition = 2 ky tu dau cua token; tim tien to = lat cat clustering lien tuc.
CREATE TABLE IF NOT EXISTS users_by_name_token (
    token_prefix TEXT,
    name_token TEXT,          -- khong dung ten "token": tu khoa CQL
    user_id TEXT,
    display_name TEXT,
    avatar_url TEXT,
    PRIMARY KEY ((token_prefix), name_token, user_id)
) WITH CLUSTERING ORDER BY (
    name_token ASC,
    user_id ASC
);

-- ===== Migration 002: tra loi, cam xuc, chuyen tiep, xoa phia toi, tep =====

-- 10. Cam xuc: moi nguoi toi da 1 / tin.
CREATE TABLE IF NOT EXISTS reactions_by_message (
    conversation_id UUID,
    message_id TIMEUUID,
    user_id TEXT,
    emoji TEXT,
    reacted_at TIMESTAMP,
    PRIMARY KEY ((conversation_id), message_id, user_id)
) WITH CLUSTERING ORDER BY (
    message_id DESC,
    user_id ASC
);

-- 11. Metadata tep dinh kem (noi dung tep o UPLOAD_DIR, khong o Cassandra).
CREATE TABLE IF NOT EXISTS attachments_by_conversation (
    conversation_id UUID,
    attachment_id TIMEUUID,
    uploader_id TEXT,
    message_id TIMEUUID,
    message_created_at TIMESTAMP,
    kind TEXT,
    mime_type TEXT,
    file_name TEXT,
    size_bytes BIGINT,
    sha256 TEXT,
    storage_key TEXT,
    status TEXT,
    created_at TIMESTAMP,
    PRIMARY KEY ((conversation_id), attachment_id)
) WITH CLUSTERING ORDER BY (
    attachment_id DESC
);

-- 12. Xoa phia toi.
CREATE TABLE IF NOT EXISTS hidden_messages_by_user (
    user_id TEXT,
    conversation_id UUID,
    message_id TIMEUUID,
    hidden_at TIMESTAMP,
    PRIMARY KEY ((user_id, conversation_id), message_id)
) WITH CLUSTERING ORDER BY (
    message_id DESC
);

-- ===== migration 003 =====

-- Q-P1: xem / sua ho so mo rong theo user_id (users giu display_name, avatar_url, email).
CREATE TABLE IF NOT EXISTS user_profiles (
    user_id text PRIMARY KEY,
    username text,
    bio text,
    updated_at timestamp
);

-- Q-P2: username duy nhat (LWT IF NOT EXISTS khi nhan, DELETE IF user_id = ? khi bo).
CREATE TABLE IF NOT EXISTS usernames (
    username text PRIMARY KEY,
    user_id text,
    created_at timestamp
);

-- Q-F0: trang thai quan he cua MOT cap nguoi dung (pair_key = id nho|id lon).
-- Moi lenh ghi deu la LWT -> khong co trang thai trung / mau thuan khi 2 ben bam cung luc.
-- status: PENDING (requester_id la nguoi gui) | FRIENDS. Khong co dong = khong quan he.
CREATE TABLE IF NOT EXISTS relationships (
    pair_key text PRIMARY KEY,
    status text,
    requester_id text,
    updated_at timestamp
);

-- Q-F1: loi moi den cua toi.
CREATE TABLE IF NOT EXISTS friend_requests_by_receiver (
    receiver_id text,
    sender_id text,
    created_at timestamp,
    PRIMARY KEY ((receiver_id), sender_id)
);

-- Q-F2: loi moi toi da gui.
CREATE TABLE IF NOT EXISTS friend_requests_by_sender (
    sender_id text,
    receiver_id text,
    created_at timestamp,
    PRIMARY KEY ((sender_id), receiver_id)
);

-- Q-F3: danh sach ban be cua toi.
CREATE TABLE IF NOT EXISTS friends_by_user (
    user_id text,
    friend_id text,
    since timestamp,
    PRIMARY KEY ((user_id), friend_id)
);

-- Q-B1: danh sach toi chan; kiem tra chan 2 chieu = 2 lan doc theo khoa day du.
CREATE TABLE IF NOT EXISTS blocked_users_by_user (
    user_id text,
    blocked_id text,
    created_at timestamp,
    PRIMARY KEY ((user_id), blocked_id)
);

-- ===== migration 004 =====
-- Q-PO1: doc 1 bai theo id (nguon su that; xoa mem bang is_deleted).
-- shared_post_id: bai chia se chi luu THAM CHIEU bai goc, khong sao chep noi dung.
CREATE TABLE IF NOT EXISTS posts (
    post_id timeuuid PRIMARY KEY,
    author_id text,
    content text,
    privacy text,
    media_ids list<timeuuid>,
    shared_post_id timeuuid,
    created_at timestamp,
    updated_at timestamp,
    is_deleted boolean
);

-- Q-PO2: dong thoi gian cua 1 nguoi, moi nhat truoc, phan trang bang con tro post_id < ?.
-- Bang tin = gop posts_by_author cua toi + ban be luc doc (fan-out on read).
CREATE TABLE IF NOT EXISTS posts_by_author (
    author_id text,
    post_id timeuuid,
    PRIMARY KEY ((author_id), post_id)
) WITH CLUSTERING ORDER BY (post_id DESC);

-- Q-PO3: metadata anh cua bai (noi dung anh nam o UPLOAD_DIR/posts). MOI lenh ghi la LWT.
-- status: PENDING (vua tai len, chi chu so huu) -> ATTACHED (thuoc post_id).
CREATE TABLE IF NOT EXISTS post_media (
    media_id timeuuid PRIMARY KEY,
    owner_id text,
    post_id timeuuid,
    status text,
    mime_type text,
    file_name text,
    size_bytes bigint,
    sha256 text,
    storage_key text,
    created_at timestamp
);

-- Q-PO4: cam xuc cua 1 bai; khoa (post_id, user_id) -> moi nguoi dung 1 cam xuc / bai.
CREATE TABLE IF NOT EXISTS post_reactions (
    post_id timeuuid,
    user_id text,
    reaction text,
    reacted_at timestamp,
    PRIMARY KEY ((post_id), user_id)
);

-- Q-PO5: binh luan cua 1 bai, cu nhat truoc, phan trang bang paging state.
CREATE TABLE IF NOT EXISTS post_comments (
    post_id timeuuid,
    comment_id timeuuid,
    author_id text,
    content text,
    created_at timestamp,
    updated_at timestamp,
    is_deleted boolean,
    reply_to_comment_id timeuuid,
    root_comment_id timeuuid,
    PRIMARY KEY ((post_id), comment_id)
) WITH CLUSTERING ORDER BY (comment_id ASC);


-- ===== migration 005 =====
-- Q-PO6: bai CONG KHAI moi nhat cua MOI nguoi (bang tin), theo thang de partition khong lon vo han.
-- Doc: bucket = 'YYYY-MM' AND post_id < con_tro LIMIT 20, lui dan tung thang. Quyen van kiem tra lai
-- tren bang posts khi doc (dong cu khi bai doi quyen / bi xoa chi bi loc bo, khong lo noi dung).
CREATE TABLE IF NOT EXISTS public_posts_by_month (
    bucket text,
    post_id timeuuid,
    author_id text,
    PRIMARY KEY ((bucket), post_id)
) WITH CLUSTERING ORDER BY (post_id DESC);

-- Q-PO7: luot chia se cua 1 bai (len bang tin hoac vao chat); dem = so dong trong partition.
CREATE TABLE IF NOT EXISTS post_shares (
    post_id timeuuid,
    share_id timeuuid,
    user_id text,
    kind text,
    PRIMARY KEY ((post_id), share_id)
);

-- ===== migration 006 =====
-- ===== Thong bao =====
-- Q-N1: thong bao cua toi, moi nhat truoc, phan trang paging state.
CREATE TABLE IF NOT EXISTS notifications_by_user (
    user_id text,
    notification_id timeuuid,
    actor_id text,
    type text,
    post_id timeuuid,
    comment_id timeuuid,
    conversation_id uuid,
    preview text,
    event_count int,
    is_read boolean,
    PRIMARY KEY ((user_id), notification_id)
) WITH CLUSTERING ORDER BY (notification_id DESC);

-- Q-N2: chong trung khi retry / bam nhieu lan: 1 khoa su kien -> 1 thong bao. MOI lenh ghi la LWT.
CREATE TABLE IF NOT EXISTS notification_keys (
    user_id text,
    dedupe_key text,
    notification_id timeuuid,
    PRIMARY KEY ((user_id), dedupe_key)
);


-- ===== Tim kiem lich su (Huong 2) =====
-- Q-S1: tu khoa (da bo dau, chu thuong) -> tin nhan chua tu do trong 1 hoi thoai, moi nhat truoc.
-- Tim nhieu tu: doc theo tu hiem nhat roi kiem tra cac tu con lai tren dong tin (doc theo khoa day du).
CREATE TABLE IF NOT EXISTS message_terms_by_conversation (
    conversation_id uuid,
    term text,
    created_at timestamp,
    message_id timeuuid,
    PRIMARY KEY ((conversation_id, term), created_at, message_id)
) WITH CLUSTERING ORDER BY (created_at DESC, message_id DESC);

-- ===== AI tom tat & cong viec (Huong 3) =====
-- Q-A1: cac ban tom tat cua 1 hoi thoai, moi nhat truoc; luu source_message_ids de truy nguyen.
CREATE TABLE IF NOT EXISTS ai_summaries_by_conversation (
    conversation_id uuid,
    summary_id timeuuid,
    requested_by text,
    summary text,
    source_message_ids list<timeuuid>,
    model text,
    message_count int,
    created_at timestamp,
    PRIMARY KEY ((conversation_id), summary_id)
) WITH CLUSTERING ORDER BY (summary_id DESC);

-- Q-A2: cong viec AI de xuat; nguoi dung xac nhan / sua / bac bo (status SUGGESTED | CONFIRMED | REJECTED).
CREATE TABLE IF NOT EXISTS ai_tasks_by_conversation (
    conversation_id uuid,
    task_id timeuuid,
    summary_id timeuuid,
    title text,
    assignee_id text,
    due_date text,
    status text,
    source_message_ids list<timeuuid>,
    updated_by text,
    updated_at timestamp,
    PRIMARY KEY ((conversation_id), task_id)
) WITH CLUSTERING ORDER BY (task_id DESC);

-- ===== Thong ke (Huong 4): bang tong hop cap nhat khi ghi, khong quet du lieu khi mo trang =====
-- Q-T1: so tin theo ngay (Asia/Ho_Chi_Minh, 'YYYY-MM-DD') cua 1 hoi thoai.
CREATE TABLE IF NOT EXISTS conversation_daily_stats (
    conversation_id uuid,
    day text,
    messages counter,
    PRIMARY KEY ((conversation_id), day)
) WITH CLUSTERING ORDER BY (day DESC);

-- Q-T2: so tin theo gio trong ngay (0-23).
CREATE TABLE IF NOT EXISTS conversation_hourly_stats (
    conversation_id uuid,
    hour int,
    messages counter,
    PRIMARY KEY ((conversation_id), hour)
);

-- Q-T3: so tin theo loai noi dung (TEXT, ATTACHMENT, POST_SHARE, SYSTEM).
CREATE TABLE IF NOT EXISTS conversation_type_stats (
    conversation_id uuid,
    message_type text,
    messages counter,
    PRIMARY KEY ((conversation_id), message_type)
);

-- Q-T4: so tin theo nguoi gui.
CREATE TABLE IF NOT EXISTS conversation_sender_stats (
    conversation_id uuid,
    sender_id text,
    messages counter,
    PRIMARY KEY ((conversation_id), sender_id)
);

-- Q-T5: thong ke mang xa hoi cua 1 nguoi (posts, comments_made, comments_received, reactions_made,
-- reactions_received, shares_received). Tach rieng khoi thong ke tin nhan.
CREATE TABLE IF NOT EXISTS user_social_stats (
    user_id text,
    metric text,
    amount counter,
    PRIMARY KEY ((user_id), metric)
);

-- ===== migration 007 =====
-- Q-C1: binh luan GOC (cap 1) cua 1 bai, cu nhat truoc, phan trang 20 bang paging state.
CREATE TABLE IF NOT EXISTS root_comments_by_post (
    post_id timeuuid,
    comment_id timeuuid,
    PRIMARY KEY ((post_id), comment_id)
) WITH CLUSTERING ORDER BY (comment_id ASC);

-- Q-C2: phan hoi cua 1 binh luan goc (moi phan hoi o moi cap deu gom ve goc), phan trang 20.
CREATE TABLE IF NOT EXISTS comment_replies_by_root (
    post_id timeuuid,
    root_comment_id timeuuid,
    comment_id timeuuid,
    PRIMARY KEY ((post_id, root_comment_id), comment_id)
) WITH CLUSTERING ORDER BY (comment_id ASC);

-- Q-C3: khoa chong trung do client sinh cho moi lan bam Gui (gui lai = cung khoa -> cung 1 binh luan). LWT.
CREATE TABLE IF NOT EXISTS comment_client_ids (
    post_id timeuuid,
    client_id uuid,
    comment_id timeuuid,
    author_id text,
    PRIMARY KEY ((post_id), client_id)
);

-- migration 008: tin nhan da ghim theo hoi thoai
CREATE TABLE IF NOT EXISTS pinned_messages_by_conversation (
    conversation_id UUID,
    message_id TIMEUUID,
    message_created_at TIMESTAMP,
    pinned_by TEXT,
    pinned_at TIMESTAMP,
    PRIMARY KEY ((conversation_id), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);

-- ===== 009_account_security.cql =====
-- Migration 009: tai khoan & bao mat (PT-01, PT-02, PT-03, PT-04, PT-09, PT-17, NFR-16 2FA).
-- CHI THEM bang moi. Khong sua / xoa bang cu. TTL dat o cau lenh ghi (USING TTL), khong dat tren bang.

-- Trang thai bao mat cua tai khoan: vai tro, khoa, moc doi mat khau, xac minh email, 2FA.
CREATE TABLE IF NOT EXISTS account_security (
    user_id text PRIMARY KEY,
    email text,
    role text,
    locked boolean,
    locked_reason text,
    locked_at timestamp,
    locked_by text,
    password_changed_at timestamp,
    email_verified_at timestamp,
    verification_required boolean,
    totp_secret text,
    totp_enabled boolean,
    updated_at timestamp
);

-- PT-01, PT-17: cac phien dang nhap cua 1 nguoi (dang xuat tu xa, huy phien khi doi mat khau).
CREATE TABLE IF NOT EXISTS sessions_by_user (
    user_id text,
    session_hash text,
    created_at timestamp,
    last_seen_at timestamp,
    user_agent text,
    ip text,
    two_factor_ok boolean,
    PRIMARY KEY ((user_id), session_hash)
);

-- PT-02: token dat lai mat khau (chi luu SHA-256), ghi bang USING TTL 1800, dung mot lan.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_hash text PRIMARY KEY,
    user_id text,
    email text,
    created_at timestamp
);

-- PT-09: ma xac minh email (chi luu hash), ghi bang USING TTL.
CREATE TABLE IF NOT EXISTS email_verification_codes (
    user_id text PRIMARY KEY,
    code_hash text,
    email text,
    expires_at timestamp,
    attempts int
);

-- PT-04: anh dai dien / anh bia (noi dung tep tren o dia, Cassandra chi giu khoa luu tru).
CREATE TABLE IF NOT EXISTS user_media (
    user_id text PRIMARY KEY,
    avatar_key text,
    avatar_mime text,
    cover_key text,
    cover_mime text,
    updated_at timestamp
);

-- Han che 3.3: "lan cuoi truy cap" luu ben vung, khong mat khi khoi dong lai backend.
CREATE TABLE IF NOT EXISTS user_last_seen (
    user_id text PRIMARY KEY,
    last_seen_at timestamp
);

-- ===== 010_chat_groups_extras.cql =====
-- Migration 010: tin nhan & nhom mo rong (PT-05, PT-06, PT-10, PT-11, PT-12, PT-13, PT-19, PT-20, PT-21).
-- CHI THEM bang moi. Bang messages_by_conversation giu nguyen; thong tin them cua tin nam o bang rieng.

-- Thong tin them cua tin nhan: da sua, binh chon, sticker, tin thoai, nhac ten, xem truoc lien ket.
CREATE TABLE IF NOT EXISTS message_meta_by_conversation (
    conversation_id uuid,
    message_id timeuuid,
    kind text,
    edited_at timestamp,
    edit_count int,
    poll_id timeuuid,
    sticker_id text,
    voice_ms int,
    mention_ids set<text>,
    link_url text,
    link_title text,
    link_description text,
    link_image text,
    link_site text,
    PRIMARY KEY ((conversation_id), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);

-- PT-06: lich su sua cua 1 tin, moi nhat truoc.
CREATE TABLE IF NOT EXISTS message_edits_by_message (
    conversation_id uuid,
    message_id timeuuid,
    edited_at timestamp,
    previous_content text,
    editor_id text,
    PRIMARY KEY ((conversation_id, message_id), edited_at)
) WITH CLUSTERING ORDER BY (edited_at DESC);

-- PT-05: vai tro trong nhom (OWNER van la conversations.created_by; bang nay giu DEPUTY / MEMBER).
CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id uuid,
    user_id text,
    role text,
    updated_at timestamp,
    updated_by text,
    PRIMARY KEY ((conversation_id), user_id)
);

-- PT-05: nhan quyen truong nhom cho nhom cu chua co truong nhom (LWT IF NOT EXISTS, chi 1 nguoi thang).
CREATE TABLE IF NOT EXISTS group_owner_claims (
    conversation_id uuid PRIMARY KEY,
    user_id text,
    claimed_at timestamp
);

-- PT-10: anh va mo ta nhom.
CREATE TABLE IF NOT EXISTS group_profiles (
    conversation_id uuid PRIMARY KEY,
    description text,
    avatar_key text,
    avatar_mime text,
    updated_at timestamp,
    updated_by text
);

-- PT-11: tat thong bao / luu tru hoi thoai (rieng tung nguoi).
CREATE TABLE IF NOT EXISTS conversation_prefs_by_user (
    user_id text,
    conversation_id uuid,
    muted_until timestamp,
    archived boolean,
    updated_at timestamp,
    PRIMARY KEY ((user_id), conversation_id)
);

-- PT-13: cac lan duoc nhac ten, moi nhat truoc.
CREATE TABLE IF NOT EXISTS mentions_by_user (
    user_id text,
    created_at timestamp,
    message_id timeuuid,
    conversation_id uuid,
    actor_id text,
    preview text,
    PRIMARY KEY ((user_id), created_at, message_id)
) WITH CLUSTERING ORDER BY (created_at DESC, message_id DESC);

-- PT-19: link moi vao nhom.
CREATE TABLE IF NOT EXISTS group_invite_links (
    invite_code text PRIMARY KEY,
    conversation_id uuid,
    created_by text,
    created_at timestamp,
    require_approval boolean,
    revoked boolean
);

CREATE TABLE IF NOT EXISTS invite_links_by_conversation (
    conversation_id uuid,
    invite_code text,
    created_by text,
    created_at timestamp,
    require_approval boolean,
    revoked boolean,
    PRIMARY KEY ((conversation_id), invite_code)
);

-- PT-19: yeu cau tham gia cho duyet.
CREATE TABLE IF NOT EXISTS group_join_requests (
    conversation_id uuid,
    user_id text,
    requested_at timestamp,
    invite_code text,
    PRIMARY KEY ((conversation_id), user_id)
);

-- PT-20: binh chon trong nhom.
CREATE TABLE IF NOT EXISTS polls_by_conversation (
    conversation_id uuid,
    poll_id timeuuid,
    question text,
    options list<text>,
    multiple boolean,
    created_by text,
    message_id timeuuid,
    message_created_at timestamp,
    closed boolean,
    PRIMARY KEY ((conversation_id), poll_id)
) WITH CLUSTERING ORDER BY (poll_id DESC);

CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id timeuuid,
    user_id text,
    choices set<int>,
    voted_at timestamp,
    PRIMARY KEY ((poll_id), user_id)
);

-- ===== 011_social_notifications_extras.cql =====
-- Migration 011: mang xa hoi & thong bao mo rong (PT-14, PT-15, PT-22, PT-23, PT-24, PT-25).
-- CHI THEM bang moi. Story het han nho USING TTL 86400 o cau lenh ghi.

-- PT-22: bai da luu (danh sach theo thoi diem luu + khoa de bat/tat).
CREATE TABLE IF NOT EXISTS saved_posts_by_user (
    user_id text,
    saved_at timestamp,
    post_id timeuuid,
    PRIMARY KEY ((user_id), saved_at, post_id)
) WITH CLUSTERING ORDER BY (saved_at DESC, post_id DESC);

CREATE TABLE IF NOT EXISTS saved_post_keys (
    user_id text,
    post_id timeuuid,
    saved_at timestamp,
    PRIMARY KEY ((user_id), post_id)
);

-- PT-23: story 24 gio cua 1 tac gia, moi nhat truoc.
CREATE TABLE IF NOT EXISTS stories_by_author (
    author_id text,
    story_id timeuuid,
    content text,
    background text,
    media_key text,
    media_mime text,
    created_at timestamp,
    PRIMARY KEY ((author_id), story_id)
) WITH CLUSTERING ORDER BY (story_id DESC);

CREATE TABLE IF NOT EXISTS story_views (
    story_id timeuuid,
    viewer_id text,
    viewed_at timestamp,
    PRIMARY KEY ((story_id), viewer_id)
);

-- PT-24: hashtag -> bai viet (moi nhat truoc) va bai -> hashtag (de don khi sua / xoa bai).
CREATE TABLE IF NOT EXISTS posts_by_hashtag (
    hashtag text,
    post_id timeuuid,
    author_id text,
    PRIMARY KEY ((hashtag), post_id)
) WITH CLUSTERING ORDER BY (post_id DESC);

CREATE TABLE IF NOT EXISTS hashtags_by_post (
    post_id timeuuid,
    hashtag text,
    PRIMARY KEY ((post_id), hashtag)
);

-- PT-25: loai thong bao muon nhan (khong co dong = bat).
CREATE TABLE IF NOT EXISTS notification_settings_by_user (
    user_id text,
    type text,
    enabled boolean,
    PRIMARY KEY ((user_id), type)
);

-- PT-14: dang ky Web Push cua tung trinh duyet.
CREATE TABLE IF NOT EXISTS push_subscriptions_by_user (
    user_id text,
    endpoint_hash text,
    endpoint text,
    p256dh text,
    auth text,
    user_agent text,
    created_at timestamp,
    PRIMARY KEY ((user_id), endpoint_hash)
);

-- PT-15: cong viec AI da xac nhan, gom theo ngay den han (YYYY-MM-DD) de bo hen gio chi doc vai partition.
CREATE TABLE IF NOT EXISTS task_reminders_by_day (
    due_day text,
    task_id timeuuid,
    conversation_id uuid,
    title text,
    assignee_id text,
    reminded boolean,
    created_at timestamp,
    PRIMARY KEY ((due_day), task_id)
);

-- ===== 012_moderation_admin.cql =====
-- Migration 012: bao cao vi pham, kiem duyet, quan tri (PT-07, PT-08, PT-16).
-- CHI THEM bang moi.

-- PT-07: ban ghi bao cao (nguon su that).
CREATE TABLE IF NOT EXISTS reports (
    report_id timeuuid PRIMARY KEY,
    reporter_id text,
    target_type text,
    target_id text,
    target_owner_id text,
    conversation_id uuid,
    post_id timeuuid,
    message_created_at timestamp,
    reason text,
    details text,
    excerpt text,
    status text,
    created_at timestamp,
    resolved_by text,
    resolved_at timestamp,
    resolution text
);

-- Hang doi cho quan tri: bao cao theo trang thai (OPEN / RESOLVED / DISMISSED), moi nhat truoc.
CREATE TABLE IF NOT EXISTS reports_by_status (
    status text,
    report_id timeuuid,
    target_type text,
    target_id text,
    reporter_id text,
    reason text,
    excerpt text,
    PRIMARY KEY ((status), report_id)
) WITH CLUSTERING ORDER BY (report_id DESC);

-- Chong bao cao trung: 1 nguoi bao cao 1 doi tuong 1 lan (LWT IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS report_keys (
    reporter_id text,
    target_key text,
    report_id timeuuid,
    PRIMARY KEY ((reporter_id), target_key)
);

-- PT-08: nhat ky kiem duyet theo ngay, moi nhat truoc.
CREATE TABLE IF NOT EXISTS moderation_log (
    day text,
    action_id timeuuid,
    admin_id text,
    action text,
    target_type text,
    target_id text,
    note text,
    PRIMARY KEY ((day), action_id)
) WITH CLUSTERING ORDER BY (action_id DESC);

-- PT-08: noi dung bi quan tri vien an (de khoi phuc dung noi dung do).
CREATE TABLE IF NOT EXISTS moderation_state (
    target_key text PRIMARY KEY,
    hidden boolean,
    hidden_by text,
    hidden_at timestamp,
    note text
);


-- ===== 013_story_reactions_ai_assistant.cql =====
-- Migration 013: cam xuc / tra loi / chia se tin (story), kieu chu cua tin, tro ly AI (Gemini).
-- CHI THEM bang moi. Khong sua bang cu.

-- Cam xuc ve 1 tin: moi nguoi 1 cam xuc / tin (ghi de khi doi). Ghi bang USING TTL nhu tin.
CREATE TABLE IF NOT EXISTS story_reactions (
    story_id timeuuid,
    user_id text,
    reaction text,
    reacted_at timestamp,
    PRIMARY KEY ((story_id), user_id)
);

-- Kieu trinh bay cua tin (phong chu, mau chu, can le, tin chia se lai tu ai). Ghi bang USING TTL nhu tin.
CREATE TABLE IF NOT EXISTS story_styles (
    story_id timeuuid PRIMARY KEY,
    font text,
    text_color text,
    text_align text,
    shared_from_id text,
    shared_from_name text
);

-- Tro ly AI: lich su hoi dap cua tung nguoi, moi nhat truoc.
CREATE TABLE IF NOT EXISTS ai_chat_by_user (
    user_id text,
    message_id timeuuid,
    role text,
    content text,
    model text,
    PRIMARY KEY ((user_id), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);

-- ===== 014_tasks_calendar_reminders.cql =====
-- Migration 014: cong viec, lich thong nhat, chong trung lich, nhac nho.
-- CHI THEM bang moi. Khong sua / xoa bang cu. Thoi gian luu UTC (timestamp).

-- ===== Cong viec =====
-- Bang nguon cua cong viec (1 dong / cong viec).
CREATE TABLE IF NOT EXISTS tasks (
    task_id timeuuid PRIMARY KEY,
    title text,
    description text,
    scope text,
    conversation_id uuid,
    creator_id text,
    assigner_id text,
    assignee_ids set<text>,
    lead_id text,
    start_at timestamp,
    end_at timestamp,
    due_at timestamp,
    priority text,
    status text,
    labels set<text>,
    primary_event_id timeuuid,
    session_ids set<timeuuid>,
    created_at timestamp,
    updated_at timestamp,
    completed_at timestamp
);

-- Q-T1: cong viec lien quan toi 1 nguoi (tao / duoc giao), moi nhat truoc. Chi luu id + vai tro.
CREATE TABLE IF NOT EXISTS tasks_by_user (
    user_id text,
    task_id timeuuid,
    is_creator boolean,
    is_assignee boolean,
    PRIMARY KEY ((user_id), task_id)
) WITH CLUSTERING ORDER BY (task_id DESC);

-- Q-T2: cong viec cua 1 nhom, moi nhat truoc.
CREATE TABLE IF NOT EXISTS tasks_by_group (
    conversation_id uuid,
    task_id timeuuid,
    PRIMARY KEY ((conversation_id), task_id)
) WITH CLUSTERING ORDER BY (task_id DESC);

-- Q-T3: binh luan cua cong viec, cu -> moi.
CREATE TABLE IF NOT EXISTS task_comments_by_task (
    task_id timeuuid,
    comment_id timeuuid,
    author_id text,
    content text,
    edited_at timestamp,
    is_deleted boolean,
    PRIMARY KEY ((task_id), comment_id)
) WITH CLUSTERING ORDER BY (comment_id ASC);

-- Q-T4: lich su thay doi cong viec, moi nhat truoc.
CREATE TABLE IF NOT EXISTS task_history_by_task (
    task_id timeuuid,
    event_id timeuuid,
    actor_id text,
    action text,
    detail text,
    PRIMARY KEY ((task_id), event_id)
) WITH CLUSTERING ORDER BY (event_id DESC);

-- ===== Lich thong nhat (phien lam viec, cuoc hop, hoat dong ca nhan) =====
-- Bang nguon cua 1 su kien lich. kind: TASK_SESSION | MEETING | PERSONAL. status: ACTIVE | CANCELLED.
CREATE TABLE IF NOT EXISTS calendar_events (
    event_id timeuuid PRIMARY KEY,
    kind text,
    title text,
    owner_id text,
    conversation_id uuid,
    task_id timeuuid,
    meeting_id timeuuid,
    participant_ids set<text>,
    start_at timestamp,
    end_at timestamp,
    status text,
    visibility text,
    created_at timestamp,
    updated_at timestamp
);

-- Q-C1: lich ban cua 1 nguoi theo ngay UTC (su kien keo dai nhieu ngay co dong o moi ngay).
-- Kiem tra trung lich chi doc vai partition (nguoi, ngay), khong quet bang.
CREATE TABLE IF NOT EXISTS events_by_user_day (
    user_id text,
    day text,
    start_at timestamp,
    event_id timeuuid,
    end_at timestamp,
    kind text,
    PRIMARY KEY ((user_id, day), start_at, event_id)
);

-- Q-C2: lich chung cua 1 nhom theo ngay UTC.
CREATE TABLE IF NOT EXISTS events_by_group_day (
    conversation_id uuid,
    day text,
    start_at timestamp,
    event_id timeuuid,
    end_at timestamp,
    kind text,
    PRIMARY KEY ((conversation_id, day), start_at, event_id)
);

-- Khoa dat lich theo nguoi (LWT IF NOT EXISTS, ghi kem USING TTL de khong ket khi tien trinh chet).
CREATE TABLE IF NOT EXISTS schedule_locks (
    user_id text PRIMARY KEY,
    holder text,
    acquired_at timestamp
);

-- Chong gui lap (Idempotency-Key): 1 khoa / nguoi -> 1 tai nguyen. Ghi kem USING TTL 1 ngay.
CREATE TABLE IF NOT EXISTS idempotency_keys (
    user_id text,
    idem_key text,
    resource_type text,
    resource_id text,
    created_at timestamp,
    PRIMARY KEY ((user_id), idem_key)
);

-- ===== Nhac nho =====
-- Bang nguon. status: PENDING | PROCESSING | SENT | FAILED | CANCELLED.
CREATE TABLE IF NOT EXISTS reminders (
    reminder_id timeuuid PRIMARY KEY,
    user_id text,
    target_type text,
    target_id text,
    offset_minutes int,
    anchor text,
    fire_at timestamp,
    note text,
    status text,
    attempts int,
    claim_id text,
    claimed_at timestamp,
    last_error text,
    sent_at timestamp,
    created_at timestamp,
    updated_at timestamp
);

-- Q-R1: nhac nho cua 1 nguoi.
CREATE TABLE IF NOT EXISTS reminders_by_user (
    user_id text,
    reminder_id timeuuid,
    PRIMARY KEY ((user_id), reminder_id)
) WITH CLUSTERING ORDER BY (reminder_id DESC);

-- Q-R2: nhac nho theo doi tuong (cong viec / su kien / cuoc hop) de cap nhat khi doi lich / huy.
CREATE TABLE IF NOT EXISTS reminders_by_target (
    target_type text,
    target_id text,
    reminder_id timeuuid,
    PRIMARY KEY ((target_type, target_id), reminder_id)
);

-- Q-R3: nhac nho den han theo gio UTC ('YYYY-MM-DDTHH'): worker chi doc vai partition gio gan day.
CREATE TABLE IF NOT EXISTS reminders_due (
    bucket text,
    fire_at timestamp,
    reminder_id timeuuid,
    PRIMARY KEY ((bucket), fire_at, reminder_id)
);

-- Tham chieu tai nguyen cho thong bao moi (cong viec / cuoc hop) - bang notifications_by_user giu nguyen.
CREATE TABLE IF NOT EXISTS notification_refs (
    user_id text,
    notification_id timeuuid,
    ref_type text,
    ref_id text,
    PRIMARY KEY ((user_id), notification_id)
);

-- ===== 015_meetings.cql =====
-- Migration 015: hop truc tuyen (lich hop, loi moi, lich su tham gia).
-- CHI THEM bang moi. Cassandra chi luu thong tin cuoc hop; am thanh / hinh anh truyen bang WebRTC.

-- Bang nguon cua cuoc hop. status: SCHEDULED | LIVE | ENDED | CANCELLED. join_policy: INVITED | GROUP.
CREATE TABLE IF NOT EXISTS meetings (
    meeting_id timeuuid PRIMARY KEY,
    title text,
    description text,
    organizer_id text,
    conversation_id uuid,
    start_at timestamp,
    end_at timestamp,
    status text,
    join_policy text,
    event_id timeuuid,
    invite_code text,
    invite_revoked boolean,
    actual_start timestamp,
    actual_end timestamp,
    created_at timestamp,
    updated_at timestamp
);

-- Q-M1: cuoc hop cua 1 nguoi (to chuc / duoc moi), moi nhat truoc.
CREATE TABLE IF NOT EXISTS meetings_by_user (
    user_id text,
    meeting_id timeuuid,
    role text,
    PRIMARY KEY ((user_id), meeting_id)
) WITH CLUSTERING ORDER BY (meeting_id DESC);

-- Q-M2: cuoc hop cua 1 nhom.
CREATE TABLE IF NOT EXISTS meetings_by_group (
    conversation_id uuid,
    meeting_id timeuuid,
    PRIMARY KEY ((conversation_id), meeting_id)
) WITH CLUSTERING ORDER BY (meeting_id DESC);

-- Q-M3: loi moi cua 1 cuoc hop. status: PENDING | ACCEPTED | DECLINED.
CREATE TABLE IF NOT EXISTS meeting_invitations (
    meeting_id timeuuid,
    user_id text,
    status text,
    invited_by text,
    invited_at timestamp,
    responded_at timestamp,
    PRIMARY KEY ((meeting_id), user_id)
);

-- Link moi: ma ngau nhien -> cuoc hop (thu hoi duoc, het han theo cuoc hop).
CREATE TABLE IF NOT EXISTS meeting_links (
    invite_code text PRIMARY KEY,
    meeting_id timeuuid,
    created_by text,
    expires_at timestamp,
    revoked boolean
);

-- Q-M4: lich su tham gia (moi lan vao phong la 1 phien).
CREATE TABLE IF NOT EXISTS meeting_participation (
    meeting_id timeuuid,
    session_id timeuuid,
    user_id text,
    joined_at timestamp,
    left_at timestamp,
    PRIMARY KEY ((meeting_id), session_id)
);

-- ===== migration 016: cam xuc binh luan =====
CREATE TABLE IF NOT EXISTS comment_reactions (
    post_id timeuuid,
    comment_id timeuuid,
    user_id text,
    reaction text,
    reacted_at timestamp,
    PRIMARY KEY ((post_id, comment_id), user_id)
);
