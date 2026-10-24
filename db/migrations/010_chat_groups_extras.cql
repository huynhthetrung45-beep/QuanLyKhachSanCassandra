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
