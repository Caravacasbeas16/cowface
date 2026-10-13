// Reseñas en los dos sentidos (como Grailed): al completarse un pedido, el comprador califica al
// vendedor y el vendedor al comprador. Una por pedido y por persona; no se editan.
import { db } from './db.js';
import { UserError, systemNote } from './messages.js';
import { blockedMessage, findBlocked, logFlagged } from './moderation.js';

export const REVIEW_WINDOW_DAYS = 60;

const getOrder = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);

export function myReview(orderId, userId) {
  return db.prepare('SELECT * FROM reviews WHERE order_id = ? AND author_id = ?').get(orderId, userId) || null;
}

// ¿Puede este usuario reseñar este pedido? Devuelve a quién y en qué papel, o null.
export function reviewTarget(order, userId) {
  if (!order || order.status !== 'completado') return null;
  if (order.buyer_id !== userId && order.seller_id !== userId) return null;
  const done = new Date(String(order.completed_at || '').replace(' ', 'T'));
  if (Number.isNaN(done.getTime()) || Date.now() - done.getTime() > REVIEW_WINDOW_DAYS * 86400e3) return null;
  if (myReview(order.id, userId)) return null;
  return order.buyer_id === userId
    ? { subjectId: order.seller_id, role: 'vendedor' }
    : { subjectId: order.buyer_id, role: 'comprador' };
}

export function createReview(orderId, userId, body) {
  const order = getOrder(orderId);
  if (!order || (order.buyer_id !== userId && order.seller_id !== userId)) return null;
  if (myReview(order.id, userId)) throw new UserError('Ya dejaste tu reseña para este pedido.');
  const target = reviewTarget(order, userId);
  if (!target) throw new UserError(`Solo se puede reseñar un pedido completado, dentro de ${REVIEW_WINDOW_DAYS} días.`);

  const rating = Number.parseInt(body.rating, 10);
  const comment = String(body.comment ?? '').trim().slice(0, 600);
  if (!(rating >= 1 && rating <= 5)) throw new UserError('Elige de 1 a 5 estrellas.');
  const matched = comment && findBlocked(comment);
  if (matched) {
    logFlagged({ userId, conversationId: order.conversation_id, context: 'reseña', body: comment, matched });
    throw new UserError(blockedMessage(matched));
  }
  db.prepare('INSERT INTO reviews (order_id, author_id, subject_id, role, rating, comment) VALUES (?, ?, ?, ?, ?, ?)')
    .run(order.id, userId, target.subjectId, target.role, rating, comment);
  systemNote(order.conversation_id, `⭐ ${target.role === 'vendedor' ? 'El comprador' : 'El vendedor'} dejó una reseña de ${rating} estrella${rating === 1 ? '' : 's'}.`);
  return order;
}

// Promedio general y por papel (como vendedor / como comprador).
export function ratingSummary(userId) {
  const rows = db.prepare('SELECT role, COUNT(*) AS n, AVG(rating) AS avg FROM reviews WHERE subject_id = ? GROUP BY role').all(userId);
  const by = Object.fromEntries(rows.map((r) => [r.role, { count: r.n, avg: r.avg }]));
  const count = rows.reduce((s, r) => s + r.n, 0);
  const avg = count ? rows.reduce((s, r) => s + r.avg * r.n, 0) / count : null;
  return { count, avg, asSeller: by.vendedor || { count: 0, avg: null }, asBuyer: by.comprador || { count: 0, avg: null } };
}

export function reviewsAbout(userId, limit = 50) {
  return db.prepare(`
    SELECT r.*, a.name AS author_name, COALESCE(a.store_name, a.name) AS author_display, o.product_title
    FROM reviews r JOIN users a ON a.id = r.author_id JOIN orders o ON o.id = r.order_id
    WHERE r.subject_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT ?
  `).all(userId, limit);
}
