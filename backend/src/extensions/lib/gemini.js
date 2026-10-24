// Ket noi Google Gemini (Generative Language API, REST generateContent).
// Cau hinh: GEMINI_API_KEY (bat buoc), GEMINI_MODEL (mac dinh gemini-2.5-flash). Khoa chi nam o backend,
// gui qua header x-goog-api-key (khong dua vao URL), khong bao gio tra ve trinh duyet.
const { httpError } = require('../../utils/httpError');

const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 30000);

let override = null; // kiem thu gan ham gia lap: ({ system, messages }) => string
function setGenerator(fn) { override = fn; }

function config() {
    return {
        configured: Boolean(override || process.env.GEMINI_API_KEY),
        model: override ? 'gemini-test' : (process.env.GEMINI_MODEL || 'gemini-2.5-flash')
    };
}

// messages: [{ role: 'user' | 'assistant', content }]
async function generate({ system, messages, maxTokens = 1024, temperature = 0.7 }) {
    if (override) return override({ system, messages });
    const { configured, model } = config();
    if (!configured) {
        throw httpError(503, 'AI_NOT_CONFIGURED', 'Chưa cấu hình Gemini: đặt GEMINI_API_KEY trong backend/.env rồi khởi động lại backend.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
            body: JSON.stringify({
                systemInstruction: system ? { parts: [{ text: system }] } : undefined,
                contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
                generationConfig: { maxOutputTokens: maxTokens, temperature }
            }),
            signal: controller.signal
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
            // Khong ghi khoa / noi dung vao log; chi ma loi.
            const status = data?.error?.status ? ` (${data.error.status})` : '';
            throw httpError(502, 'AI_PROVIDER_ERROR', `Gemini trả lỗi ${res.status}${status}.`);
        }
        const cand = data?.candidates?.[0];
        const text = (cand?.content?.parts || []).map(p => p.text || '').join('').trim();
        if (!text) {
            if (cand?.finishReason === 'SAFETY' || data?.promptFeedback?.blockReason) {
                throw httpError(422, 'AI_BLOCKED', 'Gemini từ chối trả lời nội dung này vì lý do an toàn.');
            }
            throw httpError(502, 'AI_BAD_OUTPUT', 'Gemini không trả về nội dung.');
        }
        return text;
    } catch (error) {
        if (error.name === 'AbortError') throw httpError(504, 'AI_TIMEOUT', 'Gemini không phản hồi kịp, hãy thử lại.');
        if (error.status) throw error;
        throw httpError(502, 'AI_PROVIDER_ERROR', 'Không gọi được Gemini.');
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { generate, config, setGenerator };
