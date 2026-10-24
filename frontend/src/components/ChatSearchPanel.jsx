import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, FileText, LoaderCircle, Paperclip, RotateCcw, Search, User, X } from 'lucide-react';
import Avatar from './Avatar';
import Highlight from './Highlight';
import { api } from '../api';
import { formatFull, formatListTime, localDayEnd, localDayStart } from '../utils';

const DEBOUNCE_MS = 350;
const DATE_PRESETS = [['', 'Mọi lúc'], ['today', 'Hôm nay'], ['7', '7 ngày qua'], ['30', '30 ngày qua'], ['custom', 'Tùy chọn…']];
function dateRange(preset, from, to) {
  if (!preset) return {};
  if (preset === 'custom') return { from: localDayStart(from), to: localDayEnd(to) };
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (preset !== 'today') start.setDate(start.getDate() - Number(preset) + 1);
  return { from: start.toISOString(), to: undefined };
}

// Tim kiem tin nhan CHI trong cuoc tro chuyen dang mo (backend kiem tra thanh vien; doc chi muc, khong quet toan bo).
export default function ChatSearchPanel({ conversation, onOpenResult, onClose }) {
  const cid = conversation.conversationId;
  const [q, setQ] = useState('');
  const [senderId, setSenderId] = useState('');
  const [preset, setPreset] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [members, setMembers] = useState([]);
  const [result, setResult] = useState(null);
  const [state, setState] = useState('idle'); // idle | loading | more | ready | error
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const abortRef = useRef(null);
  const seqRef = useRef(0);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    let alive = true;
    api.conversation(cid).then(d => alive && setMembers(d.members || [])).catch(() => alive && setMembers([]));
    return () => { alive = false; };
  }, [cid]);

  const keyword = q.trim();
  const tooShort = keyword.length > 0 && keyword.replace(/[^\p{L}\p{N}]/gu, '').length < 2;
  const params = useMemo(() => ({
    conversationId: cid, q: keyword || undefined, senderId: senderId || undefined, ...dateRange(preset, from, to)
  }), [cid, keyword, senderId, preset, from, to]);
  const hasCriteria = Boolean(params.q || params.senderId || params.from || params.to);

  async function run(cursor) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = ++seqRef.current;
    setState(cursor ? 'more' : 'loading');
    setError('');
    try {
      const r = await api.searchMessages({ ...params, cursor }, controller.signal);
      if (seq !== seqRef.current) return; // ket qua cu ve muon: bo qua
      setResult(prev => (cursor && prev ? { ...r, items: [...prev.items, ...r.items.filter(i => !prev.items.some(p => p.messageId === i.messageId))] } : r));
      setState('ready');
    } catch (err) {
      if (err.name === 'AbortError' || seq !== seqRef.current) return;
      setError(err.message);
      setState('error');
    }
  }

  // Debounce khi go / doi bo loc; huy request cu.
  useEffect(() => {
    if (!hasCriteria || tooShort || (preset === 'custom' && from && to && from > to)) {
      abortRef.current?.abort();
      seqRef.current += 1;
      setResult(null);
      setState('idle');
      return undefined;
    }
    const t = setTimeout(() => run(null), DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, hasCriteria, tooShort]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const clearAll = () => { setQ(''); setSenderId(''); setPreset(''); setFrom(''); setTo(''); inputRef.current?.focus(); };
  const badRange = preset === 'custom' && from && to && from > to;

  return (
    <aside className="info chat-search" aria-label="Tìm kiếm trong trò chuyện">
      <div className="info-head">
        <h3>Tìm kiếm trong trò chuyện</h3>
        <button type="button" className="icon-btn ghost" onClick={onClose} aria-label="Đóng tìm kiếm"><X size={18} /></button>
      </div>
      <div className="cs-controls">
        <div className="search boxed">
          <Search size={16} aria-hidden="true" />
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Tìm kiếm" aria-label="Từ khóa"
            maxLength={200} onKeyDown={e => e.key === 'Escape' && (q ? setQ('') : onClose())} />
          {q && <button type="button" className="icon-btn ghost cs-clear" onClick={() => { setQ(''); inputRef.current?.focus(); }} aria-label="Xóa từ khóa"><X size={14} /></button>}
        </div>
        <div className="cs-filters">
          <label className={'cs-chip' + (senderId ? ' on' : '')}>
            <User size={14} aria-hidden="true" />
            <select value={senderId} onChange={e => setSenderId(e.target.value)} aria-label="Người gửi">
              <option value="">Người gửi</option>
              {members.map(m => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
            </select>
          </label>
          <label className={'cs-chip' + (preset ? ' on' : '')}>
            <CalendarDays size={14} aria-hidden="true" />
            <select value={preset} onChange={e => setPreset(e.target.value)} aria-label="Ngày gửi">
              {DATE_PRESETS.map(([v, l]) => <option key={v} value={v}>{v ? l : 'Ngày gửi'}</option>)}
            </select>
          </label>
          {(senderId || preset || q) && <button type="button" className="link-btn" onClick={clearAll}>Xóa lọc</button>}
        </div>
        {preset === 'custom' && (
          <div className="cs-range">
            <label>Từ <input type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} /></label>
            <label>Đến <input type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} /></label>
          </div>
        )}
        {badRange && <p className="error-text small-note">Ngày bắt đầu phải trước ngày kết thúc.</p>}
      </div>

      <div className="info-scroll cs-results" aria-live="polite">
        {!hasCriteria && <p className="cs-hint">Nhập từ khóa hoặc chọn người gửi / ngày gửi để tìm tin nhắn trong cuộc trò chuyện này.</p>}
        {tooShort && <p className="cs-hint">Từ khóa cần ít nhất 2 chữ cái hoặc chữ số.</p>}
        {state === 'loading' && <p className="cs-hint"><LoaderCircle size={14} className="spin" /> Đang tìm…</p>}
        {state === 'error' && (
          <p className="error-text cs-hint" role="alert">{error || 'Không tìm được.'}{' '}
            <button type="button" className="link-btn" onClick={() => run(null)}><RotateCcw size={12} /> Thử lại</button></p>
        )}
        {state !== 'loading' && result && (
          <>
            <h5 className="cs-title">Tin nhắn</h5>
            {result.items.length === 0 && <p className="cs-hint">Không có tin nhắn nào phù hợp.</p>}
            <ul className="cs-list">
              {result.items.map(r => (
                <li key={r.messageId}>
                  <button type="button" className={'cs-item' + (selected === r.messageId ? ' on' : '')}
                    onClick={() => { setSelected(r.messageId); onOpenResult(r); }}>
                    <Avatar name={r.senderName} seed={r.senderId} size={36} />
                    <span className="cs-body">
                      <span className="cs-top"><strong>{r.senderName}</strong>
                        <time dateTime={r.createdAt} title={formatFull(r.createdAt)}>{formatListTime(r.createdAt)}</time></span>
                      <span className="cs-snippet">{r.snippet ? <Highlight text={r.snippet} terms={result.terms} /> : <em className="muted">(không có chữ)</em>}</span>
                      {r.files.length > 0 && (
                        <span className="cs-files">{r.files.map(f => <span key={f.attachmentId}>{f.kind === 'FILE' ? <FileText size={12} /> : <Paperclip size={12} />} <Highlight text={f.fileName} terms={result.terms} /></span>)}</span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {result.hasMore && (
              <button type="button" className="btn secondary small cs-more" disabled={state === 'more'} onClick={() => run(result.nextCursor)}>
                {state === 'more' ? <><LoaderCircle size={14} className="spin" /> Đang tải…</> : 'Xem thêm kết quả'}
              </button>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
