import { useState } from 'react';
import { Ban, Check, LoaderCircle, MessageCircle, UserCheck, UserMinus, UserPlus, UserX, X } from 'lucide-react';
import ConfirmDialog from './ConfirmDialog';
import { api } from '../api';

// Nut thao tac theo trang thai quan he do BACKEND tra ve (SELF | NONE | FRIENDS | OUTGOING | INCOMING | BLOCKED).
// Moi thao tac goi API roi lay trang thai moi tu ket qua, khong tu suy doan.
export default function RelationActions({ userId, displayName, relationship, onChanged, onMessage, onToast, compact = false }) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);

  async function run(action, success) {
    setBusy(true);
    try {
      const res = await action();
      if (success) onToast?.(success);
      onChanged?.(res?.status === 'OUTGOING' || res?.status === 'FRIENDS' || res?.status === 'BLOCKED' ? res.status : 'NONE');
    } catch (err) {
      onToast?.(err.message);
      onChanged?.(null);
    } finally {
      setBusy(false);
    }
  }

  if (relationship === 'SELF') return null;
  const size = compact ? 15 : 16;
  const cls = 'btn small ' + (compact ? 'secondary' : 'secondary');

  const buttons = [];
  if (relationship === 'NONE') {
    buttons.push(<button key="add" type="button" className="btn small primary" disabled={busy}
      onClick={() => run(() => api.sendFriendRequest(userId), 'Đã gửi lời mời kết bạn.')}><UserPlus size={size} /> Kết bạn</button>);
  }
  if (relationship === 'OUTGOING') {
    buttons.push(<button key="cancel" type="button" className={cls} disabled={busy}
      onClick={() => run(() => api.cancelFriendRequest(userId), 'Đã hủy lời mời.')}><X size={size} /> Hủy lời mời</button>);
  }
  if (relationship === 'INCOMING') {
    buttons.push(<button key="accept" type="button" className="btn small primary" disabled={busy}
      onClick={() => run(() => api.acceptFriend(userId), `Bạn và ${displayName} đã là bạn bè.`)}><Check size={size} /> Chấp nhận</button>);
    buttons.push(<button key="decline" type="button" className={cls} disabled={busy}
      onClick={() => run(() => api.declineFriend(userId), 'Đã từ chối lời mời.')}><UserX size={size} /> Từ chối</button>);
  }
  if (relationship === 'FRIENDS') {
    buttons.push(<span key="f" className="rel-badge"><UserCheck size={14} /> Bạn bè</span>);
    if (!compact) {
      buttons.push(<button key="unfriend" type="button" className={cls} disabled={busy}
        onClick={() => setConfirm('unfriend')}><UserMinus size={size} /> Hủy kết bạn</button>);
    }
  }
  if (relationship !== 'BLOCKED' && onMessage) {
    buttons.push(<button key="msg" type="button" className={cls} disabled={busy} onClick={() => onMessage(userId)}>
      <MessageCircle size={size} /> Nhắn tin</button>);
  }
  if (relationship === 'BLOCKED') {
    buttons.push(<button key="unblock" type="button" className={cls} disabled={busy}
      onClick={() => run(() => api.unblock(userId), `Đã bỏ chặn ${displayName}.`)}><Ban size={size} /> Bỏ chặn</button>);
  } else if (!compact) {
    buttons.push(<button key="block" type="button" className="btn small secondary danger-text" disabled={busy}
      onClick={() => setConfirm('block')}><Ban size={size} /> Chặn</button>);
  }

  return (
    <div className="rel-actions">
      {buttons}
      {busy && <LoaderCircle size={15} className="spin" />}
      {confirm && (
        <ConfirmDialog
          title={confirm === 'block' ? `Chặn ${displayName}?` : `Hủy kết bạn với ${displayName}?`}
          message={confirm === 'block'
            ? 'Hai bạn sẽ không gửi được lời mời kết bạn hay tin nhắn 1-1 cho nhau. Lời mời và quan hệ bạn bè hiện có bị hủy. Lịch sử chat cũ vẫn giữ nguyên.'
            : 'Lịch sử trò chuyện giữa hai bạn vẫn được giữ nguyên.'}
          confirmLabel={confirm === 'block' ? 'Chặn' : 'Hủy kết bạn'}
          danger
          onConfirm={() => {
            const c = confirm;
            setConfirm(null);
            if (c === 'block') run(() => api.block(userId), `Đã chặn ${displayName}.`);
            else run(() => api.unfriend(userId), 'Đã hủy kết bạn.');
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
