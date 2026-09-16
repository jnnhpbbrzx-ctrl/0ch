import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);

const JWT_SECRET = process.env.JWT_SECRET || '0ch-super-secret-change-me-in-production-2026';
const PORT = process.env.PORT || 3000;

const OWNER_NAMES = ['moradora', 'zero.milk'];

function isOwnerName(name) {
  return OWNER_NAMES.includes((name || '').toLowerCase());
}

function isSimilarToOwner(name) {
  const lower = (name || '').toLowerCase().replace(/[^a-z0-9а-яё.]/g, '');
  for (const own of OWNER_NAMES) {
    if (lower === own) return true;
    if (lower.includes(own) || own.includes(lower)) return true;
  }
  return false;
}

const BAD_WORDS = ['пидор', 'нигер', 'nigger', 'faggot'];
function censorText(text) {
  if (!text) return text;
  let out = text;
  for (const w of BAD_WORDS) {
    out = out.replace(new RegExp(w, 'gi'), '*'.repeat(w.length));
  }
  return out;
}

const uploadsDir = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadsDir),
  filename: (_, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 80 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = /jpeg|jpg|png|gif|webp|mp4|webm|mov|ogg|mp3|wav/.test(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Только медиа'), ok);
  }
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '4mb' }));
app.use('/uploads', express.static(uploadsDir));

const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(frontendDist)) app.use(express.static(frontendDist));

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Нет токена' });
  try {
    req.user = jwt.verify(h.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Неверный токен' });
  }
}

function requireMod(req, res, next) {
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
  if (!u || (u.role !== 'owner' && u.role !== 'mod')) return res.status(403).json({ error: 'Нет прав' });
  next();
}

app.post('/api/register', async (req, res) => {
  try {
    const { username, password, agreed } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Логин и пароль обязательны' });
    if (!agreed) return res.status(400).json({ error: 'Нужно согласие с правилами' });
    if (username.length < 3 || username.length > 24) return res.status(400).json({ error: 'Логин 3-24 символа' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль мин. 6 символов' });
    if (!/^[a-zA-Z0-9_а-яА-ЯёЁ.]+$/.test(username)) return res.status(400).json({ error: 'Только буквы, цифры, _ .' });

    if (isSimilarToOwner(username) && !isOwnerName(username)) {
      return res.status(400).json({ error: 'Нельзя создавать аккаунты, похожие на администраторские' });
    }

    if (db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username)) {
      return res.status(400).json({ error: 'Логин занят' });
    }

    const id = uuidv4();
    const hash = await bcrypt.hash(password, 10);
    const role = isOwnerName(username) ? 'owner' : 'user';

    db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(id, username, hash, role);

    const token = jwt.sign({ id, username, role }, JWT_SECRET, { expiresIn: '60d' });
    res.json({ token, user: { id, username, avatar: null, role } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
    if (!user) return res.status(401).json({ error: 'Неверный логин или пароль' });
    if (!(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Неверный логин или пароль' });

    if (isOwnerName(user.username) && user.role !== 'owner') {
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run('owner', user.id);
      user.role = 'owner';
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '60d' });
    res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar, role: user.role } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/api/me', auth, (req, res) => {
  const user = db.prepare('SELECT id, username, avatar, role FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Не найден' });
  res.json({ user });
});

app.post('/api/avatar', auth, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Нет файла' });
  const avatar = `/uploads/${req.file.filename}`;
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar, req.user.id);
  res.json({ avatar });
});

app.post('/api/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Нет файла' });
  const url = `/uploads/${req.file.filename}`;
  const type = req.file.mimetype.startsWith('video') ? 'video' : req.file.mimetype.startsWith('audio') ? 'audio' : 'image';
  res.json({ url, type });
});

app.get('/api/messages', auth, (req, res) => {
  const channel = req.query.channel || 'general';
  const limit = Math.min(parseInt(req.query.limit) || 120, 250);
  let rows;
  if (channel.startsWith('dm:')) {
    const otherId = channel.slice(3);
    rows = db.prepare(`
      SELECT m.*, u.avatar, u.role FROM messages m
      LEFT JOIN users u ON u.id = m.user_id
      WHERE (m.channel = ? OR (m.to_user_id = ? AND m.user_id = ?) OR (m.to_user_id = ? AND m.user_id = ?))
      ORDER BY m.created_at DESC LIMIT ?
    `).all(channel, req.user.id, otherId, otherId, req.user.id, limit);
  } else {
    rows = db.prepare(`
      SELECT m.*, u.avatar, u.role FROM messages m
      LEFT JOIN users u ON u.id = m.user_id
      WHERE m.channel = ? AND m.to_user_id IS NULL
      ORDER BY m.created_at DESC LIMIT ?
    `).all(channel, limit);
  }
  res.json({ messages: rows.reverse() });
});

app.delete('/api/messages/:id', auth, requireMod, (req, res) => {
  db.prepare('DELETE FROM messages WHERE id = ?').run(req.params.id);
  io.emit('message:delete', { id: req.params.id });
  res.json({ ok: true });
});

// ========== Socket.IO ==========
const online = new Map(); // socketId -> { id, username, avatar, role, socketId }

const io = new Server(httpServer, {
  cors: { origin: true, credentials: true },
  maxHttpBufferSize: 1e8,
  pingTimeout: 60000,
  pingInterval: 25000
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('auth'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('auth'));
  }
});

io.on('connection', (socket) => {
  const u = socket.user;
  const dbUser = db.prepare('SELECT avatar, role FROM users WHERE id = ?').get(u.id);
  if (dbUser?.role === 'banned') {
    socket.disconnect(true);
    return;
  }

  online.set(socket.id, {
    id: u.id,
    username: u.username,
    avatar: dbUser?.avatar || null,
    role: dbUser?.role || 'user',
    socketId: socket.id
  });

  io.emit('online', Array.from(online.values()).map(({ socketId, ...rest }) => rest));

  socket.join('general');

  // Chat message
  socket.on('message', (data) => {
    try {
      const { content, media_url, media_type, encrypted = true, is_nsfw = false, channel = 'general', to_user_id = null } = data;
      if (!content && !media_url) return;

      const id = uuidv4();
      const now = Math.floor(Date.now() / 1000);
      const safe = censorText(content || '');

      db.prepare(`
        INSERT INTO messages (id, user_id, username, content, encrypted, media_url, media_type, is_nsfw, channel, to_user_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, u.id, u.username, safe, encrypted ? 1 : 0, media_url || null, media_type || null, is_nsfw ? 1 : 0, channel, to_user_id, now);

      const msg = {
        id, user_id: u.id, username: u.username, content: safe, encrypted: !!encrypted,
        media_url, media_type, is_nsfw: !!is_nsfw, channel, to_user_id,
        created_at: now, avatar: online.get(socket.id)?.avatar, role: online.get(socket.id)?.role
      };

      if (to_user_id) {
        // DM: send to both
        for (const [sid, ou] of online) {
          if (ou.id === u.id || ou.id === to_user_id) io.to(sid).emit('message', msg);
        }
      } else {
        io.to(channel).emit('message', msg);
      }
    } catch (e) {
      console.error(e);
    }
  });

  // ===== WebRTC targeted signaling =====
  socket.on('call:offer', (data) => {
    // data: { toUserId, offer, callId, withVideo?, withScreen? }
    for (const [sid, ou] of online) {
      if (ou.id === data.toUserId && sid !== socket.id) {
        io.to(sid).emit('call:offer', {
          from: { id: u.id, username: u.username, avatar: online.get(socket.id)?.avatar },
          offer: data.offer,
          callId: data.callId,
          withVideo: !!data.withVideo,
          withScreen: !!data.withScreen
        });
        break;
      }
    }
  });

  socket.on('call:answer', (data) => {
    for (const [sid, ou] of online) {
      if (ou.id === data.toUserId && sid !== socket.id) {
        io.to(sid).emit('call:answer', {
          from: { id: u.id, username: u.username },
          answer: data.answer,
          callId: data.callId
        });
        break;
      }
    }
  });

  socket.on('call:ice', (data) => {
    for (const [sid, ou] of online) {
      if (ou.id === data.toUserId && sid !== socket.id) {
        io.to(sid).emit('call:ice', {
          from: { id: u.id, username: u.username },
          candidate: data.candidate,
          callId: data.callId
        });
        break;
      }
    }
  });

  socket.on('call:end', (data) => {
    for (const [sid, ou] of online) {
      if (ou.id === data.toUserId && sid !== socket.id) {
        io.to(sid).emit('call:end', { from: { id: u.id, username: u.username }, callId: data.callId });
        break;
      }
    }
  });

  socket.on('disconnect', () => {
    online.delete(socket.id);
    io.emit('online', Array.from(online.values()).map(({ socketId, ...rest }) => rest));
  });
});

app.get('*', (req, res) => {
  const idx = path.join(frontendDist, 'index.html');
  if (fs.existsSync(idx)) res.sendFile(idx);
  else res.send('Backend OK');
});

httpServer.listen(PORT, () => console.log(`0ch on :${PORT}`));
