// Tro ly AI (chatbot) dung Google Gemini. Moi nguoi co lich su hoi dap rieng (ai_chat_by_user).
// Gui kem toi da 20 luot gan nhat lam ngu canh. Khong co khoa -> 503 AI_NOT_CONFIGURED, ung dung van chay.
const db = require('../db');
const { httpError } = require('../utils/httpError');
const { TimeUuid, iso } = require('../utils/types');
const gemini = require('./lib/gemini');

const CONTEXT_TURNS = 20;
const MAX_INPUT = 4000;

function systemPrompt(user) {
    return [
        'Bạn là "Trợ lý ChatOTT", trợ lý AI trong ứng dụng nhắn tin ChatOTT (đồ án lưu lịch sử tin nhắn trên Apache Cassandra).',
        `Người dùng hiện tại tên là ${user.displayName}. Trả lời bằng ngôn ngữ người dùng dùng (mặc định tiếng Việt), ngắn gọn, rõ ràng, thân thiện.`,
        'Có thể giúp: soạn tin nhắn, viết bài đăng, tóm tắt, dịch, giải thích kiến thức, hướng dẫn dùng ChatOTT.',
        'Bạn KHÔNG đọc được tin nhắn, bài viết hay dữ liệu riêng của người dùng; nếu được hỏi về chúng, hãy nói rõ điều đó.',
        'Không bịa thông tin; khi không chắc chắn hãy nói là không chắc.'
    ].join(' ');
}

function status() {
    const c = gemini.config();
    return {
        configured: c.configured,
        provider: 'gemini',
        model: c.configured ? c.model : null,
        message: c.configured ? null : 'Chưa cấu hình Gemini: đặt GEMINI_API_KEY trong backend/.env rồi khởi động lại backend.'
    };
}

const toDto = r => ({ messageId: r.message_id.toString(), role: r.role, content: r.content, model: r.model || null, createdAt: iso(r.message_id.getDate()) });

async function history(user) {
    const rs = await db.execute(`SELECT message_id, role, content, model FROM ai_chat_by_user WHERE user_id = ? LIMIT 100`, [user.userId]);
    return { ...status(), items: rs.rows.map(toDto).reverse() };
}

async function ask(user, body = {}) {
    const text = typeof body.content === 'string' ? body.content.trim() : '';
    if (!text || text.length > MAX_INPUT) throw httpError(400, 'INVALID_CONTENT', `Câu hỏi cần từ 1 đến ${MAX_INPUT} ký tự.`);
    const st = status();
    if (!st.configured) throw httpError(503, 'AI_NOT_CONFIGURED', st.message);
    const prev = (await db.execute(`SELECT message_id, role, content FROM ai_chat_by_user WHERE user_id = ? LIMIT ${CONTEXT_TURNS}`, [user.userId]))
        .rows.reverse().map(r => ({ role: r.role, content: r.content }));
    const reply = await gemini.generate({ system: systemPrompt(user), messages: [...prev, { role: 'user', content: text }] });
    // Chi luu sau khi Gemini tra loi thanh cong (khong de lai cau hoi mo coi khi loi).
    const qid = TimeUuid.now();
    const aid = TimeUuid.now();
    const model = gemini.config().model;
    await db.execute('INSERT INTO ai_chat_by_user (user_id, message_id, role, content, model) VALUES (?, ?, ?, ?, ?)', [user.userId, qid, 'user', text, null]);
    await db.execute('INSERT INTO ai_chat_by_user (user_id, message_id, role, content, model) VALUES (?, ?, ?, ?, ?)',
        [user.userId, aid, 'assistant', reply.slice(0, 20000), model]);
    return {
        question: { messageId: qid.toString(), role: 'user', content: text, createdAt: iso(qid.getDate()) },
        answer: { messageId: aid.toString(), role: 'assistant', content: reply, model, createdAt: iso(aid.getDate()), aiGenerated: true }
    };
}

async function clear(user) {
    const rows = (await db.execute('SELECT message_id FROM ai_chat_by_user WHERE user_id = ?', [user.userId], { fetchSize: 5000 })).rows;
    for (const r of rows) await db.execute('DELETE FROM ai_chat_by_user WHERE user_id = ? AND message_id = ?', [user.userId, r.message_id]);
    return { cleared: rows.length };
}

module.exports = { status, history, ask, clear };
