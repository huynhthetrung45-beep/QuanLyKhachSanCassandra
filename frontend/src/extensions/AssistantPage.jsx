// Tro ly AI (chatbot Google Gemini). Khoa API chi nam o backend; trang nay chi goi /api/v1/assistant.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Bot, Copy, LoaderCircle, Send, Sparkles, Trash2 } from 'lucide-react';
import Avatar from '../components/Avatar';
import ConfirmDialog from '../components/ConfirmDialog';
import { ext } from './extApi';
import { copyText, formatClock } from '../utils';

const SUGGESTIONS = [
  'Giải thích ngắn gọn Apache Cassandra là gì?',
  'Viết giúp mình lời mời họp nhóm lịch sự vào thứ Tư 14h',
  'Gợi ý 3 caption vui cho bài đăng về đồ án',
  'Dịch sang tiếng Anh: "Cảm ơn mọi người đã hỗ trợ dự án"'
];

export default function AssistantPage({ user, onToast }) {
  const [state, setState] = useState({ loading: true, configured: true, model: null, message: null });
  const [items, setItems] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const scroller = useRef(null);
  const input = useRef(null);

  useEffect(() => {
    ext.assistant()
      .then(r => { setItems(r.items); setState({ loading: false, configured: r.configured, model: r.model, message: r.message }); })
      .catch(err => { setState({ loading: false, configured: false, message: err.message }); });
  }, []);

  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [items, busy]);

  async function send(value = text) {
    const q = value.trim();
    if (!q || busy) return;
    setBusy(true);
    setText('');
    const tempId = 'tmp-' + Date.now();
    setItems(list => [...list, { messageId: tempId, role: 'user', content: q, createdAt: new Date().toISOString(), pending: true }]);
    try {
      const r = await ext.askAssistant(q);
      setItems(list => [...list.filter(m => m.messageId !== tempId), r.question, r.answer]);
      if (r.answer.model) setState(s => ({ ...s, model: r.answer.model }));
    } catch (err) {
      setItems(list => list.filter(m => m.messageId !== tempId));
      setText(q);
      onToast(err.message);
      if (err.code === 'AI_NOT_CONFIGURED') setState(s => ({ ...s, configured: false, message: err.message }));
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  }

  async function clear() {
    setConfirm(false);
    try { await ext.clearAssistant(); setItems([]); onToast('Đã xóa lịch sử trò chuyện với trợ lý.'); } catch (err) { onToast(err.message); }
  }

  return (
    <section className="ext-assistant" aria-label="Trợ lý AI">
      <header className="ext-assistant-head">
        <span className="ext-bot-avatar"><Bot size={22} /></span>
        <div className="ext-grow">
          <h2>Trợ lý ChatOTT</h2>
          <span className="muted ext-sub">{state.configured ? `Google Gemini${state.model ? ' · ' + state.model : ''}` : 'Chưa kết nối Gemini'}</span>
        </div>
        {items.length > 0 && (
          <button type="button" className="icon-btn" onClick={() => setConfirm(true)} title="Xóa lịch sử" aria-label="Xóa lịch sử trò chuyện"><Trash2 size={18} /></button>
        )}
      </header>

      <div className="ext-assistant-body" ref={scroller}>
        {!state.loading && !state.configured && (
          <div className="banner warn ext-assistant-banner">
            {state.message || 'Chưa cấu hình Gemini.'} Lấy khóa miễn phí tại Google AI Studio (aistudio.google.com) rồi đặt
            <code> GEMINI_API_KEY=… </code> trong <code>backend/.env</code>.
          </div>
        )}
        {state.loading && <p className="muted pad"><LoaderCircle size={15} className="spin" /> Đang tải…</p>}
        {!state.loading && items.length === 0 && (
          <div className="ext-assistant-empty">
            <span className="ext-bot-avatar big"><Sparkles size={34} /></span>
            <h3>Xin chào {user.displayName.split(' ').slice(-1)[0]}, mình có thể giúp gì?</h3>
            <p className="muted">Hỏi đáp, soạn tin nhắn, viết bài đăng, dịch, giải thích kiến thức… Trợ lý không đọc được tin nhắn riêng của bạn.</p>
            <div className="ext-assistant-suggest">
              {SUGGESTIONS.map(s => <button key={s} type="button" className="ext-chip" disabled={!state.configured || busy} onClick={() => send(s)}>{s}</button>)}
            </div>
          </div>
        )}
        {items.map(m => (
          <div key={m.messageId} className={'ext-ai-row ' + (m.role === 'user' ? 'mine' : 'bot')}>
            {m.role === 'user' ? <Avatar name={user.displayName} seed={user.userId} size={30} /> : <span className="ext-bot-avatar small"><Bot size={16} /></span>}
            <div className={'ext-ai-bubble' + (m.pending ? ' pending' : '')}>
              <div className="ext-ai-text">{m.content}</div>
              <div className="ext-ai-meta">
                <time dateTime={m.createdAt}>{formatClock(m.createdAt)}</time>
                {m.role === 'assistant' && (
                  <button type="button" className="link-btn" onClick={async () => onToast((await copyText(m.content)) ? 'Đã sao chép câu trả lời.' : 'Không sao chép được.')}>
                    <Copy size={12} /> Sao chép
                  </button>
                )}
                {m.role === 'assistant' && <span className="muted">Do AI tạo, có thể chưa chính xác</span>}
              </div>
            </div>
          </div>
        ))}
        {busy && (
          <div className="ext-ai-row bot">
            <span className="ext-bot-avatar small"><Bot size={16} /></span>
            <div className="ext-ai-bubble"><span className="typing-dots" aria-label="Trợ lý đang trả lời"><i /><i /><i /></span></div>
          </div>
        )}
      </div>

      <form className="ext-assistant-input" onSubmit={e => { e.preventDefault(); send(); }}>
        <textarea ref={input} rows={1} value={text} maxLength={4000} disabled={!state.configured} aria-label="Câu hỏi cho trợ lý"
          placeholder={state.configured ? 'Hỏi trợ lý ChatOTT… (Enter để gửi)' : 'Cần cấu hình GEMINI_API_KEY để trò chuyện'}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
        <button type="submit" className="send-btn" disabled={busy || !text.trim() || !state.configured} aria-label="Gửi câu hỏi">
          {busy ? <LoaderCircle size={19} className="spin" /> : <Send size={19} />}
        </button>
      </form>

      {confirm && (
        <ConfirmDialog title="Xóa lịch sử trò chuyện?" message="Toàn bộ câu hỏi và câu trả lời với trợ lý sẽ bị xóa." confirmLabel="Xóa" danger
          onConfirm={clear} onCancel={() => setConfirm(false)} />
      )}
    </section>
  );
}
