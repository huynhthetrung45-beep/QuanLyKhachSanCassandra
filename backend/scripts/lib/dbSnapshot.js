// Chup "anh" du lieu cu va cau hinh bang bang truy van CHI DOC, de so sanh truoc / sau migration.
// Khong bao gio ghi. Khong tra ve mat khau, hash hay token (cac bang cu khong co truong nhay cam).
const crypto = require('crypto');
const { pairKey } = require('../../src/services/conversation.service');
const { nameTokens, tokenBucket } = require('../../src/utils/text');

const OLD_TABLES = ['users', 'conversations', 'conversations_by_user', 'messages_by_conversation'];
const ms = d => (d ? new Date(d).getTime() : null);

async function scanAll(client, query, params = []) {
    const rows = [];
    let pageState;
    do {
        const rs = await client.execute(query, params, { prepare: true, fetchSize: 500, pageState });
        rows.push(...rs.rows);
        pageState = rs.pageState;
    } while (pageState);
    return rows;
}

async function takeSnapshot(client, keyspace) {
    const ks = (await client.execute(
        'SELECT keyspace_name, replication FROM system_schema.keyspaces WHERE keyspace_name = ?', [keyspace], { prepare: true })).first();
    const tables = (await client.execute(
        `SELECT table_name, default_time_to_live, gc_grace_seconds, compaction FROM system_schema.tables
         WHERE keyspace_name = ?`, [keyspace], { prepare: true })).rows;
    const tableOptions = {};
    for (const t of tables) {
        if (!OLD_TABLES.includes(t.table_name)) continue;
        tableOptions[t.table_name] = {
            default_time_to_live: t.default_time_to_live,
            gc_grace_seconds: t.gc_grace_seconds,
            compaction: t.compaction && t.compaction.class
        };
    }
    const oldColumns = {};
    for (const table of OLD_TABLES) {
        const cols = (await client.execute(
            `SELECT column_name, kind, type, clustering_order FROM system_schema.columns
             WHERE keyspace_name = ? AND table_name = ?`, [keyspace, table], { prepare: true })).rows;
        oldColumns[table] = cols.map(c => `${c.column_name}:${c.type}:${c.kind}:${c.clustering_order}`).sort();
    }

    const users = (await scanAll(client, 'SELECT user_id, display_name, avatar_url, created_at FROM users'))
        .map(u => ({ user_id: u.user_id, display_name: u.display_name, avatar_url: u.avatar_url, created_at: ms(u.created_at) }))
        .sort((a, b) => a.user_id.localeCompare(b.user_id));

    const conversations = (await scanAll(client,
        'SELECT conversation_id, conversation_name, conversation_type, participant_ids, last_message_at, created_at FROM conversations'))
        .map(c => ({
            conversation_id: c.conversation_id.toString(),
            conversation_name: c.conversation_name,
            conversation_type: c.conversation_type,
            participant_ids: [...(c.participant_ids || [])].sort(),
            last_message_at: ms(c.last_message_at),
            created_at: ms(c.created_at)
        }))
        .sort((a, b) => a.conversation_id.localeCompare(b.conversation_id));

    const memberIds = [...new Set([...users.map(u => u.user_id), ...conversations.flatMap(c => c.participant_ids)])].sort();
    const membership = {};
    let membershipRows = 0;
    for (const u of memberIds) {
        const rows = (await client.execute(
            `SELECT last_message_at, conversation_id, conversation_name, conversation_type, last_message_preview, last_sender_name
             FROM conversations_by_user WHERE user_id = ?`, [u], { prepare: true })).rows;
        membershipRows += rows.length;
        membership[u] = rows.map(r => ({
            last_message_at: ms(r.last_message_at),
            conversation_id: r.conversation_id.toString(),
            conversation_name: r.conversation_name,
            conversation_type: r.conversation_type,
            last_message_preview: r.last_message_preview,
            last_sender_name: r.last_sender_name
        }));
    }

    // Tin nhan: dem + bam SHA-256 toan bo noi dung moi partition (doc theo trang, khong giu het trong bo nho).
    const messages = {};
    let messageTotal = 0;
    for (const c of conversations) {
        const hash = crypto.createHash('sha256');
        let count = 0;
        let recalled = 0;
        let pageState;
        do {
            const rs = await client.execute(
                `SELECT created_at, message_id, sender_id, sender_name, content, message_type, is_deleted, deleted_at
                 FROM messages_by_conversation WHERE conversation_id = ?`,
                [c.conversation_id], { prepare: true, fetchSize: 500, pageState });
            for (const m of rs.rows) {
                count += 1;
                if (m.is_deleted) recalled += 1;
                hash.update(JSON.stringify([ms(m.created_at), m.message_id.toString(), m.sender_id, m.sender_name,
                    m.content, m.message_type, m.is_deleted, ms(m.deleted_at)]));
            }
            pageState = rs.pageState;
        } while (pageState);
        messageTotal += count;
        messages[c.conversation_id] = { count, recalled, sha256: hash.digest('hex') };
    }

    return {
        takenAt: new Date().toISOString(),
        keyspace,
        replication: ks ? ks.replication : null,
        tableOptions,
        oldColumns,
        counts: { users: users.length, conversations: conversations.length, membershipRows, messages: messageTotal },
        users,
        conversations,
        membership,
        messages
    };
}

// So sanh hai anh chup. Cot moi them vao bang cu (email, created_by, last_sender_id) duoc
// bo qua khi so sanh cot vi chung la thay doi DU KIEN; moi khac biet khac la loi.
const EXPECTED_NEW_COLUMNS = [
    // migration 001
    'users:email', 'conversations:created_by', 'conversations_by_user:last_sender_id',
    // migration 002
    'messages_by_conversation:reply_to_id', 'messages_by_conversation:reply_to_created_at',
    'messages_by_conversation:attachment_ids', 'messages_by_conversation:forwarded',
    // migration 004
    'messages_by_conversation:shared_post_id'
];

function compareSnapshots(before, after) {
    const problems = [];
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    if (!eq(before.replication, after.replication)) problems.push('replication đã thay đổi');
    if (!eq(before.tableOptions, after.tableOptions)) problems.push('TTL / gc_grace / compaction của bảng cũ đã thay đổi');
    for (const table of OLD_TABLES) {
        const b = before.oldColumns[table];
        // Chi bo qua cot du kien MOI xuat hien sau migration. Cot da co tu truoc (vd. cot cua
        // migration 001 khi dang chay 002) phai giu nguyen kieu/khoa nhu luc truoc.
        const had = new Set(b.map(c => c.split(':')[0]));
        const a = after.oldColumns[table].filter(c => {
            const name = c.split(':')[0];
            return had.has(name) || !EXPECTED_NEW_COLUMNS.includes(`${table}:${name}`);
        });
        if (!eq(b, a)) problems.push(`cột/khóa cũ của ${table} đã thay đổi`);
    }
    for (const key of ['users', 'conversations', 'membership', 'messages', 'counts']) {
        if (!eq(before[key], after[key])) problems.push(`dữ liệu ${key} khác trước migration`);
    }
    return problems;
}

// Ky vong backfill TINH TU du lieu nguon thuc te (khong hard-code so lieu cu).
function expectedBackfill(snapshot) {
    const pairs = new Map();
    const duplicatePairs = [];
    for (const c of snapshot.conversations) {
        if (c.conversation_type !== 'DIRECT' || c.participant_ids.length !== 2) continue;
        const key = pairKey(c.participant_ids[0], c.participant_ids[1]);
        if (pairs.has(key)) duplicatePairs.push(key);
        else pairs.set(key, c.conversation_id);
    }
    const tokens = [];
    for (const u of snapshot.users) {
        for (const t of nameTokens(u.display_name)) tokens.push({ token_prefix: tokenBucket(t), name_token: t, user_id: u.user_id });
    }
    return { pairs, duplicatePairs, tokens };
}

async function verifyBackfill(client, expected) {
    const problems = [];
    for (const [key, cid] of expected.pairs) {
        const row = (await client.execute('SELECT conversation_id FROM direct_conversations WHERE pair_key = ?', [key], { prepare: true })).first();
        if (!row) problems.push(`thiếu direct_conversations ${key}`);
        else if (row.conversation_id.toString() !== cid) problems.push(`direct_conversations ${key} trỏ sai ${row.conversation_id}`);
    }
    for (const t of expected.tokens) {
        const row = (await client.execute(
            'SELECT user_id FROM users_by_name_token WHERE token_prefix = ? AND name_token = ? AND user_id = ?',
            [t.token_prefix, t.name_token, t.user_id], { prepare: true })).first();
        if (!row) problems.push(`thiếu token ${t.name_token} của ${t.user_id}`);
    }
    return problems;
}

module.exports = { takeSnapshot, compareSnapshots, expectedBackfill, verifyBackfill, OLD_TABLES };
