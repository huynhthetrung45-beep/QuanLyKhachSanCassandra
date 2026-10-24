import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// Menu ngu canh dat tai vi tri chuot, tu dieu chinh de khong tran ra ngoai man hinh.
// items: [{ key, label, icon, danger, onSelect }]
export default function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      top: Math.max(8, y + height > window.innerHeight - 8 ? y - height : y)
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = e => !ref.current?.contains(e.target) && onClose();
    const onKey = e => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const buttons = [...ref.current.querySelectorAll('button')];
        const i = buttons.indexOf(document.activeElement);
        buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    // Chi dong khi NGUOI DUNG cuon (tin moi tu cuon xuong day khong lam mat menu)
    document.addEventListener('wheel', onClose, { passive: true });
    document.addEventListener('touchmove', onClose, { passive: true });
    ref.current?.querySelector('button')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
      document.removeEventListener('wheel', onClose);
      document.removeEventListener('touchmove', onClose);
    };
  }, [onClose]);

  return (
    <div className="ctx-menu" ref={ref} role="menu" style={pos} onContextMenu={e => e.preventDefault()}>
      {items.map(({ key, label, icon: Icon, danger, onSelect }) => (
        <button key={key} type="button" role="menuitem" className={'ctx-item' + (danger ? ' danger' : '')}
          onClick={() => { onClose(); onSelect(); }}>
          {Icon && <Icon size={16} />}<span>{label}</span>
        </button>
      ))}
    </div>
  );
}
