// AI tom tat hoi thoai + trich xuat cong viec (Huong 3).
//
// - Chi xu ly hoi thoai nguoi goi la thanh vien; bo tin da thu hoi / "xoa phia toi" cua nguoi goi.
// - Nha cung cap cau hinh bang bien moi truong (AI_PROVIDER=anthropic, ANTHROPIC_API_KEY, AI_MODEL);
//   KHONG hard-code khoa. Thieu cau hinh -> 503 AI_NOT_CONFIGURED, ung dung van chay binh thuong.
// - Moi ket luan luu source_message_ids; id nao khong thuoc tap tin da gui cho model se bi loai bo.
// - Ket qua AI la DE XUAT (status SUGGESTED); nguoi dung xac nhan / sua / bac bo.
const db = require('../db');
const { httpError } = require('../utils/httpError');
const { TimeUuid, iso } = require('../utils/types');
const conversations = require('./conversation.service');
const userService = require('./user.service');

const MAX_MESSAGES = 150;
const MAX_CHARS = 40000;
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 30000);
const STATUSES = ['SUGGESTED', 'CONFIRMED', 'REJECTED'];

function config() {
    const provider = (process.env.AI_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : '')).toLowerCase();
    const model = process.env.AI_MODEL || 'claude-haiku-5-5';
    const configured = provider === 'anthropic' && Boolean(process.env.ANTHROPIC_API_KEY);
    return { provider, model, configured };
}

// ----- Nha cung cap -----
async function anthropicProvider({ system, prompt, model }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({ model, max_tokens: 2000, system, messages: [{ role: 'user', content: prompt }] }),
            signal: controller.signal
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
            // Khong ghi khoa / noi dung hoi thoai vao log; chi ma loi.
            throw httpError(502, 'AI_PROVIDER_ERROR', `Dịch vụ AI trả lỗi ${res.status}${data?.error?.type ? ' (' + data.error.type + ')' : ''}.`);
        }
        return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    } catch (error) {
        if (error.name === 'AbortError') throw httpError(504, 'AI_TIMEOUT', 'Dịch vụ AI không phản hồi kịp, hãy thử lại.');
        if (error.status) throw error;
        throw httpError(502, 'AI_PROVIDER_ERROR', 'Không gọi được dịch vụ AI.');
    } finally {
        clearTimeout(timer);
    }
}

let provider = null; // test co the gan provider gia lap (khong dung khi chay that)
function setProvider(fn) { provider = fn; }
function activeProvider() {
    if (provider) return { call: provider, model: 'test-provider', configured: true };
    const c = config();
    return { call: c.configured ? anthropicProvider : null, model: c.model, configured: c.configured };
}

function status() {
    const p = activeProvider();
    return { configured: p.configured, model: p.configured ? p.model : null,
        message: p.configured ? null : 'Chưa cấu hình AI: đặt AI_PROVIDER=anthropic và ANTHROPIC_API_KEY trong backend/.env rồi khởi động lại backend.' };
}

// ----- Du lieu dau vao -----
async function recentMessages(cid, userId, limit) {
    const rs = await db.execute(
        `SELECT created_at, message_id, sender_id, sender_name, content, message_type, is_deleted
         FROM messages_by_conversation WHERE conversation_id = ? LIMIT ${limit}`, [cid]);
    const ids = rs.rows.map(r => r.message_id);
    let hidden = new Set();
    if (ids.length) {
        const marks = ids.map(() => '?').join(', ');
        hidden = new Set((await db.execute(
            `SELECT message_id FROM hidden_messages_by_user WHERE user_id = ? AND conversation_id = ? AND message_id IN (${marks})`,
            [userId, cid, ...ids])).rows.map(r => r.message_id.toString()));
    }
    const out = [];
    let chars = 0;
    for (const r of rs.rows) {
        if (r.is_deleted || r.message_type === 'SYSTEM' || !r.content || hidden.has(r.message_id.toString())) continue;
        chars += r.content.length;
        if (chars > MAX_CHARS) break;
        out.push(r);
    }
    return out.reverse(); // cu -> moi
}

function extractJson(text) {
    const s = String(text || '');
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start < 0 || end <= start) throw httpError(502, 'AI_BAD_OUTPUT', 'AI trả kết quả không đúng định dạng.');
    try { return JSON.parse(s.slice(start, end + 1)); } catch { throw httpError(502, 'AI_BAD_OUTPUT', 'AI trả kết quả không đúng định dạng.'); }
}

const toTid = id => TimeUuid.fromString(id);

async function summarize(conversationId, user, body = {}) {
    const p = activeProvider();
    if (!p.configured) throw httpError(503, 'AI_NOT_CONFIGURED', status().message);
    const { cid, members } = await conversations.requireMembership(conversationId, user.userId);
    const limit = Math.min(Math.max(Number(body.limit) || 100, 10), MAX_MESSAGES);
    const msgs = await recentMessages(cid, user.userId, limit);
    if (msgs.length < 2) throw httpError(400, 'NOT_ENOUGH_MESSAGES', 'Cần ít nhất 2 tin nhắn có nội dung để tóm tắt.');
    const profiles = await userService.getUsersByIds(members);
    const memberList = members.map(id => ({ id, name: profiles.get(id)?.displayName || id }));
    const allowed = new Set(msgs.map(m => m.message_id.toString()));

    const system = [
        'Bạn là trợ lý tóm tắt cuộc trò chuyện tiếng Việt. Chỉ dựa vào tin nhắn được cung cấp; không suy diễn ngoài nội dung.',
        'Trả về DUY NHẤT một đối tượng JSON: {"summary": string, "summary_source_ids": string[],',
        '"tasks": [{"title": string, "assignee_id": string|null, "due_date": "YYYY-MM-DD"|null, "source_message_ids": string[]}]}.',
        'source ids phải là id trong ngoặc vuông của tin nhắn liên quan. assignee_id chỉ lấy từ danh sách thành viên, nếu không rõ thì null.',
        'due_date chỉ điền khi tin nhắn nêu rõ hạn; nếu không thì null. Tối đa 10 công việc.'
    ].join(' ');
    const prompt = [
        'Thành viên: ' + memberList.map(m => `${m.id} = ${m.name}`).join('; '),
        `Hôm nay: ${new Date().toISOString().slice(0, 10)}`,
        'Tin nhắn (cũ -> mới):',
        ...msgs.map(m => `[${m.message_id}] (${iso(m.created_at)}) ${m.sender_name}: ${m.content.replace(/\s+/g, ' ')}`)
    ].join('\n');

    const raw = extractJson(await p.call({ system, prompt, model: p.model }));
    const keep = ids => [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(id => allowed.has(id)))];
    const summaryText = String(raw.summary || '').trim().slice(0, 4000);
    if (!summaryText) throw httpError(502, 'AI_BAD_OUTPUT', 'AI không trả về nội dung tóm tắt.');
    const summaryId = TimeUuid.now();
    const now = summaryId.getDate();
    const sources = keep(raw.summary_source_ids);
    await db.execute(
        `INSERT INTO ai_summaries_by_conversation (conversation_id, summary_id, requested_by, summary, source_message_ids, model, message_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [cid, summaryId, user.userId, summaryText, sources.map(toTid), p.model, msgs.length, now]
    );
    const tasks = (Array.isArray(raw.tasks) ? raw.tasks : []).slice(0, 10).map(t => ({
        title: String(t.title || '').trim().slice(0, 300),
        assigneeId: members.includes(t.assignee_id) ? t.assignee_id : null,
        dueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(t.due_date || '')) ? String(t.due_date) : null,
        sources: keep(t.source_message_ids)
    })).filter(t => t.title && t.sources.length); // cong viec khong truy nguyen duoc tin nguon -> bo
    for (const t of tasks) {
        await db.execute(
            `INSERT INTO ai_tasks_by_conversation (conversation_id, task_id, summary_id, title, assignee_id, due_date, status, source_message_ids, updated_by, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'SUGGESTED', ?, ?, ?)`,
            [cid, TimeUuid.now(), summaryId, t.title, t.assigneeId, t.dueDate, t.sources.map(toTid), user.userId, now]
        );
    }
    return overview(conversationId, user);
}

async function overview(conversationId, user) {
    const { cid, members } = await conversations.requireMembership(conversationId, user.userId);
    const [summaries, tasks] = await Promise.all([
        db.execute('SELECT summary_id, requested_by, summary, source_message_ids, model, message_count, created_at FROM ai_summaries_by_conversation WHERE conversation_id = ? LIMIT 5', [cid]),
        db.execute('SELECT task_id, summary_id, title, assignee_id, due_date, status, source_message_ids, updated_by, updated_at FROM ai_tasks_by_conversation WHERE conversation_id = ? LIMIT 50', [cid])
    ]);
    const profiles = await userService.getUsersByIds(members);
    const name = id => (id ? profiles.get(id)?.displayName || id : null);
    return {
        ...status(),
        summaries: summaries.rows.map(s => ({
            summaryId: s.summary_id.toString(), summary: s.summary, model: s.model, messageCount: s.message_count,
            requestedBy: name(s.requested_by), createdAt: iso(s.created_at),
            sourceMessageIds: [...(s.source_message_ids || [])].map(String), aiGenerated: true
        })),
        tasks: tasks.rows.map(t => ({
            taskId: t.task_id.toString(), summaryId: t.summary_id ? t.summary_id.toString() : null, title: t.title,
            assigneeId: t.assignee_id || null, assigneeName: name(t.assignee_id), dueDate: t.due_date || null, status: t.status,
            sourceMessageIds: [...(t.source_message_ids || [])].map(String), updatedBy: name(t.updated_by), updatedAt: iso(t.updated_at)
        })),
        members: members.map(id => ({ userId: id, displayName: name(id) }))
    };
}

async function updateTask(conversationId, taskId, user, body = {}) {
    const { cid, members } = await conversations.requireMembership(conversationId, user.userId);
    let tid;
    try { tid = TimeUuid.fromString(String(taskId)); } catch { throw httpError(400, 'INVALID_ID', 'taskId không hợp lệ.'); }
    const row = (await db.execute('SELECT title, assignee_id, due_date, status FROM ai_tasks_by_conversation WHERE conversation_id = ? AND task_id = ?', [cid, tid])).first();
    if (!row) throw httpError(404, 'TASK_NOT_FOUND', 'Không tìm thấy công việc.');
    const title = body.title === undefined ? row.title : String(body.title).trim();
    if (!title || title.length > 300) throw httpError(400, 'INVALID_TITLE', 'Tên công việc 1–300 ký tự.');
    const assignee = body.assigneeId === undefined ? row.assignee_id : (body.assigneeId || null);
    if (assignee && !members.includes(assignee)) throw httpError(400, 'INVALID_ASSIGNEE', 'Người phụ trách phải là thành viên hội thoại.');
    const due = body.dueDate === undefined ? row.due_date : (body.dueDate || null);
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw httpError(400, 'INVALID_DUE', 'Hạn phải có dạng YYYY-MM-DD.');
    const st = body.status === undefined ? row.status : String(body.status).toUpperCase();
    if (!STATUSES.includes(st)) throw httpError(400, 'INVALID_STATUS', 'Trạng thái không hợp lệ.');
    await db.execute(
        'UPDATE ai_tasks_by_conversation SET title = ?, assignee_id = ?, due_date = ?, status = ?, updated_by = ?, updated_at = ? WHERE conversation_id = ? AND task_id = ?',
        [title, assignee, due, st, user.userId, new Date(), cid, tid]
    );
    return overview(conversationId, user);
}

module.exports = { status, summarize, overview, updateTask, setProvider };
