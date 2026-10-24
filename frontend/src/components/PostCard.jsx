import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Ellipsis, LoaderCircle, MessageSquare, Pencil, Share2, ThumbsUp, Trash2 } from 'lucide-react';
import Avatar from './Avatar';
import ConfirmDialog from './ConfirmDialog';
import CommentThread from './CommentThread';
import ReactionsDialog from './ReactionsDialog';
import { POST_REACTIONS, PRIVACY_INFO, PrivacyIcon, PrivacySelect, reactionOf } from './PostBits';
import { api, postMediaUrl } from '../api';
import { formatFull, formatListTime } from '../utils';
import { PostExtras } from '../extensions/SocialExtras';

function Images({ post, onOpen }) {
  if (!post.media.length) return null;
  const shown = post.media.slice(0, 4);
  return (
    <div className={'post-images n' + Math.min(post.media.length, 4)}>
      {shown.map((m, i) => (
        <button key={m.mediaId} type="button" className="post-img" onClick={() => onOpen(post, i)} aria-label={'Xem ảnh ' + (i + 1)}>
          <img src={postMediaUrl(post.postId, m.mediaId)} alt={m.fileName} loading="lazy" />
          {i === 3 && post.media.length > 4 && <span className="post-img-more">+{post.media.length - 4}</span>}
        </button>
      ))}
    </div>
  );
}

function Header({ post, onOpenProfile, children }) {
  return (
    <div className="post-head">
      <button type="button" className="post-author" onClick={() => onOpenProfile?.(post.author.userId)}>
        <Avatar name={post.author.displayName} seed={post.author.userId} size={40} />
      </button>
      <div className="post-meta">
        <span className="post-name-line">
          <button type="button" className="link-btn post-name" onClick={() => onOpenProfile?.(post.author.userId)}>{post.author.displayName}</button>
          {post.shared && <span className="post-did"> đã chia sẻ một bài viết</span>}
        </span>
        <span className="post-sub">
          <time dateTime={post.createdAt} title={formatFull(post.createdAt)}>{formatListTime(post.createdAt)}</time>
          {post.edited && <span title={'Sửa lúc ' + formatFull(post.updatedAt)}> · đã sửa</span>}
          {' · '}<span title={PRIVACY_INFO[post.privacy]?.label}><PrivacyIcon value={post.privacy} /></span>
        </span>
      </div>
      {children}
    </div>
  );
}

// Bai goc ben trong ban chia se: chi hien NEU backend tra available (nguoi xem co quyen).
export function EmbeddedPost({ shared, onOpenProfile, onOpenImage }) {
  if (!shared) return null;
  if (!shared.available) {
    return <div className="post-embed unavailable">Nội dung này không còn khả dụng hoặc bạn không có quyền xem.</div>;
  }
  const p = shared.post;
  return (
    <div className="post-embed">
      <Header post={p} onOpenProfile={onOpenProfile} />
      {p.content && <p className="post-text">{p.content}</p>}
      <Images post={p} onOpen={onOpenImage} />
    </div>
  );
}

function PostCard({ post: initial, me, onChanged, onDeleted, onShare, onOpenProfile, onOpenImage, onToast, openComments = false }) {
  const [post, setPost] = useState(initial);
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ content: initial.content, privacy: initial.privacy });
  const [confirm, setConfirm] = useState(false);
  const [showComments, setShowComments] = useState(openComments);
  const [liveVersion, setLiveVersion] = useState(0);
  const [showReactions, setShowReactions] = useState(false);
  const inflight = useRef(0);
  const [picker, setPicker] = useState(false);
  const pickerTimer = useRef(null);

  useEffect(() => { setPost(initial); }, [initial]);

  // Nguoi khac tuong tac: su kien chi co postId -> tai lai bai qua API (backend kiem tra quyen).
  // Bo qua khi minh dang co request cam xuc dang chay (tranh ghi de trang thai lac quan).
  useEffect(() => {
    let timer = null;
    const onChange = e => {
      if (e.detail?.postId !== initial.postId) return;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (inflight.current > 0) return;
        try {
          const fresh = await api.post(initial.postId);
          if (inflight.current === 0) setPost(fresh);
          if (e.detail.kind === 'comment') setLiveVersion(v => v + 1);
        } catch (err) {
          if (err.status === 404) onDeleted?.(initial.postId); // bi xoa / khong con quyen xem
        }
      }, 250);
    };
    window.addEventListener('chatott:post-changed', onChange);
    return () => { clearTimeout(timer); window.removeEventListener('chatott:post-changed', onChange); };
  }, [initial.postId, onDeleted]);

  const onCountChange = useCallback(n => setPost(p => (p.commentCount === n ? p : { ...p, commentCount: n })), []);

  // Cap nhat lac quan: doi nut + bo dem ngay, ket qua that tu server ghi de; loi -> hoan tac.
  async function react(key) {
    setPicker(false);
    const before = post.reactions;
    const removing = key === null || key === before.mine;
    const counts = { ...(before.counts || {}) };
    if (before.mine) counts[before.mine] = Math.max(0, (counts[before.mine] || 1) - 1);
    if (!removing) counts[key] = (counts[key] || 0) + 1;
    Object.keys(counts).forEach(k => counts[k] === 0 && delete counts[k]);
    const optimistic = { counts, mine: removing ? null : key, total: Object.values(counts).reduce((a, b) => a + b, 0) };
    setPost(p => ({ ...p, reactions: optimistic }));
    inflight.current += 1;
    try {
      const summary = removing ? await api.unreactPost(post.postId) : await api.reactPost(post.postId, key);
      setPost(p => ({ ...p, reactions: summary }));
    } catch (err) {
      setPost(p => ({ ...p, reactions: before }));
      onToast(err.message);
    } finally {
      inflight.current -= 1;
    }
  }

  async function saveEdit(e) {
    e.preventDefault();
    try {
      const p = await api.updatePost(post.postId, draft);
      setPost(p);
      setEditing(false);
      onChanged?.(p);
    } catch (err) {
      onToast(err.message);
    }
  }

  async function remove() {
    try {
      await api.deletePost(post.postId);
      onDeleted(post.postId);
      onToast('Đã xóa bài viết.');
    } catch (err) {
      onToast(err.message);
    }
  }

  const mine = reactionOf(post.reactions.mine);
  const top = Object.entries(post.reactions.counts || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => reactionOf(k)?.emoji).filter(Boolean);

  return (
    <article className="post card" aria-label={'Bài viết của ' + post.author.displayName}>
      <Header post={post} onOpenProfile={onOpenProfile}>
        {post.canEdit && (
          <div className="post-menu-wrap">
            <button type="button" className="icon-btn" onClick={() => setMenu(v => !v)} aria-label="Tùy chọn bài viết" aria-expanded={menu}>
              <Ellipsis size={18} />
            </button>
            {menu && (
              <div className="ctx-menu post-menu" role="menu" onMouseLeave={() => setMenu(false)}>
                <button type="button" role="menuitem" className="ctx-item" onClick={() => { setMenu(false); setDraft({ content: post.content, privacy: post.privacy }); setEditing(true); }}>
                  <Pencil size={16} /><span>Sửa bài viết</span>
                </button>
                <button type="button" role="menuitem" className="ctx-item danger" onClick={() => { setMenu(false); setConfirm(true); }}>
                  <Trash2 size={16} /><span>Xóa bài viết</span>
                </button>
              </div>
            )}
          </div>
        )}
      </Header>

      {editing ? (
        <form className="post-edit" onSubmit={saveEdit}>
          <textarea value={draft.content} onChange={e => setDraft(d => ({ ...d, content: e.target.value }))} rows={4} maxLength={5000} aria-label="Sửa nội dung" autoFocus />
          <div className="pc-bar">
            <PrivacySelect value={draft.privacy} onChange={v => setDraft(d => ({ ...d, privacy: v }))} />
            <span className="pc-spacer" />
            <button type="button" className="btn small secondary" onClick={() => setEditing(false)}>Hủy</button>
            <button type="submit" className="btn small primary">Lưu</button>
          </div>
        </form>
      ) : (
        post.content && <p className="post-text">{post.content}</p>
      )}

      <Images post={post} onOpen={onOpenImage} />
      <EmbeddedPost shared={post.shared} onOpenProfile={onOpenProfile} onOpenImage={onOpenImage} />
      <PostExtras post={post} me={me} onToast={onToast} />

      {(post.reactions.total > 0 || post.commentCount > 0 || post.shareCount > 0) && (
        <div className="post-stats">
          {post.reactions.total > 0 && (
            <button type="button" className="link-btn post-stat-react" onClick={() => setShowReactions(true)}
              title={Object.entries(post.reactions.counts || {}).map(([k, n]) => `${reactionOf(k)?.label}: ${n}`).join(', ') + ' — bấm để xem ai đã bày tỏ'}
              aria-label={`${post.reactions.total} cảm xúc. Xem danh sách`}>
              <span>{top.join('')}</span> {post.reactions.mine ? (post.reactions.total > 1 ? `Bạn và ${post.reactions.total - 1} người khác` : 'Bạn') : post.reactions.total}
            </button>
          )}
          <span className="pc-spacer" />
          {post.commentCount > 0 && <button type="button" className="link-btn muted" onClick={() => setShowComments(v => !v)}>{post.commentCount} bình luận</button>}
          {post.shareCount > 0 && <span>{post.shareCount} lượt chia sẻ</span>}
        </div>
      )}

      <div className="post-actions">
        <div className="react-wrap" onMouseEnter={() => { clearTimeout(pickerTimer.current); pickerTimer.current = setTimeout(() => setPicker(true), 350); }}
          onMouseLeave={() => { clearTimeout(pickerTimer.current); pickerTimer.current = setTimeout(() => setPicker(false), 250); }}>
          <button type="button" className={'post-action' + (mine ? ' on' : '')} onClick={() => react(mine ? null : 'LIKE')}
            aria-label={mine ? `Gỡ cảm xúc ${mine.label}` : 'Thích'}>
            {mine ? <span className="post-action-emoji">{mine.emoji}</span> : <ThumbsUp size={17} />}
            {mine ? mine.label : 'Thích'}
          </button>
          {picker && (
            <div className="post-react-picker" role="menu" aria-label="Chọn cảm xúc">
              {POST_REACTIONS.map(r => (
                <button key={r.key} type="button" role="menuitem" title={r.label} aria-label={r.label}
                  className={post.reactions.mine === r.key ? 'on' : ''} onClick={() => react(r.key)}>{r.emoji}</button>
              ))}
            </div>
          )}
        </div>
        <button type="button" className="post-action" onClick={() => setShowComments(v => !v)} aria-expanded={showComments}>
          <MessageSquare size={17} /> Bình luận
        </button>
        <button type="button" className="post-action" onClick={() => onShare(post, () => setPost(p => ({ ...p, shareCount: (p.shareCount || 0) + 1 })))}>
          <Share2 size={17} /> Chia sẻ
        </button>
      </div>

      {showComments && <CommentThread post={post} me={me} onCountChange={onCountChange} onToast={onToast} onOpenProfile={onOpenProfile} liveVersion={liveVersion} />}
      {showReactions && <ReactionsDialog postId={post.postId} onClose={() => setShowReactions(false)} onOpenProfile={id => { setShowReactions(false); onOpenProfile?.(id); }} />}

      {confirm && (
        <ConfirmDialog title="Xóa bài viết?" message="Bài viết, ảnh, cảm xúc và bình luận sẽ không còn hiển thị. Các bản chia sẻ sẽ báo nội dung không khả dụng."
          confirmLabel="Xóa" danger onConfirm={() => { setConfirm(false); remove(); }} onCancel={() => setConfirm(false)} />
      )}
    </article>
  );
}

export default memo(PostCard);
