import { db, transaction } from './db.js';
import { CATEGORIES, CONDITION_GROUPS, DEPARTMENTS, PROVINCES, SORTS, isValidSize } from './catalog.js';
import { parsePrice } from './validate.js';
import { notBlockedSql } from './blocks.js';

export const PAGE_SIZE = 24;

// Tienda destacada por el admin (vigente): sus artículos van primero en "Más recientes" y en la portada.
export const FEATURED_SQL = "(u.featured_until IS NOT NULL AND u.featured_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";

const CARD_COLUMNS = `
  p.id, p.title, p.brand, p.category, p.department, p.item_type, p.size, p.color, p.condition,
  p.price, p.status, p.created_at, COALESCE(u.store_name, u.name) AS store_name, u.province, ${FEATURED_SQL} AS featured,
  (SELECT COALESCE(thumb, filename) FROM product_images i WHERE i.product_id = p.id ORDER BY position LIMIT 1) AS image
`;

// Limpia los filtros de la URL: lo que no reconoce, lo ignora.
export function parseFilters(query, viewerId = null) {
  const q = String(query.q ?? '').trim().slice(0, 80);
  const category = CATEGORIES[query.categoria] ? query.categoria : '';
  const sizes = [query.talla].flat().filter((s) => typeof s === 'string' && s && (!category || isValidSize(category, s)));
  return {
    q,
    category,
    department: DEPARTMENTS[query.para] ? query.para : '',
    item_type: category && CATEGORIES[category].types.includes(query.tipo) ? query.tipo : '',
    sizes: sizes.slice(0, 20),
    condition: CONDITION_GROUPS[query.estado] ? query.estado : '',
    province: PROVINCES.includes(query.provincia) ? query.provincia : '',
    min: parsePrice(query.min),
    max: parsePrice(query.max),
    sort: SORTS[query.orden] ? query.orden : 'recientes',
    page: Math.max(1, Math.min(500, Number.parseInt(query.pagina, 10) || 1)),
    viewerId,
  };
}

export function searchProducts(f) {
  const where = ["p.status = 'disponible'", 'u.active = 1'];
  const params = [];
  if (f.viewerId) { where.push(notBlockedSql('p.seller_id')); params.push(f.viewerId, f.viewerId); }
  if (f.onlyId) { where.push('p.id = ?'); params.push(f.onlyId); }
  if (f.q) {
    // Cada palabra debe aparecer en título, marca, tipo, color o descripción.
    for (const word of f.q.split(/\s+/).slice(0, 6)) {
      where.push("(p.title || ' ' || p.brand || ' ' || p.item_type || ' ' || p.color || ' ' || p.description) LIKE ?");
      params.push(`%${word.replace(/[%_]/g, '')}%`);
    }
  }
  if (f.category) { where.push('p.category = ?'); params.push(f.category); }
  if (f.department) {
    // Lo unisex aparece tanto para mujer como para hombre.
    where.push(f.department === 'unisex' ? "p.department = 'unisex'" : "p.department IN (?, 'unisex')");
    if (f.department !== 'unisex') params.push(f.department);
  }
  if (f.item_type) { where.push('p.item_type = ?'); params.push(f.item_type); }
  if (f.sizes.length) { where.push(`p.size IN (${f.sizes.map(() => '?').join(',')})`); params.push(...f.sizes); }
  if (f.condition) {
    const group = CONDITION_GROUPS[f.condition];
    where.push(`p.condition IN (${group.map(() => '?').join(',')})`);
    params.push(...group);
  }
  if (f.province) { where.push('u.province = ?'); params.push(f.province); }
  if (f.min) { where.push('p.price >= ?'); params.push(f.min); }
  if (f.max) { where.push('p.price <= ?'); params.push(f.max); }

  const order = { recientes: `${FEATURED_SQL} DESC, p.created_at DESC, p.id DESC`, precio_asc: 'p.price ASC', precio_desc: 'p.price DESC' }[f.sort];
  const from = `FROM products p JOIN users u ON u.id = p.seller_id WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params).n;
  const items = db.prepare(`SELECT ${CARD_COLUMNS} ${from} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, PAGE_SIZE, (f.page - 1) * PAGE_SIZE);
  return { items, total, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

// ¿Este artículo aparece en esa búsqueda? (para los avisos de búsquedas guardadas)
export function productMatches(filters, productId) {
  return searchProducts({ ...filters, onlyId: productId, page: 1 }).total > 0;
}

export function latestProducts(limit = 12, viewerId = null) {
  const hide = viewerId ? `AND ${notBlockedSql('p.seller_id')}` : '';
  return db.prepare(`
    SELECT ${CARD_COLUMNS} FROM products p JOIN users u ON u.id = p.seller_id
    WHERE p.status = 'disponible' AND u.active = 1 ${hide} ORDER BY ${FEATURED_SQL} DESC, p.created_at DESC, p.id DESC LIMIT ?
  `).all(...(viewerId ? [viewerId, viewerId] : []), limit);
}

export function countByCategory() {
  const rows = db.prepare(`
    SELECT p.category, COUNT(*) AS n FROM products p JOIN users u ON u.id = p.seller_id
    WHERE p.status = 'disponible' AND u.active = 1 GROUP BY p.category
  `).all();
  return Object.fromEntries(rows.map((r) => [r.category, r.n]));
}

export function getProduct(id) {
  const product = db.prepare(`
    SELECT p.*, COALESCE(u.store_name, u.name) AS store_name, u.name AS seller_name, u.province, u.active AS seller_active, ${FEATURED_SQL} AS featured
    FROM products p JOIN users u ON u.id = p.seller_id WHERE p.id = ?
  `).get(id);
  if (!product) return null;
  product.images = db.prepare(`
    SELECT id, filename, COALESCE(thumb, filename) AS thumb, COALESCE(original, filename) AS original
    FROM product_images WHERE product_id = ? ORDER BY position, id
  `).all(id);
  try { product.measurements = JSON.parse(product.measurements || '{}'); } catch { product.measurements = {}; }
  return product;
}

export function sellerProducts(sellerId) {
  return db.prepare(`
    SELECT ${CARD_COLUMNS}, p.quantity FROM products p JOIN users u ON u.id = p.seller_id
    WHERE p.seller_id = ? ORDER BY p.status = 'disponible' DESC, p.created_at DESC
  `).all(sellerId);
}

// status: 'disponible' para publicar, 'borrador' para guardar sin publicar.
export function createProduct(sellerId, data, photos = [], status = 'disponible') {
  return transaction(() => {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO products (seller_id, title, brand, description, category, department, item_type, size, color, condition,
        price, quantity, measurements, shipping_cost, meetup, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sellerId, data.title, data.brand, data.description, data.category, data.department,
      data.item_type, data.size, data.color, data.condition, data.price, data.quantity,
      JSON.stringify(data.measurements || {}), data.shipping_cost || 0, data.meetup ?? 1, status);
    addImages(lastInsertRowid, photos);
    return Number(lastInsertRowid);
  });
}

// publish: true pasa un borrador a "disponible" (los demás estados no cambian).
export function updateProduct(id, data, photos = [], { publish = false } = {}) {
  transaction(() => {
    db.prepare(`
      UPDATE products SET title = ?, brand = ?, description = ?, category = ?, department = ?, item_type = ?,
        size = ?, color = ?, condition = ?, price = ?, quantity = ?, measurements = ?, shipping_cost = ?, meetup = ?,
        status = CASE WHEN ? AND status = 'borrador' THEN 'disponible' ELSE status END,
        created_at = CASE WHEN ? AND status = 'borrador' THEN datetime('now') ELSE created_at END,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(data.title, data.brand, data.description, data.category, data.department, data.item_type,
      data.size, data.color, data.condition, data.price, data.quantity, JSON.stringify(data.measurements || {}),
      data.shipping_cost || 0, data.meetup ?? 1, publish ? 1 : 0, publish ? 1 : 0, id);
    addImages(id, photos);
  });
}

// Edición rápida desde "Mi cuenta": precio y cantidad sin abrir todo el formulario.
export function quickUpdate(id, price, quantity) {
  db.prepare(`
    UPDATE products SET price = ?, quantity = ?,
      status = CASE WHEN ? = 0 AND status = 'disponible' THEN 'vendido'
                    WHEN ? > 0 AND status = 'vendido' THEN 'disponible' ELSE status END,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(price, quantity, quantity, quantity, id);
}

// photos: [{ filename, thumb }] ya procesadas por images.js (la primera es la portada).
function addImages(productId, photos) {
  const start = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM product_images WHERE product_id = ?').get(productId).n;
  const insert = db.prepare('INSERT INTO product_images (product_id, filename, thumb, original, position) VALUES (?, ?, ?, ?, ?)');
  photos.forEach((p, i) => insert.run(productId, p.filename, p.thumb || null, p.original || null, start + i));
}

export function imageCount(productId) {
  return db.prepare('SELECT COUNT(*) AS n FROM product_images WHERE product_id = ?').get(productId).n;
}

const filesOf = (row) => [row.filename, row.thumb, row.original].filter(Boolean);

// Devuelve los archivos borrados (original, vista y miniatura) para que la ruta los quite del disco.
export function deleteImage(productId, imageId) {
  const row = db.prepare('SELECT filename, thumb, original FROM product_images WHERE id = ? AND product_id = ?').get(imageId, productId);
  if (row) db.prepare('DELETE FROM product_images WHERE id = ?').run(imageId);
  return row ? filesOf(row) : [];
}

// Pone una foto como portada (primera en la galería y en las tarjetas).
export function setCoverImage(productId, imageId) {
  transaction(() => {
    const row = db.prepare('SELECT id FROM product_images WHERE id = ? AND product_id = ?').get(imageId, productId);
    if (!row) return;
    const ids = db.prepare('SELECT id FROM product_images WHERE product_id = ? ORDER BY position, id').all(productId).map((r) => r.id);
    const ordered = [imageId, ...ids.filter((id) => id !== imageId)];
    const update = db.prepare('UPDATE product_images SET position = ? WHERE id = ?');
    ordered.forEach((id, i) => update.run(i, id));
  });
}

export function deleteProduct(id) {
  const files = db.prepare('SELECT filename, thumb, original FROM product_images WHERE product_id = ?').all(id).flatMap(filesOf);
  db.prepare('DELETE FROM products WHERE id = ?').run(id);
  return files;
}

export function setProductStatus(id, status) {
  db.prepare("UPDATE products SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
}

// Una foto real por categoría (el artículo disponible más reciente que tenga foto) para la portada.
export function categoryCovers() {
  const rows = db.prepare(`
    SELECT p.category, p.id, COALESCE(i.thumb, i.filename) AS image
    FROM products p JOIN users u ON u.id = p.seller_id
    JOIN product_images i ON i.product_id = p.id AND i.position = (SELECT MIN(position) FROM product_images WHERE product_id = p.id)
    WHERE p.status = 'disponible' AND u.active = 1
    ORDER BY p.created_at DESC
  `).all();
  const covers = {};
  for (const r of rows) if (!covers[r.category]) covers[r.category] = r;
  return covers;
}
