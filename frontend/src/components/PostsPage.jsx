import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, LoaderCircle, RotateCcw, X } from 'lucide-react';
import Avatar from './Avatar';
import PostCard from './PostCard';
import PostComposer from './PostComposer';
import RelationActions from './RelationActions';
import ShareDialog from './ShareDialog';
import { api, postMediaUrl } from '../api';
import StoriesBar from '../extensions/Stories';

function PostLightbox({ post, index, onClose }) {
  const [i, setI] = useState(index);
  const m = post.media[i];
  useEffect(() => {
    const onKey = e => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setI(x => Math.min(post.media.length - 1, x + 1));
      if (e.key === 'ArrowLeft') setI(x => Math.max(0, x - 1));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, post.media.length]);
  return (
    <div className="lightbox" role="dialog" aria-modal="true" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="lightbox-bar">
        <span>{post.author.displayName} · ảnh {i + 1}/{post.media.length}</span>
        <a className="icon-btn" href={postMediaUrl(post.postId, m.mediaId)} download={m.fileName} aria-label="Tải xuống"><Download size={19} /></a>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Đóng"><X size={20} /></button>
      </div>
      {i > 0 && <button type="button" className="icon-btn lb-nav prev" onClick={() => setI(i - 1)} aria-label="Ảnh trước"><ChevronLeft size={26} /></button>}
      <img src={postMediaUrl(post.postId, m.mediaId)} alt={m.fileName} />
      {i < post.media.length - 1 && <button type="button" className="icon-btn lb-nav next" onClick={() => setI(i + 1)} aria-label="Ảnh sau"><ChevronRight size={26} /></button>}
    </div>
  );
}

// Bang tin (userId = null) hoac trang ca nhan (userId).
export default function PostsPage({ user, userId = null, conversations, onOpenProfile, onMessage, onToast, onBack }) {
  const isProfile = Boolean(userId);
  const isMe = userId === user.userId;
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [profile, setProfile] = useState(null);
  const [sharing, setSharing] = useState(null);           // { post, onDone }
  const [lightbox, setLightbox] = useState(null);
  const [myStats, setMyStats] = useState(null);
  const sentinel = useRef(null);
  const busy = useRef(false);

  const fetchPage = useCallback(c => (isProfile ? api.timeline(userId, c) : api.feed(c)), [isProfile, userId]);

  const load = useCallback(async c => {
    if (busy.current) return;
    busy.current = true;
    setState(c ? 'more' : 'loading');
    try {
      const page = await fetchPage(c);
      setItems(l => {
        if (!c) return page.items;
        const seen = new Set(l.map(p => p.postId));
        return [...l, ...page.items.filter(p => !seen.has(p.postId))];
      });
      setCursor(page.nextCursor);
      setState('ready');
      setError('');
    } catch (err) {
      setError(err.message);
      setState('error');
    } finally {
      busy.current = false;
    }
  }, [fetchPage]);

  const loadProfile = useCallback(() => {
    if (isProfile) api.profile(userId).then(setProfile).catch(err => setError(err.message));
  }, [isProfile, userId]);

  useEffect(() => { load(null); loadProfile(); }, [load, loadProfile]);
  useEffect(() => { if (isMe) api.myAnalytics().then(setMyStats).catch(() => setMyStats(null)); }, [isMe, items.length]);

  // Cuon toi day -> trang tiep theo (IntersectionObserver, khong nghe scroll lien tuc)
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !cursor || state !== 'ready') return undefined;
    const ob = new IntersectionObserver(e => e.some(x => x.isIntersecting) && load(cursor), { rootMargin: '400px' });
    ob.observe(el);
    return () => ob.disconnect();
  }, [cursor, state, load]);

  const onDeleted = useCallback(id => setItems(l => l.filter(p => p.postId !== id)), []);
  const openImage = useCallback((post, index) => setLightbox({ post, index }), []);
  const closeShare = useCallback(() => setSharing(null), []);
  const openShare = useCallback((post, onDone) => setSharing({ post, onDone }), []);

  return (
    <section className="posts-page" aria-label={isProfile ? 'Trang cá nhân' : 'Bảng tin'}>
      <div className="posts-scroll">
        <div className="posts-col">
          {isProfile && profile && (
            <div className="card profile-page-head">
              <div className="profile-cover" aria-hidden="true" style={profile.coverUrl ? { backgroundImage: `url(${profile.coverUrl})` } : undefined} />
              <div className="pph-body">
                <Avatar name={profile.displayName} seed={profile.userId} size={92} />
                <div className="pph-text">
                  <h2>{profile.displayName}</h2>
                  {profile.username && <p className="muted">@{profile.username}</p>}
                  {profile.bio && <p className="pph-bio">{profile.bio}</p>}
                </div>
                {!isMe && (
                  <RelationActions userId={profile.userId} displayName={profile.displayName} relationship={profile.relationship}
                    onToast={onToast} onMessage={onMessage} onChanged={() => { loadProfile(); load(null); }} />
                )}
              </div>
              {isMe && myStats && (
                <div className="kpis pph-stats" aria-label="Thống kê của bạn">
                  <div><strong>{myStats.posts}</strong><span>bài viết</span></div>
                  <div><strong>{myStats.reactions_received}</strong><span>cảm xúc nhận</span></div>
                  <div><strong>{myStats.comments_received}</strong><span>bình luận nhận</span></div>
                  <div><strong>{myStats.shares_received}</strong><span>lượt chia sẻ</span></div>
                </div>
              )}
              {onBack && <button type="button" className="link-btn pph-back" onClick={onBack}>← Quay lại</button>}
            </div>
          )}
          {!isProfile && <h2 className="posts-title">Bảng tin</h2>}
          {!isProfile && <StoriesBar user={user} onToast={onToast} />}
          {(!isProfile || isMe) && (
            <PostComposer user={user} onToast={onToast} onPosted={p => setItems(l => [p, ...l])} />
          )}

          {state === 'loading' && <p className="muted pad"><LoaderCircle size={15} className="spin" /> Đang tải bài viết…</p>}
          {state === 'error' && (
            <div className="card pad" role="alert"><p className="error-text">Không tải được bài viết: {error}</p>
              <button type="button" className="btn secondary small" onClick={() => load(null)}><RotateCcw size={14} /> Thử lại</button></div>
          )}
          {state !== 'loading' && state !== 'error' && items.length === 0 && (
            <p className="muted pad posts-empty">
              {isProfile ? (isMe ? 'Bạn chưa đăng bài nào.' : 'Chưa có bài viết nào bạn được phép xem.')
                : 'Chưa có bài viết nào bạn được xem. Bảng tin hiển thị bài công khai của mọi người và bài của bạn bè — hãy đăng bài đầu tiên hoặc kết bạn ở mục Bạn bè.'}
            </p>
          )}
          {items.map(p => (
            <PostCard key={p.postId} post={p} me={user} onDeleted={onDeleted} onShare={openShare}
              onOpenProfile={onOpenProfile} onOpenImage={openImage} onToast={onToast} />
          ))}
          <div ref={sentinel} />
          {state === 'more' && <p className="muted pad"><LoaderCircle size={15} className="spin" /> Đang tải thêm…</p>}
          {state === 'ready' && cursor && (
            <button type="button" className="btn secondary posts-more" onClick={() => load(cursor)}>Xem thêm bài viết</button>
          )}
          {state === 'ready' && items.length > 0 && !cursor && <p className="muted pad posts-end">Đã hết bài viết.</p>}
        </div>
      </div>
      {sharing && (
        <ShareDialog post={sharing.post} conversations={conversations} onClose={closeShare} onToast={onToast}
          onSharedOnce={sharing.onDone}
          onShared={p => (!isProfile || isMe ? setItems(l => [p, ...l]) : null)} />
      )}
      {lightbox && <PostLightbox post={lightbox.post} index={lightbox.index} onClose={() => setLightbox(null)} />}
    </section>
  );
}
