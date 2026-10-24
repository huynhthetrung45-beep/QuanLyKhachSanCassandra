// Client gia lap cho kiem thu migrate.js: FakeCassandra + system_schema dong.
// Bat dau giong CSDL that hien tai: chi 4 bang cu, chua co cot moi.
// Ghi lai MOI cau lenh nhan duoc de kiem chung dry-run khong ghi gi.
const { FakeCassandra } = require('./fakeCassandra');
const { seedSampleData } = require('./helpers');

const OLD_TABLES = ['users', 'conversations', 'conversations_by_user', 'messages_by_conversation'];
const NEW_COLUMNS = {
    users: ['email'],
    conversations: ['created_by'],
    conversations_by_user: ['last_sender_id'],
    messages_by_conversation: ['reply_to_id', 'reply_to_created_at', 'attachment_ids', 'forwarded', 'shared_post_id']
};

// Cot cua bang moi nhung duoc them bang ALTER o migration sau.
const LATER_COLUMNS = { post_comments: ['reply_to_comment_id', 'root_comment_id'] };

function createSchemaStub({ keyspace = 'chat_ott' } = {}) {
    const fake = new FakeCassandra();
    seedSampleData(fake);
    const present = new Map(); // table -> Set(columns)
    for (const t of OLD_TABLES) {
        present.set(t, new Set(Object.keys(fake.tables[t].columns).filter(c => !(NEW_COLUMNS[t] || []).includes(c))));
    }
    // Bang chua ton tai o trang thai cu thi cung chua co du lieu.
    for (const t of Object.keys(fake.data)) if (!present.has(t)) fake.data[t].clear();
    const received = [];
    const R = rows => ({ rows, rowLength: rows.length, first() { return rows[0] || null; }, pageState: null, wasApplied() { return true; } });

    const columnsOf = table => {
        const t = fake.tables[table];
        const cols = present.get(table);
        if (!t || !cols) return [];
        return [...cols].map(c => ({
            column_name: c,
            type: t.columns[c],
            kind: t.partitionKey.includes(c) ? 'partition_key' : t.clustering.includes(c) ? 'clustering' : 'regular',
            position: t.partitionKey.includes(c) ? t.partitionKey.indexOf(c) : t.clustering.includes(c) ? t.clustering.indexOf(c) : -1,
            clustering_order: t.clustering.includes(c) ? t.order[c] : 'none'
        }));
    };

    // Truy van system_schema dang literal (nhu trong file .cql cho cqlsh) hoac tham so (?).
    const systemQuery = (q, params) => {
        const m = q.match(/^SELECT (.+?) FROM system_schema\.(\w+)(?: WHERE (.+?))?(?: LIMIT \d+)?$/i);
        if (!m) throw new Error('Unsupported system_schema query: ' + q);
        const [, cols, table, where] = m;
        let i = 0;
        const val = tok => {
            tok = tok.trim();
            if (tok === '?') return params[i++];
            if (/^'.*'$/.test(tok)) return tok.slice(1, -1);
            throw new Error('Bad literal ' + tok);
        };
        const conds = {};
        (where ? where.split(/\s+AND\s+/i) : []).forEach(part => {
            const inM = part.match(/^(\w+)\s+IN\s*\((.+)\)$/i);
            if (inM) conds[inM[1]] = inM[2].split(',').map(val);
            else {
                const eq = part.match(/^(\w+)\s*=\s*(.+)$/);
                if (!eq) throw new Error('Bad system_schema condition ' + part);
                conds[eq[1]] = [val(eq[2])];
            }
        });
        const ok = (k, v) => !conds[k] || conds[k].includes(v);
        if (table === 'keyspaces') {
            return R(ok('keyspace_name', keyspace) ? [{ keyspace_name: keyspace, replication: { class: 'org.apache.cassandra.locator.SimpleStrategy', replication_factor: '1' } }] : []);
        }
        if (!ok('keyspace_name', keyspace)) return R([]);
        if (table === 'tables') {
            return R([...present.keys()].sort().filter(t => ok('table_name', t)).map(t => ({
                table_name: t, compaction: { class: 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy' },
                default_time_to_live: 0, gc_grace_seconds: 864000
            })));
        }
        if (table === 'columns') {
            const rows = [];
            for (const t of [...present.keys()].sort()) {
                if (!ok('table_name', t)) continue;
                const cols = (client.overrideColumns && client.overrideColumns[t]) || columnsOf(t);
                cols.filter(c => ok('column_name', c.column_name)).forEach(c => rows.push({ table_name: t, ...c }));
            }
            return R(rows);
        }
        return R([]);
    };

    const client = {
        received,
        present,
        fake,
        overrideColumns: null,
        calls: [],
        metadata: { checkSchemaAgreement: async () => { client.calls.push({ query: '<checkSchemaAgreement>' }); return true; } },
        async execute(query, params = [], options = {}) {
            const q = query.replace(/\s+/g, ' ').trim();
            received.push(q);
            this.calls.push({ query: q, options });
            if (process.env.CQL_CAPTURE_FILE) require('fs').appendFileSync(process.env.CQL_CAPTURE_FILE, q + '\n');
            if (/FROM system_schema\./i.test(q)) return systemQuery(q, params);
            const create = q.match(/^CREATE TABLE IF NOT EXISTS (\w+)/i);
            if (create) {
                // Cot them boi migration SAU (ALTER) chua co ngay luc CREATE.
                if (!present.has(create[1])) present.set(create[1], new Set(Object.keys(fake.tables[create[1]].columns)
                    .filter(c => !(LATER_COLUMNS[create[1]] || []).includes(c))));
                return R([]);
            }
            const alter = q.match(/^ALTER TABLE (\w+) ADD (\w+)/i);
            if (alter) {
                if (present.get(alter[1]).has(alter[2])) throw new Error(`Invalid column name ${alter[2]} because it conflicts with an existing column`);
                present.get(alter[1]).add(alter[2]);
                return R([]);
            }
            const table = (q.match(/(?:FROM|INTO|UPDATE) (\w+)/i) || [])[1];
            if (table && !present.has(table)) throw new Error(`unconfigured table ${table}`);
            return fake.execute(query, params, options);
        }
    };
    return client;
}

const isWrite = q => /^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|BATCH)\b/i.test(q.trim());

module.exports = { createSchemaStub, isWrite, OLD_TABLES };
