-- Migration 013: cam xuc / tra loi / chia se tin (story), kieu chu cua tin, tro ly AI (Gemini).
-- CHI THEM bang moi. Khong sua bang cu.

-- Cam xuc ve 1 tin: moi nguoi 1 cam xuc / tin (ghi de khi doi). Ghi bang USING TTL nhu tin.
CREATE TABLE IF NOT EXISTS story_reactions (
    story_id timeuuid,
    user_id text,
    reaction text,
    reacted_at timestamp,
    PRIMARY KEY ((story_id), user_id)
);

-- Kieu trinh bay cua tin (phong chu, mau chu, can le, tin chia se lai tu ai). Ghi bang USING TTL nhu tin.
CREATE TABLE IF NOT EXISTS story_styles (
    story_id timeuuid PRIMARY KEY,
    font text,
    text_color text,
    text_align text,
    shared_from_id text,
    shared_from_name text
);

-- Tro ly AI: lich su hoi dap cua tung nguoi, moi nhat truoc.
CREATE TABLE IF NOT EXISTS ai_chat_by_user (
    user_id text,
    message_id timeuuid,
    role text,
    content text,
    model text,
    PRIMARY KEY ((user_id), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);
