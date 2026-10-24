-- Migration 007: luong binh luan (tra loi), chong trung binh luan khi gui lai.
-- CHI THEM 3 bang moi + 1 cot moi (null tren dong cu). Backfill chi DOC post_comments, chi GHI 2 bang chi muc.

-- Q-C1: binh luan GOC (cap 1) cua 1 bai, cu nhat truoc, phan trang 20 bang paging state.
CREATE TABLE IF NOT EXISTS root_comments_by_post (
    post_id timeuuid,
    comment_id timeuuid,
    PRIMARY KEY ((post_id), comment_id)
) WITH CLUSTERING ORDER BY (comment_id ASC);

-- Q-C2: phan hoi cua 1 binh luan goc (moi phan hoi o moi cap deu gom ve goc), phan trang 20.
CREATE TABLE IF NOT EXISTS comment_replies_by_root (
    post_id timeuuid,
    root_comment_id timeuuid,
    comment_id timeuuid,
    PRIMARY KEY ((post_id, root_comment_id), comment_id)
) WITH CLUSTERING ORDER BY (comment_id ASC);

-- Q-C3: khoa chong trung do client sinh cho moi lan bam Gui (gui lai = cung khoa -> cung 1 binh luan). LWT.
CREATE TABLE IF NOT EXISTS comment_client_ids (
    post_id timeuuid,
    client_id uuid,
    comment_id timeuuid,
    author_id text,
    PRIMARY KEY ((post_id), client_id)
);

-- Goc cua luong cho binh luan moi (binh luan cu: tinh theo chuoi reply_to_comment_id).
ALTER TABLE post_comments ADD root_comment_id timeuuid;
