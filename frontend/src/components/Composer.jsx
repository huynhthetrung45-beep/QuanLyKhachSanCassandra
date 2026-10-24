import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { LoaderCircle, Paperclip, Reply, RotateCw, Send, X, AlertCircle } from 'lucide-react';
import { uploadAttachment, api } from '../api';
import { FileGlyph } from './Attachments';
import { MAX_FILES_PER_MESSAGE, MAX_UPLOAD_BYTES, UPLOAD_EXTENSIONS, fileExt, formatBytes } from '../utils';
import useMentions from '../extensions/useMentions';

const MAX_LEN = 2000;
let seq = 0;

// Khung soan tin: chu + tep dinh kem (chon tep, keo tha, dan anh) + thanh "dang tra loi".
// Tep duoc tai len NGAY khi chon (trang thai PENDING o backend), gui tin chi gan ID tep.
export default function Composer({ ref, conversationId, disabled, replyTo, onCancelReply, onSend, onTyping, members = [], selfId }) {
  const [text, setText] = useState('');
  const [items, setItems] = useState([]); // { key, file, status: uploading|done|error, progress, attachment, error, preview }
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const areaRef = useRef(null);
  const fileRef = useRef(null);
  const uploads = useRef(new Map()); // key -> abort()
  const itemsRef = useRef(items);
  useLayoutEffect(() => { itemsRef.current = items; }, [items]);
  const typingAt = useRef(0);
  const mention = useMentions({ members, selfId, text, setText, areaRef }); // PT-13

  useEffect(() => {
    areaRef.current?.focus();
  }, [conversationId]);

  useEffect(() => {
    if (replyTo) areaRef.current?.focus();
  }, [replyTo]);

  // Roi hoi thoai: huy tep dang tai / chua gui de khong de lai tep mo coi.
  useEffect(() => () => {
    uploads.current.forEach(abort => abort());
    itemsRef.current.forEach(it => {
      if (it.preview) URL.revokeObjectURL(it.preview);
      if (it.status === 'done') api.cancelAttachment(conversationId, it.attachment.attachmentId).catch(() => {});
    });
  }, [conversationId]);

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, [text]);

  const patch = (key, change) => setItems(list => list.map(it => (it.key === key ? { ...it, ...change } : it)));

  function startUpload(item) {
    const { promise, abort } = uploadAttachment(conversationId, item.file, p => patch(item.key, { progress: p }));
    uploads.current.set(item.key, abort);
    promise
      .then(attachment => patch(item.key, { status: 'done', progress: 1, attachment }))
      .catch(err => {
        if (err.name !== 'AbortError') patch(item.key, { status: 'error', error: err.message });
      })
      .finally(() => uploads.current.delete(item.key));
  }

  function addFiles(fileList) {
    const files = [...fileList];
    if (files.length === 0) return;
    const room = MAX_FILES_PER_MESSAGE - itemsRef.current.length;
    const problems = [];
    const accepted = [];
    files.forEach(file => {
      if (accepted.length >= room) { problems.push(`Tối đa ${MAX_FILES_PER_MESSAGE} tệp mỗi tin, bỏ qua "${file.name}".`); return; }
      if (!UPLOAD_EXTENSIONS.includes(fileExt(file.name))) { problems.push(`"${file.name}": định dạng không được hỗ trợ.`); return; }
      if (file.size === 0) { problems.push(`"${file.name}" là tệp rỗng.`); return; }
      if (file.size > MAX_UPLOAD_BYTES) { problems.push(`"${file.name}" lớn hơn ${formatBytes(MAX_UPLOAD_BYTES)}.`); return; }
      accepted.push(file);
    });
    setError(problems.slice(0, 3).join(' '));
    const fresh = accepted.map(file => ({
      key: 'f' + (++seq), file, status: 'uploading', progress: 0, attachment: null, error: '',
      preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null
    }));
    if (fresh.length === 0) return;
    setItems(list => [...list, ...fresh]);
    fresh.forEach(startUpload);
  }

  useImperativeHandle(ref, () => ({ addFiles, focus: () => areaRef.current?.focus(), insertText: t => { setText(t); areaRef.current?.focus(); } }));

  function remove(item) {
    uploads.current.get(item.key)?.();
    if (item.preview) URL.revokeObjectURL(item.preview);
    if (item.status === 'done') api.cancelAttachment(conversationId, item.attachment.attachmentId).catch(() => {});
    setItems(list => list.filter(it => it.key !== item.key));
  }

  function retry(item) {
    patch(item.key, { status: 'uploading', progress: 0, error: '' });
    startUpload(item);
  }

  const uploading = items.some(it => it.status === 'uploading');
  const failed = items.some(it => it.status === 'error');
  const ready = items.filter(it => it.status === 'done');
  const canSend = !sending && !disabled && !uploading && !failed && (text.trim() || ready.length > 0);

  async function submit() {
    const value = text.trim();
    if (!canSend) {
      if (failed) setError('Có tệp tải lên lỗi: thử lại hoặc bỏ tệp đó trước khi gửi.');
      return;
    }
    if (value.length > MAX_LEN) {
      setError(`Tin nhắn dài ${value.length} ký tự, tối đa ${MAX_LEN}.`);
      return;
    }
    setSending(true);
    setError('');
    try {
      await onSend({ content: value, attachmentIds: ready.map(it => it.attachment.attachmentId), mentions: mention.mentionIds(value) });
      setText('');
      mention.reset();
      items.forEach(it => it.preview && URL.revokeObjectURL(it.preview));
      setItems([]);
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
      areaRef.current?.focus();
    }
  }

  function onChange(e) {
    setText(e.target.value);
    if (e.target.value.trim() && Date.now() - typingAt.current > 2500) {
      typingAt.current = Date.now();
      onTyping?.();
    }
  }

  function onKeyDown(e) {
    if (mention.onKeyDown(e)) return;
    // Enter gui, Shift+Enter xuong dong. Bo qua khi dang go bo go tieng Viet (IME).
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape' && replyTo) {
      onCancelReply();
    }
  }

  function onPaste(e) {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files.map((f, i) => (f.name && f.name !== 'image.png'
        ? f
        : new File([f], `anh-dan-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}${i ? '-' + i : ''}.${fileExt(f.name) || 'png'}`, { type: f.type }))));
    }
  }

  const over = text.length > 1800;
  return (
    <div className="composer-wrap">
      {replyTo && (
        <div className="reply-bar">
          <Reply size={16} className="reply-bar-icon" aria-hidden="true" />
          <div className="reply-bar-text">
            <strong>Trả lời {replyTo.senderName}</strong>
            <span>{replyTo.content || (replyTo.attachments?.length ? `[${replyTo.attachments.length} tệp]` : '')}</span>
          </div>
          <button type="button" className="icon-btn small" onClick={onCancelReply} aria-label="Hủy trả lời" title="Hủy trả lời (Esc)">
            <X size={15} />
          </button>
        </div>
      )}

      {items.length > 0 && (
        <ul className="tray" aria-label="Tệp đính kèm chờ gửi">
          {items.map(it => (
            <li key={it.key} className={'tray-item ' + it.status}>
              {it.preview && it.status !== 'error' ? <img src={it.preview} alt="" /> : <span className="tray-glyph"><FileGlyph name={it.file.name} size={20} /></span>}
              <span className="tray-meta">
                <span className="tray-name" title={it.file.name}>{it.file.name}</span>
                <span className="tray-sub">
                  {it.status === 'uploading' && `Đang tải ${Math.round(it.progress * 100)}%`}
                  {it.status === 'done' && formatBytes(it.file.size)}
                  {it.status === 'error' && <><AlertCircle size={12} /> {it.error}</>}
                </span>
                {it.status === 'uploading' && <span className="tray-progress"><span style={{ width: `${Math.round(it.progress * 100)}%` }} /></span>}
              </span>
              {it.status === 'error' && (
                <button type="button" className="icon-btn small" onClick={() => retry(it)} aria-label={'Thử lại ' + it.file.name} title="Thử lại">
                  <RotateCw size={14} />
                </button>
              )}
              <button type="button" className="icon-btn small" onClick={() => remove(it)}
                aria-label={(it.status === 'uploading' ? 'Hủy tải ' : 'Bỏ ') + it.file.name} title={it.status === 'uploading' ? 'Hủy tải lên' : 'Bỏ tệp'}>
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="composer-error" role="alert">{error}</p>}
      {mention.popup}
      <form className="composer" onSubmit={e => { e.preventDefault(); submit(); }}>
        <button type="button" className="icon-btn attach-btn" onClick={() => fileRef.current?.click()} disabled={disabled || items.length >= MAX_FILES_PER_MESSAGE}
          title={`Đính kèm ảnh, video, tệp (tối đa ${MAX_FILES_PER_MESSAGE} tệp, mỗi tệp ${formatBytes(MAX_UPLOAD_BYTES)})`} aria-label="Đính kèm tệp">
          <Paperclip size={20} />
        </button>
        <input ref={fileRef} type="file" multiple hidden accept={UPLOAD_EXTENSIONS.map(e => '.' + e).join(',')}
          onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
        <textarea
          ref={areaRef}
          rows={1}
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={replyTo ? 'Nhập câu trả lời…' : 'Nhập tin nhắn…'}
          aria-label="Nội dung tin nhắn"
          maxLength={MAX_LEN + 200}
        />
        {over && <span className={'counter' + (text.length > MAX_LEN ? ' bad' : '')}>{text.length}/{MAX_LEN}</span>}
        <button type="submit" className="send-btn" disabled={!canSend} aria-label="Gửi tin nhắn"
          title={uploading ? 'Đợi tệp tải lên xong' : 'Gửi (Enter)'}>
          {sending ? <LoaderCircle size={19} className="spin" /> : <Send size={19} />}
        </button>
      </form>
      <p className="composer-hint">Enter để gửi · Shift + Enter xuống dòng · Kéo thả hoặc dán ảnh để đính kèm</p>
    </div>
  );
}
