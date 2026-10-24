import { memo, useEffect, useRef, useState } from 'react';
import { Ellipsis, Forward, Reply, SmilePlus } from 'lucide-react';
import Avatar from './Avatar';
import { MessageAttachments } from './Attachments';
import SharedPostPreview from './SharedPostPreview';
import { REACTIONS, formatClock, formatFull } from '../utils';
import { ExtraBody, ExtraFooter, replacesText } from '../extensions/MessageExtras';

export function ReactionPicker({ current, onPick, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const onDown = e => !ref.current?.contains(e.target) && onClose();
    const onKey = e => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector('button')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div className="reaction-picker" ref={ref} role="menu" aria-label="Chọn cảm xúc">
      {REACTIONS.map(e => (
        <button key={e} type="button" role="menuitem" className={e === current ? 'on' : ''} onClick={() => onPick(e === current ? null : e)}
          aria-label={e === current ? `Gỡ cảm xúc ${e}` : `Thả ${e}`}>
          {e}
        </button>
      ))}
    </div>
  );
}

function ReplyQuote({ replyTo, onJump }) {
  let body;
  if (!replyTo.available) body = <em>Tin nhắn gốc không còn khả dụng</em>;
  else if (replyTo.isDeleted) body = <em>Tin nhắn đã được thu hồi</em>;
  else body = replyTo.excerpt || (replyTo.attachmentCount ? `[${replyTo.attachmentCount} tệp đính kèm]` : '');
  const clickable = replyTo.available;
  return (
    <button type="button" className="reply-quote" onClick={() => clickable && onJump(replyTo)} disabled={!clickable}
      title={clickable ? 'Đi tới tin nhắn gốc' : undefined}>
      {replyTo.available && <strong>{replyTo.senderName}</strong>}
      <span>{body}</span>
    </button>
  );
}

function MessageItem({
  m, mine, isGroup, joinsPrev, joinsNext, conversationId, userId, memberNames, highlighted, status,
  onReply, onReact, onMenu, onJump, onOpenImage, onOpenProfile
}) {
  const [picker, setPicker] = useState(false);
  const myReaction = m.reactions.find(r => r.userIds.includes(userId))?.emoji || null;
  const canAct = !m.isDeleted;
  const hasText = Boolean(m.content);
  const onlyMedia = !hasText && !m.replyTo && m.attachments.length > 0 && m.attachments.every(a => a.kind !== 'FILE');

  function openMenu(e) {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.type === 'contextmenu' ? e.clientX : rect.left;
    const y = e.type === 'contextmenu' ? e.clientY : rect.bottom + 4;
    onMenu(m, x, y);
  }

  return (
    <div id={'msg-' + m.messageId}
      className={'msg-row ' + (mine ? 'mine' : 'theirs') + (joinsPrev ? ' joined' : '') + (highlighted ? ' flash' : '')}>
      {!mine && (
        <div className="msg-avatar">
          {!joinsNext && <Avatar name={m.senderName} seed={m.senderId} size={32} />}
        </div>
      )}
      <div className="msg-stack">
        {!mine && isGroup && !joinsPrev && <span className="msg-sender">{m.senderName}</span>}
        <div className="bubble-line">
          <div className={'bubble' + (m.isDeleted ? ' recalled' : '') + (onlyMedia ? ' media-only' : '')}
            title={formatFull(m.createdAt)} onContextMenu={openMenu}>
            {m.isDeleted ? (
              <span className="recalled-text">Tin nhắn đã được thu hồi</span>
            ) : (
              <>
                {m.forwarded && <span className="forwarded"><Forward size={12} /> Đã chuyển tiếp</span>}
                {m.replyTo && <ReplyQuote replyTo={m.replyTo} onJump={onJump} />}
                {m.attachments.length > 0 && (
                  <MessageAttachments conversationId={conversationId} attachments={m.attachments} onOpenImage={onOpenImage} />
                )}
                {m.sharedPostId && <SharedPostPreview postId={m.sharedPostId} onOpenPost={onOpenProfile} />}
                <ExtraBody m={m} conversationId={conversationId} userId={userId} memberNames={memberNames} />
                {hasText && !replacesText(m) && <span className="msg-text">{m.content}</span>}
                <ExtraFooter m={m} userId={userId} />
              </>
            )}
            {!joinsNext && <time className="msg-time" dateTime={m.createdAt}>{formatClock(m.createdAt)}</time>}
          </div>

          <div className={'msg-actions' + (picker ? ' open' : '')}>
            {canAct && (
              <span className="picker-anchor">
                <button type="button" className="icon-btn small" onClick={() => setPicker(v => !v)} title="Thả cảm xúc" aria-label="Thả cảm xúc"
                  aria-expanded={picker}>
                  <SmilePlus size={16} />
                </button>
                {picker && (
                  <ReactionPicker current={myReaction} onClose={() => setPicker(false)}
                    onPick={emoji => { setPicker(false); onReact(m, emoji); }} />
                )}
              </span>
            )}
            {canAct && (
              <button type="button" className="icon-btn small" onClick={() => onReply(m)} title="Trả lời" aria-label="Trả lời">
                <Reply size={16} />
              </button>
            )}
            <button type="button" className="icon-btn small" onClick={openMenu} title="Thêm" aria-label="Thêm thao tác" aria-haspopup="menu">
              <Ellipsis size={16} />
            </button>
          </div>
        </div>

        {m.reactions.length > 0 && (
          <div className="reactions">
            {m.reactions.map(r => {
              const names = r.userIds.map(id => (id === userId ? 'Bạn' : memberNames.get(id) || 'Thành viên cũ')).join(', ');
              const mineR = r.userIds.includes(userId);
              return (
                <button key={r.emoji} type="button" className={'reaction' + (mineR ? ' mine' : '')} title={names}
                  aria-label={`${r.emoji} ${r.count}: ${names}${mineR ? '. Bấm để gỡ' : ''}`}
                  onClick={() => onReact(m, mineR ? null : r.emoji)}>
                  <span>{r.emoji}</span>{r.count > 1 && <span className="reaction-count">{r.count}</span>}
                </button>
              );
            })}
          </div>
        )}
        {status && <span className="msg-status">{status}</span>}
      </div>
    </div>
  );
}

export default memo(MessageItem);
