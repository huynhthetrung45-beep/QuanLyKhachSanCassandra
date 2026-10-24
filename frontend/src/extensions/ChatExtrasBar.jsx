// Thanh cong cu tren khung soan: PT-21 sticker, PT-12 ghi am (<= 2 phut), PT-20 tao binh chon,
// PT-26 AI goi y tra loi.
import { useEffect, useRef, useState } from 'react';
import { BarChart3, LoaderCircle, Mic, Plus, Smile, Sparkles, Square, Trash2, X } from 'lucide-react';
import { ext } from './extApi';

const MAX_MS = 120000;
let stickerCache = null;

function StickerPicker({ conversationId, onSent, onToast, onClose }) {
  const [items, setItems] = useState(stickerCache || []);
  useEffect(() => {
    if (stickerCache) return;
    ext.stickers().then(r => { stickerCache = r.items; setItems(r.items); }).catch(err => onToast(err.message));
  }, [onToast]);
  async function send(s) {
    onClose();
    try { onSent(await ext.sendSticker(conversationId, s.id)); } catch (err) { onToast(err.message); }
  }
  return (
    <div className="ext-pop ext-stickers" role="menu" aria-label="Chọn sticker">
      {items.map(s => (
        <button key={s.id} type="button" role="menuitem" title={s.label} aria-label={s.label} onClick={() => send(s)}>
          <span>{s.emoji}</span><small>{s.label}</small>
        </button>
      ))}
    </div>
  );
}

function PollDialog({ conversationId, onSent, onToast, onClose }) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multiple, setMultiple] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      onSent(await ext.createPoll(conversationId, { question, options: options.filter(o => o.trim()), multiple }));
      onClose();
    } catch (err) {
      onToast(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <form className="dialog small" role="dialog" aria-modal="true" aria-label="Tạo bình chọn" onSubmit={submit}>
        <div className="dialog-head"><h3><BarChart3 size={18} /> Tạo bình chọn</h3>
          <button type="button" className="icon-btn ghost" onClick={onClose} aria-label="Đóng"><X size={18} /></button></div>
        <input className="ext-input" placeholder="Câu hỏi" maxLength={200} value={question} onChange={e => setQuestion(e.target.value)} autoFocus aria-label="Câu hỏi" />
        {options.map((o, i) => (
          <div key={i} className="ext-row">
            <input className="ext-input" placeholder={`Lựa chọn ${i + 1}`} maxLength={100} value={o} aria-label={`Lựa chọn ${i + 1}`}
              onChange={e => setOptions(list => list.map((x, j) => (j === i ? e.target.value : x)))} />
            {options.length > 2 && <button type="button" className="icon-btn ghost small" aria-label="Bỏ lựa chọn"
              onClick={() => setOptions(list => list.filter((_, j) => j !== i))}><Trash2 size={15} /></button>}
          </div>
        ))}
        {options.length < 10 && <button type="button" className="link-btn" onClick={() => setOptions(l => [...l, ''])}><Plus size={14} /> Thêm lựa chọn</button>}
        <label className="ext-check"><input type="checkbox" checked={multiple} onChange={e => setMultiple(e.target.checked)} /> Cho phép chọn nhiều phương án</label>
        <div className="dialog-actions">
          <button type="button" className="btn secondary" onClick={onClose}>Hủy</button>
          <button type="submit" className="btn primary" disabled={busy || !question.trim() || options.filter(o => o.trim()).length < 2}>Tạo</button>
        </div>
      </form>
    </div>
  );
}

function VoiceRecorder({ conversationId, onSent, onToast, onClose }) {
  const [state, setState] = useState('idle'); // idle | recording | sending
  const [ms, setMs] = useState(0);
  const rec = useRef(null);
  const chunks = useRef([]);
  const started = useRef(0);
  const timer = useRef(null);
  const cancelled = useRef(false);

  useEffect(() => () => { clearInterval(timer.current); stopTracks(); }, []);
  function stopTracks() { rec.current?.stream?.getTracks().forEach(t => t.stop()); }

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { onToast('Trình duyệt không hỗ trợ ghi âm.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported?.(t));
      const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      chunks.current = [];
      cancelled.current = false;
      r.ondataavailable = e => e.data.size && chunks.current.push(e.data);
      r.onstop = async () => {
        clearInterval(timer.current);
        stopTracks();
        const duration = Date.now() - started.current;
        if (cancelled.current || duration < 500) { setState('idle'); setMs(0); return; }
        setState('sending');
        try {
          onSent(await ext.sendVoice(conversationId, new Blob(chunks.current, { type: r.mimeType }), Math.min(duration, MAX_MS)));
          onClose();
        } catch (err) {
          onToast(err.message);
          setState('idle');
        }
      };
      rec.current = r;
      r.start(250);
      started.current = Date.now();
      setState('recording');
      timer.current = setInterval(() => {
        const t = Date.now() - started.current;
        setMs(t);
        if (t >= MAX_MS) r.stop();
      }, 200);
    } catch {
      onToast('Không truy cập được micro. Hãy cho phép quyền micro trên trình duyệt.');
    }
  }
  const stop = () => rec.current?.state === 'recording' && rec.current.stop();
  const cancel = () => { cancelled.current = true; stop(); onClose(); };
  const sec = Math.floor(ms / 1000);
  return (
    <div className="ext-pop ext-voice" role="dialog" aria-label="Ghi âm tin nhắn thoại">
      {state === 'idle' && <button type="button" className="btn primary small" onClick={start}><Mic size={15} /> Bắt đầu ghi</button>}
      {state === 'recording' && (
        <>
          <span className="ext-rec-dot" aria-hidden="true" />
          <span className="ext-rec-time">{Math.floor(sec / 60)}:{String(sec % 60).padStart(2, '0')} / 2:00</span>
          <button type="button" className="btn primary small" onClick={stop}><Square size={13} /> Gửi</button>
        </>
      )}
      {state === 'sending' && <span><LoaderCircle size={15} className="spin" /> Đang gửi…</span>}
      <button type="button" className="icon-btn ghost small" onClick={cancel} aria-label="Hủy ghi âm"><X size={15} /></button>
    </div>
  );
}

export default function ChatExtrasBar({ conversationId, isGroup, disabled, onSent, onToast, onInsertText }) {
  const [open, setOpen] = useState(null); // sticker | voice | poll
  const [suggestions, setSuggestions] = useState([]);
  const [loadingAi, setLoadingAi] = useState(false);
  const wrap = useRef(null);
  useEffect(() => { setOpen(null); setSuggestions([]); }, [conversationId]);
  useEffect(() => {
    if (open !== 'sticker') return undefined;
    const close = e => !wrap.current?.contains(e.target) && setOpen(null);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  async function suggest() {
    setLoadingAi(true);
    try { setSuggestions((await ext.suggestReplies(conversationId)).suggestions); } catch (err) { onToast(err.message); } finally { setLoadingAi(false); }
  }
  const close = () => setOpen(null);
  return (
    <div className="ext-bar" ref={wrap}>
      <button type="button" className={'icon-btn small' + (open === 'sticker' ? ' on' : '')} disabled={disabled} title="Sticker" aria-label="Gửi sticker"
        onClick={() => setOpen(o => (o === 'sticker' ? null : 'sticker'))}><Smile size={17} /></button>
      <button type="button" className={'icon-btn small' + (open === 'voice' ? ' on' : '')} disabled={disabled} title="Tin nhắn thoại" aria-label="Ghi âm tin nhắn thoại"
        onClick={() => setOpen(o => (o === 'voice' ? null : 'voice'))}><Mic size={17} /></button>
      {isGroup && <button type="button" className="icon-btn small" disabled={disabled} title="Tạo bình chọn" aria-label="Tạo bình chọn"
        onClick={() => setOpen('poll')}><BarChart3 size={17} /></button>}
      <button type="button" className="icon-btn small" disabled={disabled || loadingAi} title="AI gợi ý trả lời" aria-label="AI gợi ý trả lời" onClick={suggest}>
        {loadingAi ? <LoaderCircle size={17} className="spin" /> : <Sparkles size={17} />}</button>
      {suggestions.length > 0 && (
        <div className="ext-suggest" aria-label="Gợi ý trả lời của AI">
          {suggestions.map(s => (
            <button key={s} type="button" className="ext-chip" onClick={() => { onInsertText(s); setSuggestions([]); }} title="Chèn vào khung soạn (AI tạo)">{s}</button>
          ))}
          <button type="button" className="icon-btn ghost small" onClick={() => setSuggestions([])} aria-label="Ẩn gợi ý"><X size={13} /></button>
        </div>
      )}
      {open === 'sticker' && <StickerPicker conversationId={conversationId} onSent={onSent} onToast={onToast} onClose={close} />}
      {open === 'voice' && <VoiceRecorder conversationId={conversationId} onSent={onSent} onToast={onToast} onClose={close} />}
      {open === 'poll' && <PollDialog conversationId={conversationId} onSent={onSent} onToast={onToast} onClose={close} />}
    </div>
  );
}
