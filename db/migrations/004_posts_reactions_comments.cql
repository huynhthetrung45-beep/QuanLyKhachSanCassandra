-- Migration 004: bai dang, anh, cam xuc, binh luan, chia se (Giai doan 2 - mang xa hoi).
-- CHI THEM bang moi + 1 cot moi (null tren dong cu). Khong sua / xoa du lieu cu.

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
    PRIMARY KEY ((post_id), comment_id)
) WITH CLUSTERING ORDER BY (comment_id ASC);

-- Chia se bai vao chat: tin nhan tham chieu bai (xem truoc duoc tai theo quyen cua tung nguoi xem).
ALTER TABLE messages_by_conversation ADD shared_post_id timeuuid;
