-- Migration 003: ho so, ket ban, chan (Giai doan 1 - mang xa hoi).
-- CHI THEM BANG MOI. Khong sua / xoa bang hay du lieu cu.

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
