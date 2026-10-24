import { useEffect } from 'react';
import { Download, FileArchive, FileSpreadsheet, FileText, File as FileIcon, X } from 'lucide-react';
import { attachmentUrl } from '../api';
import { fileExt, formatBytes } from '../utils';

export function FileGlyph({ name, size = 22 }) {
  const ext = fileExt(name);
  if (ext === 'zip') return <FileArchive size={size} />;
  if (ext === 'xlsx') return <FileSpreadsheet size={size} />;
  if (ext === 'pdf' || ext === 'docx' || ext === 'txt') return <FileText size={size} />;
  return <FileIcon size={size} />;
}

export function FileCard({ conversationId, file, compact = false }) {
  const ext = fileExt(file.fileName);
  return (
    <a
      className={'file-card' + (compact ? ' compact' : '')}
      href={attachmentUrl(conversationId, file.attachmentId)}
      download={file.fileName}
      title={'Tải xuống ' + file.fileName}
    >
      <span className={'file-glyph ext-' + ext}><FileGlyph name={file.fileName} /></span>
      <span className="file-meta">
        <span className="file-name">{file.fileName}</span>
        <span className="file-size">{ext.toUpperCase()} · {formatBytes(file.size)}</span>
      </span>
      <Download size={17} className="file-dl" aria-hidden="true" />
    </a>
  );
}

// Tep trong bong bong tin: anh/video dang luoi, tep thuong dang the.
export function MessageAttachments({ conversationId, attachments, onOpenImage }) {
  const media = attachments.filter(a => a.kind === 'IMAGE' || a.kind === 'VIDEO');
  const files = attachments.filter(a => a.kind === 'FILE');
  const audios = attachments.filter(a => a.kind === 'AUDIO'); // PT-12 tin nhan thoai
  return (
    <div className="msg-files">
      {media.length > 0 && (
        <div className={'media-grid n' + Math.min(media.length, 4)}>
          {media.map(a => (a.kind === 'IMAGE' ? (
            <button key={a.attachmentId} type="button" className="media-cell" onClick={() => onOpenImage(a)} aria-label={'Xem ảnh ' + a.fileName}>
              <img src={attachmentUrl(conversationId, a.attachmentId, true)} alt={a.fileName} loading="lazy" />
            </button>
          ) : (
            <div key={a.attachmentId} className="media-cell video">
              <video src={attachmentUrl(conversationId, a.attachmentId, true)} controls preload="metadata" aria-label={a.fileName} />
            </div>
          )))}
        </div>
      )}
      {audios.map(a => (
        <audio key={a.attachmentId} className="ext-audio" controls preload="metadata" src={attachmentUrl(conversationId, a.attachmentId)} aria-label={a.fileName} />
      ))}
      {files.map(f => <FileCard key={f.attachmentId} conversationId={conversationId} file={f} />)}
    </div>
  );
}

export function Lightbox({ conversationId, image, onClose }) {
  useEffect(() => {
    const onKey = e => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={image.fileName}
      onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="lightbox-bar">
        <span>{image.fileName} · {formatBytes(image.size)}</span>
        <a className="icon-btn" href={attachmentUrl(conversationId, image.attachmentId)} download={image.fileName} title="Tải xuống" aria-label="Tải xuống">
          <Download size={19} />
        </a>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Đóng"><X size={20} /></button>
      </div>
      <img src={attachmentUrl(conversationId, image.attachmentId, true)} alt={image.fileName} />
    </div>
  );
}
