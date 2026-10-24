import { useEffect, useState } from 'react';
import { LoaderCircle, Newspaper } from 'lucide-react';
import { PrivacyIcon } from './PostBits';
import { api, postMediaUrl } from '../api';
import { formatListTime } from '../utils';

// Bo nho dem trong phien cho cac bai duoc chia se vao chat (moi nguoi xem tu tai -> backend kiem tra quyen cua chinh ho).
const cache = new Map();

// Goi khi dang xuat: khong de du lieu bai viet cua tai khoan cu lai trong bo nho.
export function clearSharedPostCache() {
  cache.clear();
}

export default function SharedPostPreview({ postId, onOpenPost }) {
  const [state, setState] = useState(() => (cache.has(postId) ? cache.get(postId) : { status: 'loading' }));

  useEffect(() => {
    if (cache.has(postId)) return undefined;
    let alive = true;
    api.post(postId)
      .then(post => {
        const s = { status: 'ok', post: post.shared?.available ? post.shared.post : post };
        cache.set(postId, s);
        if (alive) setState(s);
      })
      .catch(err => {
        const s = { status: err.status === 404 ? 'unavailable' : 'error', message: err.message };
        if (err.status === 404) cache.set(postId, s);
        if (alive) setState(s);
      });
    return () => { alive = false; };
  }, [postId]);

  if (state.status === 'loading') return <div className="shared-post loading"><LoaderCircle size={14} className="spin" /> Đang tải bài viết…</div>;
  if (state.status !== 'ok') {
    return <div className="shared-post unavailable"><Newspaper size={15} /> Bài viết không còn khả dụng hoặc bạn không có quyền xem.</div>;
  }
  const p = state.post;
  const img = p.media[0];
  return (
    <button type="button" className="shared-post" onClick={() => onOpenPost?.(p.author.userId)} title="Xem trang cá nhân của tác giả">
      {img && <img src={postMediaUrl(p.postId, img.mediaId)} alt="" loading="lazy" />}
      <span className="sp-body">
        <span className="sp-head"><Newspaper size={13} /> <strong>{p.author.displayName}</strong> · {formatListTime(p.createdAt)} · <PrivacyIcon value={p.privacy} size={12} /></span>
        <span className="sp-text">{p.content || (p.media.length ? `${p.media.length} ảnh` : '')}</span>
      </span>
    </button>
  );
}
