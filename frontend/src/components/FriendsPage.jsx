import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle, Search, X } from 'lucide-react';
import Avatar from './Avatar';
import RelationActions from './RelationActions';
import { api } from '../api';
import { FriendSuggestions } from '../extensions/SocialExtras';
import { formatListTime } from '../utils';

const TABS = [
  ['friends', 'Bạn bè'],
  ['incoming', 'Lời mời đến'],
  ['outgoing', 'Đã gửi'],
  ['blocked', 'Đã chặn']
];
const STATUS_OF_TAB = { friends: 'FRIENDS', incoming: 'INCOMING', outgoing: 'OUTGOING', blocked: 'BLOCKED' };

function PersonRow({ person, relationship, sub, onOpenProfile, onMessage, onToast, onChanged }) {
  return (
    <li className="friend-row">
      <button type="button" className="friend-main" onClick={() => onOpenProfile(person.userId)} title="Xem hồ sơ">
        <Avatar name={person.displayName} seed={person.userId} size={44} />
        <span className="friend-text">
          <span className="friend-name">{person.displayName}</span>
          {sub && <span className="friend-sub">{sub}</span>}
        </span>
      </button>
      <RelationActions compact userId={person.userId} displayName={person.displayName} relationship={relationship}
        onMessage={relationship === 'FRIENDS' ? onMessage : null} onToast={onToast} onChanged={onChanged} />
    </li>
  );
}

export default function FriendsPage({ version, onOpenProfile, onMessage, onToast, onCountsChanged }) {
  const [tab, setTab] = useState('friends');
  const [lists, setLists] = useState({});
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState([]);
  const [searching, setSearching] = useState(false);

  const load = useCallback(async () => {
    try {
      const [friends, incoming, outgoing, blocked] = await Promise.all([
        api.friends(), api.friendRequests('incoming'), api.friendRequests('outgoing'), api.blocks()
      ]);
      const next = { friends: friends.data, incoming: incoming.data, outgoing: outgoing.data, blocked: blocked.data };
      setLists(next);
      onCountsChanged?.(next.incoming.length);
      setState('ready');
      setError('');
    } catch (err) {
      setError(err.message);
      setState('error');
    }
  }, [onCountsChanged]);

  useEffect(() => { load(); }, [load, version]);

  const q = query.trim();
  const runSearch = useCallback(async (signal) => {
    if (q.length < 2) { setPeople([]); return; }
    setSearching(true);
    try {
      const r = await api.searchUsers(q, signal);
      setPeople(r.data);
    } catch (err) {
      if (err.name !== 'AbortError') onToast(err.message);
    } finally {
      setSearching(false);
    }
  }, [q, onToast]);

  useEffect(() => {
    const controller = new AbortController();
    const t = setTimeout(() => runSearch(controller.signal), 300);
    return () => { clearTimeout(t); controller.abort(); };
  }, [runSearch]);

  const refreshAll = useCallback(() => { load(); runSearch(); }, [load, runSearch]);
  const items = lists[tab] || [];

  return (
    <section className="friends-page" aria-label="Bạn bè">
      <header className="friends-head">
        <h2>Bạn bè</h2>
        <div className="search boxed friends-search">
          <Search size={16} aria-hidden="true" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Tìm người theo tên hoặc email để kết bạn" aria-label="Tìm người" />
          {query && <button type="button" className="icon-btn ghost small" onClick={() => setQuery('')} aria-label="Xóa tìm kiếm"><X size={15} /></button>}
        </div>
      </header>

      <div className="friends-scroll">
        {q.length >= 2 && (
          <section className="friends-section">
            <h3 className="section-title">Kết quả tìm kiếm {searching && <LoaderCircle size={13} className="spin" />}</h3>
            {!searching && people.length === 0 && <p className="muted pad">Không tìm thấy ai khớp “{q}”.</p>}
            <ul>
              {people.map(p => (
                <PersonRow key={p.userId} person={p} relationship={p.relationship} onOpenProfile={onOpenProfile}
                  onMessage={onMessage} onToast={onToast} onChanged={refreshAll} />
              ))}
            </ul>
          </section>
        )}

        {q.length < 2 && <FriendSuggestions version={version} onOpenProfile={onOpenProfile} onToast={onToast} />}

        <div className="filters friends-tabs" role="tablist" aria-label="Danh sách">
          {TABS.map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'on' : ''} onClick={() => setTab(key)}>
              {label}{lists[key]?.length ? ` (${lists[key].length})` : ''}
            </button>
          ))}
        </div>

        {state === 'loading' && <p className="muted pad"><LoaderCircle size={15} className="spin" /> Đang tải…</p>}
        {state === 'error' && (
          <div className="pad"><p className="error-text">{error}</p><button type="button" className="btn secondary small" onClick={load}>Thử lại</button></div>
        )}
        {state === 'ready' && items.length === 0 && (
          <p className="muted pad">
            {{ friends: 'Bạn chưa có bạn bè nào. Tìm người ở ô phía trên để kết bạn.', incoming: 'Không có lời mời nào.',
              outgoing: 'Bạn chưa gửi lời mời nào.', blocked: 'Bạn chưa chặn ai.' }[tab]}
          </p>
        )}
        <ul>
          {items.map(p => (
            <PersonRow key={p.userId} person={p} relationship={STATUS_OF_TAB[tab]}
              sub={p.at ? { friends: 'Bạn bè từ ', incoming: 'Gửi lời mời ', outgoing: 'Đã gửi ', blocked: 'Đã chặn ' }[tab] + formatListTime(p.at).toLowerCase() : ''}
              onOpenProfile={onOpenProfile} onMessage={onMessage} onToast={onToast} onChanged={refreshAll} />
          ))}
        </ul>
      </div>
    </section>
  );
}
