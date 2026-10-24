import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, LoaderCircle, Newspaper, Paperclip, Search } from 'lucide-react';
import Avatar from './Avatar';
import Highlight from './Highlight';
import { api } from '../api';
import { formatFull, formatListTime, localDayEnd, localDayStart } from '../utils';

const TYPES = [
  ['', 'Mọi loại'], ['TEXT', 'Chỉ văn bản'], ['ATTACHMENT', 'Có tệp đính kèm'], ['IMAGE', 'Ảnh / video'],
  ['FILE', 'Tài liệu'], ['POST_SHARE', 'Bài viết được chia sẻ']
];

// Tim kiem lich su tin nhan trong cac hoi thoai cua minh (backend kiem tra thanh vien, bo tin thu hoi / an).
export default function SearchPage({ conversations, onOpenResult, onToast }) {
  const [form, setForm] = useState({ q: '', conversationId: '', senderId: '', from: '', to: '', type: '', hasFile: false });
  const [members, setMembers] = useState([]);
  const [result, setResult] = useState(null);
  const [state, setState] = useState('idle');
  const [error, setError] = useState('');
  const abortRef = useRef(null);

  useEffect(() => {
    if (!form.conversationId) { setMembers([]); return; }
    api.conversation(form.conversationId).then(d => setMembers(d.members)).catch(() => setMembers([]));
  }, [form.conversationId]);

  const params = useMemo(() => ({
    q: form.q.trim() || undefined, conversationId: form.conversationId || undefined, senderId: form.senderId || undefined,
    from: localDayStart(form.from), to: localDayEnd(form.to), type: form.type || undefined, hasFile: form.hasFile ? '1' : undefined
  }), [form]);

  async function run(cursor) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState(cursor ? 'more' : 'loading');
    setError('');
    try {
      const r = await api.searchMessages({ ...params, cursor }, controller.signal);
      setResult(prev => (cursor && prev ? { ...r, items: [...prev.items, ...r.items] } : r));
      setState('ready');
    } catch (err) {
      if (err.name === 'AbortError') return;
      setError(err.message);
      setState('error');
    }
  }

  const set = (k, v) => setForm(f => ({ ...f, [k]: v, ...(k === 'conversationId' ? { senderId: '' } : {}) }));

  return (
    <section className="posts-page" aria-label="Tìm kiếm tin nhắn">
      <div className="posts-scroll">
        <div className="posts-col">
          <h2 className="posts-title">Tìm kiếm tin nhắn</h2>
          <form className="card search-form" onSubmit={e => { e.preventDefault(); run(null); }}>
            <div className="search boxed">
              <Search size={16} aria-hidden="true" />
              <input value={form.q} onChange={e => set('q', e.target.value)} placeholder="Từ khóa (gõ có dấu hoặc không dấu đều được)" aria-label="Từ khóa" maxLength={200} autoFocus />
            </div>
            <div className="search-filters">
              <label>Hội thoại
                <select value={form.conversationId} onChange={e => set('conversationId', e.target.value)}>
                  <option value="">Tất cả hội thoại của tôi</option>
                  {conversations.map(c => <option key={c.conversationId} value={c.conversationId}>{c.displayName}</option>)}
                </select>
              </label>
              <label>Người gửi
                <select value={form.senderId} onChange={e => set('senderId', e.target.value)} disabled={!form.conversationId}
                  title={form.conversationId ? '' : 'Chọn một hội thoại để lọc theo người gửi'}>
                  <option value="">Mọi người</option>
                  {members.map(m => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
                </select>
              </label>
              <label>Từ ngày<input type="date" value={form.from} onChange={e => set('from', e.target.value)} /></label>
              <label>Đến ngày<input type="date" value={form.to} onChange={e => set('to', e.target.value)} /></label>
              <label>Loại nội dung
                <select value={form.type} onChange={e => set('type', e.target.value)}>
                  {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              <label className="check-label"><input type="checkbox" checked={form.hasFile} onChange={e => set('hasFile', e.target.checked)} /> Chỉ tin có tệp</label>
            </div>
            <div className="pc-bar"><span className="pc-spacer" /><button type="submit" className="btn small primary" disabled={state === 'loading'}>
              {state === 'loading' && <LoaderCircle size={14} className="spin" />} Tìm kiếm</button></div>
          </form>

          {state === 'error' && <div className="card pad" role="alert"><p className="error-text">{error}</p></div>}
          {result && state !== 'loading' && (
            <p className="muted small-note">
              {result.items.length ? `${result.items.length}${result.hasMore ? '+' : ''} kết quả` : 'Không có kết quả'} trong {result.searchedConversations} hội thoại.
            </p>
          )}
          {result?.items.length > 0 && (
            <ul className="card search-results">
              {result.items.map(r => (
                <li key={r.conversationId + r.messageId}>
                  <button type="button" className="search-hit" onClick={() => onOpenResult(r)}>
                    <Avatar name={r.senderName} seed={r.senderId} size={38} />
                    <span className="hit-body">
                      <span className="hit-head"><strong>{r.senderName}</strong> · {r.conversationName} ·
                        <time dateTime={r.createdAt} title={formatFull(r.createdAt)}> {formatListTime(r.createdAt)}</time></span>
                      <span className="hit-text">
                        {r.snippet ? <Highlight text={r.snippet} terms={result.terms} /> : <em className="muted">(không có chữ)</em>}
                      </span>
                      {r.files.length > 0 && (
                        <span className="hit-files">
                          {r.files.map(f => <span key={f.attachmentId}>{f.kind === 'FILE' ? <FileText size={12} /> : <Paperclip size={12} />} <Highlight text={f.fileName} terms={result.terms} /></span>)}
                        </span>
                      )}
                      {r.sharedPostId && <span className="hit-files"><span><Newspaper size={12} /> Bài viết được chia sẻ</span></span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {state === 'ready' && result?.nextCursor && (
            <button type="button" className="btn secondary posts-more" onClick={() => run(result.nextCursor)}>Xem thêm kết quả</button>
          )}
          {state === 'more' && <p className="muted pad"><LoaderCircle size={15} className="spin" /> Đang tải…</p>}
        </div>
      </div>
    </section>
  );
}
