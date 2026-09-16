import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import { v4 as uuidv4 } from 'uuid';
import { encryptMessage, decryptMessage } from './utils/crypto';

const API = '';

// Strong TURN over TCP 443 for Russia / hard NAT / DPI
const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
  ],
  iceCandidatePoolSize: 10
};

function playBeep(freq = 700, dur = 0.12) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = freq; g.gain.value = 0.07;
    o.start(); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    o.stop(ctx.currentTime + dur);
  } catch {}
}

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [user, setUser] = useState(null);
  const [view, setView] = useState(token ? 'app' : 'login');
  const [online, setOnline] = useState([]);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [channel, setChannel] = useState('general'); // general | dm:USERID
  const [dmUser, setDmUser] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [nsfwOk, setNsfwOk] = useState(false);

  // Call state
  const [call, setCall] = useState(null); // { status, peer, localStream, remoteStream, screen }
  const [incoming, setIncoming] = useState(null);
  const [muted, setMuted] = useState(false);
  const [sharing, setSharing] = useState(false);

  const socketRef = useRef(null);
  const endRef = useRef(null);
  const fileRef = useRef(null);
  const pcRef = useRef(null);
  const callIdRef = useRef(null);
  const localAudioRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const screenRef = useRef(null);

  const api = useCallback(async (path, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (!(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const res = await fetch(API + path, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Ошибка');
    return data;
  }, [token]);

  // Load + socket
  useEffect(() => {
    if (!token) return;
    let dead = false;

    (async () => {
      try {
        const { user: u } = await api('/api/me');
        if (dead) return;
        setUser(u);
        setView('app');

        const { messages: msgs } = await api('/api/messages?channel=general&limit=100');
        const dec = await Promise.all(msgs.map(async m => ({
          ...m, content: m.encrypted ? await decryptMessage(m.content) : m.content
        })));
        setMessages(dec);

        const s = io(window.location.origin, { auth: { token }, transports: ['websocket', 'polling'] });
        socketRef.current = s;

        s.on('online', list => setOnline(list));
        s.on('message', async msg => {
          const content = msg.encrypted ? await decryptMessage(msg.content) : msg.content;
          setMessages(prev => {
            // only show if current channel matches
            if (msg.to_user_id) {
              const isMine = msg.user_id === u.id || msg.to_user_id === u.id;
              if (!isMine) return prev;
            }
            return [...prev, { ...msg, content }];
          });
          if (msg.user_id !== u.id) playBeep(820, 0.1);
        });
        s.on('message:delete', ({ id }) => setMessages(p => p.filter(m => m.id !== id)));

        s.on('call:offer', data => {
          setIncoming(data);
          playBeep(500, 0.25);
        });
        s.on('call:answer', async ({ answer, callId }) => {
          if (pcRef.current && callIdRef.current === callId) {
            await pcRef.current.setRemoteDescription(answer);
          }
        });
        s.on('call:ice', async ({ candidate, callId }) => {
          if (pcRef.current && callIdRef.current === callId && candidate) {
            try { await pcRef.current.addIceCandidate(candidate); } catch {}
          }
        });
        s.on('call:end', () => hangup(true));
      } catch (e) {
        localStorage.removeItem('token');
        setToken(null);
        setView('login');
      }
    })();

    return () => { dead = true; socketRef.current?.disconnect(); };
  }, [token]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  // Switch channel / DM
  async function openChannel(ch, peer = null) {
    setChannel(ch);
    setDmUser(peer);
    setSidebar(false);
    try {
      const { messages: msgs } = await api(`/api/messages?channel=${encodeURIComponent(ch)}&limit=100`);
      const dec = await Promise.all(msgs.map(async m => ({
        ...m, content: m.encrypted ? await decryptMessage(m.content) : m.content
      })));
      setMessages(dec);
    } catch {}
  }

  async function authSubmit(e, isReg) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const f = e.target;
    try {
      const body = isReg
        ? { username: f.username.value.trim(), password: f.password.value, agreed: f.agreed?.checked }
        : { username: f.username.value.trim(), password: f.password.value };
      const data = await api(isReg ? '/api/register' : '/api/login', { method: 'POST', body: JSON.stringify(body) });
      localStorage.setItem('token', data.token);
      setToken(data.token);
      setUser(data.user);
      setView('app');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function send(e) {
    e?.preventDefault();
    if (!text.trim() && !fileRef.current?.files?.length) return;
    const s = socketRef.current;
    if (!s) return;

    let media_url = null, media_type = null;
    if (fileRef.current?.files?.[0]) {
      const fd = new FormData();
      fd.append('file', fileRef.current.files[0]);
      try {
        const up = await api('/api/upload', { method: 'POST', body: fd });
        media_url = up.url; media_type = up.type;
      } catch (err) { alert(err.message); return; }
      fileRef.current.value = '';
    }

    const is_nsfw = /\+|nsfw|18\+/i.test(text);
    const plain = text.trim();
    const encrypted = await encryptMessage(plain);
    const to_user_id = channel.startsWith('dm:') ? channel.slice(3) : null;

    s.emit('message', {
      content: encrypted, media_url, media_type, encrypted: true, is_nsfw,
      channel, to_user_id
    });
    setText('');
  }

  async function changeAvatar(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('avatar', file);
    try {
      const { avatar } = await api('/api/avatar', { method: 'POST', body: fd });
      setUser(u => ({ ...u, avatar }));
    } catch (err) { alert(err.message); }
  }

  // ========== CALLS ==========
  async function getMic() {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
  }

  function makePC(toUserId) {
    const pc = new RTCPeerConnection(ICE);
    pcRef.current = pc;

    pc.onicecandidate = ev => {
      if (ev.candidate) {
        socketRef.current?.emit('call:ice', { toUserId, candidate: ev.candidate, callId: callIdRef.current });
      }
    };
    pc.ontrack = ev => {
      const stream = ev.streams[0];
      if (remoteAudioRef.current) remoteAudioRef.current.srcObject = stream;
      setCall(c => c ? { ...c, remoteStream: stream } : c);
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) hangup(true);
    };
    return pc;
  }

  async function startCall(peer, withScreen = false) {
    try {
      const localStream = await getMic();
      const callId = uuidv4();
      callIdRef.current = callId;
      const pc = makePC(peer.id);

      localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
      if (localAudioRef.current) localAudioRef.current.srcObject = localStream;

      if (withScreen) {
        const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        screen.getTracks().forEach(t => {
          pc.addTrack(t, screen);
          t.onended = () => hangup();
        });
        screenRef.current = screen;
        setSharing(true);
      }

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socketRef.current.emit('call:offer', {
        toUserId: peer.id, offer, callId, withScreen
      });
      setCall({ status: 'calling', peer, localStream });
    } catch (e) {
      alert('Микрофон / экран: ' + e.message);
    }
  }

  async function acceptCall() {
    if (!incoming) return;
    try {
      const localStream = await getMic();
      callIdRef.current = incoming.callId;
      const pc = makePC(incoming.from.id);
      localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
      if (localAudioRef.current) localAudioRef.current.srcObject = localStream;

      await pc.setRemoteDescription(incoming.offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socketRef.current.emit('call:answer', {
        toUserId: incoming.from.id, answer, callId: incoming.callId
      });
      setCall({ status: 'active', peer: incoming.from, localStream });
      setIncoming(null);
    } catch (e) {
      alert(e.message);
      setIncoming(null);
    }
  }

  function hangup(silent = false) {
    if (call?.peer && !silent) {
      socketRef.current?.emit('call:end', { toUserId: call.peer.id, callId: callIdRef.current });
    }
    call?.localStream?.getTracks().forEach(t => t.stop());
    screenRef.current?.getTracks().forEach(t => t.stop());
    pcRef.current?.close();
    pcRef.current = null;
    callIdRef.current = null;
    setCall(null);
    setSharing(false);
    setMuted(false);
    setIncoming(null);
  }

  function toggleMute() {
    const stream = call?.localStream;
    if (!stream) return;
    stream.getAudioTracks().forEach(t => { t.enabled = muted; });
    setMuted(m => !m);
  }

  async function toggleScreen() {
    if (sharing) {
      screenRef.current?.getTracks().forEach(t => t.stop());
      setSharing(false);
      return;
    }
    if (!call?.peer || !pcRef.current) return;
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = screen.getVideoTracks()[0];
      pcRef.current.addTrack(track, screen);
      track.onended = () => setSharing(false);
      screenRef.current = screen;
      setSharing(true);
    } catch {}
  }

  function logout() {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
    setView('login');
    socketRef.current?.disconnect();
  }

  const isMod = user?.role === 'owner' || user?.role === 'mod';

  // ===== RENDER =====
  if (view === 'terms') {
    return (
      <div className="h-full flex items-center justify-center bg-bg p-4 overflow-auto">
        <div className="max-w-lg w-full bg-panel border border-border rounded-xl p-5 anim">
          <h1 className="text-lg font-semibold text-accent mb-3">Правила 0ch</h1>
          <div className="text-sm space-y-2 text-text leading-relaxed max-h-[55vh] overflow-y-auto">
            <p>1. Регистрируясь — соглашаешься с правилами.</p>
            <p>2. Запрещено: спам, скам, доксинг, угрозы, детская порнография, экстремизм, всё что запрещено законом.</p>
            <p>3. Нельзя создавать аккаунты, похожие на администраторские.</p>
            <p>4. Нарушил — бан. Без разговоров.</p>
            <p>5. Контент с «+» / NSFW может быть скрыт.</p>
            <p>6. Админ/мод может удалять сообщения и банить.</p>
            <p>7. Не нравится — не регистрируйся.</p>
          </div>
          <button onClick={() => setView('register')} className="mt-4 w-full py-2.5 bg-accent hover:bg-blue-600 rounded-lg text-white text-sm font-medium">
            Согласен → Регистрация
          </button>
          <button onClick={() => setView('login')} className="mt-2 w-full py-2 text-muted text-sm">Назад</button>
        </div>
      </div>
    );
  }

  if (view === 'login' || view === 'register') {
    const isReg = view === 'register';
    return (
      <div className="h-full flex items-center justify-center bg-bg p-4">
        <form onSubmit={e => authSubmit(e, isReg)} className="w-full max-w-xs bg-panel border border-border rounded-xl p-5 space-y-3 anim">
          <div className="text-center mb-2">
            <div className="text-3xl font-light tracking-widest text-text">Ø</div>
            <div className="text-xs text-muted mt-1">{isReg ? 'регистрация' : 'вход'}</div>
          </div>
          {error && <div className="text-red text-xs bg-red/10 p-2 rounded">{error}</div>}
          <input name="username" required minLength={3} maxLength={24} placeholder="логин"
            className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-accent" />
          <input name="password" type="password" required minLength={6} placeholder="пароль"
            className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-accent" />
          {isReg && (
            <label className="flex gap-2 text-xs text-muted cursor-pointer">
              <input name="agreed" type="checkbox" required className="mt-0.5 accent-accent" />
              <span>Согласен с <button type="button" onClick={() => setView('terms')} className="text-accent underline">правилами</button></span>
            </label>
          )}
          <button type="submit" disabled={loading} className="w-full py-2.5 bg-accent hover:bg-blue-600 disabled:opacity-40 rounded-lg text-white text-sm font-medium">
            {loading ? '...' : isReg ? 'Создать' : 'Войти'}
          </button>
          <button type="button" onClick={() => { setView(isReg ? 'login' : 'register'); setError(''); }}
            className="w-full text-xs text-muted hover:text-text">
            {isReg ? 'Уже есть аккаунт' : 'Регистрация'}
          </button>
        </form>
      </div>
    );
  }

  // APP
  return (
    <div className="h-full flex flex-col bg-bg text-text">
      {/* top */}
      <div className="h-9 bg-side border-b border-border flex items-center px-3 text-xs shrink-0">
        <button className="sm:hidden mr-2 text-base" onClick={() => setSidebar(v => !v)}>☰</button>
        <span className="text-muted tracking-wider">Ø 0ch</span>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-green hidden sm:inline">{online.length}</span>
          <button onClick={logout} className="text-muted hover:text-red">выход</button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden relative">
        {/* sidebar */}
        <div className={`absolute sm:static inset-y-0 left-0 z-20 w-60 bg-side border-r border-border flex flex-col transition-transform duration-200 ${sidebar ? 'translate-x-0' : '-translate-x-full sm:translate-x-0'}`}>
          <div className="p-3 border-b border-border flex items-center gap-2">
            <div className="relative">
              {user?.avatar
                ? <img src={user.avatar} className="w-9 h-9 rounded-full object-cover" />
                : <div className="w-9 h-9 rounded-full bg-accent/80 flex items-center justify-center text-sm font-bold">{user?.username?.[0]?.toUpperCase()}</div>}
              <label className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-panel rounded-full text-[9px] flex items-center justify-center cursor-pointer border border-border">✎
                <input type="file" accept="image/*" className="hidden" onChange={changeAvatar} />
              </label>
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{user?.username}</div>
              <div className="text-[10px] text-muted">{user?.role === 'owner' ? 'owner' : 'online'}</div>
            </div>
          </div>

          <button onClick={() => openChannel('general')}
            className={`mx-2 mt-2 px-3 py-1.5 rounded text-left text-sm ${channel === 'general' ? 'bg-hover text-text' : 'text-muted hover:bg-hover'}`}>
            # general
          </button>

          <div className="flex-1 overflow-y-auto p-2 mt-1">
            <div className="text-[10px] uppercase text-muted px-2 mb-1">онлайн</div>
            {online.map(u => (
              <div key={u.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-hover group">
                {u.avatar
                  ? <img src={u.avatar} className="w-6 h-6 rounded-full object-cover" />
                  : <div className="w-6 h-6 rounded-full bg-border flex items-center justify-center text-[10px]">{u.username[0]?.toUpperCase()}</div>}
                <button onClick={() => u.id !== user?.id && openChannel(`dm:${u.id}`, u)}
                  className="text-sm truncate flex-1 text-left">
                  {u.username}
                </button>
                {u.id !== user?.id && (
                  <div className="flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
                    <button onClick={() => startCall(u)} title="Звонок" className="text-xs text-green">📞</button>
                    <button onClick={() => startCall(u, true)} title="Экран" className="text-xs text-accent">🖥</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {sidebar && <div className="sm:hidden absolute inset-0 bg-black/60 z-10" onClick={() => setSidebar(false)} />}

        {/* chat */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="h-9 border-b border-border flex items-center px-4 text-sm shrink-0">
            {channel === 'general' ? '# general' : `DM · ${dmUser?.username || '...'}`}
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
            {messages.map(m => (
              <div key={m.id} className="flex gap-2.5 group">
                {m.avatar
                  ? <img src={m.avatar} className="w-8 h-8 rounded-full object-cover shrink-0 mt-0.5" />
                  : <div className="w-8 h-8 rounded-full bg-border flex items-center justify-center text-xs shrink-0 mt-0.5">{m.username[0]?.toUpperCase()}</div>}
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium text-green">{m.username}</span>
                    <span className="text-[10px] text-muted">{new Date(m.created_at * 1000).toLocaleString('ru', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}</span>
                    {isMod && <button onClick={() => api(`/api/messages/${m.id}`, { method: 'DELETE' })} className="text-[10px] text-red opacity-0 group-hover:opacity-100">удалить</button>}
                  </div>
                  {m.content && <div className="text-sm whitespace-pre-wrap break-words">{m.content}</div>}
                  {m.media_url && m.media_type === 'image' && (
                    <div className={`mt-1 relative inline-block ${m.is_nsfw && !nsfwOk ? 'blur-md' : ''}`}>
                      <img src={m.media_url} className="max-w-[220px] max-h-52 rounded border border-border" />
                      {m.is_nsfw && !nsfwOk && (
                        <button onClick={() => setNsfwOk(true)} className="absolute inset-0 flex items-center justify-center bg-black/50 text-xs rounded">показать</button>
                      )}
                    </div>
                  )}
                  {m.media_url && m.media_type === 'video' && (
                    <video src={m.media_url} controls className="mt-1 max-w-[220px] max-h-52 rounded border border-border" />
                  )}
                </div>
              </div>
            ))}
            <div ref={endRef} />
          </div>

          <form onSubmit={send} className="p-2 border-t border-border shrink-0">
            <div className="flex items-end gap-2 bg-panel border border-border rounded-xl px-3 py-2">
              <button type="button" onClick={() => fileRef.current?.click()} className="text-muted hover:text-text text-lg">📎</button>
              <input ref={fileRef} type="file" accept="image/*,video/*" className="hidden" />
              <textarea value={text} onChange={e => setText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder="сообщение..." rows={1}
                className="flex-1 bg-transparent resize-none text-sm focus:outline-none max-h-24 py-1" />
              <button type="submit" className="text-accent text-sm font-medium px-1">→</button>
            </div>
          </form>
        </div>
      </div>

      {/* incoming */}
      {incoming && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-panel border border-border rounded-xl p-6 text-center w-full max-w-xs anim">
            <div className="text-3xl mb-2">📞</div>
            <div className="font-medium">{incoming.from.username}</div>
            <div className="text-xs text-muted mb-5">{incoming.withScreen ? 'экран + звук' : 'голосовой звонок'}</div>
            <div className="flex gap-2">
              <button onClick={acceptCall} className="flex-1 py-2.5 bg-green hover:bg-green/80 rounded-lg text-sm font-medium text-black">Принять</button>
              <button onClick={() => { socketRef.current?.emit('call:end', { toUserId: incoming.from.id, callId: incoming.callId }); setIncoming(null); }}
                className="flex-1 py-2.5 bg-red hover:bg-red/80 rounded-lg text-sm font-medium">Отклонить</button>
            </div>
          </div>
        </div>
      )}

      {/* active call bar (Discord-like) */}
      {call && (
        <div className="fixed bottom-0 inset-x-0 sm:bottom-4 sm:left-auto sm:right-4 sm:w-80 bg-panel border border-border sm:rounded-xl p-3 z-40 anim shadow-2xl">
          <div className="text-sm font-medium mb-0.5">
            {call.status === 'calling' ? 'Звоним...' : 'В звонке'} · {call.peer.username}
          </div>
          <div className="text-[10px] text-muted mb-3">
            {sharing ? 'трансляция экрана · ' : ''}{muted ? 'микрофон выкл' : 'микрофон вкл'} · шумодав
          </div>
          <div className="flex gap-2">
            <button onClick={toggleMute} className={`flex-1 py-2 rounded-lg text-xs font-medium ${muted ? 'bg-red/20 text-red' : 'bg-hover'}`}>
              {muted ? 'unmute' : 'mute'}
            </button>
            <button onClick={toggleScreen} className={`flex-1 py-2 rounded-lg text-xs font-medium ${sharing ? 'bg-accent/20 text-accent' : 'bg-hover'}`}>
              {sharing ? 'стоп экран' : 'экран'}
            </button>
            <button onClick={() => hangup()} className="flex-1 py-2 bg-red hover:bg-red/80 rounded-lg text-xs font-medium">
              сброс
            </button>
          </div>
          <audio ref={remoteAudioRef} autoPlay playsInline />
          <audio ref={localAudioRef} muted autoPlay playsInline className="hidden" />
        </div>
      )}
    </div>
  );
}
