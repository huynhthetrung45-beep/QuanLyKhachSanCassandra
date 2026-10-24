import { useEffect, useState } from 'react';
import { Check, LoaderCircle, Search, X } from 'lucide-react';
import Avatar from './Avatar';
import { api } from '../api';

// O tim nguoi dung + danh sach da chon (dung cho tao nhom / them thanh vien)
export default function UserPicker({ selected, onChange, excludeIds = [] }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const q = query.trim();

  useEffect(() => {
    if (q.length < 2) {
      setResults([]);
      setError('');
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await api.searchUsers(q, controller.signal);
        setResults(data.data);
        setError('');
      } catch (err) {
        if (err.name !== 'AbortError') setError(err.message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q]);

  const isSelected = id => selected.some(u => u.userId === id);
  const toggle = person => onChange(isSelected(person.userId)
    ? selected.filter(u => u.userId !== person.userId)
    : [...selected, person]);

  const visible = results.filter(p => !excludeIds.includes(p.userId));

  return (
    <div className="picker">
      {selected.length > 0 && (
        <div className="chips">
          {selected.map(u => (
            <span key={u.userId} className="chip">
              {u.displayName}
              <button type="button" onClick={() => toggle(u)} aria-label={'Bỏ chọn ' + u.displayName}><X size={13} /></button>
            </span>
          ))}
        </div>
      )}
      <div className="search boxed">
        <Search size={16} aria-hidden="true" />
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Nhập tên hoặc email (ít nhất 2 ký tự)"
          aria-label="Tìm người để thêm" autoFocus />
        {loading && <LoaderCircle size={15} className="spin" />}
      </div>
      <ul className="picker-list">
        {error && <li className="muted pad">{error}</li>}
        {q.length >= 2 && !loading && !error && visible.length === 0 && <li className="muted pad">Không tìm thấy người phù hợp.</li>}
        {visible.map(p => (
          <li key={p.userId}>
            <button type="button" className={'person' + (isSelected(p.userId) ? ' picked' : '')} onClick={() => toggle(p)}
              aria-pressed={isSelected(p.userId)}>
              <Avatar name={p.displayName} seed={p.userId} size={36} />
              <span className="person-name">{p.displayName}</span>
              <span className="check">{isSelected(p.userId) && <Check size={15} />}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
