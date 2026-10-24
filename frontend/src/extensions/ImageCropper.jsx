// PT-04: cat khung anh truoc khi tai len (keo de di chuyen, thanh truot de phong to). Xuat JPEG.
import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, X } from 'lucide-react';

export default function ImageCropper({ file, aspect = 1, outWidth = 512, title = 'Cắt ảnh', onCancel, onDone }) {
  const [img, setImg] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const drag = useRef(null);
  const boxW = 320;
  const boxH = Math.round(boxW / aspect);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => setImg(image);
    image.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Ti le co ban: anh phu kin khung.
  const base = img ? Math.max(boxW / img.width, boxH / img.height) : 1;
  const scale = base * zoom;
  const w = img ? img.width * scale : 0;
  const h = img ? img.height * scale : 0;
  const clamp = p => ({
    x: Math.min(0, Math.max(boxW - w, p.x)),
    y: Math.min(0, Math.max(boxH - h, p.y))
  });
  useEffect(() => {
    if (img) setPos(p => clamp(p.x === 0 && p.y === 0 ? { x: (boxW - w) / 2, y: (boxH - h) / 2 } : p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, zoom]);

  function down(e) {
    drag.current = { x: e.clientX, y: e.clientY, start: pos };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }
  function move(e) {
    if (!drag.current) return;
    setPos(clamp({ x: drag.current.start.x + e.clientX - drag.current.x, y: drag.current.start.y + e.clientY - drag.current.y }));
  }

  async function confirm() {
    setBusy(true);
    const outH = Math.round(outWidth / aspect);
    const canvas = document.createElement('canvas');
    canvas.width = outWidth;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    const k = outWidth / boxW;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, outWidth, outH);
    ctx.drawImage(img, pos.x * k, pos.y * k, w * k, h * k);
    canvas.toBlob(blob => { setBusy(false); onDone(blob); }, 'image/jpeg', 0.9);
  }

  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onCancel()}>
      <div className="dialog ext-cropper" role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-head"><h3>{title}</h3>
          <button type="button" className="icon-btn ghost" onClick={onCancel} aria-label="Đóng"><X size={18} /></button></div>
        <div className={'ext-crop-box' + (aspect === 1 ? ' round' : '')} style={{ width: boxW, height: boxH }}
          onPointerDown={down} onPointerMove={move} onPointerUp={() => { drag.current = null; }}>
          {img ? <img src={img.src} alt="" draggable={false} style={{ width: w, height: h, transform: `translate(${pos.x}px, ${pos.y}px)` }} />
            : <LoaderCircle className="spin" />}
        </div>
        <label className="ext-zoom">Phóng to
          <input type="range" min="1" max="3" step="0.01" value={zoom} onChange={e => setZoom(Number(e.target.value))} />
        </label>
        <p className="muted ext-note">Kéo ảnh để chọn vùng hiển thị.</p>
        <div className="dialog-actions">
          <button type="button" className="btn secondary" onClick={onCancel}>Hủy</button>
          <button type="button" className="btn primary" disabled={!img || busy} onClick={confirm}>{busy && <LoaderCircle size={16} className="spin" />} Dùng ảnh này</button>
        </div>
      </div>
    </div>
  );
}
