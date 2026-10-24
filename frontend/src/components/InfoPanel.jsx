import { useCallback, useEffect, useState } from 'react';
import { Copy, Crown, LoaderCircle, LogOut, Pencil, Pin, PinOff, UserMinus, UserPlus, X, Database, Play } from 'lucide-react';
import Avatar from './Avatar';
import ConfirmDialog from './ConfirmDialog';
import UserPicker from './UserPicker';
import { FileCard, Lightbox } from './Attachments';
import { AiTab, AnalyticsTab } from './InsightTabs';
import { api, attachmentUrl } from '../api';
import { formatFull, lastSeenText } from '../utils';
import ConversationManageTab from '../extensions/ConversationManageTab';

// Tab anh/video hoac tep: doc attachments_by_conversation theo partition, 30 muc / trang.
function AttachmentTab({ conversationId, kind, version }) {
  const [items, setItems] = useState([]);
  const [token, setToken] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [image, setImage] = useState(null);

  const load = useCallback(async pageToken => {
    setState('loading');
    try {
      const page = await api.attachments(conversationId, kind, pageToken);
      setItems(list => (pageToken ? [...list, ...page.items] : page.items));
      setToken(page.nextPageToken);
      setState('ready');
    } catch (err) {
      setError(err.message);
      setState('error');
    }
  }, [conversationId, kind]);

  useEffect(() => { load(null); }, [load, version]);

  if (state === 'error') return <p className="error-text pad">{error}</p>;
  return (
    <div className="attach-tab">
      {state === 'ready' && items.length === 0 && (
        <p className="muted pad">{kind === 'media' ? 'Chưa có ảnh hoặc video nào được gửi.' : 'Chưa có tệp nào được gửi.'}</p>
      )}
      {kind === 'media' ? (
        <div className="media-wall">
          {items.map(a => (a.kind === 'IMAGE' ? (
            <button key={a.attachmentId} type="button" onClick={() => setImage(a)} aria-label={'Xem ảnh ' + a.fileName} title={a.fileName}>
              <img src={attachmentUrl(conversationId, a.attachmentId, true)} alt={a.fileName} loading="lazy" />
            </button>
          ) : (
            <a key={a.attachmentId} className="wall-video" href={attachmentUrl(conversationId, a.attachmentId, true)} target="_blank" rel="noreferrer" title={a.fileName}>
              <Play size={22} /><span>{a.fileName}</span>
            </a>
          )))}
        </div>
      ) : (
        <div className="file-list">
          {items.map(f => <FileCard key={f.attachmentId} conversationId={conversationId} file={f} compact />)}
        </div>
      )}
      {state === 'loading' && <p className="muted pad"><LoaderCircle size={14} className="spin" /> Đang tải…</p>}
      {state === 'ready' && token && (
        <div className="pad"><button type="button" className="btn secondary small block-sm" onClick={() => load(token)}>Xem thêm</button></div>
      )}
      {image && <Lightbox conversationId={conversationId} image={image} onClose={() => setImage(null)} />}
    </div>
  );
}

function MemberStatus({ member, self }) {
  if (self) return null;
  if (member.online) return <span className="member-sub online">Đang hoạt động</span>;
  if (member.lastSeenAt) return <span className="member-sub">{lastSeenText(member.lastSeenAt)}</span>;
  return null;
}

export default function InfoPanel({ user, conversation, mediaVersion = 0, statsVersion = 0, onJumpToMessage, onOpenProfile, onClose, onTogglePin, onChanged, onLeft, onToast }) {
  const id = conversation.conversationId;
  const [tab, setTab] = useState('info');
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [stats, setStats] = useState(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [toAdd, setToAdd] = useState([]);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.conversation(id);
      setDetail(data);
      setName(data.conversationName);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [id]);

  useEffect(() => {
    load();
    api.stats(id).then(setStats).catch(() => setStats(null));
  }, [id, load]);

  async function run(action, success) {
    setBusy(true);
    try {
      const result = await action();
      if (result && result.members) setDetail(result);
      if (success) onToast(success);
      onChanged();
      return result;
    } catch (err) {
      onToast(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveName(e) {
    e.preventDefault();
    if (!name.trim() || name.trim() === detail.conversationName) {
      setEditing(false);
      return;
    }
    const ok = await run(() => api.renameGroup(id, name.trim()), 'Đã đổi tên nhóm.');
    if (ok) setEditing(false);
  }

  async function addSelected() {
    const ok = await run(() => api.addMembers(id, toAdd.map(u => u.userId)), `Đã thêm ${toAdd.length} thành viên.`);
    if (ok) {
      setAdding(false);
      setToAdd([]);
    }
  }

  async function confirmAction() {
    const { type, member } = confirm;
    setConfirm(null);
    if (type === 'leave') {
      const ok = await run(() => api.removeMember(id, user.userId));
      if (ok) onLeft();
    } else {
      await run(() => api.removeMember(id, member.userId), `Đã xóa ${member.displayName} khỏi nhóm.`);
    }
  }

  function copyId() {
    navigator.clipboard?.writeText(id).then(
      () => onToast('Đã sao chép mã hội thoại.'),
      () => onToast('Không sao chép được, hãy chọn và sao chép thủ công.')
    );
  }

  const isGroup = conversation.conversationType === 'GROUP';

  return (
    <aside className="info" aria-label="Thông tin hội thoại">
      <div className="info-head">
        <h3>Thông tin hội thoại</h3>
        <button type="button" className="icon-btn ghost" onClick={onClose} aria-label="Đóng thông tin"><X size={18} /></button>
      </div>

      <div className="filters info-tabs" role="tablist" aria-label="Nội dung hội thoại">
        {[['info', 'Thông tin'], ['media', 'Ảnh'], ['file', 'Tệp'], ['stats', 'Thống kê'], ['ai', 'AI'], ['manage', 'Quản lý']].map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'on' : ''} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {(tab === 'media' || tab === 'file') && (
        <div className="info-scroll"><AttachmentTab conversationId={id} kind={tab} version={mediaVersion} /></div>
      )}
      {tab === 'stats' && <div className="info-scroll"><AnalyticsTab conversationId={id} version={statsVersion} /></div>}
      {tab === 'ai' && <div className="info-scroll"><AiTab conversationId={id} onJumpToMessage={onJumpToMessage} onToast={onToast} /></div>}

      {tab === 'manage' && (
        <ConversationManageTab conversation={conversation} user={user} members={detail?.members || []} onToast={onToast}
          onChanged={() => { load(); onChanged(); }} />
      )}
      {tab === 'info' && error && <p className="error-text pad">{error}</p>}
      {tab === 'info' && !detail && !error && <p className="muted pad"><LoaderCircle size={15} className="spin" /> Đang tải…</p>}

      {tab === 'info' && detail && (
        <div className="info-scroll">
          <div className="info-hero">
            <Avatar name={detail.displayName} seed={id} group={isGroup} size={76} />
            {editing ? (
              <form className="rename" onSubmit={saveName}>
                <input value={name} onChange={e => setName(e.target.value)} maxLength={80} autoFocus aria-label="Tên nhóm mới" />
                <button type="submit" className="btn primary small" disabled={busy}>Lưu</button>
                <button type="button" className="btn secondary small" onClick={() => { setEditing(false); setName(detail.conversationName); }}>Hủy</button>
              </form>
            ) : (
              <h4>
                {detail.displayName}
                {isGroup && detail.canRename && (
                  <button type="button" className="icon-btn ghost small" onClick={() => setEditing(true)} aria-label="Đổi tên nhóm" title="Đổi tên nhóm">
                    <Pencil size={14} />
                  </button>
                )}
              </h4>
            )}
            <p className="muted">{isGroup ? `Nhóm · ${detail.members.length} thành viên` : 'Trò chuyện cá nhân'}</p>
          </div>

          <div className="info-actions">
            <button type="button" className="tile" onClick={onTogglePin}>
              {conversation.pinned ? <PinOff size={18} /> : <Pin size={18} />}
              <span>{conversation.pinned ? 'Bỏ ghim' : 'Ghim'}</span>
            </button>
            {isGroup && (
              <button type="button" className="tile" onClick={() => setAdding(v => !v)}>
                <UserPlus size={18} /><span>Thêm người</span>
              </button>
            )}
            {isGroup && (
              <button type="button" className="tile danger" onClick={() => setConfirm({ type: 'leave' })}>
                <LogOut size={18} /><span>Rời nhóm</span>
              </button>
            )}
          </div>

          {adding && (
            <section className="info-section">
              <h5>Thêm thành viên</h5>
              <UserPicker selected={toAdd} onChange={setToAdd} excludeIds={detail.participantIds} />
              <div className="dialog-actions">
                <button type="button" className="btn secondary small" onClick={() => { setAdding(false); setToAdd([]); }}>Hủy</button>
                <button type="button" className="btn primary small" disabled={toAdd.length === 0 || busy} onClick={addSelected}>
                  Thêm {toAdd.length > 0 ? toAdd.length : ''}
                </button>
              </div>
            </section>
          )}

          {isGroup && (
            <section className="info-section">
              <h5>Thành viên ({detail.members.length})</h5>
              {detail.ownerKnown === false && (
                <p className="muted owner-note">Nhóm này chưa có trưởng nhóm nên không ai đổi tên nhóm hay xóa được thành viên. Bạn vẫn có thể thêm người hoặc tự rời nhóm.</p>
              )}
              <ul className="members">
                {detail.members.map(m => (
                  <li key={m.userId}>
                    <Avatar name={m.displayName} seed={m.userId} size={36} online={m.online && m.userId !== user.userId} />
                    <span className="member-name">
                      <button type="button" className="link-btn member-link" onClick={() => onOpenProfile?.(m.userId)} title="Xem hồ sơ">
                        {m.displayName}
                      </button>{m.userId === user.userId ? ' (bạn)' : ''}
                      {detail.createdBy === m.userId && <span className="owner"><Crown size={12} /> Trưởng nhóm</span>}
                      <MemberStatus member={m} self={m.userId === user.userId} />
                    </span>
                    {detail.canManageMembers && m.userId !== user.userId && (
                      <button type="button" className="icon-btn ghost small" title={'Xóa ' + m.displayName + ' khỏi nhóm'}
                        aria-label={'Xóa ' + m.displayName + ' khỏi nhóm'} onClick={() => setConfirm({ type: 'remove', member: m })}>
                        <UserMinus size={15} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {!isGroup && (
            <section className="info-section">
              <h5>Thành viên</h5>
              <ul className="members">
                {detail.members.map(m => (
                  <li key={m.userId}>
                    <Avatar name={m.displayName} seed={m.userId} size={36} online={m.online && m.userId !== user.userId} />
                    <span className="member-name">
                      <button type="button" className="link-btn member-link" onClick={() => onOpenProfile?.(m.userId)} title="Xem hồ sơ">
                        {m.displayName}
                      </button>{m.userId === user.userId ? ' (bạn)' : ''}
                      <MemberStatus member={m} self={m.userId === user.userId} />
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="info-section tech">
            <h5><Database size={14} /> Lưu trữ trên Cassandra</h5>
            <dl>
              <dt>Mã hội thoại (partition key)</dt>
              <dd>
                <code>{id}</code>
                <button type="button" className="icon-btn ghost small" onClick={copyId} aria-label="Sao chép mã hội thoại" title="Sao chép">
                  <Copy size={13} />
                </button>
              </dd>
              <dt>Số tin trong partition</dt>
              <dd>{stats ? `${stats.messageCount} tin (đếm trong ${stats.queryTimeMs} ms)` : '—'}</dd>
              <dt>Tạo lúc</dt>
              <dd>{detail.createdAt ? formatFull(detail.createdAt) : '—'}</dd>
            </dl>
          </section>
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.type === 'leave' ? 'Rời nhóm này?' : `Xóa ${confirm.member.displayName}?`}
          message={confirm.type === 'leave'
            ? 'Bạn sẽ không nhận và không đọc được tin nhắn của nhóm nữa, trừ khi được thêm lại.'
            : 'Người này sẽ không còn đọc hoặc gửi tin trong nhóm.'}
          confirmLabel={confirm.type === 'leave' ? 'Rời nhóm' : 'Xóa khỏi nhóm'}
          danger
          onConfirm={confirmAction}
          onCancel={() => setConfirm(null)}
        />
      )}
    </aside>
  );
}
