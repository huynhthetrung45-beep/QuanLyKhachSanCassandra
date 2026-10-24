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
