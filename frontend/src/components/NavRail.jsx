import { useEffect, useRef, useState } from 'react';
import { Bell, LogOut, MessageCircle, Gauge, UsersRound, Contact, UserRound, Newspaper, Search } from 'lucide-react';
import { Bookmark, Bot, Hash, Settings, Shield } from 'lucide-react';
import Avatar from './Avatar';
import Logo from './Logo';

export default function NavRail({
  user, onLogout, onCreateGroup, demoMode, onToggleDemo, live, unreadCount,
  view = 'chat', onShowChat, onShowFriends, onShowFeed, onShowNotifications, onShowSearch, notifBadge = 0, friendBadge = 0, onOpenMyProfile
  , isAdmin = false, onShowSettings, onShowSaved, onShowHashtag, onShowAdmin, onShowAssistant
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = e => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    const onKey = e => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  return (
    <nav className="rail" aria-label="Điều hướng chính">
      <div className="rail-logo" title="ChatOTT"><Logo size={36} /></div>

      <div className="rail-account" ref={menuRef}>
        <button
          type="button"
          className="rail-avatar"
          onClick={() => setMenuOpen(v => !v)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="Tài khoản"
        >
          <Avatar name={user.displayName} seed={user.userId} size={40} online={live} />
        </button>
        {menuOpen && (
          <div className="menu account-menu" role="menu">
            <div className="menu-profile">
              <Avatar name={user.displayName} seed={user.userId} size={48} />
              <div>
                <strong>{user.displayName}</strong>
                <span>{user.email || user.userId}</span>
                <span className={'live-state ' + (live ? 'on' : 'off')}>
                  {live ? 'Đang nhận tin trực tiếp' : 'Đang kết nối lại…'}
                </span>
              </div>
            </div>
            <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenuOpen(false); onOpenMyProfile(); }}>
              <UserRound size={17} />
              <span>Hồ sơ của tôi</span>
            </button>
            {onShowSettings && (
              <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenuOpen(false); onShowSettings(); }}>
                <Settings size={17} />
                <span>Cài đặt tài khoản</span>
              </button>
            )}
            {onShowSaved && (
              <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenuOpen(false); onShowSaved(); }}>
                <Bookmark size={17} />
                <span>Bài viết đã lưu</span>
              </button>
            )}
            <button type="button" role="menuitemcheckbox" aria-checked={demoMode} className="menu-item" onClick={onToggleDemo}>
              <Gauge size={17} />
              <span>Hiện số liệu Cassandra</span>
              <span className={'switch' + (demoMode ? ' on' : '')} aria-hidden="true" />
            </button>
            <button type="button" role="menuitem" className="menu-item danger" onClick={() => { setMenuOpen(false); onLogout(); }}>
              <LogOut size={17} />
              <span>Đăng xuất</span>
            </button>
          </div>
        )}
      </div>

      <div className="rail-nav">
        <button type="button" className={'rail-btn' + (view === 'chat' ? ' active' : '')} title="Tin nhắn"
          aria-current={view === 'chat' ? 'page' : undefined} onClick={onShowChat}>
          <MessageCircle size={22} />
          {unreadCount > 0 && <span className="rail-badge">{unreadCount > 9 ? '9+' : unreadCount}</span>}
        </button>
        <button type="button" className={'rail-btn' + (view === 'feed' ? ' active' : '')} title="Bảng tin"
          aria-current={view === 'feed' ? 'page' : undefined} onClick={onShowFeed}>
          <Newspaper size={22} />
        </button>
        <button type="button" className={'rail-btn' + (view === 'notifications' ? ' active' : '')} title="Thông báo"
          aria-label={notifBadge ? `Thông báo, ${notifBadge} chưa đọc` : 'Thông báo'}
          aria-current={view === 'notifications' ? 'page' : undefined} onClick={onShowNotifications}>
          <Bell size={22} />
          {notifBadge > 0 && <span className="rail-badge">{notifBadge > 99 ? '99+' : notifBadge}</span>}
        </button>
        <button type="button" className={'rail-btn' + (view === 'search' ? ' active' : '')} title="Tìm kiếm tin nhắn"
          aria-current={view === 'search' ? 'page' : undefined} onClick={onShowSearch}>
          <Search size={22} />
        </button>
        <button type="button" className={'rail-btn' + (view === 'friends' ? ' active' : '')} title="Bạn bè"
          aria-current={view === 'friends' ? 'page' : undefined} onClick={onShowFriends}>
          <Contact size={22} />
          {friendBadge > 0 && <span className="rail-badge">{friendBadge > 9 ? '9+' : friendBadge}</span>}
        </button>
        {onShowAssistant && (
          <button type="button" className={'rail-btn' + (view === 'assistant' ? ' active' : '')} title="Trợ lý AI (Gemini)" onClick={onShowAssistant}>
            <Bot size={22} />
          </button>
        )}
        {onShowHashtag && (
          <button type="button" className={'rail-btn' + (view === 'hashtag' ? ' active' : '')} title="Hashtag" onClick={onShowHashtag}>
            <Hash size={22} />
          </button>
        )}
        {isAdmin && onShowAdmin && (
          <button type="button" className={'rail-btn' + (view === 'admin' ? ' active' : '')} title="Quản trị" onClick={onShowAdmin}>
            <Shield size={22} />
          </button>
        )}
        <button type="button" className="rail-btn" title="Tạo nhóm" onClick={onCreateGroup}>
          <UsersRound size={22} />
        </button>
      </div>

      <button type="button" className="rail-btn rail-bottom" title="Đăng xuất" onClick={onLogout}>
        <LogOut size={20} />
      </button>
    </nav>
  );
}
