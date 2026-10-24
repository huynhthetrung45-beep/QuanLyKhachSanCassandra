// Phong hop WebRTC (mesh): am thanh, hinh anh, chia se man hinh, chat trong phong.
// Tin hieu (offer / answer / ICE) di qua backend: POST /meetings/:id/signal (ma tham gia trong header) -> SSE 'meeting:signal'.
// Nguoi moi vao gui offer toi tung nguoi dang o trong phong; nguoi cu chi tra loi -> khong bi 2 ben cung gui offer.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, MessageSquare, MonitorUp, MonitorX, PhoneOff, Power, Settings2, Users, Video, VideoOff, Wifi, WifiOff, X } from 'lucide-react';
import { useSse } from './sse';
import { work } from './workApi';
import './work.css';

const MEDIA_ERRORS = {
  NotAllowedError: 'Bạn đã chặn quyền dùng micro / camera. Hãy cho phép trong cài đặt trình duyệt rồi vào lại. Bạn vẫn có thể nghe, xem và chat.',
  NotFoundError: 'Không tìm thấy micro hoặc camera. Bạn vẫn có thể nghe, xem và chat.',
  NotReadableError: 'Micro / camera đang được ứng dụng khác sử dụng.',
  OverconstrainedError: 'Thiết bị đã chọn không còn khả dụng.'
};

function VideoTile({ stream, label, muted, self, state, status }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream || null; }, [stream]);
  const hasVideo = stream && stream.getVideoTracks().some(t => t.readyState === 'live') && state?.video !== false;
  return (
    <div className={'mt-tile' + (self ? ' self' : '')} data-peer-label={label}>
      <video ref={ref} autoPlay playsInline muted={muted} className={hasVideo || state?.screen ? '' : 'off'} />
      {!(hasVideo || state?.screen) && <div className="mt-avatar">{(label || '?').trim().split(/\s+/).pop()?.[0]?.toUpperCase()}</div>}
      <div className="mt-name">
        {state?.audio === false ? <MicOff size={13} /> : <Mic size={13} />} {label}{self ? ' (bạn)' : ''}{state?.screen ? ' · đang chia sẻ màn hình' : ''}
        {status && status !== 'connected' && !self && <span className="mt-status">{status === 'failed' ? 'mất kết nối' : 'đang kết nối…'}</span>}
      </div>
    </div>
  );
}

export default function MeetingRoom({ meetingId, user, onClose, onToast }) {
  const [phase, setPhase] = useState('preparing'); // preparing | joining | live | ended | error
  const [error, setError] = useState('');
  const [mediaWarn, setMediaWarn] = useState('');
  const [meeting, setMeeting] = useState(null);
  const [peers, setPeers] = useState({}); // sessionId -> { userId, displayName, stream, state, status }
  const [local, setLocal] = useState({ stream: null, audio: true, video: true, screen: false });
  const [chat, setChat] = useState([]);
  const [chatText, setChatText] = useState('');
  const [panel, setPanel] = useState(null); // chat | people | devices
  const [devices, setDevices] = useState({ audio: [], video: [] });
  const [online, setOnline] = useState(navigator.onLine);
  const me = useRef({ sessionId: null, token: null, ice: [] });
  const pcs = useRef(new Map()); // sessionId -> { pc, offerer, pending: [] }
  const localStream = useRef(null);
  const screenTrack = useRef(null);
  const closed = useRef(false);

  const patchPeer = useCallback((sid, patch) => setPeers(p => ({ ...p, [sid]: { ...(p[sid] || {}), ...patch } })), []);
  const send = useCallback((to, type, payload) => work.signal(meetingId, me.current.token, { toSessionId: to, type, payload }).catch(err => {
    if (err.code === 'NOT_IN_ROOM' || err.code === 'MEETING_TOKEN_EXPIRED') rejoin();
  }), [meetingId]); // eslint-disable-line react-hooks/exhaustive-deps

  function closePeer(sid) {
    const entry = pcs.current.get(sid);
    if (entry) { try { entry.pc.close(); } catch { /* bo qua */ } }
    pcs.current.delete(sid);
    setPeers(p => { const n = { ...p }; delete n[sid]; return n; });
  }

  function createPeer(sid, info, offerer) {
    closePeer(sid);
    const pc = new RTCPeerConnection({ iceServers: me.current.ice });
    const entry = { pc, offerer, pending: [] };
    pcs.current.set(sid, entry);
    const stream = localStream.current;
    if (stream) {
      for (const track of stream.getTracks()) {
        const t = track.kind === 'video' && screenTrack.current ? screenTrack.current : track;
        pc.addTrack(t, stream);
      }
    }
    // Khong co thiet bi van nhan duoc am thanh / hinh anh cua nguoi khac.
    if (!stream || !stream.getAudioTracks().length) pc.addTransceiver('audio', { direction: 'recvonly' });
    if (!stream || !stream.getVideoTracks().length) pc.addTransceiver('video', { direction: 'recvonly' });
    pc.onicecandidate = e => e.candidate && send(sid, 'ice', e.candidate.toJSON());
    pc.ontrack = e => patchPeer(sid, { stream: e.streams[0] || new MediaStream([e.track]) });
    pc.onconnectionstatechange = () => {
      patchPeer(sid, { status: pc.connectionState });
      if (pc.connectionState === 'failed' && entry.offerer) {
        pc.createOffer({ iceRestart: true }).then(o => pc.setLocalDescription(o)).then(() => send(sid, 'offer', pc.localDescription.toJSON())).catch(() => {});
      }
    };
    patchPeer(sid, { ...info, status: 'connecting' });
    return entry;
  }

  async function call(sid, info) {
    const { pc } = createPeer(sid, info, true);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await send(sid, 'offer', pc.localDescription.toJSON());
  }

  async function flush(entry) {
    for (const c of entry.pending.splice(0)) await entry.pc.addIceCandidate(c).catch(() => {});
  }

  async function onSignal(d) {
    if (d.meetingId !== meetingId || d.toSessionId !== me.current.sessionId) return;
    let entry = pcs.current.get(d.fromSessionId);
    try {
      if (d.type === 'offer') {
        if (!entry) entry = createPeer(d.fromSessionId, { userId: d.fromUserId, displayName: d.fromDisplayName }, false);
        await entry.pc.setRemoteDescription(d.payload);
        await flush(entry);
        const answer = await entry.pc.createAnswer();
        await entry.pc.setLocalDescription(answer);
        await send(d.fromSessionId, 'answer', entry.pc.localDescription.toJSON());
      } else if (d.type === 'answer' && entry) {
        await entry.pc.setRemoteDescription(d.payload);
        await flush(entry);
      } else if (d.type === 'ice' && entry) {
        if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(d.payload).catch(() => {});
        else entry.pending.push(d.payload);
      }
    } catch (err) {
      console.warn('[họp] Lỗi tín hiệu', err);
    }
  }

  async function getMedia(constraints = { audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 } } }) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (constraints.video && err.name !== 'NotAllowedError') {
        try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); setMediaWarn('Không mở được camera, chỉ dùng micro.'); return s; } catch { /* tiep */ }
      }
      setMediaWarn(MEDIA_ERRORS[err.name] || `Không truy cập được micro / camera (${err.name}).`);
      return null;
    }
  }

  async function enter() {
    setPhase('joining');
    try {
      const storeKey = 'chatott.meeting.' + meetingId;
      let previous = me.current.sessionId;
      try { previous = previous || sessionStorage.getItem(storeKey); } catch { /* bo qua */ }
      const r = await work.join(meetingId, previous || undefined);
      me.current = { sessionId: r.sessionId, token: r.token, ice: r.iceServers };
      try { sessionStorage.setItem(storeKey, r.sessionId); } catch { /* bo qua */ }
      setMeeting(r.meeting);
      setPhase('live');
      const st = localStream.current;
      await work.media(meetingId, r.token, { audio: Boolean(st?.getAudioTracks()[0]?.enabled), video: Boolean(st?.getVideoTracks()[0]?.enabled), screen: false }).catch(() => {});
      for (const p of r.participants) await call(p.sessionId, { userId: p.userId, displayName: p.displayName, state: { audio: p.audio, video: p.video, screen: p.screen } });
    } catch (err) {
      setError(err.message);
      setPhase(err.code === 'MEETING_CLOSED' ? 'ended' : 'error');
    }
  }

  async function rejoin() {
    if (closed.current) return;
    for (const sid of [...pcs.current.keys()]) closePeer(sid);
    await enter();
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      const stream = await getMedia();
      if (!alive) { stream?.getTracks().forEach(t => t.stop()); return; }
      localStream.current = stream;
      setLocal(l => ({ ...l, stream, audio: Boolean(stream?.getAudioTracks().length), video: Boolean(stream?.getVideoTracks().length) }));
      navigator.mediaDevices?.enumerateDevices?.().then(list => setDevices({
        audio: list.filter(d => d.kind === 'audioinput'), video: list.filter(d => d.kind === 'videoinput')
      })).catch(() => {});
      await enter();
    })();
    const leave = () => { if (me.current.token) fetch(`${import.meta.env.VITE_API_BASE || '/api/v1'}/meetings/${meetingId}/leave`, {
      method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Meeting-Token': me.current.token }, body: '{}'
    }).catch(() => {}); };
    window.addEventListener('pagehide', leave);
    const goOnline = () => { setOnline(true); rejoin(); };
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      alive = false;
      closed.current = true;
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      leave();
      for (const sid of [...pcs.current.keys()]) { try { pcs.current.get(sid).pc.close(); } catch { /* bo qua */ } }
      pcs.current.clear();
      localStream.current?.getTracks().forEach(t => t.stop());
      screenTrack.current?.stop();
    };
  }, [meetingId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Heartbeat: may chu don nguoi im lang qua 45s; mat phien -> vao lai.
  useEffect(() => {
    if (phase !== 'live') return undefined;
    const t = setInterval(() => work.heartbeat(meetingId, me.current.token).catch(err => {
      if (err.code === 'NOT_IN_ROOM' || err.code === 'MEETING_TOKEN_EXPIRED') rejoin();
    }), 15000);
    return () => clearInterval(t);
  }, [phase, meetingId]); // eslint-disable-line react-hooks/exhaustive-deps

  useSse('meeting:signal', onSignal);
  useSse(['meeting:joined', 'meeting:left', 'meeting:media', 'meeting:chat', 'meeting:ended'], (d, name) => {
    if (d?.meetingId !== meetingId) return;
    if (name === 'meeting:joined' && d.participant.sessionId !== me.current.sessionId) {
      patchPeer(d.participant.sessionId, { userId: d.participant.userId, displayName: d.participant.displayName, status: 'connecting',
        state: { audio: d.participant.audio, video: d.participant.video, screen: d.participant.screen } });
      onToast?.(`${d.participant.displayName} đã vào phòng.`);
    }
    if (name === 'meeting:left' && d.sessionId !== me.current.sessionId) closePeer(d.sessionId);
    if (name === 'meeting:media' && d.sessionId !== me.current.sessionId) patchPeer(d.sessionId, { state: { audio: d.audio, video: d.video, screen: d.screen } });
    if (name === 'meeting:chat') setChat(c => [...c, d.message].slice(-200));
    if (name === 'meeting:ended') {
      setPhase('ended');
      setError(d.reason === 'cancelled' ? 'Cuộc họp đã bị hủy.' : 'Người tổ chức đã kết thúc cuộc họp.');
      for (const sid of [...pcs.current.keys()]) closePeer(sid);
      me.current.token = null;
    }
  });

  const pushMedia = next => work.media(meetingId, me.current.token, { audio: next.audio, video: next.video, screen: next.screen }).catch(() => {});
  function toggle(kind) {
    const track = kind === 'audio' ? localStream.current?.getAudioTracks()[0] : localStream.current?.getVideoTracks()[0];
    if (!track) { onToast?.(kind === 'audio' ? 'Không có micro.' : 'Không có camera.'); return; }
    track.enabled = !track.enabled;
    const next = { ...local, [kind]: track.enabled };
    setLocal(next);
    pushMedia(next);
  }

  const videoSenders = () => [...pcs.current.values()].map(e => e.pc.getSenders().find(s => s.track?.kind === 'video')).filter(Boolean);

  async function toggleScreen() {
    if (screenTrack.current) {
      const cam = localStream.current?.getVideoTracks()[0];
      screenTrack.current.stop();
      screenTrack.current = null;
      for (const s of videoSenders()) await s.replaceTrack(cam || null).catch(() => {});
      const next = { ...local, screen: false };
      setLocal(next);
      pushMedia(next);
      return;
    }
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = display.getVideoTracks()[0];
      screenTrack.current = track;
      const senders = videoSenders();
      if (!senders.length && !localStream.current?.getVideoTracks().length) onToast?.('Chia sẻ màn hình cần camera hoặc kết nối lại để gửi hình.');
      for (const s of senders) await s.replaceTrack(track);
      track.onended = () => { if (screenTrack.current === track) toggleScreen(); };
      const next = { ...local, screen: true };
      setLocal(next);
      pushMedia(next);
    } catch (err) {
      if (err.name !== 'NotAllowedError') onToast?.('Không chia sẻ được màn hình: ' + err.message);
    }
  }

  async function switchDevice(kind, deviceId) {
    try {
      const s = await navigator.mediaDevices.getUserMedia(kind === 'audio' ? { audio: { deviceId: { exact: deviceId } } } : { video: { deviceId: { exact: deviceId } } });
      const track = s.getTracks()[0];
      const stream = localStream.current || new MediaStream();
      const old = kind === 'audio' ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
      if (old) { stream.removeTrack(old); old.stop(); }
      stream.addTrack(track);
      localStream.current = stream;
      for (const e of pcs.current.values()) {
        const sender = e.pc.getSenders().find(x => x.track?.kind === kind || (!x.track && e.pc.getTransceivers().find(t => t.sender === x)?.receiver.track.kind === kind));
        if (sender && !(kind === 'video' && screenTrack.current)) await sender.replaceTrack(track).catch(() => {});
      }
      setLocal(l => ({ ...l, stream: new MediaStream(stream.getTracks()), [kind]: true }));
    } catch (err) {
      onToast?.(MEDIA_ERRORS[err.name] || 'Không đổi được thiết bị.');
    }
  }

  async function sendChat(e) {
    e.preventDefault();
    const text = chatText.trim();
    if (!text) return;
    setChatText('');
    try { await work.chat(meetingId, me.current.token, text); } catch (err) { onToast?.(err.message); setChatText(text); }
  }

  async function end() {
    try { await work.endMeeting(meetingId); } catch (err) { onToast?.(err.message); }
  }

  const peerList = Object.entries(peers);
  const count = peerList.length + 1;
  return (
    <div className="mt-room" role="dialog" aria-modal="true" aria-label="Phòng họp">
      <header className="mt-head">
        <b>{meeting?.title || 'Phòng họp'}</b>
        <span className="mt-sub">{phase === 'live' ? `${count} người` : phase === 'joining' ? 'Đang vào phòng…' : phase === 'preparing' ? 'Đang mở micro / camera…' : ''}</span>
        {!online && <span className="mt-warn"><WifiOff size={14} /> Mất mạng – sẽ tự kết nối lại</span>}
        {online && phase === 'live' && <span className="mt-ok"><Wifi size={14} /></span>}
        <button type="button" className="icon-btn mt-x" aria-label="Rời phòng" onClick={onClose}><X size={18} /></button>
      </header>
      {mediaWarn && <p className="mt-banner">{mediaWarn}</p>}
      {(phase === 'ended' || phase === 'error') ? (
        <div className="mt-center">
          <p>{error || 'Cuộc họp đã kết thúc.'}</p>
          <div className="mt-center-actions">
            {phase === 'error' && <button type="button" className="btn primary" onClick={rejoin}>Thử lại</button>}
            <button type="button" className="btn secondary" onClick={onClose}>Đóng</button>
          </div>
        </div>
      ) : (
        <div className="mt-body">
          <div className={`mt-grid n${Math.min(count, 9)}`}>
            <VideoTile self muted stream={local.stream} label={user.displayName} state={local} />
            {peerList.map(([sid, p]) => <VideoTile key={sid} stream={p.stream} label={p.displayName || p.userId} state={p.state} status={p.status} />)}
          </div>
          {panel && (
            <aside className="mt-panel">
              <div className="mt-panel-head"><b>{panel === 'chat' ? 'Chat trong phòng' : panel === 'people' ? `Người tham gia (${count})` : 'Thiết bị'}</b>
                <button type="button" className="icon-btn" aria-label="Đóng" onClick={() => setPanel(null)}><X size={16} /></button></div>
              {panel === 'chat' && (
                <>
                  <div className="mt-chat">
                    {chat.map(m => <p key={m.id}><b>{m.displayName}</b> <span>{new Date(m.at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</span><br />{m.content}</p>)}
                    {!chat.length && <p className="mt-muted">Tin nhắn chỉ hiện trong phòng và không được lưu lại.</p>}
                  </div>
                  <form className="mt-chat-form" onSubmit={sendChat}>
                    <input value={chatText} maxLength={1000} onChange={e => setChatText(e.target.value)} placeholder="Nhắn cho mọi người…" aria-label="Tin nhắn" />
                    <button type="submit" className="btn small primary" disabled={!chatText.trim()}>Gửi</button>
                  </form>
                </>
              )}
              {panel === 'people' && (
                <ul className="mt-people">
                  <li>{user.displayName} (bạn){meeting?.isOrganizer ? ' · tổ chức' : ''}</li>
                  {peerList.map(([sid, p]) => (
                    <li key={sid}>{p.displayName || p.userId}{p.userId === meeting?.organizer?.userId ? ' · tổ chức' : ''}
                      <span>{p.state?.audio === false ? <MicOff size={13} /> : <Mic size={13} />}{p.state?.video === false ? <VideoOff size={13} /> : <Video size={13} />}</span></li>
                  ))}
                </ul>
              )}
              {panel === 'devices' && (
                <div className="mt-devices">
                  <label>Micro<select onChange={e => switchDevice('audio', e.target.value)} defaultValue="">
                    <option value="" disabled>Chọn micro</option>{devices.audio.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Micro'}</option>)}</select></label>
                  <label>Camera<select onChange={e => switchDevice('video', e.target.value)} defaultValue="">
                    <option value="" disabled>Chọn camera</option>{devices.video.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Camera'}</option>)}</select></label>
                </div>
              )}
            </aside>
          )}
        </div>
      )}
      {phase === 'live' && (
        <footer className="mt-bar">
          <button type="button" className={'mt-btn' + (local.audio ? '' : ' off')} onClick={() => toggle('audio')} aria-label={local.audio ? 'Tắt micro' : 'Bật micro'} title={local.audio ? 'Tắt micro' : 'Bật micro'}>
            {local.audio ? <Mic size={20} /> : <MicOff size={20} />}</button>
          <button type="button" className={'mt-btn' + (local.video ? '' : ' off')} onClick={() => toggle('video')} aria-label={local.video ? 'Tắt camera' : 'Bật camera'} title={local.video ? 'Tắt camera' : 'Bật camera'}>
            {local.video ? <Video size={20} /> : <VideoOff size={20} />}</button>
          {navigator.mediaDevices?.getDisplayMedia && (
            <button type="button" className={'mt-btn' + (local.screen ? ' on' : '')} onClick={toggleScreen} aria-label="Chia sẻ màn hình" title={local.screen ? 'Dừng chia sẻ' : 'Chia sẻ màn hình'}>
              {local.screen ? <MonitorX size={20} /> : <MonitorUp size={20} />}</button>
          )}
          <button type="button" className={'mt-btn' + (panel === 'chat' ? ' on' : '')} onClick={() => setPanel(p => (p === 'chat' ? null : 'chat'))} aria-label="Chat" title="Chat"><MessageSquare size={20} /></button>
          <button type="button" className={'mt-btn' + (panel === 'people' ? ' on' : '')} onClick={() => setPanel(p => (p === 'people' ? null : 'people'))} aria-label="Người tham gia" title="Người tham gia"><Users size={20} /></button>
          <button type="button" className={'mt-btn' + (panel === 'devices' ? ' on' : '')} onClick={() => setPanel(p => (p === 'devices' ? null : 'devices'))} aria-label="Thiết bị" title="Chọn thiết bị"><Settings2 size={20} /></button>
          <button type="button" className="mt-btn leave" onClick={onClose} aria-label="Rời phòng" title="Rời phòng"><PhoneOff size={20} /></button>
          {meeting?.isOrganizer && <button type="button" className="mt-btn end" onClick={end} title="Kết thúc cuộc họp cho mọi người"><Power size={18} /> Kết thúc</button>}
        </footer>
      )}
    </div>
  );
}
