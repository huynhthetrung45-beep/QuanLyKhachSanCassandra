// Phan bo sung trong bong bong tin: PT-06 nhan "da chinh sua", PT-13 nhac ten, PT-20 binh chon,
// PT-21 sticker + xem truoc lien ket, PT-12 thoi luong tin thoai. Va dong bo realtime cho ChatWindow.
import { useEffect, useState } from 'react';
import { AtSign, BarChart3, Check, ExternalLink, Lock } from 'lucide-react';
import { ext } from './extApi';
import { useSse } from './sse';
import { formatFull } from '../utils';

function Poll({ conversationId, poll: initial, userId, memberNames }) {
  const [poll, setPoll] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setPoll(initial); }, [initial]);
  useSse('poll:updated', d => {
    if (d.pollId === poll.pollId) ext.poll(conversationId, poll.pollId).then(setPoll).catch(() => {});
  });
  const max = Math.max(1, ...poll.options.map(o => o.count));
  async function pick(index) {
    if (poll.closed || busy) return;
    const mine = poll.myChoices || [];
    const next = poll.multiple ? (mine.includes(index) ? mine.filter(i => i !== index) : [...mine, index]) : (mine.includes(index) ? [] : [index]);
    setBusy(true);
    try { setPoll(await ext.vote(conversationId, poll.pollId, next)); } catch { /* giu ket qua cu */ } finally { setBusy(false); }
  }
  async function close() {
    try { setPoll(await ext.closePoll(conversationId, poll.pollId)); } catch { /* bo qua */ }
  }
  return (
    <div className="ext-poll" role="group" aria-label={'Bình chọn: ' + poll.question}>
      <div className="ext-poll-q"><BarChart3 size={16} /> <strong>{poll.question}</strong></div>
      <ul>
        {poll.options.map(o => {
          const mine = (poll.myChoices || []).includes(o.index);
          const names = o.voters.map(id => (id === userId ? 'Bạn' : memberNames?.get(id) || 'Thành viên')).join(', ');
          return (
            <li key={o.index}>
              <button type="button" className={'ext-poll-opt' + (mine ? ' mine' : '')} onClick={() => pick(o.index)} disabled={poll.closed}
                title={names || 'Chưa có ai chọn'} aria-pressed={mine}>
                <span className="ext-poll-bar" style={{ width: `${(o.count / max) * 100}%` }} />
                <span className="ext-poll-text">{mine && <Check size={14} />} {o.text}</span>
                <span className="ext-poll-count">{o.count}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="ext-poll-foot">
        <span>{poll.totalVoters} người đã bình chọn{poll.multiple ? ' · chọn nhiều' : ''}{poll.closed ? ' · đã kết thúc' : ''}</span>
        {!poll.closed && poll.createdBy === userId && <button type="button" className="link-btn" onClick={close}><Lock size={12} /> Kết thúc</button>}
      </div>
    </div>
  );
}

export function StickerView({ sticker }) {
  return (
    <div className="ext-sticker" role="img" aria-label={'Sticker ' + sticker.label}>
      <span className="ext-sticker-emoji">{sticker.emoji}</span>
      <span className="ext-sticker-label">{sticker.label}</span>
    </div>
  );
}

// Noi dung chinh thay cho van ban thay the (sticker / binh chon). Tra null neu khong co extra.
export function ExtraBody({ m, conversationId, userId, memberNames }) {
  const x = m.extra;
  if (!x || m.isDeleted) return null;
  if (x.sticker) return <StickerView sticker={x.sticker} />;
  if (x.poll) return <Poll conversationId={conversationId} poll={x.poll} userId={userId} memberNames={memberNames} />;
  return null;
}

export const replacesText = m => Boolean(m.extra && !m.isDeleted && (m.extra.sticker || m.extra.poll));

export function ExtraFooter({ m, userId }) {
  const x = m.extra;
  if (!x || m.isDeleted) return null;
  return (
    <>
      {x.link && (
        <a className="ext-link" href={x.link.url} target="_blank" rel="noopener noreferrer nofollow">
          {x.link.image && <img src={x.link.image} alt="" loading="lazy" referrerPolicy="no-referrer" />}
          <span className="ext-link-body">
            <span className="ext-link-site">{x.link.site} <ExternalLink size={11} /></span>
            {x.link.title && <strong>{x.link.title}</strong>}
            {x.link.description && <span className="ext-link-desc">{x.link.description}</span>}
          </span>
        </a>
      )}
      {x.mentions?.includes(userId) && <span className="ext-mention-badge"><AtSign size={12} /> Nhắc đến bạn</span>}
      {x.editedAt && <span className="ext-edited" title={'Sửa lúc ' + formatFull(x.editedAt)}>đã chỉnh sửa</span>}
    </>
  );
}

// Dong bo realtime: sua tin, extra moi (nhac ten, link, binh chon), tin duoc khoi phuc.
export function useMessageExtrasSync(conversationId, setMessages, resync) {
  useSse(['message:extra', 'message:edited', 'message:restored'], (d, name) => {
    if (d.conversationId !== conversationId) return;
    if (name === 'message:restored') { resync?.(); return; }
    setMessages(list => list.map(m => (m.messageId !== d.messageId ? m
      : { ...m, ...(name === 'message:edited' ? { content: d.content } : {}), extra: d.extra || m.extra })));
  });
}
