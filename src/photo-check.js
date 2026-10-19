// Filtro automático de fotos de artículos, antes de la revisión del admin.
//  - Se rechazan al subir: fotos casi negras (no muestran nada).
//  - Se marcan para revisar: borrosas, muy oscuras, de un solo color, y las iguales a una foto de OTRA tienda
//    (huella "dHash": aguanta cambios de tamaño, compresión y recortes leves).
//  - Toda foto nueva queda en Admin → Fotos hasta que el admin la vea. El artículo se ve mientras
//    tanto; si el admin lo pausa, queda oculto hasta que la tienda cambie las fotos y él lo apruebe.
import sharp from 'sharp';
import path from 'node:path';
import { db, transaction } from './db.js';
import { now } from './messages.js';
import { UPLOAD_DIR } from './storage.js';

const MAX_PIXELS = 120_000_000;
export const FLAG_LABELS = { borrosa: 'Se ve borrosa', oscura: 'Muy oscura', plana: 'Casi sin detalle (un solo color)', repetida: 'Igual a una foto de otra tienda' };
const DUPLICATE_BITS = 10; // de 64: recomprimida 0–4, recortada un poco ~10; fotos distintas 20 o más

// La foto en gris, de 512 px como máximo: se decodifica una sola vez para todo el análisis.
const greySmall = (input) => sharp(input, { limitInputPixels: MAX_PIXELS }).rotate().flatten({ background: '#ffffff' })
  .greyscale().resize(512, 512, { fit: 'inside', withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true });

// Huella de 64 bits (16 hex): cada bit dice si un píxel es más claro que el de su derecha (9×8 en gris).
async function dHash(grey) {
  const { data: g, info } = grey || {};
  const { data } = await sharp(g, { raw: { width: info.width, height: info.height, channels: 1 } })
    .resize(9, 8, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += data[y * 9 + x] > data[y * 9 + x + 1] ? '1' : '0';
  return BigInt(`0b${bits}`).toString(16).padStart(16, '0');
}

export function hamming(a, b) {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

// Brillo promedio, contraste (desviación) y nitidez (varianza del laplaciano) en una versión de 512 px.
export async function analyzePhoto(input) {
  const grey = await greySmall(input);
  const { data, info } = grey;
  const { width: w, height: h } = info;
  let sum = 0;
  let sq = 0;
  for (const v of data) { sum += v; sq += v * v; }
  const mean = sum / data.length;
  const stdev = Math.sqrt(Math.max(0, sq / data.length - mean * mean));
  let lsum = 0;
  let lsq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = data[i - 1] + data[i + 1] + data[i - w] + data[i + w] - 4 * data[i];
      lsum += l; lsq += l * l; n += 1;
    }
  }
  const sharpness = n ? lsq / n - (lsum / n) ** 2 : 0;
  return { mean, stdev, sharpness, hash: await dHash(grey) };
}

// Lo que se rechaza al subir (mensaje para la tienda) o null si la foto pasa.
export function rejectReason(a) {
  if (a.mean < 18) return 'Una de las fotos está casi negra: tómala con más luz.';
  return null;
}

// Marcas para la revisión del admin (la foto sí se publica).
export function qualityFlags(a) {
  const flags = [];
  if (a.stdev < 3) return ['plana'];
  if (a.sharpness < 20) flags.push('borrosa'); // fotos nítidas: cientos o miles
  if (a.mean < 45) flags.push('oscura');
  return flags;
}

// ¿Esta huella ya la tiene una foto de otra tienda? Devuelve el nombre de esa tienda o null.
export function duplicateOf(hash, sellerId) {
  if (!hash) return null;
  const rows = db.prepare(`
    SELECT i.phash, COALESCE(u.store_name, u.name) AS store FROM product_images i
    JOIN products p ON p.id = i.product_id JOIN users u ON u.id = p.seller_id
    WHERE i.phash IS NOT NULL AND i.phash != '' AND p.seller_id != ?
  `).all(sellerId);
  return rows.find((r) => hamming(r.phash, hash) <= DUPLICATE_BITS)?.store || null;
}

// Banderas finales de una foto al guardarla en un artículo (calidad + repetida de otra tienda).
export function flagsFor(photo, sellerId) {
  const flags = [...(photo.flags || [])];
  const other = duplicateOf(photo.phash, sellerId);
  if (other) flags.push(`repetida:${other}`);
  return flags.join(',') || null;
}

export const describeFlags = (s) => String(s || '').split(',').filter(Boolean).map((f) => {
  const [key, store] = f.split(':');
  return key === 'repetida' ? `${FLAG_LABELS.repetida} (${store})` : FLAG_LABELS[key] || key;
});

// ---------- Revisión del admin (Admin → Fotos) ----------

// Artículos con fotos sin revisar, y los pausados por fotos que esperan que la tienda las cambie.
export function photoQueue() {
  const products = db.prepare(`
    SELECT p.id, p.title, p.status, p.photo_hold, p.created_at, p.seller_id, COALESCE(u.store_name, u.name) AS store_name,
      (SELECT COUNT(*) FROM product_images i WHERE i.product_id = p.id AND i.reviewed_at IS NULL) AS pending
    FROM products p JOIN users u ON u.id = p.seller_id
    WHERE p.status != 'borrador' AND (p.photo_hold = 1 OR EXISTS (SELECT 1 FROM product_images i WHERE i.product_id = p.id AND i.reviewed_at IS NULL))
    ORDER BY p.photo_hold, p.created_at
  `).all();
  const images = db.prepare('SELECT id, filename, thumb, check_flags, reviewed_at FROM product_images WHERE product_id = ? ORDER BY position');
  return products.map((p) => {
    const imgs = images.all(p.id).map((i) => ({ ...i, flags: describeFlags(i.check_flags) }));
    return { ...p, images: imgs, flagged: imgs.some((i) => !i.reviewed_at && i.flags.length) };
  });
}

export const photoQueueCount = () => db.prepare(`
  SELECT COUNT(DISTINCT p.id) AS n FROM products p JOIN product_images i ON i.product_id = p.id
  WHERE p.status != 'borrador' AND i.reviewed_at IS NULL
`).get().n;

// "Se ven bien": marca las fotos como revisadas; si estaba pausado por fotos, vuelve a la venta.
export function approvePhotos(productId) {
  return transaction(() => {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!p) return null;
    db.prepare('UPDATE product_images SET reviewed_at = ? WHERE product_id = ? AND reviewed_at IS NULL').run(now(), productId);
    if (p.photo_hold) {
      db.prepare(`UPDATE products SET photo_hold = 0, admin_hidden = 0,
        status = CASE WHEN status = 'pausado' AND quantity > 0 THEN 'disponible' ELSE status END WHERE id = ?`).run(productId);
    }
    return p;
  });
}

// "Pausar": se oculta hasta que la tienda cambie las fotos y el admin las apruebe.
export function holdForPhotos(productId) {
  return transaction(() => {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!p) return null;
    db.prepare('UPDATE product_images SET reviewed_at = ? WHERE product_id = ? AND reviewed_at IS NULL').run(now(), productId);
    db.prepare(`UPDATE products SET photo_hold = 1, admin_hidden = 1,
      status = CASE WHEN status = 'disponible' THEN 'pausado' ELSE status END WHERE id = ?`).run(productId);
    return p;
  });
}

// Fotos subidas antes de este filtro: se les calcula la huella para poder detectar repetidas.
export async function backfillHashes(limit = 500) {
  const rows = db.prepare('SELECT id, filename FROM product_images WHERE phash IS NULL LIMIT ?').all(limit);
  const save = db.prepare('UPDATE product_images SET phash = ? WHERE id = ?');
  for (const r of rows) {
    try { save.run(await dHash(await greySmall(path.join(UPLOAD_DIR, r.filename))), r.id); } catch { save.run('', r.id); }
  }
  return rows.length;
}
