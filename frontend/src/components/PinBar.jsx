import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Ellipsis, ListOrdered, MessageSquareText, Pin, PinOff } from 'lucide-react';
import ContextMenu from './ContextMenu';
import { formatFull, formatListTime } from '../utils';

// Thanh tin nhan da ghim duoi tieu de hoi thoai (noi tren danh sach tin, khong doi vi tri cuon).
// Tin dai dien = tin duoc ghim gan nhat (backend da sap xep theo pinned_at giam dan).
export default function PinBar({ pins, onOpen, onUnpin }) {
  const [listOpen, setListOpen] = useState(false);
  const [menu, setMenu] = useState(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!listOpen) return undefined;
    const onDown = e => !wrapRef.current?.contains(e.target) && setListOpen(false);
    const onKey = e => e.key === 'Escape' && setListOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [listOpen]);

  if (!pins.length) return null;
  const top = pins[0];
  const extra = pins.length - 1;
  const showList = listOpen && extra > 0;

  function openMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const items = [{ key: 'goto', label: 'Xem trong đoạn chat', icon: MessageSquareText, onSelect: () => onOpen(top) }];
    if (pins.length > 1) items.push({ key: 'all', label: `Xem tất cả ${pins.length} tin đã ghim`, icon: ListOrdered, onSelect: () => setListOpen(true) });
    if (top.canUnpin) items.push({ key: 'unpin', label: 'Bỏ ghim', icon: PinOff, danger: true, onSelect: () => onUnpin(top) });
    setMenu({ x: r.right - 200, y: r.bottom + 4, items });
  }

  return (
    <div className="pin-bar-wrap" ref={wrapRef}>
      <div className="pin-bar" role="region" aria-label="Tin nhắn đã ghim">
        <button type="button" className="pin-main" onClick={() => onOpen(top)} title="Đi tới tin nhắn đã ghim">
          <span className="pin-icon" aria-hidden="true"><MessageSquareText size={20} /></span>
          <span className="pin-text">
            <strong>Tin nhắn</strong>
            <span className="pin-line"><b>{top.senderName}:</b> {top.preview || '(không có chữ)'}</span>
          </span>
        </button>
        {extra > 0 && (
          <button type="button" className={'pin-count' + (showList ? ' on' : '')} onClick={() => setListOpen(v => !v)}
            aria-expanded={showList} aria-label={`Xem ${pins.length} tin nhắn đã ghim`}>
            +{extra} ghim <ChevronDown size={15} />
          </button>
        )}
        <button type="button" className="icon-btn ghost pin-more" onClick={openMenu} aria-label="Thao tác với tin đã ghim">
          <Ellipsis size={18} />
        </button>
      </div>

      {showList && (
        <div className="pin-list" role="dialog" aria-label="Danh sách tin nhắn đã ghim">
          <div className="pin-list-head"><Pin size={14} /> {pins.length} tin nhắn đã ghim</div>
          <ul>
            {pins.map(p => (
              <li key={p.messageId}>
                <button type="button" className="pin-item" onClick={() => { setListOpen(false); onOpen(p); }}>
                  <span className="pin-line"><b>{p.senderName}:</b> {p.preview || '(không có chữ)'}</span>
                  <span className="pin-meta">
                    Ghim bởi {p.pinnedBy.displayName}
                    {p.pinnedAt && <> · <time dateTime={p.pinnedAt} title={formatFull(p.pinnedAt)}>{formatListTime(p.pinnedAt)}</time></>}
                  </span>
                </button>
                {p.canUnpin && (
                  <button type="button" className="icon-btn ghost pin-unpin" onClick={() => onUnpin(p)} aria-label="Bỏ ghim" title="Bỏ ghim">
                    <PinOff size={15} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
