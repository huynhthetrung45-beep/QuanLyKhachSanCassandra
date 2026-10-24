-- Migration 005: bang tin nhieu nguoi dung + dem luot chia se (Giai doan 2, bo sung).
-- CHI THEM 2 bang moi. Backfill (trong migrate.js) chi DOC bang posts va chi GHI vao 2 bang nay.

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
