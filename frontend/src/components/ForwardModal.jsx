import { useEffect, useMemo, useState } from 'react';
import { Check, Forward, LoaderCircle, Search, X } from 'lucide-react';
import Avatar from './Avatar';
import { api } from '../api';
import { fold } from '../utils';

// Chuyen tiep 1 tin sang cac hoi thoai minh dang tham gia. Moi hoi thoai dich la 1 lenh goi
// rieng; backend kiem tra quyen o ca hoi thoai nguon lan dich.
export default function ForwardModal({ source, conversations, onClose, onDone }) {
  const [query, setQuery] = useState('');
  const [state, setState] = useState({}); // conversationId -> sending | sent | error message

  useEffect(() => {
    const onKey = e => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shown = useMemo(() => {
    const q = fold(query);
    return conversations.filter(c => !q || fold(c.displayName).includes(q));
  }, [conversations, query]);

  async function send(target) {
    setState(s => ({ ...s, [target.conversationId]: 'sending' }));
    try {
      await api.forward(target.conversationId, {
        conversationId: source.conversationId, messageId: source.message.messageId, createdAt: source.message.createdAt
      });
      setState(s => ({ ...s, [target.conversationId]: 'sent' }));
      onDone();
    } catch (err) {
      setState(s => ({ ...s, [target.conversationId]: err.message }));
    }
  }

  const m = source.message;
  const preview = m.content || (m.attachments.length ? `[${m.attachments.length} tệp] ${m.attachments.map(a => a.fileName).join(', ')}` : '');

  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="fw-title">
        <div className="dialog-head">
          <h3 id="fw-title">Chuyển tiếp tin nhắn</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Đóng"><X size={18} /></button>
        </div>
        <blockquote className="fw-preview">{preview}</blockquote>
        <div className="search boxed">
          <Search size={16} aria-hidden="true" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Tìm hội thoại" aria-label="Tìm hội thoại" autoFocus />
        </div>
        <ul className="picker-list">
          {shown.map(c => {
            const st = state[c.conversationId];
            return (
              <li key={c.conversationId} className="fw-row">
                <Avatar name={c.displayName} seed={c.conversationId} group={c.conversationType === 'GROUP'} size={36} />
                <span className="person-name">{c.displayName}</span>
                {st && st !== 'sending' && st !== 'sent' && <span className="fw-error" title={st}>Lỗi</span>}
                <button type="button" className={'btn small ' + (st === 'sent' ? 'secondary' : 'primary')}
                  disabled={st === 'sending' || st === 'sent'} onClick={() => send(c)}>
                  {st === 'sending' ? <LoaderCircle size={14} className="spin" /> : st === 'sent' ? <><Check size={14} /> Đã gửi</> : <><Forward size={14} /> Gửi</>}
                </button>
              </li>
            );
          })}
          {shown.length === 0 && <li className="muted pad">Không có hội thoại khớp.</li>}
        </ul>
        <div className="dialog-actions">
          <button type="button" className="btn secondary" onClick={onClose}>Xong</button>
        </div>
      </div>
    </div>
  );
}
