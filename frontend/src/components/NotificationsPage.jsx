import { useCallback, useEffect, useState } from 'react';
import { AtSign, Clock, UserRoundPlus, ShieldCheck, Newspaper, Images } from 'lucide-react';
import { AlarmClock, CalendarX, ClipboardCheck, Video } from 'lucide-react';
import { Bell, CheckCheck, Heart, LoaderCircle, MessageCircle, MessageSquare, Reply, RotateCcw, Share2, UserCheck, UserPlus } from 'lucide-react';
import Avatar from './Avatar';
import { api } from '../api';
import { formatFull, formatListTime } from '../utils';

const KIND = {
  POST_REACTION: { icon: Heart, text: n => `đã bày tỏ cảm xúc về bài viết của bạn` },
  POST_COMMENT: { icon: MessageSquare, text: n => `đã bình luận bài viết của bạn: “${n.preview}”` },
  COMMENT_REPLY: { icon: Reply, text: n => `đã trả lời bình luận của bạn: “${n.preview}”` },
  POST_SHARE: { icon: Share2, text: n => n.preview || 'đã chia sẻ bài viết của bạn' },
  FRIEND_REQUEST: { icon: UserPlus, text: () => 'đã gửi cho bạn lời mời kết bạn' },
  FRIEND_ACCEPT: { icon: UserCheck, text: () => 'đã chấp nhận lời mời kết bạn của bạn' },
  MESSAGE: { icon: MessageCircle, text: n => `${n.count > 1 ? `đã gửi ${n.count} tin nhắn mới` : 'đã gửi tin nhắn'}${n.preview ? `: “${n.preview}”` : ''}` }
  ,
  // Chuc nang moi
  MENTION: { icon: AtSign, text: n => `đã nhắc đến bạn${n.preview ? `: “${n.preview}”` : ''}` },
  TASK_DUE: { icon: Clock, text: n => `Nhắc hạn công việc — ${n.preview}` },
  GROUP_JOIN_REQUEST: { icon: UserRoundPlus, text: n => n.preview || 'muốn tham gia nhóm' },
  REPORT_UPDATE: { icon: ShieldCheck, text: n => n.preview || 'Báo cáo của bạn đã được xử lý.' },
  FRIEND_POST: { icon: Newspaper, text: n => `vừa đăng bài viết mới${n.preview ? `: “${n.preview}”` : ''}` },
  FRIEND_STORY: { icon: Images, text: n => `vừa thêm tin mới${n.preview && n.preview !== 'đã thêm một tin mới' ? `: “${n.preview}”` : ''}` },
  TASK_ASSIGNED: { icon: ClipboardCheck, text: n => `đã giao cho bạn công việc ${n.preview}` },
  TASK_UPDATED: { icon: ClipboardCheck, text: n => `đã cập nhật công việc ${n.preview}` },
  TASK_STATUS: { icon: ClipboardCheck, text: n => `đã đổi trạng thái công việc ${n.preview}` },
  TASK_COMMENT: { icon: MessageSquare, text: n => `đã bình luận công việc ${n.preview}` },
  MEETING_INVITE: { icon: Video, text: n => `mời bạn họp ${n.preview}` },
  MEETING_UPDATED: { icon: Video, text: n => `đã đổi lịch cuộc họp ${n.preview}` },
  MEETING_CANCELLED: { icon: CalendarX, text: n => `đã hủy cuộc họp ${n.preview}` },
  REMINDER: { icon: AlarmClock, text: n => `Nhắc nhở — ${n.preview}` },
  STORY_REACTION: { icon: Heart, text: n => `đã bày tỏ cảm xúc ${({ LIKE: '👍', LOVE: '❤️', HAHA: '😆', WOW: '😮', SAD: '😢', ANGRY: '😡' })[n.preview] || ''} về tin của bạn` }
};

export function describe(n) {
  return (KIND[n.type] || { text: () => '' }).text(n);
}

// Danh sach thong bao (phan trang 20 / lan). `live` la thong bao moi den qua SSE -> chen len dau ngay.
export default function NotificationsPage({ live, onOpen, onUnreadChange, onToast }) {
  const [items, setItems] = useState([]);
  const [token, setToken] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');

  const load = useCallback(async pageToken => {
    setState(pageToken ? 'more' : 'loading');
    try {
      const page = await api.notifications(pageToken);
      setItems(l => {
        const base = pageToken ? l : [];
        const seen = new Set(base.map(n => n.notificationId));
        return [...base, ...page.items.filter(n => !seen.has(n.notificationId))];
      });
      setToken(page.nextPageToken);
      onUnreadChange(page.unreadCount);
      setState('ready');
    } catch (err) {
      setError(err.message);
      setState('error');
    }
  }, [onUnreadChange]);

  useEffect(() => { load(null); }, [load]);

  // Thong bao moi qua SSE: chen len dau (thong bao "don" tin nhan thay the ban cu cung hoi thoai).
  useEffect(() => {
    if (!live) return;
    setItems(l => [live, ...l.filter(n => n.notificationId !== live.notificationId
      && !(live.type === 'MESSAGE' && n.type === 'MESSAGE' && n.conversationId === live.conversationId && !n.isRead))]);
  }, [live]);

  async function open(n) {
    if (!n.isRead) {
      setItems(l => l.map(x => (x.notificationId === n.notificationId ? { ...x, isRead: true } : x)));
      api.readNotification(n.notificationId).then(r => onUnreadChange(r.unreadCount)).catch(err => onToast(err.message));
    }
    onOpen(n);
  }

  async function readAll() {
    try {
      const r = await api.readAllNotifications();
      setItems(l => l.map(x => ({ ...x, isRead: true })));
      onUnreadChange(r.unreadCount);
    } catch (err) {
      onToast(err.message);
    }
  }

  const hasUnread = items.some(n => !n.isRead);
  return (
    <section className="posts-page" aria-label="Thông báo">
      <div className="posts-scroll">
        <div className="posts-col">
          <div className="notif-head">
            <h2 className="posts-title">Thông báo</h2>
            <button type="button" className="btn small secondary" onClick={readAll} disabled={!hasUnread}><CheckCheck size={15} /> Đánh dấu tất cả đã đọc</button>
          </div>
          {state === 'loading' && <p className="muted pad"><LoaderCircle size={15} className="spin" /> Đang tải thông báo…</p>}
          {state === 'error' && (
            <div className="card pad" role="alert"><p className="error-text">Không tải được thông báo: {error}</p>
              <button type="button" className="btn secondary small" onClick={() => load(null)}><RotateCcw size={14} /> Thử lại</button></div>
          )}
          {state !== 'loading' && state !== 'error' && items.length === 0 && (
            <div className="card pad notif-empty"><Bell size={28} /><p>Chưa có thông báo nào. Khi có người thích, bình luận, chia sẻ bài viết, kết bạn hoặc nhắn tin cho bạn, thông báo sẽ hiện ở đây.</p></div>
          )}
          {items.length > 0 && (
            <ul className="card notif-list">
              {items.map(n => {
                const Icon = KIND[n.type]?.icon || Bell;
                return (
                  <li key={n.notificationId}>
                    <button type="button" className={'notif-item' + (n.isRead ? '' : ' unread')} onClick={() => open(n)}>
                      <span className="notif-avatar">
                        <Avatar name={n.actor.displayName} seed={n.actor.userId} size={46} />
                        <span className={'notif-kind k-' + n.type}><Icon size={12} /></span>
                      </span>
                      <span className="notif-body">
                        <span className="notif-text"><strong>{n.actor.displayName}</strong> {describe(n)}</span>
                        <time className="notif-time" dateTime={n.createdAt} title={formatFull(n.createdAt)}>{formatListTime(n.createdAt)}</time>
                      </span>
                      {!n.isRead && <span className="notif-dot" aria-label="Chưa đọc" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {state === 'ready' && token && <button type="button" className="btn secondary posts-more" onClick={() => load(token)}>Xem thông báo cũ hơn</button>}
          {state === 'more' && <p className="muted pad"><LoaderCircle size={15} className="spin" /> Đang tải…</p>}
        </div>
      </div>
    </section>
  );
}
