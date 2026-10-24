import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown, ArrowLeft, Copy, EyeOff, Forward, LoaderCircle, PanelRightClose, PanelRightOpen, Pin, PinOff, Reply, RotateCcw, Search, Undo2, Upload
} from 'lucide-react';
import Avatar from './Avatar';
import ConfirmDialog from './ConfirmDialog';
import Composer from './Composer';
import ContextMenu from './ContextMenu';
import ForwardModal from './ForwardModal';
import MessageItem from './MessageItem';
import PinBar from './PinBar';
import { Lightbox } from './Attachments';
import { api, normalizeMessage } from '../api';
import { copyText, formatDayDivider, lastSeenText, sameDay } from '../utils';
import { Flag, History, Languages, Pencil } from 'lucide-react';
import ChatExtrasBar from '../extensions/ChatExtrasBar';
import { useMessageExtrasSync } from '../extensions/MessageExtras';
import { EditHistoryDialog, EditMessageDialog, ReportDialog, TranslateDialog, canEdit } from '../extensions/MessageDialogs';

const GROUP_GAP_MS = 5 * 60 * 1000;
const TYPING_TTL_MS = 4500;

function mergeUnique(base, extra, position) {
  const seen = new Set(base.map(m => m.messageId));
  const fresh = extra.filter(m => !seen.has(m.messageId));
  return position === 'start' ? [...fresh, ...base] : [...base, ...fresh];
}

// Danh dau tin goc bi thu hoi trong moi doan trich tra loi dang hien thi.
function recallIn(list, messageId) {
  return list.map(m => {
    if (m.messageId === messageId) return { ...m, isDeleted: true, content: null, attachments: [], reactions: [] };
    if (m.replyTo?.messageId === messageId) return { ...m, replyTo: { ...m.replyTo, isDeleted: true, excerpt: null, attachmentCount: 0 } };
    return m;
  });
}

export default function ChatWindow({
  ref, user, conversation, conversations, demoMode, infoOpen, onToggleInfo, searchOpen, onToggleSearch, onBack, onChanged, onToast, onOpenProfile,
  jumpTarget = null, onJumpDone
}) {
  const id = conversation.conversationId;
  const isGroup = conversation.conversationType === 'GROUP';
  const [messages, setMessages] = useState([]);          // cu -> moi
  const [phase, setPhase] = useState('loading');          // loading | ready | error
  const [loadError, setLoadError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [stats, setStats] = useState(null);
  const [newBelow, setNewBelow] = useState(0);
  const [confirming, setConfirming] = useState(null);     // { type: 'recall' | 'hide', message }
  const [replyTo, setReplyTo] = useState(null);
  const [menu, setMenu] = useState(null);                 // { message, x, y }
  const [forwarding, setForwarding] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [members, setMembers] = useState([]);             // tu GET /conversations/:id (lastReadAt, online)
  const [typing, setTyping] = useState({});               // userId -> { name, until }
  const [flashId, setFlashId] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [pins, setPins] = useState([]);                   // tin da ghim (moi nhat truoc)
  const [detached, setDetached] = useState(false);       // dang xem cua so cu (chua toi tin moi nhat)
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [extDialog, setExtDialog] = useState(null);        // chuc nang moi: { type: edit|history|translate|report, message }

  const scrollRef = useRef(null);
  const sentinelRef = useRef(null);
  const composerRef = useRef(null);
  const abortRef = useRef(null);
  const anchorRef = useRef(null);       // giu vi tri cuon khi chen tin cu len dau
  const stickRef = useRef(true);        // dang o day khung chat
  const pageRef = useRef(0);
  const busyRef = useRef(false);
  const tokenRef = useRef(null);
  const hasMoreRef = useRef(false);
  const messagesRef = useRef(messages);
  useLayoutEffect(() => { messagesRef.current = messages; }, [messages]);
  const pendingJump = useRef(null);
  const olderCursorRef = useRef(null);  // che do cua so: tai cu hon bang con tro (thay pageToken)
  const newerCursorRef = useRef(null);
  const detachedRef = useRef(false);
  const bottomRef = useRef(null);
  const setDetachedBoth = v => { detachedRef.current = v; setDetached(v); };
  const dragDepth = useRef(0);

  const memberNames = useMemo(() => new Map(members.map(m => [m.userId, m.displayName])), [members]);

  const markRead = useCallback(() => {
    api.markRead(id).catch(() => {});
  }, [id]);

  // Danh sach ghim: tai khi mo hoi thoai, khi co su kien message:pins, khi ket noi lai. Bo ket qua cu ve muon.
  const pinSeq = useRef(0);
  const loadPins = useCallback(() => {
    const seq = ++pinSeq.current;
    api.pins(id).then(r => seq === pinSeq.current && setPins(r.items)).catch(() => {});
  }, [id]);
  const applyPins = r => { pinSeq.current += 1; setPins(r.items); };

  const loadMembers = useCallback(() => {
    api.conversation(id).then(d => setMembers(d.members)).catch(() => {});
  }, [id]);

  const setPaging = page => {
    olderCursorRef.current = null;
    tokenRef.current = page.nextPageToken;
    hasMoreRef.current = Boolean(page.hasMore && page.nextPageToken);
    setHasMore(hasMoreRef.current);
  };

  const loadFirst = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    busyRef.current = true;
    setPhase('loading');
    setLoadError('');
    try {
      const t0 = performance.now();
      const page = await api.messages(id, { signal: controller.signal });
      pageRef.current = 1;
      stickRef.current = true;
      setDetachedBoth(false);
      newerCursorRef.current = null;
      setMessages([...page.items].reverse());
      setPaging(page);
      setStats({ page: 1, count: page.count, db: page.queryTimeMs, total: Math.round(performance.now() - t0) });
      setPhase('ready');
      markRead();
    } catch (err) {
      if (err.name === 'AbortError') return;
      setLoadError(err.message);
      setPhase('error');
    } finally {
      busyRef.current = false;
    }
  }, [id, markRead]);

  // Doi hoi thoai: huy request dang chay, xoa token cu (SRS 6.3.5)
  useEffect(() => {
    loadFirst();
    loadMembers();
    loadPins();
    return () => abortRef.current?.abort();
  }, [loadFirst, loadMembers, loadPins]);

  // Tai 1 trang cu hon. Tra ve cac tin vua tai (cu -> moi) hoac null.
  const loadOlder = useCallback(async () => {
    if (busyRef.current || !hasMoreRef.current || (!tokenRef.current && !olderCursorRef.current)) return null;
    busyRef.current = true;
    setLoadingOlder(true);
    const el = scrollRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const t0 = performance.now();
      const byCursor = Boolean(olderCursorRef.current);
      const page = byCursor
        ? await api.messageWindow(id, { before: olderCursorRef.current, signal: controller.signal })
        : await api.messages(id, { pageToken: tokenRef.current, signal: controller.signal });
      if (el) anchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
      pageRef.current += 1;
      const older = [...page.items].reverse();
      setMessages(list => mergeUnique(list, older, 'start'));
      if (byCursor) {
        olderCursorRef.current = page.hasOlder ? page.olderCursor : null;
        hasMoreRef.current = Boolean(olderCursorRef.current);
        setHasMore(hasMoreRef.current);
      } else {
        setPaging(page);
      }
      setStats({ page: pageRef.current, count: page.count, db: page.queryTimeMs, total: Math.round(performance.now() - t0) });
      return older;
    } catch (err) {
      if (err.name === 'AbortError') return null;
      if (err.code === 'INVALID_PAGE_TOKEN') {
        onToast('Phiên phân trang đã cũ, đang tải lại từ tin mới nhất.');
        busyRef.current = false;
        loadFirst();
        return null;
      }
      onToast(err.message);
      return null;
    } finally {
      busyRef.current = false;
      setLoadingOlder(false);
    }
  }, [id, loadFirst, onToast]);

  // Che do cua so: tai tin moi hon (noi vao cuoi). Toi tin moi nhat -> tro ve che do thuong.
  const loadNewer = useCallback(async () => {
    if (busyRef.current || !detachedRef.current || !newerCursorRef.current) return;
    busyRef.current = true;
    setLoadingNewer(true);
    try {
      const page = await api.messageWindow(id, { after: newerCursorRef.current });
      setMessages(list => mergeUnique(list, [...page.items].reverse(), 'end'));
      newerCursorRef.current = page.hasNewer ? page.newerCursor : null;
      if (!page.hasNewer) { setDetachedBoth(false); setNewBelow(0); markRead(); }
    } catch (err) {
      onToast(err.message);
    } finally {
      busyRef.current = false;
      setLoadingNewer(false);
    }
  }, [id, markRead, onToast]);

  // Mo cua so lich su quanh tin dich (tin chua co trong bo nho, ke ca rat cu) - 1 request, khong tai tung trang.
  const openWindow = useCallback(async target => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    busyRef.current = true;
    try {
      const page = await api.messageWindow(id, { around: `${target.createdAt}_${target.messageId}`, signal: controller.signal });
      stickRef.current = false;
      pendingJump.current = target.messageId;
      tokenRef.current = null;
      olderCursorRef.current = page.hasOlder ? page.olderCursor : null;
      hasMoreRef.current = Boolean(olderCursorRef.current);
      setHasMore(hasMoreRef.current);
      newerCursorRef.current = page.hasNewer ? page.newerCursor : null;
      setDetachedBoth(Boolean(page.hasNewer));
      setNewBelow(0);
      setMessages([...page.items].reverse());
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return false;
      onToast(err.status === 404 ? 'Tin nhắn không còn hiển thị (đã bị thu hồi phía bạn hoặc đã xóa).' : err.message);
      return false;
    } finally {
      busyRef.current = false;
    }
  }, [id, onToast]);

  // Giu vi tri cuon / cuon xuong day / cuon toi tin goc sau moi lan render danh sach
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (anchorRef.current) {
      const { height, top } = anchorRef.current;
      el.scrollTop = el.scrollHeight - height + top;
      anchorRef.current = null;
    } else if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
    if (pendingJump.current) {
      const target = document.getElementById('msg-' + pendingJump.current);
      if (target) {
        target.scrollIntoView({ block: 'center' });
        setFlashId(pendingJump.current);
        pendingJump.current = null;
      }
    }
  }, [messages, phase]);

  // Thanh ghim hien / an lam doi khoang dem tren cung: giu nguyen tin dang xem (hoac day khung chat).
  const hasPins = pins.length > 0;
  const prevPad = useRef(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const pad = parseFloat(getComputedStyle(el).paddingTop) || 0;
    if (prevPad.current !== null && pad !== prevPad.current) {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
      else el.scrollTop += pad - prevPad.current;
    }
    prevPad.current = pad;
  }, [hasPins]);

  useEffect(() => {
    if (!flashId) return undefined;
    const t = setTimeout(() => setFlashId(null), 1600);
    return () => clearTimeout(t);
  }, [flashId]);

  // IntersectionObserver tren sentinel o dinh (khong nghe su kien scroll lien tuc)
  useEffect(() => {
    const root = scrollRef.current;
    const target = sentinelRef.current;
    if (!root || !target || phase !== 'ready' || !hasMore || loadingOlder) return undefined;
    const observer = new IntersectionObserver(
      entries => entries.some(e => e.isIntersecting) && loadOlder(),
      { root, rootMargin: '160px 0px 0px 0px' }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [phase, hasMore, loadingOlder, loadOlder, messages.length]);

  useEffect(() => {
    const root = scrollRef.current;
    const target = bottomRef.current;
    if (!root || !target || phase !== 'ready' || !detached || loadingNewer) return undefined;
    const observer = new IntersectionObserver(
      entries => entries.some(e => e.isIntersecting) && loadNewer(),
      { root, rootMargin: '0px 0px 160px 0px' }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [phase, detached, loadingNewer, loadNewer, messages.length]);

  // Het han chi bao "dang nhap"
  useEffect(() => {
    const keys = Object.keys(typing);
    if (keys.length === 0) return undefined;
    const soonest = Math.min(...keys.map(k => typing[k].until));
    const t = setTimeout(() => {
      const now = Date.now();
      setTyping(map => Object.fromEntries(Object.entries(map).filter(([, v]) => v.until > now)));
    }, Math.max(50, soonest - Date.now()));
    return () => clearTimeout(t);
  }, [typing]);

  // Quay lai tab: danh dau da doc
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && markRead();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [markRead]);

  function onScroll() {
    const el = scrollRef.current;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickRef.current = atBottom;
    if (atBottom && newBelow) setNewBelow(0);
  }

  function scrollToBottom() {
    if (detachedRef.current) { setNewBelow(0); loadFirst(); return; }
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setNewBelow(0);
  }

  const resync = useCallback(async () => {
    if (detachedRef.current) return; // dang xem cua so cu: tin moi se co khi quay ve tin moi nhat
    try {
      const page = await api.messages(id);
      const fresh = [...page.items].reverse();
      const list = messagesRef.current;
      const newest = list[list.length - 1];
      // Mat ket noi lau (hon 1 trang tin moi): tai lai tu dau thay vi de lo hong giua danh sach.
      if (newest && fresh.length && page.hasMore && new Date(fresh[0].createdAt) > new Date(newest.createdAt)) {
        loadFirst();
        return;
      }
      const freshMap = new Map(fresh.map(m => [m.messageId, m]));
      const oldestFresh = fresh[0] ? new Date(fresh[0].createdAt) : null;
      setMessages(current => mergeUnique(
        // tin trong khoang trang moi nhat ma khong con tra ve = da bi an phia minh o tab khac
        current
          .filter(m => !oldestFresh || new Date(m.createdAt) < oldestFresh || freshMap.has(m.messageId))
          .map(m => freshMap.get(m.messageId) || m),
        fresh, 'end'));
      loadMembers();
      loadPins();
    } catch {
      /* lan ket noi sau se thu lai */
    }
  }, [id, loadFirst, loadMembers, loadPins]);

  // Chuc nang moi: sua tin / extra (binh chon, nhac ten, link) / khoi phuc tin qua realtime.
  useMessageExtrasSync(id, setMessages, resync);

  useImperativeHandle(ref, () => ({
    receive(raw) {
      const message = normalizeMessage(raw);
      if (detachedRef.current) {
        // Khong noi tin moi vao cua so cu (se tao lo hong); chi bao co tin moi.
        if (message.senderId !== user.userId) setNewBelow(n => n + 1);
        return;
      }
      setMessages(list => mergeUnique(list, [message], 'end'));
      setTyping(map => {
        if (!map[message.senderId]) return map;
        const next = { ...map };
        delete next[message.senderId];
        return next;
      });
      if (!stickRef.current && message.senderId !== user.userId) setNewBelow(n => n + 1);
      if (document.visibilityState === 'visible') markRead();
      if (message.messageType === 'SYSTEM') loadMembers();
    },
    markRecalled(messageId) {
      setMessages(list => recallIn(list, messageId));
      setReplyTo(r => (r?.messageId === messageId ? null : r));
    },
    applyReactions(messageId, reactions) {
      setMessages(list => list.map(m => (m.messageId === messageId && !m.isDeleted ? { ...m, reactions } : m)));
    },
    removeMessage(messageId) {
      setMessages(list => list.filter(m => m.messageId !== messageId));
    },
    typing({ userId, displayName }) {
      if (userId === user.userId) return;
      setTyping(map => ({ ...map, [userId]: { name: displayName, until: Date.now() + TYPING_TTL_MS } }));
    },
    read({ userId, lastReadAt }) {
      setMembers(list => list.map(m => (m.userId === userId ? { ...m, lastReadAt } : m)));
    },
    presence({ userId, online, lastSeenAt }) {
      setMembers(list => list.map(m => (m.userId === userId ? { ...m, online, lastSeenAt } : m)));
    },
    resync,
    pinsChanged: () => loadPins(),
    jumpTo: target => jumpRef.current?.(target)
  }), [user.userId, markRead, loadMembers, resync, loadPins]);

  async function send({ content, attachmentIds, mentions }) {
    const created = await api.sendMessage(id, {
      content: content || undefined,
      attachmentIds: attachmentIds.length ? attachmentIds : undefined,
      mentions: mentions?.length ? mentions : undefined,
      replyTo: replyTo ? { messageId: replyTo.messageId, createdAt: replyTo.createdAt } : undefined
    });
    stickRef.current = true;
    setReplyTo(null);
    if (detachedRef.current) loadFirst();
    else setMessages(list => mergeUnique(list, [created], 'end'));
    onChanged(created);
  }

  // Tin gui tu thanh cong cu moi (sticker, ghi am, binh chon).
  function addSent(created) {
    const message = normalizeMessage(created);
    stickRef.current = true;
    if (detachedRef.current) loadFirst();
    else setMessages(list => mergeUnique(list, [message], 'end'));
    onChanged(message);
  }

  async function recall(message) {
    try {
      await api.recall(id, message);
      setMessages(list => recallIn(list, message.messageId));
      onChanged();
    } catch (err) {
      onToast(err.message);
    }
  }

  async function hide(message) {
    try {
      await api.hide(id, message);
      setMessages(list => list.filter(m => m.messageId !== message.messageId));
      if (replyTo?.messageId === message.messageId) setReplyTo(null);
      if (pins.some(p => p.messageId === message.messageId)) loadPins();
      onChanged();
    } catch (err) {
      onToast(err.message);
    }
  }

  const react = useCallback(async (message, emoji) => {
    try {
      const res = emoji ? await api.react(id, message, emoji) : await api.unreact(id, message);
      setMessages(list => list.map(m => (m.messageId === message.messageId ? { ...m, reactions: res.reactions } : m)));
    } catch (err) {
      onToast(err.message);
    }
  }, [id, onToast]);

  const startReply = useCallback(message => {
    setReplyTo(message);
    composerRef.current?.focus();
  }, []);

  const openMenu = useCallback((message, x, y) => setMenu({ message, x, y }), []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeForward = useCallback(() => setForwarding(null), []);
  const closeLightbox = useCallback(() => setLightbox(null), []);

  const jumpTo = useCallback(async target => {
    const has = () => messagesRef.current.some(m => m.messageId === target.messageId);
    if (has()) {
      const el = document.getElementById('msg-' + target.messageId);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFlashId(target.messageId);
      return;
    }
    if (!target.createdAt) { onToast('Không xác định được vị trí tin nhắn.'); return; }
    await openWindow(target);
  }, [openWindow, onToast]);

  const openImage = useCallback(image => setLightbox(image), []);

  // Nhay toi tin tu ket qua tim kiem / nguon AI (sau khi trang dau da tai xong).
  const jumpRef = useRef(null);
  useEffect(() => { jumpRef.current = jumpTo; }, [jumpTo]);
  useEffect(() => {
    if (!jumpTarget || phase !== 'ready') return;
    jumpTo(jumpTarget);
    onJumpDone?.();
  }, [jumpTarget, phase, jumpTo, onJumpDone]);

  async function pinIt(m) {
    try {
      applyPins(await api.pinMessage(id, m));
      onToast('Đã ghim tin nhắn.');
    } catch (err) {
      onToast(err.message);
    }
  }

  async function unpinIt(pin) {
    try {
      applyPins(await api.unpinMessage(id, pin.messageId));
      onToast('Đã bỏ ghim tin nhắn.');
    } catch (err) {
      onToast(err.message);
      loadPins();
    }
  }

  function menuItems(m) {
    const items = [];
    if (!m.isDeleted) items.push({ key: 'reply', label: 'Trả lời', icon: Reply, onSelect: () => startReply(m) });
    if (!m.isDeleted && m.content) {
      items.push({
        key: 'copy', label: 'Sao chép', icon: Copy,
        onSelect: async () => onToast((await copyText(m.content)) ? 'Đã sao chép tin nhắn.' : 'Trình duyệt chặn sao chép, hãy bôi đen và sao chép thủ công.')
      });
    }
    if (!m.isDeleted) items.push({ key: 'forward', label: 'Chuyển tiếp', icon: Forward, onSelect: () => setForwarding(m) });
    const pinned = pins.find(p => p.messageId === m.messageId);
    if (pinned?.canUnpin) items.push({ key: 'unpin', label: 'Bỏ ghim', icon: PinOff, onSelect: () => setConfirming({ type: 'unpin', message: pinned }) });
    else if (!pinned && !m.isDeleted && m.messageType !== 'SYSTEM') items.push({ key: 'pin', label: 'Ghim tin nhắn', icon: Pin, onSelect: () => pinIt(m) });
    if (m.senderId === user.userId && !m.isDeleted) {
      items.push({ key: 'recall', label: 'Thu hồi', icon: Undo2, danger: true, onSelect: () => setConfirming({ type: 'recall', message: m }) });
    }
    if (canEdit(m, user.userId)) items.push({ key: 'edit', label: 'Sửa tin nhắn', icon: Pencil, onSelect: () => setExtDialog({ type: 'edit', message: m }) });
    if (m.extra?.editedAt && !m.isDeleted) items.push({ key: 'history', label: 'Lịch sử chỉnh sửa', icon: History, onSelect: () => setExtDialog({ type: 'history', message: m }) });
    if (!m.isDeleted && m.content && m.messageType !== 'SYSTEM') items.push({ key: 'translate', label: 'Dịch (AI)', icon: Languages, onSelect: () => setExtDialog({ type: 'translate', message: m }) });
    if (!m.isDeleted && m.senderId !== user.userId && m.messageType !== 'SYSTEM') items.push({ key: 'report', label: 'Báo cáo', icon: Flag, danger: true, onSelect: () => setExtDialog({ type: 'report', message: m }) });
    items.push({ key: 'hide', label: 'Xóa phía tôi', icon: EyeOff, danger: true, onSelect: () => setConfirming({ type: 'hide', message: m }) });
    return items;
  }

  // "Da gui" / "Da xem" chi dua tren moc last_read_at that cua thanh vien (khong gia "da nhan").
  const lastVisible = [...messages].reverse().find(m => m.messageType !== 'SYSTEM');
  let statusFor = null;
  let statusText = null;
  if (lastVisible && lastVisible.senderId === user.userId && !lastVisible.isDeleted) {
    const others = members.filter(m => m.userId !== user.userId);
    const seen = others.filter(m => m.lastReadAt && new Date(m.lastReadAt) >= new Date(lastVisible.createdAt));
    statusFor = lastVisible.messageId;
    if (!isGroup) statusText = seen.length ? 'Đã xem' : 'Đã gửi';
    else statusText = seen.length === 0 ? 'Đã gửi'
      : seen.length === others.length ? 'Tất cả đã xem'
        : `${seen.length} người đã xem`;
  }

  const peer = !isGroup ? members.find(m => m.userId !== user.userId) : null;
  let subtitle = isGroup ? 'Nhóm chat' : 'Trò chuyện cá nhân';
  if (isGroup && members.length) {
    const onlineCount = members.filter(m => m.online && m.userId !== user.userId).length;
    subtitle = `${members.length} thành viên` + (onlineCount ? ` · ${onlineCount} đang hoạt động` : '');
  } else if (peer?.online) subtitle = 'Đang hoạt động';
  else if (peer?.lastSeenAt) subtitle = lastSeenText(peer.lastSeenAt);

  const typingNames = Object.values(typing).map(t => t.name.split(' ').slice(-1)[0]);

  function renderMessages() {
    const out = [];
    messages.forEach((m, i) => {
      const prev = messages[i - 1];
      const next = messages[i + 1];
      if (!prev || !sameDay(prev.createdAt, m.createdAt)) {
        out.push(<div key={'d' + m.messageId} className="day-divider"><span>{formatDayDivider(m.createdAt)}</span></div>);
      }
      if (m.messageType === 'SYSTEM') {
        out.push(<div key={m.messageId} id={'msg-' + m.messageId} className="system-msg"><span>{m.content}</span></div>);
        return;
      }
      const joinsPrev = prev && prev.messageType !== 'SYSTEM' && prev.senderId === m.senderId &&
        sameDay(prev.createdAt, m.createdAt) && new Date(m.createdAt) - new Date(prev.createdAt) < GROUP_GAP_MS;
      const joinsNext = next && next.messageType !== 'SYSTEM' && next.senderId === m.senderId &&
        sameDay(next.createdAt, m.createdAt) && new Date(next.createdAt) - new Date(m.createdAt) < GROUP_GAP_MS;
      out.push(
        <MessageItem
          key={m.messageId}
          m={m}
          mine={m.senderId === user.userId}
          isGroup={isGroup}
          joinsPrev={joinsPrev}
          joinsNext={joinsNext}
          conversationId={id}
          userId={user.userId}
          memberNames={memberNames}
          highlighted={flashId === m.messageId}
          status={statusFor === m.messageId ? statusText : null}
          onReply={startReply}
          onReact={react}
          onMenu={openMenu}
          onJump={jumpTo}
          onOpenImage={openImage}
          onOpenProfile={onOpenProfile}
        />
      );
    });
    return out;
  }

  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');

  return (
    <section
      className="chat"
      aria-label={'Trò chuyện với ' + conversation.displayName}
      onDragEnter={e => { if (hasFiles(e)) { e.preventDefault(); dragDepth.current += 1; setDragging(true); } }}
      onDragOver={e => { if (hasFiles(e)) e.preventDefault(); }}
      onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
      onDrop={e => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (phase === 'ready') composerRef.current?.addFiles(e.dataTransfer.files);
      }}
    >
      <header className="chat-head">
        <button type="button" className="icon-btn back-btn" onClick={onBack} aria-label="Quay lại danh sách">
          <ArrowLeft size={20} />
        </button>
        <Avatar name={conversation.displayName} seed={id} group={isGroup} size={42} online={Boolean(peer?.online)} />
        <div className="chat-title">
          <h2>{conversation.displayName}</h2>
          <p className={peer?.online ? 'online' : ''}>{subtitle}</p>
        </div>
        <button type="button" className={'icon-btn' + (searchOpen ? ' on' : '')} onClick={onToggleSearch}
          title="Tìm kiếm trong trò chuyện" aria-label="Tìm kiếm trong trò chuyện" aria-pressed={Boolean(searchOpen)}>
          <Search size={20} />
        </button>
        <button
          type="button"
          className={'icon-btn' + (infoOpen ? ' on' : '')}
          onClick={onToggleInfo}
          title={infoOpen ? 'Ẩn thông tin hội thoại' : 'Thông tin hội thoại'}
          aria-label="Thông tin hội thoại"
          aria-pressed={infoOpen}
        >
          {infoOpen ? <PanelRightClose size={20} /> : <PanelRightOpen size={20} />}
        </button>
      </header>

      <div className={'chat-body' + (pins.length ? ' has-pins' : '')}>
        <PinBar pins={pins} onOpen={p => jumpTo({ messageId: p.messageId, createdAt: p.createdAt })}
          onUnpin={p => setConfirming({ type: 'unpin', message: p })} />
        <div className="messages" ref={scrollRef} onScroll={onScroll}>
          {phase === 'ready' && (
            <div ref={sentinelRef} className="history-edge">
              {loadingOlder ? (
                <span><LoaderCircle size={15} className="spin" /> Đang tải tin cũ hơn…</span>
              ) : hasMore ? (
                <button type="button" className="link-btn" onClick={loadOlder}>Tải tin cũ hơn</button>
              ) : messages.length > 0 ? (
                <span>Đã hiển thị toàn bộ lịch sử</span>
              ) : null}
            </div>
          )}

          {phase === 'loading' && <div className="chat-state"><LoaderCircle className="spin" size={22} /> Đang tải tin nhắn…</div>}
          {phase === 'error' && (
            <div className="chat-state">
              <p className="error-text">{loadError}</p>
              <button type="button" className="btn secondary small" onClick={loadFirst}><RotateCcw size={15} /> Thử lại</button>
            </div>
          )}
          {phase === 'ready' && messages.length === 0 && !hasMore && (
            <div className="chat-state">
              <Avatar name={conversation.displayName} seed={id} group={isGroup} size={64} />
              <p>Chưa có tin nhắn. Gửi lời chào đầu tiên nhé.</p>
            </div>
          )}

          {renderMessages()}
          {phase === 'ready' && detached && (
            <div ref={bottomRef} className="history-edge">
              {loadingNewer ? <span><LoaderCircle size={15} className="spin" /> Đang tải tin mới hơn…</span>
                : <button type="button" className="link-btn" onClick={loadNewer}>Tải tin mới hơn</button>}
            </div>
          )}
        </div>

        {typingNames.length > 0 && (
          <div className="typing" aria-live="polite">
            <span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>
            {typingNames.length === 1 ? `${typingNames[0]} đang nhập…` : `${typingNames.slice(0, 2).join(', ')}${typingNames.length > 2 ? '…' : ''} đang nhập…`}
          </div>
        )}

        {(newBelow > 0 || detached) && (
          <button type="button" className="new-below" onClick={scrollToBottom}>
            <ArrowDown size={15} /> {newBelow > 0 ? `${newBelow} tin nhắn mới` : 'Về tin mới nhất'}
          </button>
        )}

        {demoMode && stats && (
          <div className="db-badge" title="Số liệu của lần tải gần nhất (SRS FR-13)">
            Trang {stats.page} · {stats.count} tin · Cassandra {stats.db} ms · API {stats.total} ms
          </div>
        )}

        {dragging && (
          <div className="drop-zone" aria-hidden="true">
            <Upload size={34} />
            <strong>Thả tệp để đính kèm</strong>
            <span>Ảnh, video MP4, PDF, DOCX, XLSX, TXT, ZIP · tối đa 20 MB/tệp, 5 tệp/tin</span>
          </div>
        )}
      </div>

      <ChatExtrasBar conversationId={id} isGroup={isGroup} disabled={phase !== 'ready'} onSent={addSent} onToast={onToast}
        onInsertText={t => composerRef.current?.insertText?.(t)} />
      <Composer
        ref={composerRef}
        conversationId={id}
        disabled={phase !== 'ready'}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        onSend={send}
        onTyping={() => api.typing(id).catch(() => {})}
        members={members}
        selfId={user.userId}
      />

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.message)} onClose={closeMenu} />}

      {confirming && (
        <ConfirmDialog
          title={confirming.type === 'recall' ? 'Thu hồi tin nhắn?' : confirming.type === 'unpin' ? 'Bỏ ghim tin nhắn?' : 'Xóa tin nhắn ở phía bạn?'}
          message={confirming.type === 'recall'
            ? 'Mọi người trong cuộc trò chuyện sẽ thấy “Tin nhắn đã được thu hồi” thay cho nội dung và tệp đính kèm.'
            : confirming.type === 'unpin' ? 'Tin nhắn sẽ không còn trên thanh ghim của mọi thành viên. Tin nhắn vẫn giữ nguyên trong cuộc trò chuyện.'
            : 'Tin nhắn chỉ bị ẩn trên các thiết bị của bạn. Những người khác vẫn thấy bình thường.'}
          confirmLabel={confirming.type === 'recall' ? 'Thu hồi' : confirming.type === 'unpin' ? 'Bỏ ghim' : 'Xóa phía tôi'}
          danger
          onConfirm={() => {
            const { type, message } = confirming;
            setConfirming(null);
            if (type === 'recall') recall(message); else if (type === 'unpin') unpinIt(message); else hide(message);
          }}
          onCancel={() => setConfirming(null)}
        />
      )}

      {forwarding && (
        <ForwardModal
          source={{ conversationId: id, message: forwarding }}
          conversations={conversations}
          onClose={closeForward}
          onDone={() => onChanged()}
        />
      )}

      {extDialog?.type === 'edit' && (
        <EditMessageDialog conversationId={id} message={extDialog.message} onToast={onToast} onClose={() => setExtDialog(null)}
          onSaved={m => { setMessages(list => list.map(x => (x.messageId === m.messageId ? { ...x, content: m.content, extra: m.extra } : x))); onChanged(); }} />
      )}
      {extDialog?.type === 'history' && <EditHistoryDialog conversationId={id} message={extDialog.message} onClose={() => setExtDialog(null)} />}
      {extDialog?.type === 'translate' && <TranslateDialog conversationId={id} message={extDialog.message} onClose={() => setExtDialog(null)} />}
      {extDialog?.type === 'report' && (
        <ReportDialog onToast={onToast} onClose={() => setExtDialog(null)}
          target={{ targetType: 'MESSAGE', targetId: extDialog.message.messageId, conversationId: id, createdAt: extDialog.message.createdAt, label: 'tin nhắn' }} />
      )}
      {lightbox && <Lightbox conversationId={id} image={lightbox} onClose={closeLightbox} />}
    </section>
  );
}
