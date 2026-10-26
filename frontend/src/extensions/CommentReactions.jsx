// Tha cam xuc cho binh luan bai viet: bam "Thich" = 👍 (bam lai de go), re chuot / giu lau de chon 6 cam xuc,
// bam tong so de xem ai da tha cam xuc.
import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import Avatar from '../components/Avatar';
import { POST_REACTIONS, reactionOf } from '../components/PostBits';
import { ext } from './extApi';

const EMPTY = { total: 0, counts: {}, top: [], mine: null };

function ReactorsDialog({ postId, commentId, onClose }) {
  const [data, setData] = useState(null);
  const [type, setType] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    ext.commentReactors(postId, commentId).then(setData).catch(err => setError(err.message));
  }, [postId, commentId]);
  useEffect(() => {
    const onKey = e => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const items = (data?.items || []).filter(r => !type || r.reaction === type);
  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="dialog small ext-creact-dialog" role="dialog" aria-modal="true" aria-label="Cảm xúc về bình luận">
        <div className="dialog-head"><h3>Cảm xúc</h3>
          <button type="button" className="icon-btn" aria-label="Đóng" onClick={onClose}><X size={18} /></button></div>
        {error && <p className="error-text">{error}</p>}
        {!data && !error && <p className="muted"><LoaderCircle size={14} className="spin" /> Đang tải…</p>}
        {data && (
          <>
            <div className="ext-creact-tabs" role="tablist">
              <button type="button" className={!type ? 'on' : ''} onClick={() => setType('')}>Tất cả {data.summary.total}</button>
              {Object.entries(data.summary.counts).map(([k, n]) => (
                <button key={k} type="button" className={type === k ? 'on' : ''} onClick={() => setType(k)}>{reactionOf(k)?.emoji} {n}</button>
              ))}
            </div>
            <ul className="ext-creact-list">
              {items.map(r => (
                <li key={r.userId}>
                  <span className="ext-creact-avatar"><Avatar name={r.displayName} seed={r.userId} size={34} />
                    <span className="ext-creact-badge">{reactionOf(r.reaction)?.emoji}</span></span>
                  <span data-profile-id={r.userId}>{r.displayName}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

export default function CommentReactions({ postId, comment, onToast }) {
  const [sum, setSum] = useState(comment.reactions || EMPTY);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showList, setShowList] = useState(false);
  const timer = useRef(null);
  const longPressed = useRef(false);
  useEffect(() => { if (comment.reactions) setSum(comment.reactions); }, [comment.reactions]);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function pick(key) {
    setPicker(false);
    if (busy) return;
    const prev = sum;
    // Cap nhat ngay tren giao dien, loi thi tra lai.
    const counts = { ...sum.counts };
    if (sum.mine) counts[sum.mine] = Math.max(0, (counts[sum.mine] || 1) - 1);
    if (key) counts[key] = (counts[key] || 0) + 1;
    Object.keys(counts).forEach(k => { if (!counts[k]) delete counts[k]; });
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    setSum({ total, counts, top: Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 3), mine: key });
    setBusy(true);
    try {
      const r = key ? await ext.reactComment(postId, comment.commentId, key) : await ext.unreactComment(postId, comment.commentId);
      setSum(r.reactions);
    } catch (err) {
      setSum(prev);
      onToast?.(err.message);
    } finally {
      setBusy(false);
    }
  }

  const open = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setPicker(true), 450); };
  const close = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setPicker(false), 300); };
  const mine = reactionOf(sum.mine);

  return (
    <>
      <span className="picker-anchor" onMouseEnter={open} onMouseLeave={close}>
        <button type="button" className={'link-btn ext-creact-btn' + (mine ? ` on r-${sum.mine}` : '')} disabled={busy}
          aria-label={mine ? `Gỡ cảm xúc ${mine.label}` : 'Thích bình luận'}
          onTouchStart={() => { longPressed.current = false; timer.current = setTimeout(() => { longPressed.current = true; setPicker(true); }, 450); }}
          onTouchEnd={() => clearTimeout(timer.current)}
          onClick={() => { if (longPressed.current) { longPressed.current = false; return; } pick(sum.mine ? null : 'LIKE'); }}
          onKeyDown={e => { if (e.key === 'ArrowUp') { e.preventDefault(); setPicker(true); } }}>
          {mine ? <>{mine.emoji} {mine.label}</> : 'Thích'}
        </button>
        {picker && (
          <span className="reaction-picker ext-creact-picker" role="menu" aria-label="Chọn cảm xúc" onMouseEnter={() => clearTimeout(timer.current)}>
            {POST_REACTIONS.map(r => (
              <button key={r.key} type="button" role="menuitem" title={r.label} className={sum.mine === r.key ? 'on' : ''}
                aria-label={sum.mine === r.key ? `Gỡ ${r.label}` : r.label} onClick={() => pick(sum.mine === r.key ? null : r.key)}>
                {r.emoji}
              </button>
            ))}
          </span>
        )}
      </span>
      {sum.total > 0 && (
        <button type="button" className="ext-creact-sum" onClick={() => setShowList(true)} title="Xem ai đã bày tỏ cảm xúc">
          {sum.top.map(k => <span key={k}>{reactionOf(k)?.emoji}</span>)}
          <b>{sum.total}</b>
        </button>
      )}
      {showList && <ReactorsDialog postId={postId} commentId={comment.commentId} onClose={() => setShowList(false)} />}
    </>
  );
}
