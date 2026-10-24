// Lich ngay / tuan / thang / danh sach, keo tha de doi gio (may chu kiem tra trung; loi -> tra ve vi tri cu).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, LoaderCircle, X } from 'lucide-react';
import { useSse } from './sse';
import { ConflictBox } from './TaskDialogs';
import { KIND, addDays, fmtDate, fmtRange, fmtTime, startOfDay, startOfWeek, work } from './workApi';

const HOUR = 44;
const SNAP = 15;
const MODES = [['day', 'Ngày'], ['week', 'Tuần'], ['month', 'Tháng'], ['list', 'Danh sách']];

function rangeOf(mode, cursor) {
  if (mode === 'day') return [startOfDay(cursor), addDays(startOfDay(cursor), 1)];
  if (mode === 'week') { const s = startOfWeek(cursor); return [s, addDays(s, 7)]; }
  if (mode === 'month') {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const s = startOfWeek(first);
    return [s, addDays(s, 42)];
  }
  return [startOfDay(cursor), addDays(startOfDay(cursor), 14)];
}

// Xep cac su kien chong nhau trong 1 ngay thanh cac lan song song.
function layout(events) {
  const sorted = [...events].sort((a, b) => a.s - b.s || b.e - a.e);
  const lanes = [];
  const out = [];
  let cluster = [];
  let clusterEnd = 0;
  const flush = () => { const n = Math.max(1, ...cluster.map(x => x.lane + 1)); cluster.forEach(x => (x.lanes = n)); cluster = []; lanes.length = 0; };
  for (const ev of sorted) {
    if (cluster.length && ev.s >= clusterEnd) flush();
    let lane = lanes.findIndex(end => end <= ev.s);
    if (lane < 0) { lane = lanes.length; lanes.push(0); }
    lanes[lane] = ev.e;
    const item = { ...ev, lane };
    cluster.push(item);
    out.push(item);
    clusterEnd = Math.max(clusterEnd, ev.e);
  }
  flush();
  return out;
}

export default function WorkCalendar({ source = { type: 'me' }, onOpenItem, onCreateAt, onToast }) {
  const [mode, setMode] = useState(() => (window.innerWidth < 720 ? 'day' : 'week'));
  const [cursor, setCursor] = useState(() => new Date());
  const [data, setData] = useState({ items: [], busy: [], conflicts: [], members: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [moveError, setMoveError] = useState(null);
  const [showBusy, setShowBusy] = useState(true);
  const drag = useRef(null);
  const scroller = useRef(null);
  const [from, to] = useMemo(() => rangeOf(mode, cursor), [mode, cursor]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = source.type === 'group'
        ? await work.groupCalendar(source.cid, from.toISOString(), to.toISOString())
        : await work.calendar(from.toISOString(), to.toISOString());
      setData({ items: r.items, busy: r.busy || [], conflicts: r.conflicts || [], members: r.members || [] });
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [source.type, source.cid, from, to]);
  useEffect(() => { load(); }, [load]);
  useSse(['calendar:changed', 'task:changed', 'meeting:changed'], () => load());
  useEffect(() => { if (scroller.current && (mode === 'week' || mode === 'day')) scroller.current.scrollTop = 7 * HOUR; }, [mode]);

  const conflictIds = useMemo(() => new Set(data.conflicts.flatMap(c => c.eventIds)), [data.conflicts]);
  const nameOf = id => data.members.find(m => m.userId === id)?.displayName || id;
  const all = useMemo(() => [
    ...data.items.map(e => ({ ...e, busy: false })),
    ...(showBusy ? data.busy.map(b => ({ ...b, busy: true, eventId: `busy-${b.userId}-${b.eventId}`, realId: b.eventId })) : [])
  ], [data, showBusy]);

  const step = dir => setCursor(c => (mode === 'day' ? addDays(c, dir) : mode === 'month' ? new Date(c.getFullYear(), c.getMonth() + dir, 1) : addDays(c, 7 * dir)));
  const title = mode === 'month' ? cursor.toLocaleDateString('vi-VN', { month: 'long', year: 'numeric' })
    : mode === 'day' ? cursor.toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })
      : `${fmtDate(from)} – ${fmtDate(addDays(to, -1))}`;

  async function move(ev, start, end) {
    const prev = data.items;
    setData(d => ({ ...d, items: d.items.map(x => (x.eventId === ev.eventId ? { ...x, start: start.toISOString(), end: end.toISOString() } : x)) }));
    try {
      await work.moveEvent(ev.eventId, start.toISOString(), end.toISOString());
      onToast?.('Đã dời lịch.');
      load();
    } catch (err) {
      setData(d => ({ ...d, items: prev })); // tra ve vi tri cu
      err.eventId = ev.eventId;
      setMoveError(err);
    }
  }

  const canDrag = ev => !ev.busy && ev.visible !== false && ev.mine !== false;
  const onDragStart = (e, ev, grabMinutes = 0) => {
    drag.current = { ev, grabMinutes };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', ev.eventId);
  };
  const dropOnTime = (e, day) => {
    e.preventDefault();
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const minutes = Math.round(((e.clientY - rect.top) / HOUR * 60 - d.grabMinutes) / SNAP) * SNAP;
    const dur = new Date(d.ev.end) - new Date(d.ev.start);
    const start = new Date(startOfDay(day).getTime() + Math.max(0, minutes) * 60000);
    if (start.getTime() === new Date(d.ev.start).getTime()) return;
    move(d.ev, start, new Date(start.getTime() + dur));
  };
  const dropOnDay = (e, day) => {
    e.preventDefault();
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const old = new Date(d.ev.start);
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), old.getHours(), old.getMinutes());
    if (start.getTime() === old.getTime()) return;
    move(d.ev, start, new Date(start.getTime() + (new Date(d.ev.end) - old)));
  };
  const clickSlot = (e, day) => {
    if (e.target !== e.currentTarget || !onCreateAt) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const minutes = Math.floor((e.clientY - rect.top) / HOUR * 60 / 30) * 30;
    const start = new Date(startOfDay(day).getTime() + minutes * 60000);
    onCreateAt(start, new Date(start.getTime() + 3600000));
  };

  const label = ev => (ev.busy ? `${nameOf(ev.userId)}: ${ev.title}` : ev.title);
  const cls = ev => `wk-ev k-${ev.kind}${ev.busy ? ' busy' : ''}${conflictIds.has(ev.realId || ev.eventId) ? ' conflict' : ''}`;
  const days = mode === 'day' ? [startOfDay(cursor)] : Array.from({ length: 7 }, (_, i) => addDays(from, i));

  function timeGrid() {
    return (
      <div className="wk-grid-wrap" ref={scroller}>
        <div className="wk-grid-head" style={{ gridTemplateColumns: `48px repeat(${days.length}, 1fr)` }}>
          <span />
          {days.map(d => <span key={d} className={startOfDay(new Date()).getTime() === d.getTime() ? 'today' : ''}>{fmtDate(d)}</span>)}
        </div>
        <div className="wk-grid" style={{ gridTemplateColumns: `48px repeat(${days.length}, 1fr)` }}>
          <div className="wk-hours">{Array.from({ length: 24 }, (_, h) => <span key={h} style={{ height: HOUR }}>{String(h).padStart(2, '0')}:00</span>)}</div>
          {days.map(day => {
            const ds = day.getTime();
            const de = addDays(day, 1).getTime();
            const placed = layout(all.filter(ev => new Date(ev.start) < de && new Date(ev.end) > ds)
              .map(ev => ({ ...ev, s: Math.max(ds, new Date(ev.start).getTime()), e: Math.min(de, new Date(ev.end).getTime()) })));
            return (
              <div key={ds} className="wk-col" style={{ height: 24 * HOUR }} onDragOver={e => e.preventDefault()} onDrop={e => dropOnTime(e, day)} onClick={e => clickSlot(e, day)}>
                {placed.map(ev => {
                  const top = (ev.s - ds) / 3600000 * HOUR;
                  const height = Math.max(18, (ev.e - ev.s) / 3600000 * HOUR - 2);
                  return (
                    <button key={ev.eventId + ds} type="button" className={cls(ev)} draggable={canDrag(ev)}
                      style={{ top, height, left: `calc(${(ev.lane / ev.lanes) * 100}% + 2px)`, width: `calc(${100 / ev.lanes}% - 4px)` }}
                      title={`${label(ev)}\n${fmtRange(ev.start, ev.end)}`}
                      onDragStart={e => onDragStart(e, ev, (e.clientY - e.currentTarget.getBoundingClientRect().top) / HOUR * 60 + (ev.s - new Date(ev.start).getTime()) / 60000)}
                      onClick={() => !ev.busy && onOpenItem?.(ev)}>
                      <b>{label(ev)}</b><span>{fmtTime(ev.start)} – {fmtTime(ev.end)}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  function monthGrid() {
    const cells = Array.from({ length: 42 }, (_, i) => addDays(from, i));
    return (
      <div className="wk-month">
        {['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'].map(d => <span key={d} className="wk-month-h">{d}</span>)}
        {cells.map(day => {
          const ds = day.getTime();
          const list = all.filter(ev => new Date(ev.start) < addDays(day, 1) && new Date(ev.end) > day).sort((a, b) => a.start.localeCompare(b.start));
          return (
            <div key={ds} className={'wk-cell' + (day.getMonth() !== cursor.getMonth() ? ' other' : '') + (startOfDay(new Date()).getTime() === ds ? ' today' : '')}
              onDragOver={e => e.preventDefault()} onDrop={e => dropOnDay(e, day)}
              onDoubleClick={e => e.target === e.currentTarget && onCreateAt?.(new Date(ds + 9 * 3600000), new Date(ds + 10 * 3600000))}>
              <span className="wk-cell-n">{day.getDate()}</span>
              {list.slice(0, 4).map(ev => (
                <button key={ev.eventId} type="button" className={cls(ev) + ' chip-ev'} draggable={canDrag(ev)} onDragStart={e => onDragStart(e, ev)}
                  onClick={() => !ev.busy && onOpenItem?.(ev)} title={`${label(ev)} · ${fmtRange(ev.start, ev.end)}`}>
                  {fmtTime(ev.start)} {label(ev)}
                </button>
              ))}
              {list.length > 4 && <button type="button" className="link-btn wk-more" onClick={() => { setCursor(day); setMode('day'); }}>+{list.length - 4} nữa</button>}
            </div>
          );
        })}
      </div>
    );
  }

  function listView() {
    const byDay = new Map();
    for (const ev of [...all].sort((a, b) => a.start.localeCompare(b.start))) {
      const k = startOfDay(ev.start).getTime();
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(ev);
    }
    if (!byDay.size) return <p className="muted pad">Không có lịch trong 14 ngày tới.</p>;
    return (
      <div className="wk-list">
        {[...byDay.entries()].map(([k, list]) => (
          <section key={k}>
            <h4>{fmtDate(new Date(k))}</h4>
            {list.map(ev => (
              <button key={ev.eventId} type="button" className={'wk-list-item ' + cls(ev)} onClick={() => !ev.busy && onOpenItem?.(ev)}>
                <span className="wk-when">{fmtTime(ev.start)} – {fmtTime(ev.end)}</span>
                <b>{label(ev)}</b><span className="muted">{KIND[ev.kind] || ''}</span>
              </button>
            ))}
          </section>
        ))}
      </div>
    );
  }

  return (
    <div className="wk-calendar">
      <div className="wk-cal-bar">
        <div className="wk-cal-nav">
          <button type="button" className="icon-btn" aria-label="Trước" onClick={() => step(-1)}><ChevronLeft size={18} /></button>
          <button type="button" className="btn small secondary" onClick={() => setCursor(new Date())}>Hôm nay</button>
          <button type="button" className="icon-btn" aria-label="Sau" onClick={() => step(1)}><ChevronRight size={18} /></button>
          <b className="wk-cal-title">{title}</b>
          {loading && <LoaderCircle size={16} className="spin" />}
        </div>
        <div className="wk-tabs" role="tablist">
          {MODES.map(([k, v]) => <button key={k} type="button" role="tab" aria-selected={mode === k} className={mode === k ? 'active' : ''} onClick={() => setMode(k)}>{v}</button>)}
        </div>
      </div>
      {source.type === 'group' && (
        <div className="wk-legend">
          <label><input type="checkbox" checked={showBusy} onChange={e => setShowBusy(e.target.checked)} /> Hiện lịch bận của thành viên</label>
          {data.conflicts.length > 0 && <span className="wk-pill st-overdue">{data.conflicts.length} xung đột lịch</span>}
        </div>
      )}
      <div className="wk-legend">
        <span className="wk-dot k-TASK_SESSION" /> Công việc <span className="wk-dot k-MEETING" /> Cuộc họp <span className="wk-dot k-PERSONAL" /> Cá nhân
        <span className="muted">· Kéo thả để đổi giờ{onCreateAt ? ', bấm ô trống để thêm lịch' : ''}</span>
      </div>
      {error && <p className="error-text pad">{error}</p>}
      {(mode === 'week' || mode === 'day') && timeGrid()}
      {mode === 'month' && monthGrid()}
      {mode === 'list' && listView()}
      {moveError && (
        <div className="overlay" onMouseDown={e => e.target === e.currentTarget && setMoveError(null)}>
          <div className="dialog wk-dialog" role="alertdialog" aria-label="Không dời được lịch">
            <div className="wk-dialog-head"><h3>Không dời được lịch</h3>
              <button type="button" className="icon-btn" aria-label="Đóng" onClick={() => setMoveError(null)}><X size={18} /></button></div>
            <p className="muted">Lịch đã được trả về vị trí cũ.</p>
            <ConflictBox error={moveError} onPick={s => {
              const ev = data.items.find(x => x.eventId === moveError.eventId);
              setMoveError(null);
              if (ev) move(ev, new Date(s.start), new Date(s.end));
            }} />
          </div>
        </div>
      )}
    </div>
  );
}
