// PT-16 trang quan tri + PT-07/PT-08 xu ly bao cao, an noi dung, khoa tai khoan, nhat ky.
import { useCallback, useEffect, useState } from 'react';
import { Activity, Database, Flag, LoaderCircle, Lock, RotateCcw, ScrollText, Search, Shield, Unlock, Users } from 'lucide-react';
import Avatar from '../components/Avatar';
import { REPORT_REASONS, ext } from './extApi';
import { useSse } from './sse';
import { formatFull } from '../utils';

const REASON = Object.fromEntries(REPORT_REASONS);
const TARGET = { POST: 'Bài viết', COMMENT: 'Bình luận', MESSAGE: 'Tin nhắn', USER: 'Tài khoản' };

function Overview({ onToast }) {
  const [data, setData] = useState(null);
  const load = useCallback(() => ext.adminOverview().then(setData).catch(err => onToast(err.message)), [onToast]);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  if (!data) return <p className="muted pad"><LoaderCircle size={15} className="spin" /> Đang tải…</p>;
  const max = Math.max(1, ...data.messagesPerDay.map(d => d.messages));
  return (
    <>
      <div className="kpis ext-kpis">
        <div><strong>{data.users}</strong><span>người dùng</span></div>
        <div><strong>{data.conversations}</strong><span>hội thoại</span></div>
        <div><strong>{data.messagesToday}</strong><span>tin hôm nay</span></div>
        <div><strong>{data.realtime.connections}</strong><span>kết nối realtime</span></div>
        <div><strong>{data.openReports}</strong><span>báo cáo chờ xử lý</span></div>
      </div>
      <section className="card ext-card">
        <h3 className="ext-card-title"><Activity size={17} /> Tin nhắn 14 ngày gần nhất</h3>
        <div className="ext-bars" role="img" aria-label="Biểu đồ số tin nhắn theo ngày">
          {data.messagesPerDay.map(d => (
            <div key={d.day} className="ext-bar-col" title={`${d.day}: ${d.messages} tin`}>
              <span className="ext-bar-val">{d.messages || ''}</span>
              <span className="ext-bar-fill" style={{ height: `${(d.messages / max) * 100}%` }} />
              <span className="ext-bar-lbl">{d.day.slice(8)}/{d.day.slice(5, 7)}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="card ext-card">
        <h3 className="ext-card-title"><Database size={17} /> Cassandra & máy chủ</h3>
        <dl className="ext-dl">
          <dt>Trạng thái</dt><dd className={data.cassandra.status === 'UP' ? 'ext-ok' : 'ext-warn'}>{data.cassandra.status} · {data.cassandra.latencyMs} ms</dd>
          <dt>Keyspace</dt><dd>{data.cassandra.keyspace || '—'}</dd>
          <dt>Nút</dt><dd>{(data.cassandra.hosts || []).map(h => `${h.address} (${h.datacenter}, ${h.up ? 'UP' : 'DOWN'})`).join(', ') || '—'}</dd>
          <dt>Tiến trình</dt><dd>Node {data.process.node} · chạy {Math.round(data.process.uptimeSeconds / 60)} phút · RSS {data.process.rssMb} MB · heap {data.process.heapMb} MB</dd>
          <dt>Cập nhật</dt><dd>{formatFull(data.generatedAt)}</dd>
        </dl>
        <button type="button" className="btn secondary small" onClick={async () => {
          try { const r = await ext.runReminders(); onToast(`Đã chạy nhắc hạn: gửi ${r.sent} thông báo.`); } catch (err) { onToast(err.message); }
        }}>Chạy nhắc hạn công việc ngay</button>
      </section>
    </>
  );
}

function Reports({ onToast }) {
  const [status, setStatus] = useState('OPEN');
  const [items, setItems] = useState(null);
  const [note, setNote] = useState({});
  const load = useCallback(() => ext.adminReports(status).then(r => setItems(r.items)).catch(err => onToast(err.message)), [status, onToast]);
  useEffect(() => { setItems(null); load(); }, [load]);
  useSse('report:new', () => status === 'OPEN' && load());
  async function act(r, action) {
    try { await ext.resolveReport(r.reportId, action, note[r.reportId] || ''); onToast('Đã xử lý báo cáo.'); load(); } catch (err) { onToast(err.message); }
  }
  async function restore(r) {
    try {
      await ext.restoreContent({ targetType: r.targetType, targetId: r.targetId, postId: r.postId, conversationId: r.conversationId, createdAt: r.messageCreatedAt });
      onToast('Đã khôi phục nội dung.');
      load();
    } catch (err) { onToast(err.message); }
  }
  return (
    <>
      <div className="filters ext-tabs">
        {[['OPEN', 'Chờ xử lý'], ['RESOLVED', 'Đã xử lý'], ['DISMISSED', 'Đã bỏ qua']].map(([k, l]) => (
          <button key={k} type="button" className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>{l}</button>
        ))}
      </div>
      {!items && <p className="muted pad"><LoaderCircle size={15} className="spin" /> Đang tải…</p>}
      {items && items.length === 0 && <p className="muted pad">Không có báo cáo.</p>}
      {items?.map(r => (
        <article key={r.reportId} className="card ext-card ext-report">
          <div className="ext-row"><span className="ext-badge">{TARGET[r.targetType]}</span><strong>{REASON[r.reason] || r.reason}</strong>
            <span className="pc-spacer" /><span className="muted">{formatFull(r.createdAt)}</span></div>
          <p className="ext-quote">{r.excerpt || '(không có nội dung văn bản)'}</p>
          {r.details && <p><em>Mô tả:</em> {r.details}</p>}
          <p className="muted ext-sub">Người báo cáo: {r.reporter.displayName} · Chủ nội dung: {r.owner?.displayName || '—'}{r.contentHidden ? ' · nội dung đang bị ẩn' : ''}</p>
          {r.resolution && <p className="muted ext-sub">Kết quả: {r.resolution} · {r.resolvedBy} · {formatFull(r.resolvedAt)}</p>}
          {r.status === 'OPEN' ? (
            <>
              <input className="ext-input" placeholder="Ghi chú xử lý (lưu vào nhật ký)" value={note[r.reportId] || ''} onChange={e => setNote(n => ({ ...n, [r.reportId]: e.target.value }))} />
              <div className="ext-row wrap">
                {r.targetType !== 'USER' && <button type="button" className="btn danger small" onClick={() => act(r, 'HIDE')}>Ẩn nội dung</button>}
                {r.owner && <button type="button" className="btn danger small" onClick={() => act(r, 'LOCK_USER')}><Lock size={14} /> Khóa tài khoản</button>}
                <button type="button" className="btn secondary small" onClick={() => act(r, 'RESOLVE')}>Đánh dấu đã xử lý</button>
                <button type="button" className="btn secondary small" onClick={() => act(r, 'DISMISS')}>Bỏ qua</button>
              </div>
            </>
          ) : r.contentHidden && <button type="button" className="btn secondary small" onClick={() => restore(r)}><RotateCcw size={14} /> Khôi phục nội dung</button>}
        </article>
      ))}
    </>
  );
}

function UsersTab({ me, onToast }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState(null);
  const load = useCallback(query => ext.adminUsers(query).then(r => setItems(r.items)).catch(err => onToast(err.message)), [onToast]);
  useEffect(() => { load(''); }, [load]);
  const run = async (fn, msg) => { try { await fn(); onToast(msg); load(q); } catch (err) { onToast(err.message); } };
  return (
    <>
      <form className="ext-row" onSubmit={e => { e.preventDefault(); load(q); }}>
        <input className="ext-input" value={q} onChange={e => setQ(e.target.value)} placeholder="Tìm theo tên hoặc email" aria-label="Tìm người dùng" />
        <button type="submit" className="btn primary small"><Search size={14} /> Tìm</button>
      </form>
      <ul className="card ext-list ext-card">
        {items?.map(u => (
          <li key={u.userId}>
            <Avatar name={u.displayName} seed={u.userId} size={34} />
            <span className="ext-grow"><strong>{u.displayName}</strong>{u.isAdmin && <span className="ext-badge role-owner">Quản trị</span>}
              {u.locked && <span className="ext-badge danger">Đã khóa</span>}
              <span className="muted ext-sub">{u.email || u.userId}{u.lockedReason ? ` · lý do: ${u.lockedReason}` : ''}</span></span>
            {u.userId !== me.userId && (u.locked
              ? <button type="button" className="btn secondary small" onClick={() => run(() => ext.unlockUser(u.userId), 'Đã mở khóa.')}><Unlock size={14} /> Mở khóa</button>
              : <button type="button" className="btn danger small" onClick={() => {
                const reason = window.prompt(`Lý do khóa ${u.displayName}?`, 'Vi phạm quy định cộng đồng');
                if (reason !== null) run(() => ext.lockUser(u.userId, reason), 'Đã khóa tài khoản.');
              }}><Lock size={14} /> Khóa</button>)}
            {u.userId !== me.userId && (
              <button type="button" className="btn secondary small" onClick={() => run(() => ext.setUserRole(u.userId, u.isAdmin ? 'USER' : 'ADMIN'), 'Đã cập nhật vai trò.')}>
                <Shield size={14} /> {u.isAdmin ? 'Gỡ quản trị' : 'Cấp quản trị'}</button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function LogTab({ onToast }) {
  const [items, setItems] = useState(null);
  useEffect(() => { ext.moderationLog().then(r => setItems(r.items)).catch(err => onToast(err.message)); }, [onToast]);
  if (!items) return <p className="muted pad"><LoaderCircle size={15} className="spin" /> Đang tải…</p>;
  return (
    <table className="ext-table card">
      <thead><tr><th>Thời điểm</th><th>Quản trị viên</th><th>Hành động</th><th>Đối tượng</th><th>Ghi chú</th></tr></thead>
      <tbody>
        {items.length === 0 && <tr><td colSpan={5} className="muted">Chưa có hoạt động trong 7 ngày.</td></tr>}
        {items.map(i => <tr key={i.actionId}><td>{formatFull(i.at)}</td><td>{i.admin}</td><td>{i.action}</td><td>{i.targetType} {i.targetId.slice(0, 13)}</td><td>{i.note}</td></tr>)}
      </tbody>
    </table>
  );
}

export default function AdminPage({ user, onToast }) {
  const [tab, setTab] = useState('overview');
  return (
    <section className="posts-page" aria-label="Quản trị">
      <div className="posts-scroll">
        <div className="posts-col ext-wide">
          <h2 className="posts-title"><Shield size={20} /> Trang quản trị</h2>
          <div className="filters ext-tabs" role="tablist">
            {[['overview', 'Tổng quan', Activity], ['reports', 'Báo cáo', Flag], ['users', 'Người dùng', Users], ['log', 'Nhật ký', ScrollText]].map(([k, l, Icon]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}><Icon size={14} /> {l}</button>
            ))}
          </div>
          {tab === 'overview' && <Overview onToast={onToast} />}
          {tab === 'reports' && <Reports onToast={onToast} />}
          {tab === 'users' && <UsersTab me={user} onToast={onToast} />}
          {tab === 'log' && <LogTab onToast={onToast} />}
        </div>
      </div>
    </section>
  );
}
