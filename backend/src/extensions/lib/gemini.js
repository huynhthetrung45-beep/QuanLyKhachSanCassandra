// Ket noi Google Gemini (Generative Language API, REST generateContent).
// Cau hinh: GEMINI_API_KEY (bat buoc), GEMINI_MODEL (mac dinh gemini-flash-latest). Khoa chi nam o backend,
// gui qua header x-goog-api-key (khong dua vao URL), khong bao gio tra ve trinh duyet.
// Google ngung dan cac model cu (vd gemini-2.5-flash tra 404 voi khoa moi): model cau hinh bi 404 thi tu chuyen
// sang bi danh gemini-flash-latest (Google luon tro toi ban Flash hien hanh).
const { httpError } = require('../../utils/httpError');

const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 30000);
const FALLBACK_MODEL = 'gemini-flash-latest';

let override = null; // kiem thu gan ham gia lap: ({ system, messages }) => string
function setGenerator(fn) { override = fn; }
let replaced = null; // model cau hinh bi 404 -> dung FALLBACK_MODEL cho cac lan sau

function config() {
    const wanted = process.env.GEMINI_MODEL || FALLBACK_MODEL;
    return {
        configured: Boolean(override || process.env.GEMINI_API_KEY),
        model: override ? 'gemini-test' : (replaced === wanted ? FALLBACK_MODEL : wanted)
    };
}

// messages: [{ role: 'user' | 'assistant', content }]
async function generate(input) {
    if (override) return override({ system: input.system, messages: input.messages });
    const { configured, model } = config();
    if (!configured) {
        throw httpError(503, 'AI_NOT_CONFIGURED', 'Chưa cấu hình Gemini: đặt GEMINI_API_KEY trong backend/.env rồi khởi động lại backend.');
    }
    try {
        return await callModel(model, input);
    } catch (error) {
        if (error.providerStatus !== 404 || model === FALLBACK_MODEL) throw error;
        console.warn(`[gemini] Model ${model} không còn khả dụng (404), chuyển sang ${FALLBACK_MODEL}. Nên sửa GEMINI_MODEL trong backend/.env.`);
        replaced = model;
        return callModel(FALLBACK_MODEL, input);
    }
}

async function callModel(model, { system, messages, maxTokens = 1024, temperature = 0.7 }) {
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
            const err = httpError(502, 'AI_PROVIDER_ERROR', res.status === 404
                ? `Model Gemini “${model}” không còn khả dụng; đổi GEMINI_MODEL trong backend/.env (ví dụ gemini-flash-latest).`
                : `Gemini trả lỗi ${res.status}${status}.`);
            err.providerStatus = res.status;
            throw err;
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
