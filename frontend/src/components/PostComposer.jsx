import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ImagePlus, LoaderCircle, RotateCw, X } from 'lucide-react';
import Avatar from './Avatar';
import { PrivacySelect } from './PostBits';
import { api, uploadPostMedia } from '../api';
import { MAX_UPLOAD_BYTES, fileExt, formatBytes } from '../utils';

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
const MAX_IMAGES = 10;
let seq = 0;

// Soan bai: chu + toi da 10 anh (tai len ngay khi chon, trang thai PENDING o backend) + quyen rieng tu.
export default function PostComposer({ user, onPosted, onToast }) {
  const [text, setText] = useState('');
  const [privacy, setPrivacy] = useState('FRIENDS');
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);
  const aborts = useRef(new Map());
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);

  // Roi trang: huy anh chua dang de khong de lai anh mo coi.
  useEffect(() => () => {
    aborts.current.forEach(a => a());
    itemsRef.current.forEach(it => {
      URL.revokeObjectURL(it.preview);
      if (it.status === 'done') api.cancelPostMedia(it.media.mediaId).catch(() => {});
    });
  }, []);

  const patch = (key, change) => setItems(list => list.map(it => (it.key === key ? { ...it, ...change } : it)));

  function start(item) {
    const { promise, abort } = uploadPostMedia(item.file, p => patch(item.key, { progress: p }));
    aborts.current.set(item.key, abort);
    promise.then(media => patch(item.key, { status: 'done', media }))
      .catch(err => err.name !== 'AbortError' && patch(item.key, { status: 'error', error: err.message }))
      .finally(() => aborts.current.delete(item.key));
  }

  function addFiles(list) {
    const problems = [];
    const fresh = [];
    for (const file of [...list]) {
      if (itemsRef.current.length + fresh.length >= MAX_IMAGES) { problems.push(`Tối đa ${MAX_IMAGES} ảnh mỗi bài.`); break; }
      if (!IMAGE_EXT.includes(fileExt(file.name))) { problems.push(`"${file.name}" không phải ảnh JPG/PNG/GIF/WEBP.`); continue; }
      if (file.size > MAX_UPLOAD_BYTES) { problems.push(`"${file.name}" lớn hơn ${formatBytes(MAX_UPLOAD_BYTES)}.`); continue; }
      fresh.push({ key: 'p' + (++seq), file, status: 'uploading', progress: 0, preview: URL.createObjectURL(file) });
    }
    setError(problems.slice(0, 2).join(' '));
    if (!fresh.length) return;
    setItems(l => [...l, ...fresh]);
    fresh.forEach(start);
  }

  function remove(it) {
    aborts.current.get(it.key)?.();
    URL.revokeObjectURL(it.preview);
    if (it.status === 'done') api.cancelPostMedia(it.media.mediaId).catch(() => {});
    setItems(l => l.filter(x => x.key !== it.key));
  }

  const uploading = items.some(i => i.status === 'uploading');
  const failed = items.some(i => i.status === 'error');
  const ready = items.filter(i => i.status === 'done');
  const canPost = !busy && !uploading && !failed && (text.trim() || ready.length);

  async function submit(e) {
    e.preventDefault();
    if (!canPost) return;
    setBusy(true);
    setError('');
    try {
      const post = await api.createPost({ content: text.trim() || undefined, privacy, mediaIds: ready.length ? ready.map(i => i.media.mediaId) : undefined });
      items.forEach(i => URL.revokeObjectURL(i.preview));
      setItems([]);
      setText('');
      onPosted(post);
      onToast?.('Đã đăng bài.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="post-composer card" onSubmit={submit}>
      <div className="pc-top">
        <Avatar name={user.displayName} seed={user.userId} size={40} />
        <textarea value={text} onChange={e => setText(e.target.value)} placeholder={`${user.displayName.split(' ').slice(-1)[0]} ơi, bạn đang nghĩ gì?`}
          maxLength={5000} rows={text.split('\n').length > 2 ? 5 : 2} aria-label="Nội dung bài viết"
          onPaste={e => { const f = [...(e.clipboardData?.files || [])]; if (f.length) { e.preventDefault(); addFiles(f); } }} />
      </div>
      {items.length > 0 && (
        <ul className="pc-images">
          {items.map(it => (
            <li key={it.key} className={'pc-image ' + it.status}>
              {it.status !== 'error' ? <img src={it.preview} alt="" /> : <span className="pc-img-error"><AlertCircle size={18} />{it.error}</span>}
              {it.status === 'uploading' && <span className="pc-progress">{Math.round(it.progress * 100)}%</span>}
              {it.status === 'error' && (
                <button type="button" className="pc-retry" onClick={() => { patch(it.key, { status: 'uploading', progress: 0 }); start(it); }}
                  aria-label="Thử lại"><RotateCw size={14} /></button>
              )}
              <button type="button" className="pc-remove" onClick={() => remove(it)} aria-label={'Bỏ ' + it.file.name}><X size={14} /></button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="composer-error" role="alert">{error}</p>}
      <div className="pc-bar">
        <button type="button" className="btn small secondary" onClick={() => fileRef.current?.click()} disabled={items.length >= MAX_IMAGES}>
          <ImagePlus size={16} /> Ảnh
        </button>
        <input ref={fileRef} type="file" multiple hidden accept={IMAGE_EXT.map(e => '.' + e).join(',')}
          onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
        <PrivacySelect value={privacy} onChange={setPrivacy} />
        <span className="pc-spacer" />
        <button type="submit" className="btn small primary" disabled={!canPost}>
          {busy ? <LoaderCircle size={15} className="spin" /> : null} Đăng
        </button>
      </div>
    </form>
  );
}
