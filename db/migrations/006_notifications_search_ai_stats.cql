-- Migration 006: thong bao, phan hoi binh luan, tim kiem lich su, AI tom tat, thong ke.
-- CHI THEM bang moi + 1 cot moi. Backfill (migrate.js) chi DOC bang cu, chi GHI bang moi.

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

-- Phan hoi binh luan: binh luan tham chieu binh luan duoc tra loi (cung bai).
ALTER TABLE post_comments ADD reply_to_comment_id timeuuid;

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
