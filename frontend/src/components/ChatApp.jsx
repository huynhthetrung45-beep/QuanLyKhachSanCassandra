import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import NavRail from './NavRail';
import Sidebar from './Sidebar';
import ChatWindow from './ChatWindow';
import InfoPanel from './InfoPanel';
import ChatSearchPanel from './ChatSearchPanel';
import CreateGroupModal from './CreateGroupModal';
import Logo from './Logo';
import ErrorBoundary from './ErrorBoundary';
import FriendsPage from './FriendsPage';
import ProfileModal from './ProfileModal';
import PostsPage from './PostsPage';
import NotificationsPage, { describe } from './NotificationsPage';
import PostModal from './PostModal';
import SearchPage from './SearchPage';
import ConfirmDialog from './ConfirmDialog';
import useEventStream from '../hooks/useEventStream';
import { api } from '../api';
import { readPref, timeuuidToIso, writePref } from '../utils';
import useChatAppExtensions from '../extensions/useChatAppExtensions';

export default function ChatApp({ user, onLogout, onUserChanged }) {
  const [conversations, setConversations] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [activeId, setActiveId] = useState(null);
  // Man hinh hep: panel thong tin la lop phu, mac dinh dong
  const [showInfo, setShowInfo] = useState(() => window.innerWidth > 1240 && readPref('chatott.info', true));
  const [demoMode, setDemoMode] = useState(() => readPref('chatott.demo', true));
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [toast, setToast] = useState('');
  const [detailVersion, setDetailVersion] = useState(0);
  const [mediaVersion, setMediaVersion] = useState(0);
  const [view, setView] = useState('chat');            // chat | friends | feed | profile | notifications | search
  const [notifUnread, setNotifUnread] = useState(0);
  const [liveNotif, setLiveNotif] = useState(null);
  const [postModal, setPostModal] = useState(null);     // { postId, openComments }
  const [logoutAsk, setLogoutAsk] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const [jumpTarget, setJumpTarget] = useState(null);   // { conversationId, messageId, createdAt }
  const [statsVersion, setStatsVersion] = useState(0);
  const [pageUserId, setPageUserId] = useState(null);  // trang ca nhan dang xem
  const [friendsVersion, setFriendsVersion] = useState(0);
  const [incomingCount, setIncomingCount] = useState(0);
  const [profileId, setProfileId] = useState(null);
  const [typingIn, setTypingIn] = useState({}); // conversationId -> { name, until } (cho danh sach ben trai)
  const chatRef = useRef(null);
  const refreshTimer = useRef(null);

  const loadConversations = useCallback(async () => {
    try {
      const data = await api.conversations();
      setConversations(data.data);
      setListError('');
    } catch (err) {
      setListError(err.message);
    } finally {
      setListLoading(false);
    }
  }, []);

  const scheduleRefresh = useCallback(() => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(loadConversations, 250);
  }, [loadConversations]);

  useEffect(() => {
    loadConversations();
    return () => clearTimeout(refreshTimer.current);
  }, [loadConversations]);

  const loadIncoming = useCallback(() => {
    api.friendRequests('incoming').then(r => setIncomingCount(r.data.length)).catch(() => {});
  }, []);
  useEffect(() => { loadIncoming(); }, [loadIncoming]);

  const loadUnread = useCallback(() => {
    api.unreadNotifications().then(r => setNotifUnread(r.unreadCount)).catch(() => {});
  }, []);
  useEffect(() => { loadUnread(); }, [loadUnread]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(''), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => writePref('chatott.info', showInfo), [showInfo]);
  const [showSearch, setShowSearch] = useState(false);   // panel tim kiem trong tro chuyen (thay cho panel thong tin)
  useEffect(() => { setShowSearch(false); }, [activeId]);
  useEffect(() => writePref('chatott.demo', demoMode), [demoMode]);

  const active = useMemo(
    () => conversations.find(c => c.conversationId === activeId) || null,
    [conversations, activeId]
  );

  const openConversation = useCallback(id => {
    setActiveId(id);
    setConversations(list => list.map(c => (c.conversationId === id ? { ...c, unread: false } : c)));
  }, []);

  // Chuc nang moi: cai dat, bai da luu, hashtag, quan tri, link moi nhom.
  const extras = useChatAppExtensions({
    user, view, setView, conversations, openConversation, loadConversations, setToast, onOpenProfile: setProfileId, onUserChanged
  });

  useEffect(() => {
    const keys = Object.keys(typingIn);
    if (keys.length === 0) return undefined;
    const t = setTimeout(() => {
      const now = Date.now();
      setTypingIn(map => Object.fromEntries(Object.entries(map).filter(([, v]) => v.until > now)));
    }, 1000);
    return () => clearTimeout(t);
  }, [typingIn]);

  const live = useEventStream({
    'message:new': ({ conversationId, message }) => {
      if (conversationId === activeId) chatRef.current?.receive(message);
      if (message.messageType === 'SYSTEM' && conversationId === activeId) setDetailVersion(v => v + 1);
      if (conversationId === activeId && message.attachments?.length) setMediaVersion(v => v + 1);
      if (conversationId === activeId) setStatsVersion(v => v + 1);
      setTypingIn(map => {
        if (!map[conversationId]) return map;
        const next = { ...map };
        delete next[conversationId];
        return next;
      });
      scheduleRefresh();
    },
    'message:deleted': ({ conversationId, messageId }) => {
      if (conversationId === activeId) {
        chatRef.current?.markRecalled(messageId);
        setMediaVersion(v => v + 1);
      }
      scheduleRefresh();
    },
    // Chi gui cho chinh minh (tab/thiet bi khac cua cung tai khoan)
    'message:hidden': ({ conversationId, messageId }) => {
      if (conversationId === activeId) chatRef.current?.removeMessage(messageId);
      scheduleRefresh();
    },
    // Ghim / bo ghim (chi thanh vien nhan): thanh ghim tu tai lai qua API co kiem tra quyen.
    'message:pins': ({ conversationId }) => {
      if (conversationId === activeId) chatRef.current?.pinsChanged();
    },
    'reaction:updated': ({ conversationId, messageId, reactions }) => {
      if (conversationId === activeId) chatRef.current?.applyReactions(messageId, reactions);
    },
    typing: data => {
      if (data.userId === user.userId) return;
      if (data.conversationId === activeId) chatRef.current?.typing(data);
      setTypingIn(map => ({ ...map, [data.conversationId]: { name: data.displayName, until: Date.now() + 4500 } }));
    },
    read: data => {
      if (data.conversationId === activeId) chatRef.current?.read(data);
    },
    presence: data => chatRef.current?.presence(data),
    'friend:updated': data => {
      setFriendsVersion(v => v + 1);
      loadIncoming();
      if (data.actorId !== user.userId && data.status === 'PENDING') setToast('Bạn có lời mời kết bạn mới.');
      if (data.actorId !== user.userId && data.status === 'FRIENDS') setToast('Lời mời kết bạn đã được chấp nhận.');
    },
    // Thong bao moi (chi gui cho chinh minh): badge + danh sach cap nhat ngay, khong chuyen trang.
    'notification:new': ({ notification, unreadCount }) => {
      setNotifUnread(unreadCount);
      setLiveNotif(notification);
      const chatting = notification.type === 'MESSAGE' && view === 'chat' && notification.conversationId === activeId;
      if (view !== 'notifications' && !chatting) setToast(`${notification.actor.displayName} ${describe(notification)}`);
    },
    'notification:read': ({ unreadCount }) => setNotifUnread(unreadCount),
    // Bai viet thay doi (chi co postId): the bai dang hien thi tu tai lai qua API co kiem tra quyen.
    'post:changed': data => window.dispatchEvent(new CustomEvent('chatott:post-changed', { detail: data })),
    'conversation:updated': () => scheduleRefresh(),
    'conversation:removed': ({ conversationId }) => {
      if (conversationId === activeId) {
        setActiveId(null);
        setToast('Bạn không còn là thành viên của nhóm này.');
      }
      scheduleRefresh();
    },
    // Ket noi lai sau khi mat mang: dong bo lai danh sach
    ready: () => {
      scheduleRefresh();
      loadIncoming();
      loadUnread();
      chatRef.current?.resync();
    }
  });

  async function startDirect(targetUserId) {
    try {
      const { conversationId } = await api.openDirect(targetUserId);
      setView('chat');
      await loadConversations();
      openConversation(conversationId);
    } catch (err) {
      setToast(err.message);
    }
  }

  function openNotification(n) {
    if (n.ref && ['TASK', 'MEETING', 'EVENT'].includes(n.ref.type)) return window.dispatchEvent(new CustomEvent('chatott:navigate', { detail: { view: 'work', ref: n.ref } }));
    if (['POST_REACTION', 'POST_COMMENT', 'COMMENT_REPLY', 'POST_SHARE'].includes(n.type) && n.postId) {
      setPostModal({ postId: n.postId, openComments: n.type === 'POST_COMMENT' || n.type === 'COMMENT_REPLY' });
    } else if (n.type === 'MESSAGE' && n.conversationId) {
      setView('chat');
      openConversation(n.conversationId);
    } else if (n.type === 'FRIEND_REQUEST') {
      setView('friends');
    } else if (n.type === 'FRIEND_POST' && n.postId) {
      setPostModal({ postId: n.postId, openComments: false });
    } else if (n.type === 'FRIEND_STORY' || n.type === 'STORY_REACTION') {
      setView('feed');
      setTimeout(() => window.dispatchEvent(new CustomEvent('chatott:open-story', { detail: { authorId: n.type === 'FRIEND_STORY' ? n.actor.userId : user.userId } })), 400);
    } else if (['MENTION', 'TASK_DUE', 'GROUP_JOIN_REQUEST'].includes(n.type) && n.conversationId) {
      setView('chat');
      openConversation(n.conversationId);
    } else if (n.type === 'FRIEND_ACCEPT') {
      setProfileId(n.actor.userId);
    }
  }

  function openSearchResult(r) {
    setView('chat');
    openConversation(r.conversationId);
    setJumpTarget({ conversationId: r.conversationId, messageId: r.messageId, createdAt: r.createdAt });
  }

  async function confirmLogout() {
    setLogoutBusy(true);
    setLogoutError('');
    try {
      await onLogout(); // thanh cong -> ChatApp bi unmount (dong SSE, xoa state)
    } catch (err) {
      setLogoutError(`Đăng xuất chưa thành công: ${err.message}`);
      setLogoutBusy(false);
    }
  }

  async function togglePin(conversation) {
    try {
      await api.pin(conversation.conversationId, !conversation.pinned);
      setToast(conversation.pinned ? 'Đã bỏ ghim hội thoại.' : 'Đã ghim hội thoại lên đầu.');
      loadConversations();
    } catch (err) {
      setToast(err.message);
    }
  }

  return (
    <div className={'shell' + (view !== 'chat' ? ' view-friends' : '') + (active ? ' has-active' : '') + ((showInfo || showSearch) && active && view === 'chat' ? ' info-open' : '')}>
      <NavRail
        user={user}
        onLogout={() => { if (!logoutAsk) { setLogoutError(''); setLogoutAsk(true); } }}
        onCreateGroup={() => setCreatingGroup(true)}
        demoMode={demoMode}
        onToggleDemo={() => setDemoMode(v => !v)}
        live={live}
        unreadCount={conversations.filter(c => c.unread).length}
        view={view}
        onShowChat={() => setView('chat')}
        onShowFriends={() => setView('friends')}
        onShowFeed={() => setView('feed')}
        onShowNotifications={() => setView('notifications')}
        onShowSearch={() => setView('search')}
        notifBadge={notifUnread}
        friendBadge={incomingCount}
        onOpenMyProfile={() => setProfileId(user.userId)}
        isAdmin={extras.isAdmin}
        onShowSettings={() => setView('settings')}
        onShowSaved={() => setView('saved')}
        onShowHashtag={() => setView('hashtag')}
        onShowAdmin={() => setView('admin')}
        onShowAssistant={() => setView('assistant')}
        onShowWork={() => setView('work')}
      />

      {(view === 'feed' || view === 'profile') && (
        <main className="friends-area">
          <ErrorBoundary resetKey={view + (pageUserId || '')} message="Không hiển thị được bài viết.">
            <PostsPage key={view + (pageUserId || '')} user={user} userId={view === 'profile' ? pageUserId : null}
              conversations={conversations} onOpenProfile={setProfileId} onMessage={startDirect} onToast={setToast}
              onBack={view === 'profile' ? () => setView('feed') : null} />
          </ErrorBoundary>
        </main>
      )}

      {view === 'notifications' && (
        <main className="friends-area">
          <ErrorBoundary message="Không hiển thị được thông báo.">
            <NotificationsPage live={liveNotif} onOpen={openNotification} onUnreadChange={setNotifUnread} onToast={setToast} />
          </ErrorBoundary>
        </main>
      )}

      {view === 'search' && (
        <main className="friends-area">
          <ErrorBoundary message="Không hiển thị được trang tìm kiếm.">
            <SearchPage conversations={conversations} onOpenResult={openSearchResult} onToast={setToast} />
          </ErrorBoundary>
        </main>
      )}

      {view === 'friends' && (
        <main className="friends-area">
          <ErrorBoundary message="Không hiển thị được trang bạn bè.">
            <FriendsPage version={friendsVersion} onOpenProfile={setProfileId} onMessage={startDirect}
              onToast={setToast} onCountsChanged={setIncomingCount} />
          </ErrorBoundary>
        </main>
      )}

      {extras.render()}

      {view === 'chat' && <Sidebar
        user={user}
        conversations={conversations}
        loading={listLoading}
        error={listError}
        activeId={activeId}
        onOpen={openConversation}
        onStartDirect={startDirect}
        onCreateGroup={() => setCreatingGroup(true)}
        onTogglePin={togglePin}
        onRetry={loadConversations}
        typingIn={typingIn}
      />}

      {view === 'chat' && <main className="chat-area">
        {active ? (
          <ErrorBoundary resetKey={active.conversationId} message="Không hiển thị được cuộc trò chuyện này.">
          <ChatWindow
            ref={chatRef}
            key={active.conversationId}
            user={user}
            conversation={active}
            conversations={conversations}
            demoMode={demoMode}
            infoOpen={showInfo && !showSearch}
            onToggleInfo={() => { setShowSearch(false); setShowInfo(v => (showSearch ? true : !v)); }}
            searchOpen={showSearch}
            onToggleSearch={() => setShowSearch(v => !v)}
            onBack={() => setActiveId(null)}
            onChanged={created => {
              if (created?.attachments?.length) setMediaVersion(v => v + 1);
              scheduleRefresh();
            }}
            onToast={setToast}
            onOpenProfile={setProfileId}
            jumpTarget={jumpTarget?.conversationId === active.conversationId ? jumpTarget : null}
            onJumpDone={() => setJumpTarget(null)}
          />
          </ErrorBoundary>
        ) : (
          <div className="chat-empty">
            <Logo size={72} />
            <h2>Chào {user.displayName}</h2>
            <p>Chọn một cuộc trò chuyện ở bên trái, hoặc tìm bạn bè theo tên hay email để bắt đầu nhắn tin.</p>
            <button type="button" className="btn secondary" onClick={() => setCreatingGroup(true)}>Tạo nhóm mới</button>
          </div>
        )}
      </main>}

      {view === 'chat' && active && showSearch && (
        <ErrorBoundary resetKey={active.conversationId} message="Không hiển thị được tìm kiếm.">
          <ChatSearchPanel key={active.conversationId} conversation={active} onClose={() => setShowSearch(false)}
            onOpenResult={r => {
              chatRef.current?.jumpTo({ messageId: r.messageId, createdAt: r.createdAt });
              if (window.innerWidth <= 1240) setShowSearch(false); // man hinh nho: drawer dong lai de thay tin
            }} />
        </ErrorBoundary>
      )}

      {view === 'chat' && active && showInfo && !showSearch && (
        <ErrorBoundary resetKey={active.conversationId} message="Không hiển thị được thông tin hội thoại.">
        <InfoPanel
          key={active.conversationId + ':' + detailVersion}
          user={user}
          conversation={active}
          mediaVersion={mediaVersion}
          statsVersion={statsVersion}
          onJumpToMessage={id => chatRef.current?.jumpTo({ messageId: id, createdAt: timeuuidToIso(id) })}
          onOpenProfile={setProfileId}
          onClose={() => setShowInfo(false)}
          onTogglePin={() => togglePin(active)}
          onChanged={scheduleRefresh}
          onLeft={() => { setActiveId(null); setToast('Bạn đã rời nhóm.'); scheduleRefresh(); }}
          onToast={setToast}
        />
        </ErrorBoundary>
      )}

      {creatingGroup && (
        <CreateGroupModal
          onClose={() => setCreatingGroup(false)}
          onCreated={async id => {
            setCreatingGroup(false);
            await loadConversations();
            openConversation(id);
          }}
        />
      )}

      {profileId && (
        <ProfileModal userId={profileId} me={user} onClose={() => setProfileId(null)} onMessage={startDirect}
          onViewPage={id => { setPageUserId(id); setView('profile'); }}
          onToast={setToast} onRelationChanged={() => setFriendsVersion(v => v + 1)} />
      )}

      {postModal && (
        <PostModal postId={postModal.postId} openComments={postModal.openComments} me={user} conversations={conversations}
          onClose={() => setPostModal(null)} onOpenProfile={id => { setPostModal(null); setProfileId(id); }} onToast={setToast} />
      )}

      {logoutAsk && (
        <ConfirmDialog
          title="Đăng xuất khỏi ChatOTT?"
          message="Bạn có chắc chắn muốn đăng xuất khỏi tài khoản này?"
          confirmLabel="Đăng xuất"
          cancelLabel="Ở lại"
          danger
          busy={logoutBusy}
          error={logoutError}
          onConfirm={confirmLogout}
          onCancel={() => { if (!logoutBusy) setLogoutAsk(false); }}
        />
      )}

      {extras.overlays}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
