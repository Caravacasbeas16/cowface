// Conversaciones y ofertas. Cada cambio deja un mensaje en la conversación y avisa en vivo
// a las dos partes. Los pedidos y pagos viven en orders.js.
import { db, transaction } from './db.js';
import { formatColones } from './catalog.js';
import { notify } from './realtime.js';
import { UserError, addMessage, announce, assertStoreOpen, convRow, now, unreadCount } from './messages.js';
import { chooseSize } from './variants.js';
import { createOrder, orderForConversation } from './orders.js';
import { isBlockedEither } from './blocks.js';
import { openText } from './crypto-box.js';

const BLOCKED_MSG = 'No puedes tratar con esta persona: una de las dos cuentas bloqueó a la otra.';
function assertNotBlocked(a, b) {
  if (isBlockedEither(a, b)) throw new UserError(BLOCKED_MSG);
}

export { UserError, unreadCount };

export const OFFER_TTL_HOURS = 48;
export const MIN_OFFER_RATIO = 0.5;

function expireOffers() {
  db.prepare("UPDATE offers SET status = 'expirada' WHERE status = 'pendiente' AND expires_at < ?").run(now());
}

export function minOffer(price) {
  return Math.ceil((price * MIN_OFFER_RATIO) / 100) * 100;
}

// ---------- Conversaciones ----------

export function getOrCreateConversation(product, buyerId) {
  if (product.seller_id === buyerId) throw new UserError('Este artículo es tuyo.');
  assertNotBlocked(product.seller_id, buyerId);
  const existing = db.prepare('SELECT id FROM conversations WHERE product_id = ? AND buyer_id = ?').get(product.id, buyerId);
  if (existing) return existing.id;
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO conversations (product_id, product_title, buyer_id, seller_id) VALUES (?, ?, ?, ?)',
  ).run(product.id, product.title, buyerId, product.seller_id);
  return Number(lastInsertRowid);
}

export function findConversation(productId, buyerId) {
  return db.prepare('SELECT id FROM conversations WHERE product_id = ? AND buyer_id = ?').get(productId, buyerId)?.id || null;
}

// Devuelve la conversación solo si el usuario participa en ella.
export function getConversationForUser(id, userId) {
  expireOffers();
  const c = db.prepare(`
    SELECT c.*, p.price, p.status AS product_status, p.category, p.size, p.quantity, p.meetup, p.has_sizes, s.province, s.pickup_points,
      (SELECT COALESCE(thumb, filename) FROM product_images i WHERE i.product_id = p.id ORDER BY position LIMIT 1) AS image,
      b.name AS buyer_name, s.name AS seller_name, COALESCE(s.store_name, s.name) AS store_name
    FROM conversations c
    LEFT JOIN products p ON p.id = c.product_id
    JOIN users b ON b.id = c.buyer_id
    JOIN users s ON s.id = c.seller_id
    WHERE c.id = ? AND (c.buyer_id = ? OR c.seller_id = ?)
  `).get(id, userId, userId);
  if (!c) return null;
  c.role = c.buyer_id === userId ? 'comprador' : 'vendedor';
  c.otherName = c.role === 'comprador' ? c.store_name : c.buyer_name;
  c.order = orderForConversation(id);
  c.pendingOffer = db.prepare("SELECT * FROM offers WHERE conversation_id = ? AND status = 'pendiente' ORDER BY id DESC LIMIT 1").get(id) || null;
  return c;
}

export function listConversations(userId) {
  return db.prepare(`
    SELECT c.id, c.product_id, c.product_title, c.last_message_at, p.category,
      CASE WHEN c.buyer_id = ? THEN COALESCE(s.store_name, s.name) ELSE b.name END AS other_name,
      CASE WHEN c.buyer_id = ? THEN 'comprador' ELSE 'vendedor' END AS role,
      CASE WHEN c.buyer_id = ? THEN c.buyer_read_at ELSE c.seller_read_at END < c.last_message_at AS unread,
      (SELECT COALESCE(thumb, filename) FROM product_images i WHERE i.product_id = c.product_id ORDER BY position LIMIT 1) AS image,
      (SELECT CASE WHEN m.attachment_type = 'imagen' THEN '📷 Foto' WHEN m.attachment_type = 'pdf' THEN '📄 PDF'
              WHEN m.kind = 'texto' THEN m.body WHEN m.kind = 'oferta' THEN 'Oferta: ' || o.amount ELSE m.body END
         FROM messages m LEFT JOIN offers o ON o.id = m.offer_id
         WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_text
    FROM conversations c
    JOIN users b ON b.id = c.buyer_id
    JOIN users s ON s.id = c.seller_id
    LEFT JOIN products p ON p.id = c.product_id
    WHERE c.buyer_id = ? OR c.seller_id = ?
    ORDER BY c.last_message_at DESC LIMIT 200
  `).all(userId, userId, userId, userId, userId).map((c) => ({ ...c, last_text: openText(c.last_text) }));
}

export function markRead(conv, userId) {
  const col = conv.buyer_id === userId ? 'buyer_read_at' : 'seller_read_at';
  db.prepare(`UPDATE conversations SET ${col} = ? WHERE id = ?`).run(now(), conv.id);
  notify([userId], 'no-leidos', { count: unreadCount(userId) });
}

export function threadMessages(conversationId) {
  expireOffers();
  return db.prepare(`
    SELECT m.id, m.sender_id, m.kind, m.body, m.created_at, m.attachment, m.attachment_type,
      o.id AS offer_id, o.amount, o.made_by, o.status AS offer_status, o.expires_at
    FROM messages m LEFT JOIN offers o ON o.id = m.offer_id
    WHERE m.conversation_id = ? ORDER BY m.id
  `).all(conversationId).map((m) => ({ ...m, body: openText(m.body) }));
}

export function sendText(conv, userId, body) {
  assertNotBlocked(conv.buyer_id, conv.seller_id);
  addMessage(conv, userId, 'texto', body);
  announce(conv);
}

// Foto o PDF (comprobantes, detalles de la prenda…), con un texto opcional.
export function sendAttachment(conv, userId, attachment, caption = '') {
  assertNotBlocked(conv.buyer_id, conv.seller_id);
  addMessage(conv, userId, 'texto', caption, null, attachment);
  announce(conv);
}

// ---------- Ofertas ----------

export function makeOffer(conv, userId, amount) {
  expireOffers();
  assertNotBlocked(conv.buyer_id, conv.seller_id);
  if (userId === conv.buyer_id) assertStoreOpen(conv.seller_id);
  const product = db.prepare('SELECT id, price, status, quantity, has_sizes FROM products WHERE id = ?').get(conv.product_id);
  if (!product || product.status !== 'disponible' || product.quantity < 1) throw new UserError('Este artículo ya no está disponible.');
  if (product.has_sizes && userId === conv.buyer_id) assertSizeAvailable(product.id, conv.chosen_size);
  if (!Number.isInteger(amount) || amount <= 0) throw new UserError('Escribe un monto válido en colones.');
  if (amount >= product.price) throw new UserError(`La oferta debe ser menor al precio (${formatColones(product.price)}). Para pagar el precio completo usa "Comprar ahora".`);
  if (userId === conv.buyer_id && amount < minOffer(product.price)) {
    throw new UserError(`La oferta mínima para este artículo es ${formatColones(minOffer(product.price))}.`);
  }
  transaction(() => {
    db.prepare("UPDATE offers SET status = 'reemplazada', responded_at = ? WHERE conversation_id = ? AND status = 'pendiente'")
      .run(now(), conv.id);
    const expires = new Date(Date.now() + OFFER_TTL_HOURS * 3600e3).toISOString();
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO offers (conversation_id, product_id, amount, made_by, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).run(conv.id, product.id, amount, userId, expires);
    addMessage(conv, userId, 'oferta', '', Number(lastInsertRowid));
  });
  announce(conv);
}

export function respondOffer(offerId, userId, action) {
  expireOffers();
  const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(offerId);
  const conv = offer && convRow(offer.conversation_id);
  if (!conv || (conv.buyer_id !== userId && conv.seller_id !== userId)) return null;
  if (offer.status !== 'pendiente') throw new UserError('Esta oferta ya no está activa.');

  if (action === 'aceptar') assertNotBlocked(conv.buyer_id, conv.seller_id);
  const mine = offer.made_by === userId;
  if (action === 'retirar' && !mine) throw new UserError('Solo quien hizo la oferta puede retirarla.');
  if ((action === 'aceptar' || action === 'rechazar') && mine) throw new UserError('No puedes responder tu propia oferta.');
  if (action === 'aceptar') {
    // El precio pudo cambiar desde que se hizo la oferta: se valida contra el precio actual.
    const product = db.prepare('SELECT price FROM products WHERE id = ?').get(conv.product_id);
    if (product && offer.amount >= product.price) {
      throw new UserError(`El precio bajó a ${formatColones(product.price)}, que es menos que esta oferta. Compra al precio publicado.`);
    }
    if (product && offer.made_by === conv.buyer_id && offer.amount < minOffer(product.price)) {
      throw new UserError('Esta oferta quedó por debajo del mínimo para el precio actual.');
    }
  }

  transaction(() => {
    const status = { aceptar: 'aceptada', rechazar: 'rechazada', retirar: 'retirada' }[action];
    if (!status) throw new UserError('Acción no válida.');
    db.prepare('UPDATE offers SET status = ?, responded_at = ? WHERE id = ?').run(status, now(), offer.id);
    if (action === 'aceptar') createOrder(conv, offer.amount, 'oferta');
    else addMessage(conv, null, 'sistema', action === 'rechazar' ? `Oferta de ${formatColones(offer.amount)} rechazada.` : `Oferta de ${formatColones(offer.amount)} retirada.`);
  });
  announce(conv);
  return conv;
}

// ---------- Compra directa ----------

// size: la talla elegida en la página del artículo (si el artículo tiene varias tallas).
export function buyNow(product, buyerId, size = null) {
  assertStoreOpen(product.seller_id);
  return transaction(() => {
    const id = getOrCreateConversation(product, buyerId);
    if (product.has_sizes && size) chooseSize(id, product.id, size);
    const conv = convRow(id);
    createOrder(conv, product.price, 'compra');
    announce(conv);
    return conv.id;
  });
}

// Antes de ofertar por un artículo con tallas, el comprador tiene que haber elegido una que quede.
function assertSizeAvailable(productId, size) {
  const row = size && db.prepare('SELECT quantity FROM product_sizes WHERE product_id = ? AND size = ?').get(productId, size);
  if (!row) throw new UserError('Elige tu talla en la página del artículo antes de ofertar.');
  if (row.quantity < 1) throw new UserError(`Ya no queda la talla ${size}. Elige otra en la página del artículo.`);
}
