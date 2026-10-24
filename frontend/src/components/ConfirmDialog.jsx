import { useEffect, useRef } from 'react';

export default function ConfirmDialog({ title, message, confirmLabel = 'Đồng ý', cancelLabel = 'Hủy', danger = false, busy = false, error = '', onConfirm, onCancel }) {
  const confirmRef = useRef(null);
  // Bo qua cu bam ra ngoai ngay sau khi mo (bam dup / bam lien tuc vao nut mo hop thoai).
  const openedAt = useRef(0);
  useEffect(() => { openedAt.current = Date.now(); }, []);
  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = e => e.key === 'Escape' && onCancel();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && Date.now() - openedAt.current > 400 && onCancel()}>
      <div className="dialog small" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <h3 id="confirm-title">{title}</h3>
        <p>{message}</p>
        {error && <p className="error-text" role="alert" style={{ marginTop: 10 }}>{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn secondary" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
          <button type="button" ref={confirmRef} className={'btn ' + (danger ? 'danger' : 'primary')} onClick={onConfirm} disabled={busy}>
            {busy ? 'Đang xử lý…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
