// Mang xa hoi: PT-22 luu bai, PT-24 hashtag, PT-07 bao cao bai, PT-18 goi y ket ban,
// PT-19 tham gia nhom bang link moi; trang danh sach bai (bai da luu / theo hashtag).
import { useCallback, useEffect, useState } from 'react';
import { Bookmark, BookmarkCheck, Flag, Hash, LoaderCircle, RotateCcw, UserPlus, Users, X } from 'lucide-react';
import Avatar from '../components/Avatar';
import PostCard from '../components/PostCard';
import ShareDialog from '../components/ShareDialog';
import { api, postMediaUrl } from '../api';
import { ext } from './extApi';
import { navigate } from './sse';
import { ReportDialog } from './MessageDialogs';
import { fold } from '../utils';

// Giong backend (social-extras.service hashtagsOf): bo dau, chu thuong, [a-z0-9_], 2-50 ky tu, toi da 10.
function hashtagsOf(text) {
  const out = new Set();
  const re = /(^|[^\p{L}\p{N}_&])#([\p{L}\p{N}_]{2,50})/gu;
  let m;
  while ((m = re.exec(String(text || ''))) && out.size < 10) {
    const key = fold(m[2]).replace(/[^a-z0-9_]/g, '');
    if (key.length >= 2 && !/^\d+$/.test(key)) out.add(key);
  }
  return [...out];
}

export function PostExtras({ post, me, onToast }) {
  const [saved, setSaved] = useState(Boolean(post.saved));
  const [report, setReport] = useState(false);
  useEffect(() => { setSaved(Boolean(post.saved)); }, [post.saved]);
  async function toggleSave() {
    const next = !saved;
    setSaved(next);
    try {
      await (next ? ext.savePost(post.postId) : ext.unsavePost(post.postId));
      onToast(next ? 'Đã lưu bài viết.' : 'Đã bỏ lưu bài viết.');
    } catch (err) {
      setSaved(!next);
      onToast(err.message);
    }
  }
  const tags = post.hashtags || hashtagsOf(post.content);
  return (
    <div className="ext-post-extras">
      {tags.map(t => (
        <button key={t} type="button" className="ext-hashtag" onClick={() => navigate('hashtag', { tag: t })}>#{t}</button>
      ))}
      <span className="pc-spacer" />
      <button type="button" className={'icon-btn small' + (saved ? ' on' : '')} onClick={toggleSave} title={saved ? 'Bỏ lưu' : 'Lưu bài viết'} aria-label={saved ? 'Bỏ lưu bài viết' : 'Lưu bài viết'} aria-pressed={saved}>
        {saved ? <BookmarkCheck size={16} /> : <Bookmark size={16} />}
      </button>
      {post.author.userId !== me.userId && (
        <button type="button" className="icon-btn small" onClick={() => setReport(true)} title="Báo cáo bài viết" aria-label="Báo cáo bài viết"><Flag size={15} /></button>
      )}
      {report && <ReportDialog target={{ targetType: 'POST', targetId: post.postId, label: 'bài viết' }} onClose={() => setReport(false)} onToast={onToast} />}
    </div>
  );
}

export function ReportUserButton({ userId, displayName, onToast }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn small secondary" onClick={() => setOpen(true)}><Flag size={15} /> Báo cáo</button>
      {open && <ReportDialog target={{ targetType: 'USER', targetId: userId, label: `tài khoản ${displayName}` }} onClose={() => setOpen(false)} onToast={onToast} />}
    </>
  );
}

export function ReportCommentButton({ postId, commentId, onToast }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="link-btn" onClick={() => setOpen(true)}>Báo cáo</button>
      {open && <ReportDialog target={{ targetType: 'COMMENT', targetId: commentId, postId, label: 'bình luận' }} onClose={() => setOpen(false)} onToast={onToast} />}
    </>
  );
}

// Trang bai da luu (mode = saved) hoac theo hashtag (mode = hashtag, tag).
export function PostListPage({ mode, tag, user, conversations, onOpenProfile, onToast }) {
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [sharing, setSharing] = useState(null);
  const [q, setQ] = useState(tag || '');
  const load = useCallback(async c => {
    setState(c ? 'more' : 'loading');
    try {
      const page = mode === 'saved' ? await ext.savedPosts(c) : await ext.hashtagPosts(tag, c);
      setItems(l => (c ? [...l, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setState('ready');
    } catch (err) {
      setError(err.message);
      setState('error');
    }
  }, [mode, tag]);
  useEffect(() => { setQ(tag || ''); load(null); }, [load, tag]);
  const onDeleted = useCallback(id => setItems(l => l.filter(p => p.postId !== id)), []);
  const openShare = useCallback((post, onDone) => setSharing({ post, onDone }), []);
  const openImage = useCallback((post, i) => window.open(postMediaUrl(post.postId, post.media[i].mediaId), '_blank', 'noopener'), []);
  return (
    <section className="posts-page" aria-label={mode === 'saved' ? 'Bài đã lưu' : 'Hashtag'}>
      <div className="posts-scroll">
        <div className="posts-col">
          {mode === 'saved' ? <h2 className="posts-title"><Bookmark size={20} /> Bài viết đã lưu</h2> : (
            <form className="ext-row ext-hashtag-head" onSubmit={e => { e.preventDefault(); if (q.trim()) navigate('hashtag', { tag: q.replace(/^#/, '').trim() }); }}>
              <h2 className="posts-title"><Hash size={20} /></h2>
              <input className="ext-input" value={q} onChange={e => setQ(e.target.value)} placeholder="Tìm hashtag" aria-label="Hashtag" />
              <button type="submit" className="btn primary small">Tìm</button>
            </form>
          )}
          {state === 'loading' && <p className="muted pad"><LoaderCircle size={15} className="spin" /> Đang tải…</p>}
          {state === 'error' && <div className="card pad"><p className="error-text">{error}</p>
            <button type="button" className="btn secondary small" onClick={() => load(null)}><RotateCcw size={14} /> Thử lại</button></div>}
          {state === 'ready' && items.length === 0 && (
            <p className="muted pad">{mode === 'saved' ? 'Bạn chưa lưu bài viết nào. Bấm biểu tượng dấu trang trên bài viết để lưu.' : `Chưa có bài viết nào bạn được xem với #${tag}.`}</p>
          )}
          {items.map(p => (p.unavailable
            ? <div key={p.postId} className="card pad muted">Bài viết không còn khả dụng.
              {mode === 'saved' && <button type="button" className="link-btn" onClick={async () => { await ext.unsavePost(p.postId); onDeleted(p.postId); }}> Bỏ lưu</button>}</div>
            : <PostCard key={p.postId} post={p} me={user} onDeleted={onDeleted} onShare={openShare} onOpenProfile={onOpenProfile} onOpenImage={openImage} onToast={onToast} />))}
          {state === 'ready' && cursor && <button type="button" className="btn secondary posts-more" onClick={() => load(cursor)}>Xem thêm</button>}
          {state === 'more' && <p className="muted pad"><LoaderCircle size={15} className="spin" /> Đang tải thêm…</p>}
        </div>
      </div>
      {sharing && <ShareDialog post={sharing.post} conversations={conversations} onClose={() => setSharing(null)} onToast={onToast} onSharedOnce={sharing.onDone} onShared={() => {}} />}
    </section>
  );
}

export function FriendSuggestions({ version, onOpenProfile, onToast }) {
  const [items, setItems] = useState(null);
  const load = useCallback(() => ext.suggestions().then(r => setItems(r.data)).catch(() => setItems([])), []);
  useEffect(() => { load(); }, [load, version]);
  if (!items || items.length === 0) return null;
  async function add(p) {
    try { await api.sendFriendRequest(p.userId); onToast(`Đã gửi lời mời tới ${p.displayName}.`); load(); } catch (err) { onToast(err.message); }
  }
  return (
    <section className="friends-section ext-suggestions">
      <h3 className="section-title">Gợi ý kết bạn</h3>
      <ul>
        {items.map(p => (
          <li key={p.userId} className="ext-sug">
            <button type="button" className="ext-sug-main" onClick={() => onOpenProfile(p.userId)}>
              <Avatar name={p.displayName} seed={p.userId} size={44} />
              <span><strong>{p.displayName}</strong>
                <span className="muted ext-sub">{p.mutualCount} bạn chung{p.mutualNames.length ? `: ${p.mutualNames.join(', ')}` : ''}</span></span>
            </button>
            {p.relationship === 'NONE' && <button type="button" className="btn small primary" onClick={() => add(p)}><UserPlus size={14} /> Kết bạn</button>}
            {p.relationship === 'OUTGOING' && <span className="muted">Đã gửi lời mời</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function JoinInviteDialog({ code, onClose, onJoined, onToast }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { ext.previewInvite(code).then(setInfo).catch(err => setError(err.message)); }, [code]);
  async function join() {
    setBusy(true);
    try {
      const r = await ext.joinInvite(code);
      if (r.joined) { onToast('Đã tham gia nhóm.'); onJoined(r.conversationId); } else { onToast('Đã gửi yêu cầu tham gia, chờ trưởng/phó nhóm duyệt.'); onClose(); }
    } catch (err) {
      onToast(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="dialog small" role="dialog" aria-modal="true" aria-label="Lời mời vào nhóm">
        <div className="dialog-head"><h3><Users size={18} /> Lời mời vào nhóm</h3>
          <button type="button" className="icon-btn ghost" onClick={onClose} aria-label="Đóng"><X size={18} /></button></div>
        {error && <p className="error-text">{error}</p>}
        {!info && !error && <p className="muted"><LoaderCircle size={14} className="spin" /> Đang tải…</p>}
        {info && (
          <>
            <div className="ext-row"><Avatar name={info.name} seed={info.conversationId} group size={56} />
              <div><strong>{info.name}</strong><p className="muted">{info.memberCount} thành viên{info.requireApproval ? ' · cần duyệt' : ''}</p></div></div>
            {info.description && <p>{info.description}</p>}
            <div className="dialog-actions">
              <button type="button" className="btn secondary" onClick={onClose}>Để sau</button>
              {info.isMember ? <button type="button" className="btn primary" onClick={() => onJoined(info.conversationId)}>Mở nhóm</button>
                : info.pending ? <button type="button" className="btn primary" disabled>Đang chờ duyệt</button>
                  : <button type="button" className="btn primary" disabled={busy} onClick={join}>{info.requireApproval ? 'Xin tham gia' : 'Tham gia'}</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
