// Herramientas de la tienda para sus artículos: "Subir al inicio" (como el bump de Grailed),
// duplicar un artículo (como en el menú de DoorDash) y exportar el inventario a CSV.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { db, transaction } from './db.js';
import { CATEGORIES, CONDITIONS, PRODUCT_STATUS } from './catalog.js';
import { UPLOAD_DIR } from './storage.js';
import { sizesOf, saveSizes } from './variants.js';
import { refreshProductSearch } from './products.js';

export const BUMP_DAYS = 7;
const DAY_MS = 24 * 3600e3;
// Fechas de SQLite ("2026-10-14 22:10:00", en UTC) a milisegundos.
const ms = (sqlDate) => Date.parse(`${String(sqlDate).replace(' ', 'T')}Z`);

// Se puede subir si está a la venta y pasaron 7 días desde que se publicó o se subió por última vez.
export function bumpState(p, nowMs = Date.now()) {
  const last = ms(p.bumped_at || p.created_at);
  const next = last + BUMP_DAYS * DAY_MS;
  return { can: p.status === 'disponible' && nowMs >= next, next: new Date(next) };
}

export function bump(productId) {
  db.prepare("UPDATE products SET bumped_at = datetime('now') WHERE id = ?").run(productId);
}

// Copia un archivo de foto con un nombre nuevo (la copia y el original se pueden borrar por separado).
function copyPhoto(name) {
  if (!name) return null;
  const ext = path.extname(name);
  const copy = `${crypto.randomBytes(12).toString('hex')}${name.includes('_o.') ? '_o' : name.includes('_t.') ? '_t' : ''}${ext}`;
  fs.copyFileSync(path.join(UPLOAD_DIR, name), path.join(UPLOAD_DIR, copy));
  return copy;
}

// Duplica el artículo como borrador (mismos datos, tallas, detalles y fotos copiadas).
export function duplicateProduct(productId) {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!p) return null;
  const images = db.prepare('SELECT filename, thumb, original, position FROM product_images WHERE product_id = ? ORDER BY position, id').all(productId);
  const copies = [];
  try {
    for (const img of images) {
      const c = { filename: copyPhoto(img.filename), thumb: copyPhoto(img.thumb), original: copyPhoto(img.original), position: img.position };
      copies.push(c);
    }
  } catch (err) {
    for (const c of copies) for (const f of [c.filename, c.thumb, c.original]) if (f) fs.rmSync(path.join(UPLOAD_DIR, f), { force: true });
    throw err;
  }
  const id = transaction(() => {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO products (seller_id, title, brand, description, category, department, item_type, size, color, condition,
        price, quantity, measurements, shipping_cost, meetup, status, details, retail_price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'borrador', ?, ?)
    `).run(p.seller_id, `${p.title} (copia)`.slice(0, 100), p.brand, p.description, p.category, p.department, p.item_type, p.size,
      p.color, p.condition, p.compare_at_price && p.compare_at_price > p.price ? p.compare_at_price : p.price, Math.max(1, p.quantity),
      p.measurements, p.shipping_cost, p.meetup, p.details, p.retail_price);
    const newId = Number(lastInsertRowid);
    const insert = db.prepare('INSERT INTO product_images (product_id, filename, thumb, original, position) VALUES (?, ?, ?, ?, ?)');
    for (const c of copies) insert.run(newId, c.filename, c.thumb, c.original, c.position);
    if (p.has_sizes) saveSizes(newId, sizesOf(productId).map((s) => ({ ...s, quantity: s.quantity || 1 })));
    return newId;
  });
  refreshProductSearch(id);
  return id;
}

// ---------- CSV del inventario (para Excel / Google Sheets) ----------

const cell = (v) => {
  const s = String(v ?? '');
  // Evita que Excel interprete fórmulas ("=", "+", "-", "@") y escapa comillas.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",;\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function inventoryCsv(sellerId, baseUrl = '') {
  const rows = db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM favorites f WHERE f.product_id = p.id) AS favs
    FROM products p WHERE p.seller_id = ? ORDER BY p.created_at DESC, p.id DESC
  `).all(sellerId);
  const head = ['ID', 'Título', 'Marca', 'Categoría', 'Tipo', 'Talla(s)', 'Unidades por talla', 'Estado', 'Condición', 'Precio',
    'Precio normal (sin descuento)', 'Unidades', 'Visitas', 'Favoritos', 'Publicado', 'Enlace'];
  const lines = rows.map((p) => [
    p.id, p.title, p.brand, CATEGORIES[p.category]?.label || p.category, p.item_type, p.size,
    p.has_sizes ? sizesOf(p.id).map((s) => `${s.size}: ${s.quantity}`).join(' | ') : '',
    p.status === 'vendido' ? 'Agotado' : PRODUCT_STATUS[p.status], CONDITIONS[p.condition] || p.condition, p.price,
    p.compare_at_price && p.compare_at_price > p.price ? p.compare_at_price : '', p.quantity, p.views, p.favs,
    p.created_at, p.status === 'borrador' ? '' : `${baseUrl}/p/${p.id}`,
  ].map(cell).join(','));
  // BOM para que Excel abra bien las tildes.
  return `﻿${[head.map(cell).join(','), ...lines].join('\r\n')}\r\n`;
}
