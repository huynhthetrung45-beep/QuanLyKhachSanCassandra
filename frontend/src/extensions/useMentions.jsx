// PT-13: go "@" trong khung soan de chon thanh vien. Tra ve popup, xu ly phim, danh sach userId da nhac.
import { useMemo, useState } from 'react';
import Avatar from '../components/Avatar';
import { fold } from '../utils';

export default function useMentions({ members = [], selfId, text, setText, areaRef }) {
  const [picked, setPicked] = useState([]); // [{ userId, displayName }]
  const [index, setIndex] = useState(0);
  const [dismissedAt, setDismissedAt] = useState(-1);

  // Tim "@tu" ngay truoc con tro.
  const caret = areaRef.current?.selectionStart ?? text.length;
  const before = text.slice(0, caret);
  const m = /(^|\s)@([^\s@]{0,30})$/.exec(before);
  const start = m ? caret - m[2].length - 1 : -1;
  const query = m ? fold(m[2]) : null;
  const options = useMemo(() => (query === null ? [] : members
    .filter(x => x.userId !== selfId && fold(x.displayName).includes(query))
    .slice(0, 6)), [members, query, selfId]);
  const open = options.length > 0 && start !== dismissedAt;

  function choose(member) {
    const insert = '@' + member.displayName + ' ';
    const next = text.slice(0, start) + insert + text.slice(caret);
    setText(next);
    setPicked(list => (list.some(p => p.userId === member.userId) ? list : [...list, member]));
    setIndex(0);
    requestAnimationFrame(() => {
      const el = areaRef.current;
      if (el) { el.focus(); el.selectionStart = el.selectionEnd = start + insert.length; }
    });
  }

  // Tra true neu da xu ly phim (khong cho Composer gui tin).
  function onKeyDown(e) {
    if (!open) return false;
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(i => (i + 1) % options.length); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(i => (i - 1 + options.length) % options.length); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(options[Math.min(index, options.length - 1)]); return true; }
    if (e.key === 'Escape') { e.preventDefault(); setDismissedAt(start); return true; }
    return false;
  }

  // Chi giu nguoi van con "@Ten" trong noi dung khi gui.
  const mentionIds = value => picked.filter(p => value.includes('@' + p.displayName)).map(p => p.userId);
  const reset = () => setPicked([]);

  const popup = open ? (
    <ul className="ext-mention-pop" role="listbox" aria-label="Nhắc tên thành viên">
      {options.map((o, i) => (
        <li key={o.userId} role="option" aria-selected={i === index}>
          <button type="button" className={i === index ? 'on' : ''} onMouseDown={e => { e.preventDefault(); choose(o); }}>
            <Avatar name={o.displayName} seed={o.userId} size={26} /> {o.displayName}
          </button>
        </li>
      ))}
    </ul>
  ) : null;

  return { popup, onKeyDown, mentionIds, reset };
}
