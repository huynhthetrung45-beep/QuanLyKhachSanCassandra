// PT-23: story 24 gio. Thanh story tren bang tin + trinh xem (tu chuyen sau 6 giay) + soan story.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Eye, ImagePlus, LoaderCircle, Plus, Trash2, X } from 'lucide-react';
import Avatar from '../components/Avatar';
import { ext } from './extApi';
import { useSse } from './sse';
import { formatListTime } from '../utils';

const BGS = ['teal', 'harbor', 'sunset', 'violet', 'forest', 'rose'];
const DURATION = 6000;
const mediaSrc = url => (url ? url.replace(/^\/api\/v1/, import.meta.env.VITE_API_BASE || '/api/v1') : null);

function StoryComposer({ onClose, onPosted, onToast }) {
  const [text, setText] = useState('');
  const [bg, setBg] = useState('teal');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  useEffect(() => () => preview && URL.revokeObjectURL(preview), [preview]);
  async function post() {
    setBusy(true);
    try {
      await (file ? ext.createImageStory(file, text, bg) : ext.createStory(text, bg));
      onPosted();
      onClose();
    } catch (err) {
      onToast(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="dialog ext-story-compose" role="dialog" aria-modal="true" aria-label="Tạo story">
        <div className="dialog-head"><h3>Tạo story (hiển thị 24 giờ với bạn bè)</h3>
          <button type="button" className="icon-btn ghost" onClick={onClose} aria-label="Đóng"><X size={18} /></button></div>
        <div className={'ext-story-canvas bg-' + bg}>
          {preview && <img src={preview} alt="" />}
          <textarea value={text} maxLength={500} onChange={e => setText(e.target.value)} placeholder="Bạn đang nghĩ gì?" aria-label="Nội dung story" />
        </div>
        <div className="ext-row wrap">
          {BGS.map(b => <button key={b} type="button" className={'ext-swatch bg-' + b + (bg === b ? ' on' : '')} onClick={() => setBg(b)} aria-label={'Nền ' + b} />)}
          <button type="button" className="btn secondary small" onClick={() => fileRef.current?.click()}><ImagePlus size={15} /> {file ? 'Đổi ảnh' : 'Thêm ảnh'}</button>
          {file && <button type="button" className="btn secondary small" onClick={() => { setFile(null); setPreview(null); }}>Bỏ ảnh</button>}
          <input ref={fileRef} type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif"
            onChange={e => { const f = e.target.files[0]; e.target.value = ''; if (f) { setFile(f); setPreview(URL.createObjectURL(f)); } }} />
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn secondary" onClick={onClose}>Hủy</button>
          <button type="button" className="btn primary" disabled={busy || (!text.trim() && !file)} onClick={post}>{busy && <LoaderCircle size={15} className="spin" />} Đăng story</button>
        </div>
      </div>
    </div>
  );
}

function StoryViewer({ groups, start, me, onClose, onChanged, onToast }) {
  const [g, setG] = useState(start);
  const [i, setI] = useState(() => Math.max(0, groups[start].items.findIndex(s => !s.viewed)));
  const [viewers, setViewers] = useState(null);
  const [paused, setPaused] = useState(false);
  const group = groups[g];
  const story = group?.items[i];

  const next = useCallback(() => {
    if (i < group.items.length - 1) setI(i + 1);
    else if (g < groups.length - 1) { setG(g + 1); setI(0); }
    else onClose();
  }, [g, i, group, groups.length, onClose]);
  const prev = () => { if (i > 0) setI(i - 1); else if (g > 0) { setG(g - 1); setI(0); } };

  useEffect(() => {
    if (!story) return undefined;
    setViewers(null);
    if (!story.mine && !story.viewed) ext.viewStory(group.author.userId, story.storyId).catch(() => {});
    if (paused) return undefined;
    const t = setTimeout(next, DURATION);
    return () => clearTimeout(t);
  }, [story, group, next, paused]);
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); if (e.key === 'ArrowRight') next(); if (e.key === 'ArrowLeft') prev(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });
  if (!story) return null;

  async function remove() {
    try { await ext.deleteStory(story.storyId); onToast('Đã xóa story.'); onChanged(); onClose(); } catch (err) { onToast(err.message); }
  }
  async function showViewers() {
    setPaused(true);
    try { setViewers((await ext.storyViewers(story.storyId)).items); } catch (err) { onToast(err.message); }
  }
  return (
    <div className="ext-story-viewer" role="dialog" aria-modal="true" aria-label={'Story của ' + group.author.displayName}>
      <div className={'ext-story-stage bg-' + story.background} onMouseDown={() => setPaused(true)} onMouseUp={() => setPaused(false)}>
        <div className="ext-story-progress">
          {group.items.map((s, k) => <span key={s.storyId} className={k < i ? 'done' : k === i ? (paused ? 'now paused' : 'now') : ''} style={{ animationDuration: `${DURATION}ms` }} />)}
        </div>
        <div className="ext-story-head">
          <Avatar name={group.author.displayName} seed={group.author.userId} size={34} />
          <strong>{group.author.userId === me.userId ? 'Story của bạn' : group.author.displayName}</strong>
          <span>{formatListTime(story.createdAt)}</span>
          <span className="pc-spacer" />
          {story.mine && <button type="button" className="icon-btn" onClick={showViewers} aria-label="Người đã xem"><Eye size={18} /></button>}
          {story.mine && <button type="button" className="icon-btn" onClick={remove} aria-label="Xóa story"><Trash2 size={18} /></button>}
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Đóng"><X size={20} /></button>
        </div>
        {story.mediaUrl && <img className="ext-story-img" src={mediaSrc(story.mediaUrl)} alt="" />}
        {story.content && <p className={'ext-story-text' + (story.mediaUrl ? ' over' : '')}>{story.content}</p>}
        <button type="button" className="ext-story-nav prev" onClick={prev} aria-label="Story trước"><ChevronLeft size={28} /></button>
        <button type="button" className="ext-story-nav next" onClick={next} aria-label="Story sau"><ChevronRight size={28} /></button>
        {viewers && (
          <div className="ext-story-viewers" onMouseDown={e => e.stopPropagation()}>
            <strong>{viewers.length} người đã xem</strong>
            <ul>{viewers.map(v => <li key={v.userId}><Avatar name={v.displayName} seed={v.userId} size={24} /> {v.displayName}</li>)}</ul>
            <button type="button" className="link-btn" onClick={() => { setViewers(null); setPaused(false); }}>Đóng</button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function StoriesBar({ user, onToast }) {
  const [groups, setGroups] = useState([]);
  const [viewing, setViewing] = useState(null);
  const [composing, setComposing] = useState(false);
  const load = useCallback(() => ext.stories().then(r => setGroups(r.groups)).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  useSse('story:changed', () => load());
  const mine = groups.find(gr => gr.author.userId === user.userId);
  return (
    <div className="card ext-stories" aria-label="Story">
      <button type="button" className="ext-story-tile add" onClick={() => setComposing(true)}>
        <span className="ext-story-ring"><Avatar name={user.displayName} seed={user.userId} size={52} /><span className="ext-story-plus"><Plus size={14} /></span></span>
        <span>Tạo story</span>
      </button>
      {groups.map((gr, idx) => (
        <button key={gr.author.userId} type="button" className="ext-story-tile" onClick={() => setViewing(idx)}>
          <span className={'ext-story-ring' + (gr.allViewed ? ' seen' : '')}><Avatar name={gr.author.displayName} seed={gr.author.userId} size={52} /></span>
          <span>{gr === mine ? 'Story của bạn' : gr.author.displayName.split(' ').slice(-1)[0]}</span>
        </button>
      ))}
      {groups.length === 0 && <span className="muted ext-note">Story của bạn bè sẽ hiện ở đây trong 24 giờ.</span>}
      {composing && <StoryComposer onClose={() => setComposing(false)} onPosted={load} onToast={onToast} />}
      {viewing !== null && groups[viewing] && (
        <StoryViewer groups={groups} start={viewing} me={user} onClose={() => { setViewing(null); load(); }} onChanged={load} onToast={onToast} />
      )}
    </div>
  );
}
