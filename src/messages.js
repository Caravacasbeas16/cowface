// Piezas compartidas por el chat y los pedidos: mensajes en la conversación y avisos en vivo.
import { db } from './db.js';
import { notify } from './realtime.js';
import { pushToUser } from './push.js';
import { formatColones } from './catalog.js';
import { sealText } from './crypto-box.js';

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
  `).run(conv.id, senderId, kind, sealText(body), offerId, attachment?.name || null, attachment?.type || null, ts);
  db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(ts, conv.id);
  // Quien escribe ya lo leyó.
  if (senderId) {
    const col = conv.buyer_id === senderId ? 'buyer_read_at' : 'seller_read_at';
    db.prepare(`UPDATE conversations SET ${col} = ? WHERE id = ?`).run(ts, conv.id);
  }
  pushMessage(conv, senderId, kind, body, offerId, attachment);
}

// Notificación al celular de la otra persona (o de las dos, si es un aviso de CowFace sobre el pedido).
// Todas las de una conversación comparten "tag": la nueva reemplaza a la anterior en vez de apilarse.
function pushMessage(conv, senderId, kind, body, offerId, attachment) {
  const title = conv.product_title || convRow(conv.id)?.product_title || 'CowFace';
  const url = `/mensajes/${conv.id}`;
  const tag = `conv-${conv.id}`;
  if (!senderId) {
    for (const id of [conv.buyer_id, conv.seller_id]) pushToUser(id, { title: `CowFace · ${title}`, body: String(body).slice(0, 180), url, tag });
    return;
  }
  const sender = db.prepare('SELECT COALESCE(store_name, name) AS name FROM users WHERE id = ?').get(senderId)?.name || 'Alguien';
  let text = String(body || '').trim();
  if (kind === 'oferta') {
    const amount = offerId && db.prepare('SELECT amount FROM offers WHERE id = ?').get(offerId)?.amount;
    text = amount ? `Oferta: ${formatColones(amount)}` : 'Te hizo una oferta';
  } else if (attachment) {
    text = `${attachment.type === 'pdf' ? '📄 PDF' : '📷 Foto'}${text ? ` · ${text}` : ''}`;
  }
  const recipient = senderId === conv.buyer_id ? conv.seller_id : conv.buyer_id;
  pushToUser(recipient, { title: `${sender} · ${title}`, body: text.slice(0, 180) || 'Te escribió', url, tag });
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

// Tienda en pausa (vacaciones, sin poder enviar): no se puede comprar ni ofertar hasta que la reanude.
export function assertStoreOpen(sellerId) {
  const paused = db.prepare('SELECT store_paused FROM users WHERE id = ?').get(sellerId)?.store_paused;
  if (paused) throw new UserError(`Esta tienda está en pausa («${paused}»). Puedes escribirle o guardar el artículo y comprar cuando vuelva.`);
}
