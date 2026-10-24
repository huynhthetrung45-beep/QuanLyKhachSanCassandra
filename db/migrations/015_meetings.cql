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
