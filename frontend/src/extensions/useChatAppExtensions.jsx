// Gan cac trang / hop thoai moi vao ChatApp: cai dat tai khoan, bai da luu, hashtag, quan tri,
// link moi nhom (?invite=CODE), mo hoi thoai tu thong bao day (?conversation=ID).
import { useCallback, useEffect, useState } from 'react';
import ErrorBoundary from '../components/ErrorBoundary';
import AccountSettings from './AccountSettings';
import AdminPage from './AdminPage';
import { JoinInviteDialog, PostListPage } from './SocialExtras';
import { ext } from './extApi';
import { useSse } from './sse';
import { loadPrefs } from './prefsStore';
import { registerSw } from './push';

export const EXTRA_VIEWS = ['settings', 'saved', 'hashtag', 'admin'];

function takeParam(name) {
  const url = new URL(window.location.href);
  const value = url.searchParams.get(name);
  if (value) {
    url.searchParams.delete(name);
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  return value;
}

export default function useChatAppExtensions({ user, view, setView, conversations, openConversation, loadConversations, setToast, onOpenProfile, onUserChanged }) {
  const [security, setSecurity] = useState(null);
  const [tag, setTag] = useState('');
  const [invite, setInvite] = useState(() => takeParam('invite'));
  const [settingsTab, setSettingsTab] = useState('profile');

  const loadSecurity = useCallback(() => ext.security().then(setSecurity).catch(() => {}), []);
  useEffect(() => { loadSecurity(); loadPrefs(); registerSw().catch(() => {}); }, [loadSecurity]);
  useSse('account:security', loadSecurity);

  // ?conversation=ID (bam vao thong bao day)
  useEffect(() => {
    const cid = takeParam('conversation');
    if (cid) { setView('chat'); openConversation(cid); }
  }, [openConversation, setView]);

  useEffect(() => {
    const onNav = e => {
      const d = e.detail || {};
      if (d.view === 'hashtag') setTag(String(d.tag || '').toLowerCase());
      if (d.view === 'settings' && d.tab) setSettingsTab(d.tab);
      if (d.view === 'chat' && d.conversationId) openConversation(d.conversationId);
      setView(d.view);
    };
    window.addEventListener('chatott:navigate', onNav);
    return () => window.removeEventListener('chatott:navigate', onNav);
  }, [setView, openConversation]);

  function render() {
    if (!EXTRA_VIEWS.includes(view)) return null;
    return (
      <main className="friends-area">
        <ErrorBoundary resetKey={view + tag} message="Không hiển thị được trang này.">
          {view === 'settings' && <AccountSettings key={settingsTab} user={user} initialTab={settingsTab} onToast={setToast} onUserChanged={onUserChanged} />}
          {view === 'saved' && <PostListPage mode="saved" user={user} conversations={conversations} onOpenProfile={onOpenProfile} onToast={setToast} />}
          {view === 'hashtag' && <PostListPage mode="hashtag" tag={tag} user={user} conversations={conversations} onOpenProfile={onOpenProfile} onToast={setToast} />}
          {view === 'admin' && (security?.isAdmin ? <AdminPage user={user} onToast={setToast} />
            : <p className="muted pad">Chức năng chỉ dành cho quản trị viên.</p>)}
        </ErrorBoundary>
      </main>
    );
  }

  const overlays = invite ? (
    <JoinInviteDialog code={invite} onToast={setToast} onClose={() => setInvite(null)}
      onJoined={async id => { setInvite(null); setView('chat'); await loadConversations(); openConversation(id); }} />
  ) : null;

  return { security, isAdmin: Boolean(security?.isAdmin), render, overlays };
}
