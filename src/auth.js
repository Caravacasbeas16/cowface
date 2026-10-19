import crypto from 'node:crypto';
import { db, getSetting, setSetting } from './db.js';

const SESSION_DAYS = 30;
const COOKIE = 'sid';

// En la base solo se guarda el hash del token de sesión (la cookie lleva el token). Así, si alguien
// consiguiera una copia de la base o de un respaldo, no podría usar esas sesiones.
export const sessionHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// Una sola vez: las sesiones que ya existían (con el token tal cual) pasan a guardarse con su hash.
if (getSetting('sessions_hashed') !== '1') {
  const rows = db.prepare('SELECT rowid AS id, token FROM sessions').all();
  const update = db.prepare('UPDATE sessions SET token = ? WHERE rowid = ?');
  for (const r of rows) update.run(sessionHash(r.token), r.id);
  setSetting('sessions_hashed', '1');
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400e3);
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(sessionHash(token), userId, expires.toISOString());
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    expires,
  });
}

export function endSession(req, res) {
  const token = req.cookies?.[COOKIE];
  if (typeof token === 'string') db.prepare('DELETE FROM sessions WHERE token = ?').run(sessionHash(token));
  res.clearCookie(COOKIE);
}

// Carga el usuario de la sesión (si hay) en req.user y res.locals.user.
export function loadUser(req, res, next) {
  const token = req.cookies?.[COOKIE];
  let user = null;
  if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) {
    user = db.prepare(`
      SELECT u.id, u.role, u.name, u.store_name, u.email, u.phone, u.province, u.active, u.payout_phone, u.payout_name, u.email_messages, u.seller_status, u.pickup_lat
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ? AND u.active = 1
    `).get(sessionHash(token), new Date().toISOString()) || null;
  }
  req.user = user;
  res.locals.user = user;
  next();
}

export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) {
      // Tras entrar, vuelve a la página donde estaba (un POST no se puede repetir con un enlace).
      const referer = (req.get('Referer') || '').replace(/^https?:\/\/[^/]+/, '');
      const back = req.method === 'GET' ? req.originalUrl : referer.startsWith('/') && !referer.startsWith('//') ? referer : '/';
      return res.redirect(`/entrar?next=${encodeURIComponent(back)}`);
    }
    if (req.user.role !== role) return res.status(403).render('error', { title: 'Sin acceso', message: 'Esta sección no es para tu tipo de cuenta.' });
    next();
  };
}
