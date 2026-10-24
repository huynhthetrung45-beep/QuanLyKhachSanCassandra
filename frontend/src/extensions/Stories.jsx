// PT-23: tin (story) 24 gio - giao dien kieu Facebook.
//  - StoriesBar: hang the doc tren Bang tin (the "Tao tin" + the cua tung nguoi).
//  - StoryComposer: man hinh tao tin: chon tin anh / tin van ban, phong chu, phong nen, mau chu, can le, xem truoc.
//  - StoryViewer: danh sach tin ben trai + khung xem: thanh tien do, tam dung, cam xuc, tra loi, chia se, nguoi xem.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlignCenter, AlignLeft, AlignRight, ChevronLeft, ChevronRight, Eye, ImagePlus, LoaderCircle, MessageCircle,
  Pause, Play, Plus, Repeat2, Send, Share2, Trash2, Type, X
} from 'lucide-react';
import Avatar from '../components/Avatar';
import { api } from '../api';
import { ext } from './extApi';
import { useSse } from './sse';
import { formatListTime } from '../utils';

const BGS = ['teal', 'harbor', 'sunset', 'violet', 'forest', 'rose', 'ocean', 'fire', 'night', 'mint', 'gold', 'berry', 'sky', 'black'];
const FONTS = [['clean', 'Gọn gàng'], ['simple', 'Đơn giản'], ['casual', 'Thông thường'], ['headline', 'Tiêu đề']];
const COLORS = ['#ffffff', '#111111', '#ffe14d', '#ff6b6b', '#4dd4ff', '#7dff9a', '#ff9de2'];
const REACTIONS = [['LIKE', '👍'], ['LOVE', '❤️'], ['HAHA', '😆'], ['WOW', '😮'], ['SAD', '😢'], ['ANGRY', '😡']];
const EMOJI = Object.fromEntries(REACTIONS);
const DURATION = 6000;
const mediaSrc = url => (url ? url.replace(/^\/api\/v1/, import.meta.env.VITE_API_BASE || '/api/v1') : null);
const lastName = name => String(name || '').split(' ').slice(-1)[0];

// Mat tin (dung chung cho the xem truoc, khung tao, khung xem).
export function StoryFace({ story, preview = null, compact = false }) {
  const s = story;
  const img = preview || mediaSrc(s.mediaUrl);
  return (
    <div className={'ext-sface bg-' + (s.background || 'teal') + (compact ? ' compact' : '')}>
      {img && <img className="ext-sface-img" src={img} alt="" />}
      {s.content && (
        <p className={`ext-sface-text sf-${s.font || 'clean'}${img ? ' caption' : ''}`}
          style={{ color: s.textColor || '#ffffff', textAlign: s.textAlign || 'center' }}>{s.content}</p>
      )}
      {s.sharedFrom && !compact && <span className="ext-sface-shared"><Repeat2 size={13} /> Chia sẻ từ {s.sharedFrom.displayName}</span>}
    </div>
  );
}

// ===== Khung tao tin =====
function StoryComposer({ user, onClose, onPosted, onToast }) {
  const [mode, setMode] = useState(null); // null | 'text' | 'photo'
  const [text, setText] = useState('');
  const [style, setStyle] = useState({ background: 'sunset', font: 'clean', textColor: '#ffffff', textAlign: 'center' });
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  useEffect(() => () => preview && URL.revokeObjectURL(preview), [preview]);
  useEffect(() => {
    const onKey = e => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const set = patch => setStyle(s => ({ ...s, ...patch }));

  function pickPhoto(f) {
    if (!f) return;
    setFile(f);
    setPreview(URL.createObjectURL(f));
    setMode('photo');
    set({ background: 'black', textAlign: 'center' });
  }

  async function post() {
    setBusy(true);
    try {
      await (mode === 'photo' ? ext.createImageStory(file, text, style) : ext.createStory(text, style));
      onToast('Đã chia sẻ lên tin của bạn.');
      onPosted();
      onClose();
    } catch (err) {
      onToast(err.message);
    } finally {
      setBusy(false);
    }
  }

  const canPost = mode === 'photo' ? Boolean(file) : Boolean(text.trim());
  return (
    <div className="ext-story-compose" role="dialog" aria-modal="true" aria-label="Tạo tin">
      <aside className="ext-sc-panel">
        <div className="ext-sc-top">
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Đóng"><X size={20} /></button>
          <h2>Tin của bạn</h2>
        </div>
        <div className="ext-sc-me"><Avatar name={user.displayName} seed={user.userId} size={44} /><strong>{user.displayName}</strong></div>
        {mode && (
          <div className="ext-sc-tools">
            <textarea className="ext-input ext-textarea" rows={mode === 'photo' ? 3 : 5} maxLength={500} autoFocus value={text}
              onChange={e => setText(e.target.value)} placeholder={mode === 'photo' ? 'Thêm văn bản lên ảnh (không bắt buộc)' : 'Bắt đầu nhập'} aria-label="Nội dung tin" />
            <span className="muted ext-sub">{text.length}/500</span>
            <label className="ext-sc-label"><Type size={15} /> Phông chữ</label>
            <select className="ext-input" value={style.font} onChange={e => set({ font: e.target.value })} aria-label="Phông chữ">
              {FONTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <label className="ext-sc-label">Căn lề</label>
            <div className="ext-row">
              {[['left', AlignLeft], ['center', AlignCenter], ['right', AlignRight]].map(([k, Icon]) => (
                <button key={k} type="button" className={'icon-btn small ext-sc-opt' + (style.textAlign === k ? ' on' : '')} onClick={() => set({ textAlign: k })}
                  aria-label={'Căn ' + k} aria-pressed={style.textAlign === k}><Icon size={16} /></button>
              ))}
            </div>
            <label className="ext-sc-label">Màu chữ</label>
            <div className="ext-sc-swatches">
              {COLORS.map(c => <button key={c} type="button" className={'ext-swatch' + (style.textColor === c ? ' on' : '')} style={{ background: c }}
                onClick={() => set({ textColor: c })} aria-label={'Màu chữ ' + c} />)}
            </div>
            {mode === 'text' && (
              <>
                <label className="ext-sc-label">Phông nền</label>
                <div className="ext-sc-swatches">
                  {BGS.map(b => <button key={b} type="button" className={'ext-swatch bg-' + b + (style.background === b ? ' on' : '')}
                    onClick={() => set({ background: b })} aria-label={'Phông nền ' + b} />)}
                </div>
              </>
            )}
            {mode === 'photo' && (
              <button type="button" className="btn secondary small" onClick={() => fileRef.current?.click()}><ImagePlus size={15} /> Đổi ảnh</button>
            )}
            <p className="muted ext-note">Tin hiển thị với bạn bè trong 24 giờ.</p>
          </div>
        )}
        {mode && (
          <div className="ext-sc-actions">
            <button type="button" className="btn secondary" onClick={() => { setMode(null); setText(''); setFile(null); setPreview(null); }}>Bỏ</button>
            <button type="button" className="btn primary" disabled={!canPost || busy} onClick={post}>
              {busy && <LoaderCircle size={15} className="spin" />} Chia sẻ lên tin
            </button>
          </div>
        )}
      </aside>
      <main className="ext-sc-stage">
        {!mode ? (
          <div className="ext-sc-choices">
            <button type="button" className="ext-sc-choice photo" onClick={() => fileRef.current?.click()}>
              <span className="ext-sc-icon"><ImagePlus size={26} /></span><strong>Tạo tin dạng ảnh</strong>
            </button>
            <button type="button" className="ext-sc-choice text" onClick={() => setMode('text')}>
              <span className="ext-sc-icon"><span className="ext-aa">Aa</span></span><strong>Tạo tin dạng văn bản</strong>
            </button>
          </div>
        ) : (
          <div className="ext-sc-preview">
            <h3>Xem trước</h3>
            <div className="ext-sc-phone">
              <StoryFace story={{ ...style, content: text || (mode === 'text' ? 'Bắt đầu nhập' : '') }} preview={preview} />
            </div>
          </div>
        )}
      </main>
      <input ref={fileRef} type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif"
        onChange={e => { const f = e.target.files[0]; e.target.value = ''; pickPhoto(f); }} />
    </div>
  );
}

// ===== Chia se tin vao hoi thoai =====
function ShareToChat({ story, author, onClose, onToast }) {
  const [list, setList] = useState(null);
  const [note, setNote] = useState('');
  useEffect(() => { api.conversations().then(r => setList(r.data)).catch(() => setList([])); }, []);
  async function send(c) {
    try {
      await ext.shareStory(author.userId, story.storyId, { target: 'chat', conversationId: c.conversationId, content: note });
      onToast(`Đã gửi tin của ${author.displayName} tới ${c.displayName}.`);
      onClose();
    } catch (err) {
      onToast(err.message);
    }
  }
  return (
    <div className="ext-story-pop" onMouseDown={e => e.stopPropagation()}>
      <div className="dialog-head"><strong>Gửi trong tin nhắn</strong>
        <button type="button" className="icon-btn ghost small" onClick={onClose} aria-label="Đóng"><X size={16} /></button></div>
      <input className="ext-input" value={note} maxLength={500} onChange={e => setNote(e.target.value)} placeholder="Viết gì đó… (không bắt buộc)" />
      {!list && <p className="muted"><LoaderCircle size={14} className="spin" /> Đang tải…</p>}
      <ul className="ext-list">
        {list?.map(c => (
          <li key={c.conversationId}>
            <Avatar name={c.displayName} seed={c.conversationId} group={c.conversationType === 'GROUP'} size={30} />
            <span className="ext-grow">{c.displayName}</span>
            <button type="button" className="btn primary small" onClick={() => send(c)}>Gửi</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ===== Trinh xem tin =====
function StoryViewer({ groups, start, me, onClose, onChanged, onCreate, onToast }) {
  const [g, setG] = useState(start);
  const [i, setI] = useState(() => Math.max(0, groups[start].items.findIndex(s => !s.viewed && !s.mine)));
  const [paused, setPaused] = useState(false);
  const [panel, setPanel] = useState(null); // viewers | share | chat
  const [viewers, setViewers] = useState(null);
  const [reply, setReply] = useState('');
  const [burst, setBurst] = useState(null);
  const [mine, setMine] = useState({}); // storyId -> reaction (cap nhat lac quan)
  const group = groups[g];
  const story = group?.items[i];
  const hold = paused || Boolean(panel) || Boolean(reply);

  const next = useCallback(() => {
    if (i < group.items.length - 1) setI(i + 1);
    else if (g < groups.length - 1) { setG(g + 1); setI(0); }
    else onClose();
  }, [g, i, group, groups.length, onClose]);
  const prev = () => { if (i > 0) setI(i - 1); else if (g > 0) { setG(g - 1); setI(0); } };

  useEffect(() => {
    if (!story) return undefined;
    setPanel(null);
    setViewers(null);
    if (!story.mine && !story.viewed) ext.viewStory(group.author.userId, story.storyId).catch(() => {});
    return undefined;
  }, [story, group]);
  useEffect(() => {
    if (!story || hold) return undefined;
    const t = setTimeout(next, DURATION);
    return () => clearTimeout(t);
  }, [story, next, hold]);
  useEffect(() => {
    const onKey = e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') next();
      if (e.key === 'ArrowLeft') prev();
      if (e.key === ' ') { e.preventDefault(); setPaused(p => !p); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });
  if (!story) return null;

  const myReaction = story.storyId in mine ? mine[story.storyId] : story.myReaction;
  async function react(key) {
    const value = myReaction === key ? null : key;
    setMine(m => ({ ...m, [story.storyId]: value }));
    if (value) { setBurst({ emoji: EMOJI[value], id: Date.now() }); setTimeout(() => setBurst(null), 1100); }
    try { await ext.reactStory(group.author.userId, story.storyId, value); } catch (err) { onToast(err.message); }
  }
  async function sendReply(e) {
    e.preventDefault();
    const t = reply.trim();
    if (!t) return;
    try {
      await ext.replyStory(group.author.userId, story.storyId, t);
      setReply('');
      onToast(`Đã gửi trả lời tới ${group.author.displayName}.`);
    } catch (err) {
      onToast(err.message);
    }
  }
  async function reshare() {
    setPanel(null);
    try {
      await ext.shareStory(group.author.userId, story.storyId, { target: 'story' });
      onToast('Đã chia sẻ lên tin của bạn.');
      onChanged();
    } catch (err) {
      onToast(err.message);
    }
  }
  async function remove() {
    try { await ext.deleteStory(story.storyId); onToast('Đã xóa tin.'); onChanged(); onClose(); } catch (err) { onToast(err.message); }
  }
  async function showViewers() {
    setPanel('viewers');
    try { setViewers((await ext.storyViewers(story.storyId)).items); } catch (err) { onToast(err.message); }
  }
  const counts = story.reactionCounts || {};
  const totalReacts = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="ext-story-viewer" role="dialog" aria-modal="true" aria-label={'Tin của ' + group.author.displayName}>
      <aside className="ext-sv-side">
        <div className="ext-sv-side-head">
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Đóng"><X size={20} /></button>
          <h2>Tin</h2>
        </div>
        <h3 className="ext-sv-sub">Tin của bạn</h3>
        <button type="button" className="ext-sv-entry" onClick={() => { onClose(); onCreate(); }}>
          <span className="ext-sv-plus"><Plus size={20} /></span>
          <span><strong>Tạo tin</strong><span className="muted ext-sub">Chia sẻ ảnh hoặc viết gì đó</span></span>
        </button>
        <h3 className="ext-sv-sub">Tất cả tin</h3>
        <ul>
          {groups.map((gr, idx) => {
            const unseen = gr.items.filter(s => !s.viewed && !s.mine).length;
            return (
              <li key={gr.author.userId}>
                <button type="button" className={'ext-sv-entry' + (idx === g ? ' on' : '')} onClick={() => { setG(idx); setI(0); }}>
                  <span className={'ext-story-ring' + (gr.allViewed ? ' seen' : '')}><Avatar name={gr.author.displayName} seed={gr.author.userId} size={48} /></span>
                  <span className="ext-grow">
                    <strong>{gr.author.userId === me.userId ? 'Tin của bạn' : gr.author.displayName}</strong>
                    <span className="ext-sub">{unseen > 0 ? <b className="ext-sv-new">{unseen} thẻ mới</b> : `${gr.items.length} thẻ`} · {formatListTime(gr.latestAt)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <main className="ext-sv-main">
        <button type="button" className="ext-sv-nav prev" onClick={prev} disabled={g === 0 && i === 0} aria-label="Tin trước"><ChevronLeft size={26} /></button>
        <div className="ext-sv-card">
          <StoryFace story={story} />
          <div className="ext-sv-progress">
            {group.items.map((s, k) => (
              <span key={s.storyId} className={k < i ? 'done' : k === i ? 'now' + (hold ? ' paused' : '') : ''}>
                {k === i && <i key={story.storyId} style={{ animationDuration: `${DURATION}ms` }} />}
              </span>
            ))}
          </div>
          <div className="ext-sv-head">
            <Avatar name={group.author.displayName} seed={group.author.userId} size={38} />
            <div className="ext-grow">
              <strong>{group.author.userId === me.userId ? 'Tin của bạn' : group.author.displayName}</strong>
              <span>{formatListTime(story.createdAt)}</span>
            </div>
            <button type="button" className="icon-btn" onClick={() => setPaused(p => !p)} aria-label={paused ? 'Tiếp tục' : 'Tạm dừng'}>
              {paused ? <Play size={18} /> : <Pause size={18} />}
            </button>
            <button type="button" className="icon-btn" onClick={() => setPanel(p => (p === 'share' ? null : 'share'))} aria-label="Chia sẻ tin"><Share2 size={18} /></button>
            {story.mine && <button type="button" className="icon-btn" onClick={remove} aria-label="Xóa tin"><Trash2 size={18} /></button>}
          </div>

          {burst && <span key={burst.id} className="ext-sv-burst" aria-hidden="true">{burst.emoji}</span>}

          {panel === 'share' && (
            <div className="ext-story-pop menu" onMouseDown={e => e.stopPropagation()}>
              {!story.mine && <button type="button" className="ext-sv-menu" onClick={reshare}><Repeat2 size={16} /> Chia sẻ lên tin của bạn</button>}
              <button type="button" className="ext-sv-menu" onClick={() => setPanel('chat')}><MessageCircle size={16} /> Gửi trong tin nhắn</button>
            </div>
          )}
          {panel === 'chat' && <ShareToChat story={story} author={group.author} onClose={() => setPanel(null)} onToast={onToast} />}

          {panel === 'viewers' && (
            <div className="ext-story-pop viewers" onMouseDown={e => e.stopPropagation()}>
              <div className="dialog-head"><strong>Người xem tin</strong>
                <button type="button" className="icon-btn ghost small" onClick={() => setPanel(null)} aria-label="Đóng"><X size={16} /></button></div>
              {!viewers && <p className="muted"><LoaderCircle size={14} className="spin" /> Đang tải…</p>}
              {viewers && viewers.length === 0 && <p className="muted">Chưa có ai xem tin này.</p>}
              <ul className="ext-list">
                {viewers?.map(v => (
                  <li key={v.userId}><Avatar name={v.displayName} seed={v.userId} size={32} /><span className="ext-grow">{v.displayName}</span>
                    {v.reaction && <span className="ext-sv-react-tag">{EMOJI[v.reaction]}</span>}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="ext-sv-foot">
            {story.mine ? (
              <button type="button" className="ext-sv-seen" onClick={showViewers}>
                <Eye size={16} /> {story.viewCount || 0} người xem
                {totalReacts > 0 && <span>· {Object.entries(counts).map(([k, n]) => `${EMOJI[k]} ${n}`).join('  ')}</span>}
              </button>
            ) : (
              <>
                <form className="ext-sv-reply" onSubmit={sendReply}>
                  <input value={reply} maxLength={1000} onChange={e => setReply(e.target.value)} placeholder={`Trả lời ${lastName(group.author.displayName)}…`} aria-label="Trả lời tin" />
                  <button type="submit" className="icon-btn" disabled={!reply.trim()} aria-label="Gửi trả lời"><Send size={18} /></button>
                </form>
                <div className="ext-sv-reacts" role="group" aria-label="Bày tỏ cảm xúc">
                  {REACTIONS.map(([k, e]) => (
                    <button key={k} type="button" className={myReaction === k ? 'on' : ''} onClick={() => react(k)} aria-label={'Bày tỏ ' + k} aria-pressed={myReaction === k}>{e}</button>
                  ))}
                </div>
              </>
            )}
          </div>
          <button type="button" className="ext-sv-tap prev" onClick={prev} aria-label="Tin trước" tabIndex={-1} />
          <button type="button" className="ext-sv-tap next" onClick={next} aria-label="Tin sau" tabIndex={-1} />
        </div>
        <button type="button" className="ext-sv-nav next" onClick={next} aria-label="Tin sau"><ChevronRight size={26} /></button>
      </main>
    </div>
  );
}

// ===== Hang the tin tren Bang tin =====
export default function StoriesBar({ user, onToast }) {
  const [groups, setGroups] = useState([]);
  const [viewing, setViewing] = useState(null);
  const [composing, setComposing] = useState(false);
  const rowRef = useRef(null);
  const load = useCallback(() => ext.stories().then(r => setGroups(r.groups)).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  useSse('story:changed', () => load());
  // Mo tin cua 1 nguoi tu thong bao ("ban be vua them tin").
  useEffect(() => {
    const onOpen = e => {
      const authorId = e.detail?.authorId;
      ext.stories().then(r => {
        setGroups(r.groups);
        const idx = r.groups.findIndex(gr => gr.author.userId === authorId);
        if (idx >= 0) setViewing(idx);
      }).catch(() => {});
    };
    window.addEventListener('chatott:open-story', onOpen);
    return () => window.removeEventListener('chatott:open-story', onOpen);
  }, []);
  const covers = useMemo(() => groups.map(gr => gr.items[gr.items.length - 1]), [groups]);
  const scroll = d => rowRef.current?.scrollBy({ left: d * 260, behavior: 'smooth' });

  return (
    <div className="card ext-stories" aria-label="Tin">
      <div className="ext-stories-row" ref={rowRef}>
        <button type="button" className="ext-story-tile add" onClick={() => setComposing(true)}>
          <span className="ext-tile-top"><Avatar name={user.displayName} seed={user.userId} size={64} /></span>
          <span className="ext-tile-plus"><Plus size={18} /></span>
          <span className="ext-tile-label">Tạo tin</span>
        </button>
        {groups.map((gr, idx) => (
          <button key={gr.author.userId} type="button" className="ext-story-tile" onClick={() => setViewing(idx)}
            aria-label={'Xem tin của ' + gr.author.displayName}>
            <StoryFace story={covers[idx]} compact />
            <span className={'ext-story-ring' + (gr.allViewed ? ' seen' : '')}><Avatar name={gr.author.displayName} seed={gr.author.userId} size={36} /></span>
            <span className="ext-tile-name">{gr.author.userId === user.userId ? 'Tin của bạn' : gr.author.displayName}</span>
          </button>
        ))}
        {groups.length === 0 && <span className="muted ext-note ext-stories-empty">Tin của bạn và bạn bè sẽ hiện ở đây trong 24 giờ.</span>}
      </div>
      {groups.length > 3 && (
        <>
          <button type="button" className="ext-stories-arrow left" onClick={() => scroll(-1)} aria-label="Cuộn trái"><ChevronLeft size={20} /></button>
          <button type="button" className="ext-stories-arrow right" onClick={() => scroll(1)} aria-label="Cuộn phải"><ChevronRight size={20} /></button>
        </>
      )}
      {composing && <StoryComposer user={user} onClose={() => setComposing(false)} onPosted={load} onToast={onToast} />}
      {viewing !== null && groups[viewing] && (
        <StoryViewer groups={groups} start={viewing} me={user} onClose={() => { setViewing(null); load(); }} onChanged={load}
          onCreate={() => setComposing(true)} onToast={onToast} />
      )}
    </div>
  );
}
