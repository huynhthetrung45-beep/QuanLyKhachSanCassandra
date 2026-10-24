// PT-26: AI goi y tra loi ngan + dich tin nhan. Dung CHUNG cau hinh voi ai.service
// (AI_PROVIDER=anthropic, ANTHROPIC_API_KEY, AI_MODEL). Thieu khoa -> 503 AI_NOT_CONFIGURED.
const db = require('../db');
const { httpError } = require('../utils/httpError');
const { parseTimeUuid, parseTimestamp } = require('../utils/types');
const conversations = require('../services/conversation.service');
const messageService = require('../services/message.service');
const ai = require('../services/ai.service');

const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 30000);
const LANGS = { vi: 'tiếng Việt', en: 'tiếng Anh', ja: 'tiếng Nhật', ko: 'tiếng Hàn', zh: 'tiếng Trung', fr: 'tiếng Pháp' };

let provider = null; // kiem thu gan provider gia lap
function setProvider(fn) { provider = fn; }

async function callModel({ system, prompt, maxTokens = 600 }) {
    if (provider) return provider({ system, prompt });
    const st = ai.status();
    if (!st.configured) throw httpError(503, 'AI_NOT_CONFIGURED', st.message);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: st.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] }),
            signal: controller.signal
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw httpError(502, 'AI_PROVIDER_ERROR', `Dịch vụ AI trả lỗi ${res.status}.`);
        return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    } catch (error) {
        if (error.name === 'AbortError') throw httpError(504, 'AI_TIMEOUT', 'Dịch vụ AI không phản hồi kịp, hãy thử lại.');
        if (error.status) throw error;
        throw httpError(502, 'AI_PROVIDER_ERROR', 'Không gọi được dịch vụ AI.');
    } finally {
        clearTimeout(timer);
    }
}

function parseJson(text) {
    const s = String(text || '');
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    try { return JSON.parse(s.slice(a, b + 1)); } catch { throw httpError(502, 'AI_BAD_OUTPUT', 'AI trả kết quả không đúng định dạng.'); }
}

async function suggestReplies(conversationId, user) {
    const { cid } = await conversations.requireMembership(conversationId, user.userId);
    const rs = await db.execute(
        'SELECT message_id, sender_id, sender_name, content, message_type, is_deleted FROM messages_by_conversation WHERE conversation_id = ? LIMIT 20', [cid]);
    const hidden = await messageService.hiddenSet(user.userId, cid, rs.rows.map(r => r.message_id));
    const msgs = rs.rows.filter(r => !r.is_deleted && r.content && r.message_type !== 'SYSTEM' && !hidden.has(r.message_id.toString())).reverse();
    if (msgs.length === 0) throw httpError(400, 'NOT_ENOUGH_MESSAGES', 'Chưa có tin nhắn để gợi ý trả lời.');
    const system = 'Bạn gợi ý câu trả lời ngắn cho người dùng trong cuộc trò chuyện. Trả về DUY NHẤT JSON {"suggestions": string[]} gồm 3 câu, mỗi câu tối đa 80 ký tự, cùng ngôn ngữ với cuộc trò chuyện, lịch sự, không bịa thông tin.';
    const prompt = [`Người cần trả lời: ${user.displayName}`, 'Tin nhắn gần đây (cũ -> mới):',
        ...msgs.map(m => `${m.sender_id === user.userId ? '(tôi) ' : ''}${m.sender_name}: ${m.content.replace(/\s+/g, ' ').slice(0, 500)}`)].join('\n');
    const raw = parseJson(await callModel({ system, prompt, maxTokens: 300 }));
    const suggestions = (Array.isArray(raw.suggestions) ? raw.suggestions : []).map(s => String(s).trim().slice(0, 120)).filter(Boolean).slice(0, 3);
    if (suggestions.length === 0) throw httpError(502, 'AI_BAD_OUTPUT', 'AI không đưa ra gợi ý nào.');
    return { suggestions, aiGenerated: true };
}

const cache = new Map();
async function translate(conversationId, messageId, user, body = {}) {
    const lang = String(body.targetLang || 'en').toLowerCase();
    if (!LANGS[lang]) throw httpError(400, 'INVALID_LANG', `Ngôn ngữ hỗ trợ: ${Object.keys(LANGS).join(', ')}.`);
    const mid = parseTimeUuid(messageId);
    const at = parseTimestamp(body.createdAt);
    const { cid } = await conversations.requireMembership(conversationId, user.userId);
    const m = await messageService.readByFullKey(cid, at, mid);
    if (!m || m.is_deleted || !m.content) throw httpError(404, 'MESSAGE_NOT_FOUND', 'Không có nội dung để dịch.');
    const key = `${mid}|${lang}|${m.content.length}`;
    if (cache.has(key)) return { ...cache.get(key), cached: true };
    const system = `Dịch chính xác tin nhắn sang ${LANGS[lang]}. Trả về DUY NHẤT JSON {"translation": string, "sourceLang": string}. Không thêm giải thích.`;
    const raw = parseJson(await callModel({ system, prompt: m.content.slice(0, 2000), maxTokens: 1200 }));
    const out = { messageId: mid.toString(), targetLang: lang, translation: String(raw.translation || '').slice(0, 4000), sourceLang: String(raw.sourceLang || '').slice(0, 20), aiGenerated: true };
    if (!out.translation) throw httpError(502, 'AI_BAD_OUTPUT', 'AI không trả bản dịch.');
    cache.set(key, out);
    if (cache.size > 2000) cache.clear();
    return out;
}

module.exports = { suggestReplies, translate, setProvider, LANGS };
