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
