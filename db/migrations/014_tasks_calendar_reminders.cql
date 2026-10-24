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
