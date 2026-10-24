import { useEffect, useMemo, useState } from 'react';
import { Check, LoaderCircle, MessageCircle, Newspaper, Search, Send, X } from 'lucide-react';
import Avatar from './Avatar';
import { PrivacySelect } from './PostBits';
import { api } from '../api';
import { fold } from '../utils';

// Chia se bai: len bang tin cua minh (bai moi tham chieu bai goc) hoac vao 1 cuoc tro chuyen (tin tham chieu bai).
export default function ShareDialog({ post, conversations, onClose, onShared, onSharedOnce, onToast }) {
  const [tab, setTab] = useState('feed');
  const [text, setText] = useState('');
  const [privacy, setPrivacy] = useState('FRIENDS');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [sent, setSent] = useState({});
  const original = post.shared?.available ? post.shared.post : post;

  useEffect(() => {
    const onKey = e => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shown = useMemo(() => {
    const q = fold(query);
    return conversations.filter(c => !q || fold(c.displayName).includes(q));
  }, [conversations, query]);

  async function toFeed() {
    setBusy(true);
    try {
      const p = await api.sharePost(post.postId, { content: text.trim() || undefined, privacy });
      onShared?.(p);
      onSharedOnce?.();
      onToast('Đã chia sẻ lên bảng tin của bạn.');
      onClose();
    } catch (err) {
      onToast(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function toChat(c) {
    setSent(s => ({ ...s, [c.conversationId]: 'sending' }));
    try {
      await api.sendMessage(c.conversationId, { content: text.trim() || undefined, sharedPostId: post.postId });
      setSent(s => ({ ...s, [c.conversationId]: 'sent' }));
      onSharedOnce?.();
    } catch (err) {
      setSent(s => ({ ...s, [c.conversationId]: null }));
      onToast(err.message);
    }
  }

  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="share-title">
        <div className="dialog-head">
          <h3 id="share-title">Chia sẻ bài viết</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Đóng"><X size={18} /></button>
        </div>
        <div className="filters share-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'feed'} className={tab === 'feed' ? 'on' : ''} onClick={() => setTab('feed')}>
            <Newspaper size={15} /> Lên bảng tin
          </button>
          <button type="button" role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
            <MessageCircle size={15} /> Gửi vào chat
          </button>
        </div>
        <blockquote className="fw-preview">
          <strong>{original.author.displayName}</strong>: {original.content || (original.media.length ? `[${original.media.length} ảnh]` : '')}
        </blockquote>
        <textarea className="profile-bio-input" rows={2} maxLength={tab === 'feed' ? 5000 : 2000} value={text}
          onChange={e => setText(e.target.value)} placeholder="Nói gì đó về bài viết này (không bắt buộc)" aria-label="Lời dẫn" />
        {tab === 'feed' ? (
          <div className="dialog-actions">
            <PrivacySelect value={privacy} onChange={setPrivacy} />
            <span className="pc-spacer" />
            <button type="button" className="btn secondary" onClick={onClose}>Hủy</button>
            <button type="button" className="btn primary" onClick={toFeed} disabled={busy}>
              {busy && <LoaderCircle size={15} className="spin" />} Chia sẻ ngay
            </button>
          </div>
        ) : (
          <>
            <div className="search boxed" style={{ marginTop: 10 }}>
              <Search size={16} aria-hidden="true" />
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Tìm cuộc trò chuyện" aria-label="Tìm cuộc trò chuyện" />
            </div>
            <ul className="picker-list">
              {shown.map(c => {
                const st = sent[c.conversationId];
                return (
                  <li key={c.conversationId} className="fw-row">
                    <Avatar name={c.displayName} seed={c.conversationId} group={c.conversationType === 'GROUP'} size={34} />
                    <span className="person-name">{c.displayName}</span>
                    <button type="button" className={'btn small ' + (st === 'sent' ? 'secondary' : 'primary')} disabled={Boolean(st)} onClick={() => toChat(c)}>
                      {st === 'sending' ? <LoaderCircle size={14} className="spin" /> : st === 'sent' ? <><Check size={14} /> Đã gửi</> : <><Send size={14} /> Gửi</>}
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="muted small-note">Người nhận chỉ xem được bài nếu quyền riêng tư của bài cho phép.</p>
          </>
        )}
      </div>
    </div>
  );
}
