// Piezas compartidas por el chat y los pedidos: mensajes en la conversación y avisos en vivo.
import { db } from './db.js';
import { notify } from './realtime.js';

// Error con mensaje para mostrarle al usuario tal cual.
export class UserError extends Error {}

export const now = () => new Date().toISOString();

export const convRow = (id) => db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);

// attachment: { name, type } de un adjunto privado (foto o PDF) ya procesado por images.js.
export function addMessage(conv, senderId, kind, body = '', offerId = null, attachment = null) {
  const ts = now();
  db.prepare(`
    INSERT INTO messages (conversation_id, sender_id, kind, body, offer_id, attachment, attachment_type, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(conv.id, senderId, kind, body, offerId, attachment?.name || null, attachment?.type || null, ts);
  db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(ts, conv.id);
  // Quien escribe ya lo leyó.
  if (senderId) {
    const col = conv.buyer_id === senderId ? 'buyer_read_at' : 'seller_read_at';
    db.prepare(`UPDATE conversations SET ${col} = ? WHERE id = ?`).run(ts, conv.id);
  }
}

export function unreadCount(userId) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM conversations
    WHERE (buyer_id = ? AND buyer_read_at < last_message_at) OR (seller_id = ? AND seller_read_at < last_message_at)
  `).get(userId, userId).n;
}

export function announce(conv) {
  for (const id of [conv.buyer_id, conv.seller_id]) {
    notify([id], 'conversacion', { id: conv.id });
    notify([id], 'no-leidos', { count: unreadCount(id) });
  }
}

// Deja un aviso del sistema en la conversación de un pedido y avisa a las dos partes.
export function systemNote(conversationId, text) {
  const conv = conversationId && convRow(conversationId);
  if (!conv) return;
  addMessage(conv, null, 'sistema', text);
  announce(conv);
}
