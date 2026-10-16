// Borrar la cuenta (lo exigen Google Play y la App Store).
// No se borra la fila del usuario: los pedidos dependen de ella y hay que conservarlos por contabilidad
// y reclamos. Se borran sus datos personales, artículos, fotos, sesiones, avisos, búsquedas y las
// conversaciones sin pedido; lo que queda (pedidos, reseñas, chats de pedidos) aparece como "Cuenta eliminada".
import crypto from 'node:crypto';
import { db, transaction } from './db.js';
import { hashPassword } from './auth.js';
import { systemNote } from './messages.js';
import { ATTACH_DIR, UPLOAD_DIR, removeFrom } from './storage.js';
import { restockSize } from './variants.js';

export const DELETED_NAME = 'Cuenta eliminada';

// Lo que impide borrar ahora: pedidos en curso o dinero por recibir.
export function deletionBlockers(userId) {
  const blockers = [];
  const open = db.prepare(`
    SELECT code, status, buyer_id = ? AS as_buyer FROM orders
    WHERE (buyer_id = ? OR seller_id = ?)
      AND (status IN ('pagado', 'enviado', 'en_disputa', 'reembolso_pendiente') OR (status = 'por_pagar' AND payment_reported_at IS NOT NULL))
  `).all(userId, userId, userId);
  for (const o of open) blockers.push(`El pedido ${o.code} está en curso (${o.as_buyer ? 'como comprador' : 'como vendedor'}). Espera a que se complete o se cancele.`);
  const owed = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE seller_id = ? AND status = 'completado' AND payout_status = 'pendiente'").get(userId).n;
  if (owed) blockers.push(`CowFace todavía te debe el pago de ${owed} venta${owed === 1 ? '' : 's'}. Cuando te paguemos, podrás borrar la cuenta.`);
  return blockers;
}

export function deleteAccount(userId) {
  if (deletionBlockers(userId).length) throw new Error('La cuenta tiene pedidos en curso.');
  const uploads = [];
  const attachments = [];
  const notes = [];
  transaction(() => {
    // Pedidos sin pagar: se cancelan (si era comprador, el artículo vuelve a la venta).
    for (const o of db.prepare("SELECT * FROM orders WHERE (buyer_id = ? OR seller_id = ?) AND status = 'por_pagar'").all(userId, userId)) {
      db.prepare("UPDATE orders SET status = 'cancelado', updated_at = datetime('now') WHERE id = ?").run(o.id);
      if (o.seller_id !== userId && o.product_id) {
        const bySize = o.chosen_size && restockSize(o.product_id, o.chosen_size);
        db.prepare(`UPDATE products SET quantity = quantity + ${bySize ? 0 : 1}, status = CASE WHEN status IN ('reservado', 'vendido') THEN 'disponible' ELSE status END WHERE id = ?`).run(o.product_id);
      }
      if (o.conversation_id) notes.push([o.conversation_id, `El pedido ${o.code} se canceló porque la otra persona borró su cuenta.`]);
    }
    // Sus artículos y fotos.
    for (const p of db.prepare('SELECT id FROM products WHERE seller_id = ?').all(userId)) {
      uploads.push(...db.prepare('SELECT filename, thumb, original FROM product_images WHERE product_id = ?').all(p.id).flatMap((i) => [i.filename, i.thumb, i.original]));
      db.prepare('DELETE FROM products WHERE id = ?').run(p.id);
    }
    // Conversaciones sin ningún pedido: se borran con sus adjuntos. Las de pedidos se conservan.
    const loose = db.prepare(`
      SELECT id FROM conversations c WHERE (buyer_id = ? OR seller_id = ?) AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.conversation_id = c.id)
    `).all(userId, userId);
    for (const c of loose) {
      attachments.push(...db.prepare('SELECT attachment FROM messages WHERE conversation_id = ? AND attachment IS NOT NULL').all(c.id).map((m) => m.attachment));
      db.prepare('DELETE FROM conversations WHERE id = ?').run(c.id);
    }
    // Fotos de su solicitud de tienda.
    try {
      const req = JSON.parse(db.prepare('SELECT seller_request FROM users WHERE id = ?').get(userId)?.seller_request || '{}');
      attachments.push(...(req.product_photos || []), ...(req.shipment_photos || []));
    } catch { /* sin solicitud */ }
    for (const table of ['sessions', 'push_subscriptions', 'saved_searches', 'password_resets', 'oauth_accounts', 'help_requests', 'reports', 'support_messages', 'favorites', 'store_follows']) {
      const col = table === 'reports' ? 'reporter_id' : 'user_id';
      db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`).run(userId);
    }
    db.prepare('DELETE FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?').run(userId, userId);
    db.prepare('DELETE FROM store_follows WHERE store_id = ?').run(userId);
    // Datos personales fuera; contraseña al azar que nadie conoce; cuenta inactiva.
    db.prepare(`
      UPDATE users SET name = ?, store_name = NULL, email = ?, phone = NULL, province = '', payout_phone = NULL, payout_name = NULL,
        password_hash = ?, active = 0, store_address = '', pickup_points = '[]', store_hours = '{}', seller_request = '{}',
        seller_note = '', store_promo = '{}', featured_until = NULL, last_seen_at = NULL, email_messages = 0,
        history_source = '', deleted_at = datetime('now')
      WHERE id = ?
    `).run(DELETED_NAME, `eliminada-${userId}-${crypto.randomBytes(4).toString('hex')}@cowface.invalid`, hashPassword(crypto.randomBytes(32).toString('hex')), userId);
  });
  removeFrom(UPLOAD_DIR, uploads);
  removeFrom(ATTACH_DIR, attachments);
  for (const [conv, text] of notes) systemNote(conv, text);
}
