import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle, RotateCcw, X } from 'lucide-react';
import Avatar from './Avatar';
import { POST_REACTIONS, reactionOf } from './PostBits';
import { api } from '../api';

// Danh sach nguoi da bay to cam xuc. Backend kiem tra quyen xem bai; tu tai lai khi co nguoi doi cam xuc.
export default function ReactionsDialog({ postId, onClose, onOpenProfile }) {
  const [type, setType] = useState('');
  const [data, setData] = useState(null);
  const [items, setItems] = useState([]);
  const [token, setToken] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');

  const load = useCallback(async pageToken => {
    setState(pageToken ? 'more' : 'loading');
    try {
      const r = await api.postReactions(postId, type || undefined, pageToken);
      setData(r.summary);
      setItems(l => (pageToken ? [...l, ...r.items.filter(x => !l.some(y => y.userId === x.userId))] : r.items));
      setToken(r.nextPageToken);
      setState('ready');
    } catch (err) {
      setError(err.status === 404 ? 'Bài viết không còn khả dụng hoặc bạn không có quyền xem.' : err.message);
      setState('error');
    }
  }, [postId, type]);

  useEffect(() => { load(null); }, [load]);

  useEffect(() => {
    let t = null;
    const onChange = e => {
      if (e.detail?.postId !== postId || e.detail.kind !== 'reaction') return;
      clearTimeout(t);
      t = setTimeout(() => load(null), 300);
    };
    window.addEventListener('chatott:post-changed', onChange);
    const onKey = e => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); window.removeEventListener('chatott:post-changed', onChange); document.removeEventListener('keydown', onKey); };
  }, [postId, load, onClose]);

  const tabs = [['', `Tất cả${data ? ' ' + data.total : ''}`],
    ...POST_REACTIONS.filter(r => data?.counts?.[r.key]).map(r => [r.key, `${r.emoji} ${data.counts[r.key]}`])];

  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="dialog reactions-dialog" role="dialog" aria-modal="true" aria-labelledby="rx-title">
        <div className="dialog-head">
          <h3 id="rx-title">Cảm xúc về bài viết</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Đóng"><X size={18} /></button>
        </div>
        <div className="filters rx-tabs" role="tablist">
          {tabs.map(([k, label]) => (
            <button key={k || 'all'} type="button" role="tab" aria-selected={type === k} className={type === k ? 'on' : ''} onClick={() => setType(k)}>{label}</button>
          ))}
        </div>
        {state === 'loading' && <p className="muted pad"><LoaderCircle size={15} className="spin" /> Đang tải…</p>}
        {state === 'error' && (
          <div className="pad" role="alert"><p className="error-text">{error}</p>
            <button type="button" className="btn secondary small" onClick={() => load(null)}><RotateCcw size={14} /> Thử lại</button></div>
        )}
        {state !== 'loading' && state !== 'error' && items.length === 0 && <p className="muted pad">Chưa có ai bày tỏ cảm xúc.</p>}
        <ul className="rx-list">
          {items.map(i => (
            <li key={i.userId}>
              <button type="button" className="rx-person" onClick={() => onOpenProfile?.(i.userId)}>
                <span className="rx-avatar"><Avatar name={i.displayName} seed={i.userId} size={40} />
                  <span className="rx-emoji" title={reactionOf(i.reaction)?.label}>{reactionOf(i.reaction)?.emoji}</span></span>
                <span className="rx-name">{i.displayName}{i.isMe ? ' (bạn)' : ''}</span>
                <span className="muted small-note">{reactionOf(i.reaction)?.label}</span>
              </button>
            </li>
          ))}
        </ul>
        {state === 'ready' && token && <button type="button" className="btn secondary small posts-more" onClick={() => load(token)}>Xem thêm</button>}
        {state === 'more' && <p className="muted pad"><LoaderCircle size={14} className="spin" /> Đang tải…</p>}
      </div>
    </div>
  );
}
