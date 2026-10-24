import { useEffect, useState } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import UserPicker from './UserPicker';
import { api } from '../api';

export default function CreateGroupModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [members, setMembers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = e => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const canCreate = name.trim().length > 0 && members.length >= 2 && !busy;

  async function submit(e) {
    e.preventDefault();
    if (!canCreate) return;
    setBusy(true);
    setError('');
    try {
      const { conversationId } = await api.createGroup(name.trim(), members.map(m => m.userId));
      onCreated(conversationId);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="group-title" onSubmit={submit}>
        <div className="dialog-head">
          <h3 id="group-title">Tạo nhóm</h3>
          <button type="button" className="icon-btn ghost" onClick={onClose} aria-label="Đóng"><X size={18} /></button>
        </div>
        <div className="field">
          <label htmlFor="group-name">Tên nhóm</label>
          <div className="input-wrap">
            <input id="group-name" value={name} onChange={e => setName(e.target.value)} maxLength={80} placeholder="Ví dụ: Ôn thi NoSQL" />
          </div>
        </div>
        <p className="field-label">Thành viên <span className="muted">· đã chọn {members.length}, cần ít nhất 2</span></p>
        <UserPicker selected={members} onChange={setMembers} />
        {error && <div className="banner error" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn secondary" onClick={onClose}>Hủy</button>
          <button type="submit" className="btn primary" disabled={!canCreate}>
            {busy && <LoaderCircle size={16} className="spin" />} Tạo nhóm
          </button>
        </div>
      </form>
    </div>
  );
}
