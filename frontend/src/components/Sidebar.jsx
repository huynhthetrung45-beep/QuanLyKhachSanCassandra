import { useEffect, useMemo, useState } from 'react';
import { Search, X, Pin, PinOff, UserPlus, LoaderCircle, MessageSquarePlus } from 'lucide-react';
import Avatar from './Avatar';
import { api } from '../api';
import { fold, formatListTime } from '../utils';
import { isMutedNow, usePrefs } from '../extensions/prefsStore';
import { BellOff } from 'lucide-react';

function previewText(item, user) {
  if (!item.lastMessagePreview) {
    return item.conversationType === 'GROUP' ? 'Nhóm mới, chưa có tin nhắn' : 'Bắt đầu trò chuyện';
  }
  if (item.lastSenderId === user.userId) return 'Bạn: ' + item.lastMessagePreview;
  if (item.conversationType === 'GROUP' && item.lastSenderName) {
    return item.lastSenderName.split(' ').slice(-1)[0] + ': ' + item.lastMessagePreview;
  }
  return item.lastMessagePreview;
}

function ConversationItem({ item, user, active, onOpen, onTogglePin, typing }) {
  const count = item.unread && item.unreadCount > 0 ? (item.unreadCount > 99 ? '99+' : String(item.unreadCount)) : null;
  return (
    <li className={'conv' + (active ? ' active' : '') + (item.unread ? ' unread' : '')}>
      <button type="button" className="conv-main" onClick={() => onOpen(item.conversationId)}>
        <Avatar name={item.displayName} seed={item.conversationId} group={item.conversationType === 'GROUP'} size={48} />
        <span className="conv-text">
          <span className="conv-top">
            <span className="conv-name">{item.displayName}</span>
            <time className="conv-time" dateTime={item.lastMessageAt}>{formatListTime(item.lastMessageAt)}</time>
          </span>
          <span className="conv-bottom">
            {typing
              ? <span className="conv-preview typing-preview">{item.conversationType === 'GROUP' ? typing.name.split(' ').slice(-1)[0] + ' đang nhập…' : 'Đang nhập…'}</span>
              : <span className="conv-preview">{previewText(item, user)}</span>}
            {item.muted && <BellOff size={13} className="conv-pin" aria-label="Đã tắt thông báo" />}
            {item.pinned && <Pin size={13} className="conv-pin" aria-label="Đã ghim" />}
            {count && <span className="unread-count" aria-label={`${count} tin chưa đọc`}>{count}</span>}
            {item.unread && !count && <span className="unread-dot" aria-label="Có tin chưa đọc" />}
          </span>
        </span>
      </button>
      <button
        type="button"
        className="icon-btn conv-action"
        onClick={() => onTogglePin(item)}
        title={item.pinned ? 'Bỏ ghim' : 'Ghim hội thoại'}
        aria-label={item.pinned ? 'Bỏ ghim' : 'Ghim hội thoại'}
      >
        {item.pinned ? <PinOff size={16} /> : <Pin size={16} />}
      </button>
    </li>
  );
}

export default function Sidebar({
  user, conversations, loading, error, activeId, onOpen, onStartDirect, onCreateGroup, onTogglePin, onRetry, typingIn = {}
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [people, setPeople] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');

  const q = query.trim();

  // Tim nguoi dung (debounce 300ms, huy request cu)
  useEffect(() => {
    if (q.length < 2) {
      setPeople([]);
      setSearchError('');
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const data = await api.searchUsers(q, controller.signal);
        setPeople(data.data);
        setSearchError('');
      } catch (err) {
        if (err.name !== 'AbortError') setSearchError(err.message);
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q]);

  // PT-11: hoi thoai luu tru chi hien o bo loc "Lưu trữ" (va khi tim kiem); hoi thoai tat thong bao co bieu tuong.
  const prefs = usePrefs();
  const shown = useMemo(() => {
    const needle = fold(q);
    return conversations
      .map(c => ({ ...c, muted: isMutedNow(prefs[c.conversationId]), archived: Boolean(prefs[c.conversationId]?.archived) }))
      .filter(c => (filter === 'archived' ? c.archived : (needle || !c.archived))
        && (filter !== 'unread' || c.unread) && (!needle || fold(c.displayName).includes(needle)));
  }, [conversations, q, filter, prefs]);
  const archivedTotal = conversations.filter(c => prefs[c.conversationId]?.archived).length;

  const unreadTotal = conversations.filter(c => c.unread).length;

  return (
    <aside className="sidebar" aria-label="Danh sách hội thoại">
      <div className="sidebar-head">
        <div className="search">
          <Search size={17} aria-hidden="true" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Tìm hội thoại, tên hoặc email"
            aria-label="Tìm hội thoại hoặc người dùng"
          />
          {query && (
            <button type="button" className="icon-btn ghost small" onClick={() => setQuery('')} aria-label="Xóa tìm kiếm">
              <X size={15} />
            </button>
          )}
        </div>
        <button type="button" className="icon-btn" onClick={onCreateGroup} title="Tạo nhóm" aria-label="Tạo nhóm">
          <MessageSquarePlus size={19} />
        </button>
      </div>

      {!q && (
        <div className="filters" role="tablist" aria-label="Lọc hội thoại">
          <button type="button" role="tab" aria-selected={filter === 'all'} className={filter === 'all' ? 'on' : ''}
            onClick={() => setFilter('all')}>Tất cả</button>
          <button type="button" role="tab" aria-selected={filter === 'unread'} className={filter === 'unread' ? 'on' : ''}
            onClick={() => setFilter('unread')}>
            Chưa đọc{unreadTotal > 0 ? ` (${unreadTotal})` : ''}
          </button>
          {archivedTotal > 0 && (
            <button type="button" role="tab" aria-selected={filter === 'archived'} className={filter === 'archived' ? 'on' : ''}
              onClick={() => setFilter('archived')}>Lưu trữ ({archivedTotal})</button>
          )}
        </div>
      )}

      <div className="sidebar-scroll">
        {q.length >= 2 && (
          <section className="people">
            <h3 className="section-title">Người dùng {searching && <LoaderCircle size={13} className="spin" />}</h3>
            {searchError && <p className="muted pad">{searchError}</p>}
            {!searching && !searchError && people.length === 0 && (
              <p className="muted pad">Không tìm thấy ai tên “{q}”. Thử nhập đúng email.</p>
            )}
            <ul>
              {people.map(p => (
                <li key={p.userId}>
                  <button type="button" className="person" onClick={() => { setQuery(''); onStartDirect(p.userId); }}>
                    <Avatar name={p.displayName} seed={p.userId} size={40} />
                    <span className="person-name">{p.displayName}</span>
                    <span className="person-action"><UserPlus size={15} /> Nhắn tin</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {q && <h3 className="section-title">Hội thoại</h3>}

        {loading && <p className="muted pad">Đang tải hội thoại…</p>}
        {error && (
          <div className="pad">
            <p className="error-text">{error}</p>
            <button type="button" className="btn secondary small" onClick={onRetry}>Thử lại</button>
          </div>
        )}
        {!loading && !error && shown.length === 0 && (
          <p className="muted pad">
            {q ? 'Không có hội thoại nào khớp.' : filter === 'unread' ? 'Bạn đã đọc hết tin nhắn.' : 'Chưa có cuộc trò chuyện nào. Tìm một người bằng ô phía trên để bắt đầu.'}
          </p>
        )}
        <ul className="conv-list">
          {shown.map(item => (
            <ConversationItem
              key={item.conversationId}
              item={item}
              user={user}
              active={item.conversationId === activeId}
              onOpen={onOpen}
              onTogglePin={onTogglePin}
              typing={item.conversationId !== activeId ? typingIn[item.conversationId] : null}
            />
          ))}
        </ul>
      </div>
    </aside>
  );
}
