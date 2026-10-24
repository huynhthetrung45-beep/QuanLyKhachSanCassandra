import { useCallback, useEffect, useRef, useState } from 'react';
import { CornerDownRight, LoaderCircle, RotateCcw } from 'lucide-react';
import Avatar from './Avatar';
import { ReportCommentButton } from '../extensions/SocialExtras';
import ConfirmDialog from './ConfirmDialog';
import { api } from '../api';
import { formatFull, formatListTime } from '../utils';

const newClientId = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)));

// O nhap binh luan / tra loi. clientId giu nguyen cho cac lan gui LAI cung noi dung -> backend khong tao trung.
function CommentInput({ me, placeholder, autoFocus, onSubmit, onCancel, submitLabel = 'Gửi' }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const clientId = useRef(null);
  const ref = useRef(null);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);

  async function submit(e) {
    e.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    clientId.current = clientId.current || newClientId();
    setBusy(true);
    try {
      await onSubmit(value, clientId.current);
      setText('');
      clientId.current = null;
    } catch {
      /* loi da bao qua toast; giu noi dung + clientId de gui lai khong bi trung */
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="comment-form" onSubmit={submit}>
      <Avatar name={me.displayName} seed={me.userId} size={28} />
      <input ref={ref} value={text} onChange={e => { setText(e.target.value); clientId.current = null; }} placeholder={placeholder}
        maxLength={2000} aria-label={placeholder} onKeyDown={e => e.key === 'Escape' && onCancel?.()} />
      <button type="submit" className="btn small primary" disabled={!text.trim() || busy}>{busy ? <LoaderCircle size={14} className="spin" /> : submitLabel}</button>
      {onCancel && <button type="button" className="btn small secondary" onClick={onCancel}>Hủy</button>}
    </form>
  );
}

function CommentItem({ c, isReply, rootId, onReply, onEdited, onAskDelete, onOpenProfile, onToast, postId }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.content || '');
  if (c.deleted) {
    return <div className="comment deleted"><div className="comment-bubble"><em className="muted">Bình luận đã bị xóa</em></div></div>;
  }
  async function save(e) {
    e.preventDefault();
    try {
      const r = await api.editComment(postId, c.commentId, draft);
      onEdited(r.comment);
      setEditing(false);
    } catch (err) {
      onToast(err.message);
    }
  }
  return (
    <div className={'comment' + (isReply ? ' is-reply' : '')} id={'c-' + c.commentId}>
      <button type="button" className="post-author" onClick={() => onOpenProfile?.(c.author.userId)}>
        <Avatar name={c.author.displayName} seed={c.author.userId} size={isReply ? 26 : 30} />
      </button>
      <div className="comment-body">
        {editing ? (
          <form className="comment-edit" onSubmit={save}>
            <input value={draft} onChange={e => setDraft(e.target.value)} maxLength={2000} autoFocus aria-label="Sửa bình luận"
              onKeyDown={e => e.key === 'Escape' && setEditing(false)} />
            <button type="submit" className="btn small primary" disabled={!draft.trim()}>Lưu</button>
            <button type="button" className="btn small secondary" onClick={() => setEditing(false)}>Hủy</button>
          </form>
        ) : (
          <div className="comment-bubble">
            <strong>{c.author.displayName}</strong>
            {isReply && c.replyTo && c.replyTo.commentId !== rootId && (
              <span className="comment-reply-to">
                <CornerDownRight size={11} /> {c.replyTo.available ? <>trả lời <b>{c.replyTo.authorName}</b>: “{c.replyTo.excerpt}”</> : 'trả lời một bình luận đã bị xóa'}
              </span>
            )}
            <span className="comment-text">{c.content}</span>
          </div>
        )}
        <div className="comment-meta">
          <time dateTime={c.createdAt} title={formatFull(c.createdAt)}>{formatListTime(c.createdAt)}</time>
          {c.edited && <span>· đã sửa</span>}
          <button type="button" className="link-btn" onClick={() => onReply(c)}>Trả lời</button>
          {c.canEdit && !editing && <button type="button" className="link-btn" onClick={() => { setDraft(c.content); setEditing(true); }}>Sửa</button>}
          {c.canDelete && <button type="button" className="link-btn danger-text" onClick={() => onAskDelete(c)}>Xóa</button>}
          {!c.canEdit && <ReportCommentButton postId={postId} commentId={c.commentId} onToast={onToast} />}
        </div>
      </div>
    </div>
  );
}

// Binh luan theo luong: goc (20 / trang) + phan hoi duoi moi goc (20 / trang).
export default function CommentThread({ post, me, onCountChange, onToast, onOpenProfile, liveVersion }) {
  const [roots, setRoots] = useState([]);
  const [token, setToken] = useState(null);
  const [state, setState] = useState('loading');
  const [threads, setThreads] = useState({});       // rootId -> { items, token, loading, error }
  const [replyTarget, setReplyTarget] = useState(null); // { rootId, comment }
  const [confirm, setConfirm] = useState(null);
  const rootsRef = useRef(roots);
  const threadsRef = useRef(threads);
  useEffect(() => { rootsRef.current = roots; threadsRef.current = threads; }, [roots, threads]);

  const loadRoots = useCallback(async (pageToken, keep = 0) => {
    setState(s => (pageToken ? 'more' : s === 'ready' ? 'ready' : 'loading'));
    try {
      let all = [];
      let next = pageToken;
      for (let i = 0; i < 5; i++) {
        const page = await api.comments(post.postId, next);
        all = all.concat(page.items);
        next = page.nextPageToken;
        onCountChange(page.total);
        if (!next || all.length >= keep) break;
      }
      setRoots(l => (pageToken ? [...l, ...all.filter(c => !l.some(x => x.commentId === c.commentId))] : all));
      setToken(next);
      setState('ready');
    } catch (err) {
      onToast(err.message);
      setState('error');
    }
  }, [post.postId, onCountChange, onToast]);

  const loadThread = useCallback(async (rootId, pageToken, keep = 0) => {
    setThreads(t => ({ ...t, [rootId]: { ...(t[rootId] || { items: [] }), loading: true, error: '' } }));
    try {
      let all = [];
      let next = pageToken;
      for (let i = 0; i < 5; i++) {
        const page = await api.replies(post.postId, rootId, next);
        all = all.concat(page.items);
        next = page.nextPageToken;
        if (!next || all.length >= keep) break;
      }
      setThreads(t => ({ ...t, [rootId]: { items: pageToken ? [...(t[rootId]?.items || []), ...all] : all, token: next, loading: false, error: '' } }));
    } catch (err) {
      setThreads(t => ({ ...t, [rootId]: { ...(t[rootId] || { items: [] }), loading: false, error: err.message } }));
    }
  }, [post.postId]);

  useEffect(() => { loadRoots(null); }, [loadRoots]);

  // Nguoi khac binh luan / tra loi / sua / xoa: tai lai so trang dang mo cua goc va cac luong dang mo.
  useEffect(() => {
    if (!liveVersion) return;
    loadRoots(null, rootsRef.current.length);
    Object.entries(threadsRef.current).forEach(([rootId, t]) => loadThread(rootId, null, t.items.length));
  }, [liveVersion, loadRoots, loadThread]);

  async function addRoot(content, clientId) {
    try {
      const r = await api.addReply(post.postId, content, undefined, clientId);
      if (!token) setRoots(l => (l.some(c => c.commentId === r.comment.commentId) ? l : [...l, { ...r.comment, replyCount: 0 }]));
      onCountChange(r.total);
    } catch (err) {
      onToast(err.message);
      throw err;
    }
  }

  async function addReply(content, clientId) {
    const { rootId, comment } = replyTarget;
    try {
      const r = await api.addReply(post.postId, content, comment.commentId, clientId);
      onCountChange(r.total);
      setRoots(l => l.map(c => (c.commentId === rootId && !r.duplicate ? { ...c, replyCount: (c.replyCount || 0) + 1 } : c)));
      const t = threadsRef.current[rootId];
      if (t && !t.token) {
        setThreads(x => ({ ...x, [rootId]: { ...t, items: t.items.some(i => i.commentId === r.comment.commentId) ? t.items : [...t.items, r.comment] } }));
      } else {
        await loadThread(rootId, null, (t?.items.length || 0) + 1);
      }
      setReplyTarget(null);
    } catch (err) {
      onToast(err.message);
      throw err;
    }
  }

  async function remove(c, rootId) {
    try {
      const r = await api.deleteComment(post.postId, c.commentId);
      onCountChange(r.total);
      if (rootId) {
        setThreads(t => ({ ...t, [rootId]: { ...t[rootId], items: t[rootId].items.filter(i => i.commentId !== c.commentId) } }));
        setRoots(l => l.map(x => (x.commentId === rootId ? { ...x, replyCount: Math.max(0, (x.replyCount || 1) - 1) } : x)));
      } else {
        await loadRoots(null, rootsRef.current.length); // goc co phan hoi -> placeholder; khong -> bien mat
      }
    } catch (err) {
      onToast(err.message);
    }
  }

  const updateItem = rootId => updated => {
    if (rootId) setThreads(t => ({ ...t, [rootId]: { ...t[rootId], items: t[rootId].items.map(i => (i.commentId === updated.commentId ? { ...i, ...updated } : i)) } }));
    else setRoots(l => l.map(c => (c.commentId === updated.commentId ? { ...c, ...updated } : c)));
  };

  return (
    <div className="comments">
      {state === 'loading' && <p className="muted small-note"><LoaderCircle size={13} className="spin" /> Đang tải bình luận…</p>}
      {state === 'error' && (
        <p className="error-text small-note" role="alert">Không tải được bình luận.{' '}
          <button type="button" className="link-btn" onClick={() => loadRoots(null)}><RotateCcw size={12} /> Thử lại</button></p>
      )}
      {state === 'ready' && roots.length === 0 && <p className="muted small-note">Chưa có bình luận nào. Hãy là người đầu tiên.</p>}
      {roots.map(root => {
        const t = threads[root.commentId];
        const shown = t?.items.length || 0;
        return (
          <div key={root.commentId} className="comment-thread">
            <CommentItem c={root} postId={post.postId} onReply={c => setReplyTarget({ rootId: root.commentId, comment: c })}
              onEdited={updateItem(null)} onAskDelete={c => setConfirm({ c, rootId: null })} onOpenProfile={onOpenProfile} onToast={onToast} />
            <div className="replies">
              {t?.items.map(r => (
                <CommentItem key={r.commentId} c={r} isReply rootId={root.commentId} postId={post.postId}
                  onReply={c => setReplyTarget({ rootId: root.commentId, comment: c })} onEdited={updateItem(root.commentId)}
                  onAskDelete={c => setConfirm({ c, rootId: root.commentId })} onOpenProfile={onOpenProfile} onToast={onToast} />
              ))}
              {root.replyCount > shown && !t?.loading && (
                <button type="button" className="link-btn replies-more" onClick={() => loadThread(root.commentId, t?.token || null)}>
                  <CornerDownRight size={13} /> {shown ? 'Xem thêm phản hồi' : `Xem ${root.replyCount}${root.replyCountCapped ? '+' : ''} phản hồi`}
                </button>
              )}
              {t?.loading && <p className="muted small-note"><LoaderCircle size={12} className="spin" /> Đang tải phản hồi…</p>}
              {t?.error && <p className="error-text small-note">{t.error}</p>}
              {replyTarget?.rootId === root.commentId && (
                <div className="reply-box">
                  <p className="comment-replying">Đang trả lời <strong>{replyTarget.comment.author.displayName}</strong>: “{(replyTarget.comment.content || '').slice(0, 80)}”</p>
                  <CommentInput me={me} autoFocus placeholder={`Trả lời ${replyTarget.comment.author.displayName}…`} onSubmit={addReply}
                    onCancel={() => setReplyTarget(null)} submitLabel="Trả lời" />
                </div>
              )}
            </div>
          </div>
        );
      })}
      {state === 'ready' && token && <button type="button" className="link-btn comments-more" onClick={() => loadRoots(token)}>Xem thêm bình luận</button>}
      {state === 'more' && <p className="muted small-note"><LoaderCircle size={13} className="spin" /> Đang tải…</p>}
      <CommentInput me={me} placeholder="Viết bình luận…" onSubmit={addRoot} />
      {confirm && (
        <ConfirmDialog title="Xóa bình luận?" message={confirm.rootId ? 'Phản hồi sẽ không còn hiển thị với mọi người.'
          : 'Bình luận sẽ không còn hiển thị. Phản hồi của người khác (nếu có) vẫn được giữ.'} confirmLabel="Xóa" danger
          onConfirm={() => { const x = confirm; setConfirm(null); remove(x.c, x.rootId); }} onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
}
