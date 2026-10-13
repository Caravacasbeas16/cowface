// Bloqueos entre usuarios. Si cualquiera de los dos bloqueó al otro, no pueden chatear ni hacer
// tratos nuevos, y quien bloqueó deja de ver los artículos del otro (y viceversa).
// Los pedidos ya pagados siguen su curso para que nadie pierda su dinero.
import { db } from './db.js';

export function block(blockerId, blockedId) {
  if (blockerId === blockedId) return;
  db.prepare('INSERT OR IGNORE INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)').run(blockerId, blockedId);
}

export function unblock(blockerId, blockedId) {
  db.prepare('DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?').run(blockerId, blockedId);
}

export function hasBlocked(blockerId, blockedId) {
  return Boolean(db.prepare('SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?').get(blockerId, blockedId));
}

export function isBlockedEither(a, b) {
  if (!a || !b) return false;
  return Boolean(db.prepare(
    'SELECT 1 FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)',
  ).get(a, b, b, a));
}

export function myBlocks(userId) {
  return db.prepare(`
    SELECT u.id, u.name, COALESCE(u.store_name, u.name) AS store_name, b.created_at
    FROM user_blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY b.created_at DESC
  `).all(userId);
}

// Condición SQL para ocultar artículos de vendedores con bloqueo en cualquier dirección.
// Uso: `AND ${notBlockedSql('p.seller_id')}` con el id del visitante agregado dos veces a los parámetros.
export function notBlockedSql(column) {
  return `NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE (ub.blocker_id = ? AND ub.blocked_id = ${column}) OR (ub.blocker_id = ${column} AND ub.blocked_id = ?))`;
}
