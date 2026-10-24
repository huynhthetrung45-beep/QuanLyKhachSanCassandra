// Tim kiem lich su tin nhan (Huong 2).
//
// Truy van (khong quet toan bo Cassandra, khong ALLOW FILTERING):
//   - Co tu khoa: doc message_terms_by_conversation theo (conversation_id, term) cua TU DAI NHAT
//     (thuong hiem nhat), gioi han thoi gian bang clustering created_at, roi doc dong tin theo khoa day du
//     de kiem tra cac tu con lai va bo loc (nguoi gui, loai, tep).
//   - Khong co tu khoa (chi loc): doc partition tin nhan theo khoang thoi gian, moi lan toi da SCAN dong.
// Chi tim trong hoi thoai nguoi goi la THANH VIEN; bo tin da thu hoi va tin da "xoa phia toi".
// Ket qua moi nhat truoc, phan trang bang con tro = message_id cuoi (timeuuid, thu tu on dinh).
const db = require('../db');
const { httpError } = require('../utils/httpError');
const { TimeUuid, iso } = require('../utils/types');
const { termsOf } = require('../utils/searchTerms');
const { compareDesc } = require('../utils/postTime');
const conversations = require('./conversation.service');
const attachments = require('./attachment.service');

const PAGE = 20;
const INDEX_LIMIT = 50;   // so dong chi muc / hoi thoai / lan goi
const SCAN = 200;         // so dong tin / hoi thoai / lan goi khi khong co tu khoa
const MAX_CONVERSATIONS = 50;
const TYPES = ['TEXT', 'ATTACHMENT', 'POST_SHARE', 'IMAGE', 'FILE'];

const MSG_COLS = `conversation_id, created_at, message_id, sender_id, sender_name, content, message_type,
                  is_deleted, attachment_ids, shared_post_id`;

// ===== Ghi chi muc (goi khi gui / chuyen tiep tin) =====
async function indexMessage(conversationId, { messageId, createdAt, content, fileNames = [] }) {
    const terms = termsOf(content, ...fileNames);
    await Promise.all(terms.map(term => db.execute(
        'INSERT INTO message_terms_by_conversation (conversation_id, term, created_at, message_id) VALUES (?, ?, ?, ?)',
        [conversationId, term, createdAt, messageId]
    ))).catch(error => console.warn('Không ghi được chỉ mục tìm kiếm:', error.message));
}

// ===== Tim kiem =====
function parseDate(value, name) {
    if (value === undefined || value === '') return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw httpError(400, 'INVALID_DATE', `${name} không hợp lệ.`);
    return d;
}

function parseQuery(query) {
    const q = String(query.q || '').trim();
    if (q.length > 200) throw httpError(400, 'INVALID_QUERY', 'Từ khóa tối đa 200 ký tự.');
    const terms = termsOf(q);
    if (q && terms.length === 0) throw httpError(400, 'INVALID_QUERY', 'Từ khóa cần ít nhất 2 chữ cái hoặc chữ số.');
    const type = query.type ? String(query.type).toUpperCase() : null;
    if (type && !TYPES.includes(type)) throw httpError(400, 'INVALID_TYPE', 'Loại nội dung không hợp lệ.');
    const from = parseDate(query.from, 'from');
    let to = parseDate(query.to, 'to');
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(String(query.to))) to = new Date(to.getTime() + 86400000 - 1); // het ngay
    if (from && to && from > to) throw httpError(400, 'INVALID_DATE', 'Khoảng thời gian không hợp lệ.');
    let cursor = null;
    if (query.cursor) {
        try { cursor = TimeUuid.fromString(String(query.cursor)); } catch { throw httpError(400, 'INVALID_CURSOR', 'cursor không hợp lệ.'); }
    }
    const senderId = query.senderId ? String(query.senderId) : null;
    const hasFile = query.hasFile === '1' || query.hasFile === 'true';
    return { q, terms, type, from, to, cursor, senderId, hasFile, conversationId: query.conversationId || null };
}

async function targetConversations(user, conversationId) {
    if (conversationId) {
        const { cid } = await conversations.requireMembership(String(conversationId), user.userId);
        const list = await conversations.listForUser(user);
        const meta = list.find(c => c.conversationId === cid.toString());
        return [{ cid, name: meta ? meta.displayName : 'Hội thoại' }];
    }
    const list = (await conversations.listForUser(user)).slice(0, MAX_CONVERSATIONS);
    return list.map(c => ({ cid: require('cassandra-driver').types.Uuid.fromString(c.conversationId), name: c.displayName }));
}

// Gioi han thoi gian tren clustering created_at: <= min(to, thoi diem con tro), >= from.
function timeBounds(f) {
    const upper = [f.to, f.cursor ? f.cursor.getDate() : null].filter(Boolean).sort((a, b) => a - b)[0] || null;
    let where = '';
    const params = [];
    if (upper) { where += ' AND created_at <= ?'; params.push(upper); }
    if (f.from) { where += ' AND created_at >= ?'; params.push(f.from); }
    return { where, params };
}

async function candidatesFromIndex(cid, f) {
    const driver = [...f.terms].sort((a, b) => b.length - a.length)[0];
    const { where, params } = timeBounds(f);
    const rs = await db.execute(
        `SELECT created_at, message_id FROM message_terms_by_conversation WHERE conversation_id = ? AND term = ?${where} LIMIT ${INDEX_LIMIT}`,
        [cid, driver, ...params]
    );
    const rows = await Promise.all(rs.rows.map(r => db.execute(
        `SELECT ${MSG_COLS} FROM messages_by_conversation WHERE conversation_id = ? AND created_at = ? AND message_id = ?`,
        [cid, r.created_at, r.message_id]
    ).then(x => x.first())));
    return { rows: rows.filter(Boolean), complete: rs.rows.length < INDEX_LIMIT };
}

async function candidatesFromScan(cid, f) {
    const { where, params } = timeBounds(f);
    const rs = await db.execute(`SELECT ${MSG_COLS} FROM messages_by_conversation WHERE conversation_id = ?${where} LIMIT ${SCAN}`,
        [cid, ...params]);
    return { rows: rs.rows, complete: rs.rows.length < SCAN };
}

async function hiddenFor(userId, cid, ids) {
    if (ids.length === 0) return new Set();
    const marks = ids.map(() => '?').join(', ');
    const rs = await db.execute(
        `SELECT message_id FROM hidden_messages_by_user WHERE user_id = ? AND conversation_id = ? AND message_id IN (${marks})`,
        [userId, cid, ...ids]
    );
    return new Set(rs.rows.map(r => r.message_id.toString()));
}

function snippet(content, terms) {
    const text = String(content || '').replace(/\s+/g, ' ').trim();
    if (text.length <= 160) return text;
    const { fold } = require('../utils/text');
    const folded = fold(text);
    const at = terms.map(t => folded.indexOf(t)).filter(i => i >= 0).sort((a, b) => a - b)[0] ?? 0;
    const start = Math.max(0, at - 50);
    return (start > 0 ? '…' : '') + text.slice(start, start + 160) + (start + 160 < text.length ? '…' : '');
}

async function filterRows(user, cid, rows, f) {
    const hidden = await hiddenFor(user.userId, cid, rows.map(r => r.message_id));
    const out = [];
    for (const r of rows) {
        if (r.is_deleted || hidden.has(r.message_id.toString()) || r.message_type === 'SYSTEM') continue;
        if (f.cursor && compareDesc(r.message_id.toString(), f.cursor.toString()) <= 0) continue; // chi lay CU hon con tro
        if (f.senderId && r.sender_id !== f.senderId) continue;
        const attIds = [...(r.attachment_ids || [])];
        if (f.hasFile && attIds.length === 0) continue;
        let files = [];
        if (attIds.length && (f.terms.length || f.type === 'IMAGE' || f.type === 'FILE')) {
            files = (await attachments.getRows(cid, attIds.map(id => TimeUuid.fromString(id.toString()))))
                .filter(a => a.status === 'ATTACHED');
        }
        if (f.type === 'TEXT' && (attIds.length || r.shared_post_id)) continue;
        if (f.type === 'ATTACHMENT' && attIds.length === 0) continue;
        if (f.type === 'POST_SHARE' && !r.shared_post_id) continue;
        if (f.type === 'IMAGE' && !files.some(a => a.kind === 'IMAGE' || a.kind === 'VIDEO')) continue;
        if (f.type === 'FILE' && !files.some(a => a.kind === 'FILE')) continue;
        if (f.terms.length) {
            const have = new Set(termsOf(r.content, ...files.map(a => a.file_name)));
            if (!f.terms.every(t => have.has(t))) continue;
        }
        out.push({ row: r, files });
    }
    return out;
}

async function searchMessages(user, query = {}) {
    const f = parseQuery(query);
    if (!f.q && !f.senderId && !f.type && !f.hasFile && !f.from && !f.to) {
        throw httpError(400, 'EMPTY_SEARCH', 'Hãy nhập từ khóa hoặc chọn ít nhất một bộ lọc.');
    }
    const targets = await targetConversations(user, f.conversationId);
    const perConv = await Promise.all(targets.map(async t => {
        const c = f.terms.length ? await candidatesFromIndex(t.cid, f) : await candidatesFromScan(t.cid, f);
        const matched = await filterRows(user, t.cid, c.rows, f);
        // Moc da xet toi trong hoi thoai nay (dong cuoi doc duoc) -> khong duoc vuot qua khi cat trang.
        const scannedTo = c.rows.length ? c.rows.map(r => r.message_id.toString()).sort(compareDesc).pop() : null;
        return { t, matched, complete: c.complete, scannedTo };
    }));

    // Ranh gioi an toan: voi hoi thoai chua doc het, khong tra ket qua cu hon dong cuoi da doc cua no
    // (neu khong, trang sau se bo sot tin nam giua).
    const limits = perConv.filter(p => !p.complete && p.scannedTo).map(p => p.scannedTo);
    const boundary = limits.length ? limits.sort(compareDesc)[0] : null;
    const all = perConv.flatMap(p => p.matched.map(m => ({ ...m, conv: p.t })))
        .filter(m => !boundary || compareDesc(m.row.message_id.toString(), boundary) <= 0)
        .sort((a, b) => compareDesc(a.row.message_id.toString(), b.row.message_id.toString()));
    const page = all.slice(0, PAGE);
    const exhausted = perConv.every(p => p.complete) && all.length <= PAGE;
    let nextCursor = null;
    if (page.length === PAGE) nextCursor = page[page.length - 1].row.message_id.toString();
    else if (!exhausted && boundary) nextCursor = boundary;

    return {
        items: page.map(({ row, files, conv }) => ({
            conversationId: conv.cid.toString(),
            conversationName: conv.name,
            messageId: row.message_id.toString(),
            createdAt: iso(row.created_at),
            senderId: row.sender_id,
            senderName: row.sender_name,
            messageType: row.message_type || 'TEXT',
            snippet: snippet(row.content, f.terms),
            files: files.map(a => ({ attachmentId: a.attachment_id.toString(), fileName: a.file_name, kind: a.kind })),
            sharedPostId: row.shared_post_id ? row.shared_post_id.toString() : null
        })),
        nextCursor,
        hasMore: Boolean(nextCursor),
        searchedConversations: targets.length,
        terms: f.terms
    };
}

module.exports = { indexMessage, searchMessages };
