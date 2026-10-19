// "Pedir ayuda a CowFace": si hay un problema con una compra (o con cualquier conversación), cualquiera
// de las dos partes avisa y el admin se hace cargo. El admin puede escribir en la conversación como
// CowFace y marcar la solicitud como resuelta.
import { db } from './db.js';
import { UserError, systemNote } from './messages.js';
import { notifyAdmin } from './admin-notify.js';
import { openText, sealText } from './crypto-box.js';

const MAX_OPEN_PER_USER = 5;

export function requestHelp(user, conv, text) {
  const body = String(text ?? '').trim().slice(0, 1000);
  if (body.length < 10) throw new UserError('Cuéntanos qué pasó (al menos una frase).');
  const open = db.prepare("SELECT COUNT(*) AS n FROM help_requests WHERE user_id = ? AND status = 'abierta'").get(user.id).n;
  if (open >= MAX_OPEN_PER_USER) throw new UserError('Ya tienes varias solicitudes de ayuda abiertas; te respondemos pronto.');
  const order = db.prepare("SELECT id, code FROM orders WHERE conversation_id = ? AND status != 'cancelado' ORDER BY id DESC LIMIT 1").get(conv.id);
  const { lastInsertRowid } = db.prepare('INSERT INTO help_requests (user_id, conversation_id, order_id, body) VALUES (?, ?, ?, ?)')
    .run(user.id, conv.id, order?.id || null, sealText(body));
  const who = user.store_name || user.name;
  systemNote(conv.id, `🛟 ${who} pidió ayuda a CowFace${order ? ` con el pedido ${order.code}` : ''}. Nos hacemos cargo: revisamos la conversación y les respondemos por aquí.`);
  notifyAdmin('ayuda', `Pidieron ayuda: ${conv.product_title || 'conversación'}${order ? ` (${order.code})` : ''}`,
    `${who} (${user.email}) pidió ayuda:\n«${body}»`, `/admin/conversaciones/${conv.id}`);
  return Number(lastInsertRowid);
}

export function openHelpRequests() {
  return db.prepare(`
    SELECT h.*, COALESCE(u.store_name, u.name) AS who, u.email, c.product_title, o.code AS order_code, o.status AS order_status
    FROM help_requests h JOIN users u ON u.id = h.user_id
    LEFT JOIN conversations c ON c.id = h.conversation_id LEFT JOIN orders o ON o.id = h.order_id
    WHERE h.status = 'abierta' ORDER BY h.id
  `).all().map((h) => ({ ...h, body: openText(h.body) }));
}

export function resolveHelp(id, note) {
  const h = db.prepare("SELECT * FROM help_requests WHERE id = ? AND status = 'abierta'").get(id);
  if (!h) return null;
  const text = String(note ?? '').trim().slice(0, 1000);
  db.prepare("UPDATE help_requests SET status = 'resuelta', admin_note = ?, resolved_at = datetime('now') WHERE id = ?").run(text, id);
  if (h.conversation_id) systemNote(h.conversation_id, `✅ CowFace resolvió la solicitud de ayuda${text ? `: ${text}` : '.'}`);
  return h;
}

// Mensaje del admin dentro de una conversación (lo ven las dos partes y les llega la notificación).
export function adminSay(conversationId, text) {
  const body = String(text ?? '').trim().slice(0, 1000);
  if (body.length < 2) throw new UserError('Escribe el mensaje.');
  const conv = db.prepare('SELECT id FROM conversations WHERE id = ?').get(conversationId);
  if (!conv) return null;
  systemNote(conv.id, `💬 CowFace: ${body}`);
  return conv;
}

export const openHelpCount = () => db.prepare("SELECT COUNT(*) AS n FROM help_requests WHERE status = 'abierta'").get().n;
