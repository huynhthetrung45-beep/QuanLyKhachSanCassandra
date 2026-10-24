import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import PostCard from './PostCard';
import ShareDialog from './ShareDialog';

import { api } from '../api';

// Mo 1 bai viet (vd. tu thong bao). Backend kiem tra quyen: khong xem duoc -> bao ro, khong lo noi dung.
export default function PostModal({ postId, me, conversations, openComments = false, onClose, onOpenProfile, onToast }) {
  const [post, setPost] = useState(null);
  const [error, setError] = useState('');
  const [sharing, setSharing] = useState(null);

  useEffect(() => {
    let alive = true;
    api.post(postId).then(p => alive && setPost(p)).catch(err => alive && setError(err.status === 404 ? 'Bài viết không còn khả dụng hoặc bạn không có quyền xem.' : err.message));
    return () => { alive = false; };
  }, [postId]);

  useEffect(() => {
    const onKey = e => e.key === 'Escape' && !sharing && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, sharing]);

  const onShare = useCallback((p, onDone) => setSharing({ post: p, onDone }), []);

  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="dialog post-dialog" role="dialog" aria-modal="true" aria-label="Bài viết">
        <div className="dialog-head">
          <h3>Bài viết</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Đóng"><X size={18} /></button>
        </div>
        {!post && !error && <p className="muted"><LoaderCircle size={15} className="spin" /> Đang tải…</p>}
        {error && <p className="muted" role="alert">{error}</p>}
        {post && (
          <PostCard post={post} me={me} openComments={openComments} onDeleted={onClose} onShare={onShare}
            onOpenProfile={onOpenProfile} onOpenImage={() => {}} onToast={onToast} />
        )}
      </div>
      {sharing && (
        <ShareDialog post={sharing.post} conversations={conversations} onClose={() => setSharing(null)} onToast={onToast}
          onSharedOnce={sharing.onDone} />
      )}
    </div>
  );
}
