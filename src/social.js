// Seguir tiendas y guardar artículos en favoritos (como Grailed): quien sigue una tienda recibe un
// aviso en el celular cuando publica algo nuevo; quien guardó un artículo, cuando le bajan el precio.
import { db } from './db.js';
import { SITE_NAME, formatColones } from './catalog.js';
import { pushToUser } from './push.js';
import { sendMail } from './mailer.js';
import { notBlockedSql } from './blocks.js';
import { FEATURED_SQL, LIVE_SELLER } from './products.js';

// ---------- Seguir tiendas ----------

export const isFollowing = (userId, storeId) => Boolean(userId && db.prepare('SELECT 1 FROM store_follows WHERE user_id = ? AND store_id = ?').get(userId, storeId));
export const followerCount = (storeId) => db.prepare('SELECT COUNT(*) AS n FROM store_follows WHERE store_id = ?').get(storeId).n;

export function follow(userId, storeId) {
  if (userId === storeId) return false;
  const store = db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'usuario' AND active = 1").get(storeId);
  if (!store) return false;
  db.prepare('INSERT OR IGNORE INTO store_follows (user_id, store_id) VALUES (?, ?)').run(userId, storeId);
  return true;
}

export const unfollow = (userId, storeId) => db.prepare('DELETE FROM store_follows WHERE user_id = ? AND store_id = ?').run(userId, storeId);

export function followedStores(userId) {
  return db.prepare(`
    SELECT u.id, COALESCE(u.store_name, u.name) AS store_name, u.store_logo, u.province,
      (SELECT COUNT(*) FROM products p WHERE p.seller_id = u.id AND p.status = 'disponible') AS listings
    FROM store_follows f JOIN users u ON u.id = f.store_id
    WHERE f.user_id = ? AND u.active = 1 ORDER BY f.created_at DESC
  `).all(userId);
}

const CARD = `
  p.id, p.title, p.brand, p.category, p.department, p.item_type, p.size, p.color, p.condition,
  p.price, p.compare_at_price, p.promo_until, p.status, p.created_at, p.bumped_at, COALESCE(u.store_name, u.name) AS store_name, u.province, ${FEATURED_SQL} AS featured,
  (SELECT COALESCE(thumb, filename) FROM product_images i WHERE i.product_id = p.id ORDER BY position LIMIT 1) AS image
`;

// Lo último de las tiendas que sigue (la pestaña "Siguiendo").
export function followingFeed(userId, limit = 60) {
  return db.prepare(`
    SELECT ${CARD} FROM store_follows f JOIN products p ON p.seller_id = f.store_id JOIN users u ON u.id = p.seller_id
    WHERE f.user_id = ? AND p.status = 'disponible' AND ${LIVE_SELLER} AND ${notBlockedSql('p.seller_id')}
    ORDER BY COALESCE(p.bumped_at, p.created_at) DESC, p.id DESC LIMIT ?
  `).all(userId, userId, userId, limit);
}

// Al publicar: aviso en el celular a quienes siguen la tienda (no bloquea la publicación).
export function notifyFollowers(storeId, productId) {
  setImmediate(() => {
    try {
      const p = db.prepare('SELECT p.title, p.price, COALESCE(u.store_name, u.name) AS store FROM products p JOIN users u ON u.id = p.seller_id WHERE p.id = ?').get(productId);
      if (!p) return;
      for (const { user_id: id } of db.prepare('SELECT user_id FROM store_follows WHERE store_id = ?').all(storeId)) {
        pushToUser(id, { title: `Nuevo en ${p.store}`, body: `${p.title} · ${formatColones(p.price)}`, url: `/p/${productId}`, tag: `tienda-${storeId}` });
      }
    } catch (err) {
      console.error('Error avisando a seguidores:', err.message);
    }
  });
}

// ---------- Favoritos ----------

export const isFavorite = (userId, productId) => Boolean(userId && db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND product_id = ?').get(userId, productId));
export const favoriteCount = (productId) => db.prepare('SELECT COUNT(*) AS n FROM favorites WHERE product_id = ?').get(productId).n;

// Devuelve true si quedó guardado, false si se quitó, null si el artículo no existe o es suyo.
export function toggleFavorite(userId, productId) {
  const p = db.prepare("SELECT seller_id, price FROM products WHERE id = ? AND status != 'borrador'").get(productId);
  if (!p || p.seller_id === userId) return null;
  if (isFavorite(userId, productId)) {
    db.prepare('DELETE FROM favorites WHERE user_id = ? AND product_id = ?').run(userId, productId);
    return false;
  }
  db.prepare('INSERT INTO favorites (user_id, product_id, notified_price) VALUES (?, ?, ?)').run(userId, productId, p.price);
  return true;
}

export function favoritesOf(userId) {
  return db.prepare(`
    SELECT ${CARD}, f.notified_price FROM favorites f JOIN products p ON p.id = f.product_id JOIN users u ON u.id = p.seller_id
    WHERE f.user_id = ? AND p.status != 'borrador' AND u.active = 1 ORDER BY p.status = 'disponible' DESC, f.created_at DESC
  `).all(userId);
}

// Ids de los artículos guardados de una persona (para pintar los corazones en una lista).
export function favoriteIds(userId) {
  if (!userId) return new Set();
  return new Set(db.prepare('SELECT product_id FROM favorites WHERE user_id = ?').all(userId).map((r) => r.product_id));
}

// Cuántas personas guardaron cada artículo de una tienda.
export function favoriteCounts(sellerId) {
  return Object.fromEntries(db.prepare(`
    SELECT f.product_id, COUNT(*) AS n FROM favorites f JOIN products p ON p.id = f.product_id WHERE p.seller_id = ? GROUP BY f.product_id
  `).all(sellerId).map((r) => [r.product_id, r.n]));
}

// Revisión periódica: si un artículo guardado bajó de precio (descuento, promo o edición), aviso por
// el celular y por correo a quien lo guardó. Una vez por bajada.
export async function notifyPriceDrops(baseUrl = '') {
  const drops = db.prepare(`
    SELECT f.user_id, f.product_id, f.notified_price, p.title, p.price, u.email, u.name
    FROM favorites f JOIN products p ON p.id = f.product_id JOIN users u ON u.id = f.user_id JOIN users s ON s.id = p.seller_id
    WHERE p.status = 'disponible' AND p.price < f.notified_price AND u.active = 1 AND s.active = 1 AND s.store_paused = ''
  `).all();
  for (const d of drops) {
    db.prepare('UPDATE favorites SET notified_price = ? WHERE user_id = ? AND product_id = ?').run(d.price, d.user_id, d.product_id);
    const pct = Math.round((1 - d.price / d.notified_price) * 100);
    const text = `${d.title}: ahora ${formatColones(d.price)} (antes ${formatColones(d.notified_price)}, −${pct} %)`;
    pushToUser(d.user_id, { title: '💸 Bajó de precio algo que guardaste', body: text, url: `/p/${d.product_id}`, tag: `precio-${d.product_id}` });
    const link = `${baseUrl}/p/${d.product_id}`;
    try {
      await sendMail({
        to: d.email,
        subject: `Bajó de precio: ${d.title}`,
        text: `Hola ${d.name}:\n\n${text}\n${link}\n\nLo guardaste en tus favoritos de ${SITE_NAME}. Si ya no te interesa, quítalo de tus favoritos.`,
        html: `<p>Hola ${esc(d.name)}:</p><p><a href="${link}"><strong>${esc(d.title)}</strong></a> bajó de precio: ahora <strong>${formatColones(d.price)}</strong> <s>${formatColones(d.notified_price)}</s> (−${pct} %).</p>`
          + `<p style="color:#666">Lo guardaste en tus favoritos de ${SITE_NAME}. Si ya no te interesa, quítalo de tus favoritos.</p>`,
      });
    } catch (err) {
      console.error('Error avisando bajada de precio:', err.message);
    }
  }
  // Si subió de precio, se actualiza la referencia (el aviso es por bajadas desde el último precio visto).
  db.prepare(`UPDATE favorites SET notified_price = (SELECT price FROM products WHERE id = favorites.product_id)
    WHERE notified_price < (SELECT price FROM products WHERE id = favorites.product_id)`).run();
  return drops.length;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
