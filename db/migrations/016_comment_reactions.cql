-- Migration 016: tha cam xuc cho binh luan bai viet.
-- CHI THEM bang moi. Moi binh luan la 1 partition (post_id, comment_id): doc tong hop cam xuc cua 1 binh luan = doc 1 partition nho.
-- reaction: LIKE | LOVE | HAHA | WOW | SAD | ANGRY (moi nguoi 1 cam xuc / binh luan, tha lai = doi).
CREATE TABLE IF NOT EXISTS comment_reactions (
    post_id timeuuid,
    comment_id timeuuid,
    user_id text,
    reaction text,
    reacted_at timestamp,
    PRIMARY KEY ((post_id, comment_id), user_id)
);
