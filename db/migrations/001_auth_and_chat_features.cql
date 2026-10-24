-- Migration 001 - Tai khoan, phien dang nhap va tinh nang chat (Cassandra 4.1)
-- Nguyen tac: CHI THEM. Khong DROP, khong TRUNCATE, khong DELETE, khong doi khoa chinh,
-- khong doi compaction / TTL cua bang cu, khong doi keyspace.
-- Chay bang script (KHONG chay file nay truc tiep bang cqlsh):
--   npm run migrate:dry   -> chi doc system_schema, in ke hoach
--   npm run migrate       -> ap dung
-- Script kiem tra system_schema truoc moi buoc: bang/cot da dung -> bo qua;
-- da ton tai nhung SAI cau truc/kieu -> dung lai bao loi. Chay lai sau khi dung giua chung van an toan.
--
-- Thu tu: (1) tao bang moi, (2) them cot vao bang cu, (3) backfill trong script
-- (chi ghi vao 2 bang MOI: direct_conversations, users_by_name_token).

-- (1) Bang moi --------------------------------------------------------------

-- Dang nhap + email duy nhat. email (da trim + lowercase) la partition key; moi lenh
-- ghi vao bang nay deu la LWT (IF NOT EXISTS / IF ...). status: PENDING | ACTIVE.
CREATE TABLE IF NOT EXISTS accounts_by_email (
    email text PRIMARY KEY,
    user_id text,
    password_hash text,
    status text,
    created_at timestamp
);

-- Phien dang nhap: khoa = SHA-256(token). Het han bang USING TTL khi ghi.
CREATE TABLE IF NOT EXISTS sessions (
    session_hash text PRIMARY KEY,
    user_id text,
    created_at timestamp,
    expires_at timestamp
);

-- Hoi thoai 1-1 duy nhat: pair_key = hai user_id da sap xep, noi bang '|'.
CREATE TABLE IF NOT EXISTS direct_conversations (
    pair_key text PRIMARY KEY,
    conversation_id uuid,
    created_at timestamp
);

-- Trang thai rieng moi nguoi - moi hoi thoai: da doc toi dau, ghim.
CREATE TABLE IF NOT EXISTS conversation_state_by_user (
    user_id text,
    conversation_id uuid,
    last_read_at timestamp,
    pinned boolean,
    PRIMARY KEY ((user_id), conversation_id)
);

-- Tim nguoi theo tien to cua tung tu trong ten (bo dau).
-- Truy van: WHERE token_prefix = ? AND name_token >= ? AND name_token < ?
-- (Khong dat ten cot la "token": TOKEN la tu khoa CQL - ham token() - nen
--  "SELECT token, ..." / "token >= ?" bi loi cu phap.)
CREATE TABLE IF NOT EXISTS users_by_name_token (
    token_prefix text,
    name_token text,
    user_id text,
    display_name text,
    avatar_url text,
    PRIMARY KEY ((token_prefix), name_token, user_id)
) WITH CLUSTERING ORDER BY (name_token ASC, user_id ASC);

-- (2) Cot moi tren bang cu (dong cu nhan gia tri null) -----------------------

ALTER TABLE users ADD email text;
ALTER TABLE conversations ADD created_by text;
ALTER TABLE conversations_by_user ADD last_sender_id text;
