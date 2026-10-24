import { useEffect, useState } from 'react';
import {
  Search,
  Send,
  MessageCircle,
  Users,
  Trash2,
  RefreshCw,
  ChevronUp
} from 'lucide-react';
import './App.css';

const API = 'http://localhost:3000/api/v1';
const PAGE_SIZE = 20;

function getArray(result, key) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.[key])) return result[key];
  return [];
}

function App() {
  const [users, setUsers] = useState([]);
  const [userId, setUserId] = useState('user01');
  const [conversations, setConversations] = useState([]);
  const [conversation, setConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [content, setContent] = useState('');
  const [keyword, setKeyword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sending, setSending] = useState(false);
  const [nextPageToken, setNextPageToken] = useState(null);
  const [hasMore, setHasMore] = useState(false);

  // Tải danh sách người dùng
  async function loadUsers() {
    try {
      const res = await fetch(`${API}/users`);

      if (!res.ok) {
        throw new Error('Không tải được danh sách người dùng.');
      }

      const result = await res.json();
      const userList = getArray(result, 'users');

      setUsers(userList);

      if (
        userList.length > 0 &&
        !userList.some(
          user => (user.userId || user.user_id) === userId
        )
      ) {
        setUserId(userList[0].userId || userList[0].user_id);
      }
    } catch (err) {
      setError('Không kết nối được backend tại cổng 3000.');
      console.error('Lỗi tải người dùng:', err);
    }
  }

  // Tải danh sách hội thoại của người dùng
  async function loadConversations(selectedUser = userId) {
    try {
      const res = await fetch(
        `${API}/users/${encodeURIComponent(selectedUser)}/conversations`
      );

      if (!res.ok) {
        throw new Error('Không tải được danh sách hội thoại.');
      }

      const result = await res.json();
      const list = getArray(result, 'conversations');

      setConversations(list);

      // Đồng bộ thông tin hội thoại đang mở
      setConversation(current => {
        if (!current) return current;

        return list.find(
          item => item.conversationId === current.conversationId
        ) || current;
      });

      return list;
    } catch (err) {
      setError(err.message);
      console.error('Lỗi tải hội thoại:', err);
      return null;
    }
  }

  useEffect(() => {
    loadUsers();
  }, []);

  useEffect(() => {
    setConversation(null);
    setMessages([]);
    setNextPageToken(null);
    setHasMore(false);
    setError('');

    loadConversations(userId);
  }, [userId]);

  // Tải tin nhắn của một hội thoại
  async function openConversation(item) {
    setConversation(item);
    setMessages([]);
    setNextPageToken(null);
    setHasMore(false);
    setLoading(true);
    setError('');

    try {
      const url =
        `${API}/conversations/${item.conversationId}/messages` +
        `?userId=${encodeURIComponent(userId)}&limit=${PAGE_SIZE}`;

      const res = await fetch(url);
      const result = await res.json();

      if (!res.ok) {
        throw new Error(
          result.message || 'Không tải được lịch sử tin nhắn.'
        );
      }

      // API hiện tại trả danh sách trong trường items
      const items = Array.isArray(result.items)
        ? result.items
        : Array.isArray(result.messages)
          ? result.messages
          : Array.isArray(result.data?.items)
            ? result.data.items
            : [];

      setMessages(items);
      setNextPageToken(result.nextPageToken || null);
      setHasMore(Boolean(result.hasMore));
    } catch (err) {
      setError(err.message);
      console.error('Lỗi tải tin nhắn:', err);
    } finally {
      setLoading(false);
    }
  }

  // Tải thêm tin nhắn cũ bằng page token của Cassandra
  async function loadOlderMessages() {
    if (
      !conversation ||
      !nextPageToken ||
      loadingOlder ||
      !hasMore
    ) {
      return;
    }

    setLoadingOlder(true);
    setError('');

    try {
      const params = new URLSearchParams({
        userId,
        limit: String(PAGE_SIZE),
        pageToken: nextPageToken
      });

      const url =
        `${API}/conversations/${conversation.conversationId}/messages?${params}`;

      const res = await fetch(url);
      const result = await res.json();

      if (!res.ok) {
        throw new Error(
          result.message || 'Không tải được tin nhắn cũ hơn.'
        );
      }

      const olderItems = Array.isArray(result.items)
        ? result.items
        : Array.isArray(result.messages)
          ? result.messages
          : Array.isArray(result.data?.items)
            ? result.data.items
            : [];

      // Giữ nguyên tin nhắn đã có, tránh thêm trùng ID
      setMessages(current => {
        const existingIds = new Set(
          current.map(message => message.messageId)
        );

        const uniqueOlderItems = olderItems.filter(
          message => !existingIds.has(message.messageId)
        );

        return [...current, ...uniqueOlderItems];
      });

      setNextPageToken(result.nextPageToken || null);
      setHasMore(Boolean(result.hasMore));
    } catch (err) {
      setError(err.message);
      console.error('Lỗi tải tin nhắn cũ:', err);
    } finally {
      setLoadingOlder(false);
    }
  }

  // Gửi tin nhắn
  async function sendMessage(e) {
    e.preventDefault();

    const text = content.trim();

    if (!text || !conversation || sending) return;

    setSending(true);
    setError('');

    try {
      const res = await fetch(
        `${API}/conversations/${conversation.conversationId}/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            userId,
            content: text,
            messageType: 'TEXT'
          })
        }
      );

      const result = await res.json();

      if (!res.ok) {
        throw new Error(
          result.message || 'Gửi tin nhắn thất bại.'
        );
      }

      setContent('');

      // Tải lại trang đầu để hiển thị tin nhắn mới nhất
      await openConversation(conversation);
      await loadConversations(userId);
    } catch (err) {
      setError(err.message);
      console.error('Lỗi gửi tin nhắn:', err);
    } finally {
      setSending(false);
    }
  }

  // Thu hồi tin nhắn của chính mình
  async function deleteMessage(messageId) {
    if (!conversation) return;

    const confirmed = window.confirm(
      'Bạn có chắc muốn thu hồi tin nhắn này không?'
    );

    if (!confirmed) return;

    setError('');

    try {
      const url =
        `${API}/conversations/${conversation.conversationId}` +
        `/messages/${messageId}?userId=${encodeURIComponent(userId)}`;

      const res = await fetch(url, {
        method: 'DELETE'
      });

      const result = await res.json();

      if (!res.ok) {
        throw new Error(
          result.message || 'Thu hồi tin nhắn thất bại.'
        );
      }

      await openConversation(conversation);
      await loadConversations(userId);
    } catch (err) {
      setError(err.message);
      console.error('Lỗi thu hồi tin nhắn:', err);
    }
  }

  // Tìm kiếm hội thoại theo tên
  const filteredConversations = conversations.filter(item =>
    (item.conversationName || '')
      .toLowerCase()
      .includes(keyword.trim().toLowerCase())
  );

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">
            <MessageCircle size={26} />
          </div>

          <div>
            <h1>ChatOTT</h1>
            <p>Hệ thống lưu trữ tin nhắn</p>
          </div>
        </div>

        <div className="user-picker">
          <label>NGƯỜI DÙNG HIỆN TẠI</label>

          <select
            value={userId}
            onChange={e => setUserId(e.target.value)}
          >
            {users.map(user => {
              const id = user.userId || user.user_id;
              const name = user.displayName || user.display_name;

              return (
                <option key={id} value={id}>
                  {name} ({id})
                </option>
              );
            })}
          </select>
        </div>

        <div className="conversation-heading">
          <span>HỘI THOẠI</span>
          <span className="count">{conversations.length}</span>
        </div>

        <div className="search-box">
          <Search size={18} />

          <input
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            placeholder="Tìm hội thoại..."
            aria-label="Tìm hội thoại"
          />
        </div>

        <div className="conversation-list">
          {filteredConversations.map(item => {
            const isGroup = item.conversationType === 'GROUP';

            return (
              <button
                key={item.conversationId}
                className={
                  'conversation ' +
                  (conversation?.conversationId === item.conversationId
                    ? 'active'
                    : '')
                }
                onClick={() => openConversation(item)}
              >
                <div className="avatar">
                  {isGroup
                    ? <Users size={22} />
                    : (item.conversationName || '?').charAt(0)}
                </div>

                <div className="conversation-info">
                  <strong>{item.conversationName}</strong>

                  <p>
                    {item.lastSenderName
                      ? `${item.lastSenderName}: `
                      : ''}
                    {item.lastMessagePreview || 'Chưa có tin nhắn'}
                  </p>
                </div>
              </button>
            );
          })}

          {filteredConversations.length === 0 && (
            <p className="empty-list">
              {keyword
                ? 'Không tìm thấy hội thoại phù hợp.'
                : 'Người dùng chưa có hội thoại.'}
            </p>
          )}
        </div>

        <div className="sidebar-footer">
          <span className="online-dot"></span>
          Cassandra Database

          <button
            type="button"
            title="Tải lại hội thoại"
            aria-label="Tải lại hội thoại"
            onClick={() => loadConversations(userId)}
          >
            <RefreshCw size={15} />
          </button>
        </div>
      </aside>

      <main className="chat-panel">
        {conversation ? (
          <>
            <header className="chat-header">
              <div className="avatar header-avatar">
                {conversation.conversationType === 'GROUP'
                  ? <Users size={22} />
                  : (conversation.conversationName || '?').charAt(0)}
              </div>

              <div className="header-info">
                <h2>{conversation.conversationName}</h2>

                <p>
                  {conversation.conversationType === 'GROUP'
                    ? 'Nhóm trò chuyện'
                    : 'Trò chuyện trực tiếp'}
                  {' · '}
                  Lưu trữ trên Cassandra
                </p>
              </div>
            </header>

            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}

            <div className="date-divider">
              <span>LỊCH SỬ TIN NHẮN</span>
            </div>

            <div className="messages">
              {hasMore && !loading && (
                <button
                  type="button"
                  className="load-older"
                  onClick={loadOlderMessages}
                  disabled={loadingOlder}
                >
                  <ChevronUp size={16} />
                  {loadingOlder
                    ? 'Đang tải tin nhắn cũ...'
                    : 'Tải tin nhắn cũ hơn'}
                </button>
              )}

              {loading && (
                <p className="loading-text">
                  Đang tải tin nhắn...
                </p>
              )}

              {!loading && messages.length === 0 && !error && (
                <p className="loading-text">
                  Hội thoại chưa có tin nhắn.
                </p>
              )}

              {messages.slice().reverse().map(message => {
                const mine = message.senderId === userId;
                const deleted = message.isDeleted;

                return (
                  <div
                    key={message.messageId}
                    className={`message-row ${mine ? 'mine' : 'theirs'}`}
                  >
                    {!mine && (
                      <div className="message-avatar">
                        {(message.senderName || '?').charAt(0)}
                      </div>
                    )}

                    <div className="message">
                      {!mine && (
                        <div className="sender">
                          {message.senderName || message.senderId}
                        </div>
                      )}

                      <p className={deleted ? 'deleted-message' : ''}>
                        {deleted
                          ? 'Tin nhắn đã được thu hồi'
                          : message.content}
                      </p>

                      <div className="message-meta">
                        <time>
                          {message.createdAt
                            ? new Date(message.createdAt).toLocaleString(
                                'vi-VN',
                                {
                                  day: '2-digit',
                                  month: '2-digit',
                                  hour: '2-digit',
                                  minute: '2-digit'
                                }
                              )
                            : ''}
                        </time>

                        {mine && !deleted && (
                          <button
                            type="button"
                            title="Thu hồi tin nhắn"
                            aria-label="Thu hồi tin nhắn"
                            onClick={() => deleteMessage(message.messageId)}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <form className="composer" onSubmit={sendMessage}>
              <input
                value={content}
                onChange={e => setContent(e.target.value)}
                placeholder="Nhập nội dung tin nhắn..."
                maxLength={2000}
                aria-label="Nội dung tin nhắn"
              />

              <button
                type="submit"
                disabled={!content.trim() || sending}
                title="Gửi tin nhắn"
                aria-label="Gửi tin nhắn"
              >
                <Send size={19} />
              </button>
            </form>

            <div className="composer-note">
              Tin nhắn được lưu trong cơ sở dữ liệu Cassandra
            </div>
          </>
        ) : (
          <div className="welcome">
            <div className="welcome-icon">
              <MessageCircle size={44} />
            </div>

            <h2>Chào mừng đến với ChatOTT</h2>
            <p>Chọn một hội thoại bên trái để xem lịch sử tin nhắn.</p>

            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default App;