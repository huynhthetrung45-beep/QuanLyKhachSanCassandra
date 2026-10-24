// Hop thoai cho tin nhan / noi dung: PT-06 sua tin + lich su, PT-26 dich, PT-07 bao cao vi pham.
import { useEffect, useState } from 'react';
import { Flag, History, Languages, LoaderCircle, Pencil, X } from 'lucide-react';
import { REPORT_REASONS, ext } from './extApi';
import { formatFull } from '../utils';

export const EDIT_WINDOW_MS = 15 * 60 * 1000;
export const canEdit = (m, userId) => m.senderId === userId && !m.isDeleted && m.messageType !== 'SYSTEM' && Boolean(m.content)
  && !(m.extra && (m.extra.sticker || m.extra.poll || m.extra.kind === 'VOICE')) && Date.now() - new Date(m.createdAt).getTime() < EDIT_WINDOW_MS;

function Shell({ title, icon: Icon, onClose, children }) {
  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="dialog small" role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-head"><h3><Icon size={18} /> {title}</h3>
          <button type="button" className="icon-btn ghost" onClick={onClose} aria-label="Đóng"><X size={18} /></button></div>
        {children}
      </div>
    </div>
  );
}

export function EditMessageDialog({ conversationId, message, onClose, onSaved, onToast }) {
  const [text, setText] = useState(message.content || '');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const r = await ext.editMessage(conversationId, message, text.trim());
      onSaved({ ...message, content: r.content, extra: r.extra || message.extra });
      onClose();
    } catch (err) {
      onToast(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Shell title="Sửa tin nhắn" icon={Pencil} onClose={onClose}>
      <textarea className="ext-input ext-textarea" rows={4} maxLength={2000} value={text} onChange={e => setText(e.target.value)} autoFocus aria-label="Nội dung mới"
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); save(); } }} />
      <p className="muted ext-note">Chỉ sửa được trong 15 phút sau khi gửi. Mọi người sẽ thấy nhãn “đã chỉnh sửa” và lịch sử sửa.</p>
      <div className="dialog-actions">
        <button type="button" className="btn secondary" onClick={onClose}>Hủy</button>
        <button type="button" className="btn primary" disabled={busy || !text.trim() || text.trim() === message.content} onClick={save}>Lưu</button>
      </div>
    </Shell>
  );
}

export function EditHistoryDialog({ conversationId, message, onClose }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { ext.editHistory(conversationId, message.messageId).then(r => setItems(r.items)).catch(err => setError(err.message)); }, [conversationId, message.messageId]);
  return (
    <Shell title="Lịch sử chỉnh sửa" icon={History} onClose={onClose}>
      {error && <p className="error-text">{error}</p>}
      {!items && !error && <p className="muted"><LoaderCircle size={14} className="spin" /> Đang tải…</p>}
      {items && (
        <ul className="ext-list">
          <li><span className="ext-grow"><strong>Hiện tại</strong><span className="ext-sub">{message.content}</span></span></li>
          {items.map(i => (
            <li key={i.editedAt}><span className="ext-grow"><span className="muted">Trước {formatFull(i.editedAt)}</span><span className="ext-sub">{i.previousContent}</span></span></li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

const LANG = [['en', 'Tiếng Anh'], ['vi', 'Tiếng Việt'], ['ja', 'Tiếng Nhật'], ['ko', 'Tiếng Hàn'], ['zh', 'Tiếng Trung'], ['fr', 'Tiếng Pháp']];
export function TranslateDialog({ conversationId, message, onClose }) {
  const [lang, setLang] = useState('en');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function run(l = lang) {
    setBusy(true);
    setError('');
    try { setResult(await ext.translate(conversationId, message, l)); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { run('en'); }, []);
  return (
    <Shell title="Dịch tin nhắn (AI)" icon={Languages} onClose={onClose}>
      <p className="ext-quote">{message.content}</p>
      <div className="ext-row">
        <select className="ext-input" value={lang} onChange={e => { setLang(e.target.value); run(e.target.value); }} aria-label="Ngôn ngữ đích">
          {LANG.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      {busy && <p className="muted"><LoaderCircle size={14} className="spin" /> Đang dịch…</p>}
      {error && <p className="error-text">{error}</p>}
      {result && !busy && <p className="ext-translation">{result.translation}<span className="muted ext-sub">Bản dịch do AI tạo, có thể chưa chính xác.</span></p>}
    </Shell>
  );
}

// target: { targetType, targetId, conversationId?, createdAt?, postId?, label }
export function ReportDialog({ target, onClose, onToast }) {
  const [reason, setReason] = useState('SPAM');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const { label, ...payload } = target;
      const r = await ext.report({ ...payload, reason, details });
      onToast(r.message);
      onClose();
    } catch (err) {
      onToast(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Shell title={`Báo cáo ${target.label || 'nội dung'}`} icon={Flag} onClose={onClose}>
      <form onSubmit={submit} className="ext-form">
        <p>Quản trị viên sẽ xem xét báo cáo. Người bị báo cáo không biết ai đã báo cáo.</p>
        <div className="ext-reasons" role="radiogroup" aria-label="Lý do">
          {REPORT_REASONS.map(([k, l]) => (
            <label key={k} className={'ext-chip' + (reason === k ? ' on' : '')}>
              <input type="radio" name="reason" value={k} checked={reason === k} onChange={() => setReason(k)} /> {l}
            </label>
          ))}
        </div>
        <textarea className="ext-input ext-textarea" rows={3} maxLength={500} placeholder="Mô tả thêm (không bắt buộc)" value={details} onChange={e => setDetails(e.target.value)} />
        <div className="dialog-actions">
          <button type="button" className="btn secondary" onClick={onClose}>Hủy</button>
          <button type="submit" className="btn danger" disabled={busy}>Gửi báo cáo</button>
        </div>
      </form>
    </Shell>
  );
}
