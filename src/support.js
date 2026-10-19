// Chat directo con CowFace: el admin le escribe a una tienda (o a cualquier persona) y ella le
// responde. Un solo hilo por usuario, cifrado como el resto del chat. Del lado de la tienda aparece
// fijo arriba en Mensajes como "CowFace · Equipo oficial".
import { db, getSetting, setSetting } from './db.js';
import { SITE_NAME } from './catalog.js';
import { UserError, unreadCount } from './messages.js';
import { openText, sealText } from './crypto-box.js';
import { notify } from './realtime.js';
import { pushToUser } from './push.js';
import { sendMail } from './mailer.js';
import { notifyAdmin } from './admin-notify.js';

export const MAX_SUPPORT_TEXT = 2000;
const EMAIL_EVERY_MS = 30 * 60_000; // como mucho un correo cada 30 min por persona
const lastEmail = new Map();

const now = () => new Date().toISOString();
const userRow = (id) => db.prepare("SELECT id, name, COALESCE(store_name, name) AS store_name, email, active FROM users WHERE id = ? AND role = 'usuario' AND deleted_at IS NULL").get(id);

export function supportThread(userId) {
  return db.prepare('SELECT * FROM support_messages WHERE user_id = ? ORDER BY id').all(userId)
    .map((m) => ({ ...m, body: openText(m.body) }));
}

// Lo que no ha leído la persona (mensajes del admin) o el admin (mensajes de la persona).
export const userUnreadSupport = (userId) => db.prepare('SELECT COUNT(*) AS n FROM support_messages WHERE user_id = ? AND from_admin = 1 AND read_at IS NULL').get(userId).n;
export const adminUnreadSupport = () => db.prepare('SELECT COUNT(*) AS n FROM support_messages WHERE from_admin = 0 AND read_at IS NULL').get().n;

export function markSupportRead(userId, side) {
  db.prepare(`UPDATE support_messages SET read_at = ? WHERE user_id = ? AND from_admin = ? AND read_at IS NULL`)
    .run(now(), userId, side === 'usuario' ? 1 : 0);
}

// Resumen para la bandeja de la tienda (null si nunca le escribió CowFace).
export function supportSummary(userId) {
  const last = db.prepare('SELECT * FROM support_messages WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId);
  if (!last) return null;
  return { last_text: openText(last.body), last_at: last.created_at, from_admin: last.from_admin, unread: userUnreadSupport(userId) };
}

// Bandeja del admin: un hilo por persona, lo más reciente primero.
export function supportInbox() {
  return db.prepare(`
    SELECT u.id, u.name, COALESCE(u.store_name, u.name) AS store_name, u.store_logo, u.email,
      m.body AS last_body, m.created_at AS last_at, m.from_admin,
      (SELECT COUNT(*) FROM support_messages x WHERE x.user_id = u.id AND x.from_admin = 0 AND x.read_at IS NULL) AS unread
    FROM users u JOIN support_messages m ON m.id = (SELECT MAX(id) FROM support_messages WHERE user_id = u.id)
    ORDER BY m.id DESC LIMIT 200
  `).all().map((r) => ({ ...r, last_text: openText(r.last_body) }));
}

function clean(body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n').trim().slice(0, MAX_SUPPORT_TEXT);
  if (!text) throw new UserError('Escribe un mensaje.');
  return text;
}

// El admin le escribe a una persona: aviso en vivo, al celular y (cada tanto) por correo.
export function adminWrites(userId, body, baseUrl = '') {
  const u = userRow(userId);
  if (!u) return null;
  const text = clean(body);
  db.prepare('INSERT INTO support_messages (user_id, from_admin, body, created_at) VALUES (?, 1, ?, ?)').run(userId, sealText(text), now());
  notify([userId], 'soporte', {});
  notify([userId], 'no-leidos', { count: unreadCount(userId) });
  pushToUser(userId, { title: `${SITE_NAME} · Equipo oficial`, body: text.slice(0, 180), url: '/mensajes/cowface', tag: 'soporte' });
  const t = Date.now();
  if (t - (lastEmail.get(userId) || 0) > EMAIL_EVERY_MS) {
    lastEmail.set(userId, t);
    sendMail({
      to: u.email,
      subject: `${SITE_NAME} te escribió`,
      text: `Hola ${u.name}:\n\nEl equipo de ${SITE_NAME} te mandó un mensaje:\n\n«${text.slice(0, 500)}»\n\nRespóndelo aquí: ${baseUrl}/mensajes/cowface\n\n${SITE_NAME}`,
    }).catch(() => {});
  }
  return u;
}

// La persona le responde a CowFace: aviso al admin.
export function userWrites(user, body) {
  const text = clean(body);
  db.prepare('INSERT INTO support_messages (user_id, from_admin, body, created_at) VALUES (?, 0, ?, ?)').run(user.id, sealText(text), now());
  notifyAdmin('soporte', `Mensaje de ${user.store_name || user.name}`, `${user.store_name || user.name} te escribió:\n«${text.slice(0, 500)}»`, `/admin/mensajes/${user.id}`);
}


// Número de WhatsApp de soporte para tiendas (Admin → Configuración). Solo lo ven las tiendas.
export function storeSupport() {
  const phone = getSetting('store_support_phone') || '';
  if (!/^\d{8}$/.test(phone)) return null;
  return { phone: `${phone.slice(0, 4)}-${phone.slice(4)}`, whatsapp: `https://wa.me/506${phone}` };
}
export const setStoreSupport = (phone) => setSetting('store_support_phone', phone || '');
