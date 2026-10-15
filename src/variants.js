// Tallas con su propia cantidad (como StockX): un mismo artículo —por ejemplo unos tenis nuevos—
// con 2 en US 8, 1 en US 9 y 3 en US 10. products.quantity guarda la suma y products.size un
// resumen ("US 8 – US 10") para las tarjetas; la talla que elige el comprador queda en la
// conversación (chosen_size) y en el pedido.
import { db } from './db.js';
import { allSizes } from './catalog.js';
import { UserError } from './messages.js';

export const MAX_SIZE_QTY = 999;

// Campo del formulario para cada talla: vs_zapatos_0, vs_zapatos_1… (categoría + orden del catálogo,
// para que las cuadrículas de las otras categorías no se mezclen si llegan en el formulario).
export const sizeField = (category, i) => `vs_${category}_${i}`;

export function sizesOf(productId) {
  return db.prepare('SELECT size, quantity FROM product_sizes WHERE product_id = ? ORDER BY position').all(productId)
    .map((r) => ({ size: r.size, quantity: r.quantity }));
}

export function sizeSummary(sizes) {
  if (!sizes.length) return '';
  if (sizes.length === 1) return sizes[0].size;
  return `${sizes[0].size} – ${sizes[sizes.length - 1].size}`;
}

// Lee las cantidades por talla del formulario. Solo cuentan las tallas con 1 o más unidades
// (en "editar tallas" del inventario se pueden dejar en 0 las que ya existían).
export function parseSizeStock(category, body, { keepZero = [], allowEmpty = false } = {}) {
  const sizes = [];
  let error = null;
  allSizes(category).forEach((size, i) => {
    const raw = String(body[sizeField(category, i)] ?? '').trim();
    if (!raw) return;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > MAX_SIZE_QTY) { error = `Unidades de la talla ${size}: un número de 0 a ${MAX_SIZE_QTY}.`; return; }
    if (n > 0 || keepZero.includes(size)) sizes.push({ size, quantity: n, position: i });
  });
  if (!error && !allowEmpty && !sizes.some((s) => s.quantity > 0)) error = 'Pon cuántas unidades tienes en al menos una talla.';
  return { sizes, error };
}

// Guarda las tallas (reemplaza las anteriores) y actualiza la suma, el resumen y el estado.
export function saveSizes(productId, sizes) {
  db.prepare('DELETE FROM product_sizes WHERE product_id = ?').run(productId);
  const insert = db.prepare('INSERT INTO product_sizes (product_id, size, quantity, position) VALUES (?, ?, ?, ?)');
  sizes.forEach((s, i) => insert.run(productId, s.size, s.quantity, s.position ?? i));
  syncTotals(productId);
}

export function clearSizes(productId) {
  db.prepare('DELETE FROM product_sizes WHERE product_id = ?').run(productId);
  db.prepare('UPDATE products SET has_sizes = 0 WHERE id = ?').run(productId);
}

// Suma de unidades y resumen de tallas en el artículo. Con 0 unidades queda agotado; al volver a
// tener, vuelve a la venta (igual que la edición rápida de cantidad).
function syncTotals(productId) {
  const sizes = sizesOf(productId);
  const total = sizes.reduce((a, s) => a + s.quantity, 0);
  const inStock = sizes.filter((s) => s.quantity > 0);
  db.prepare(`
    UPDATE products SET has_sizes = 1, quantity = ?, size = ?,
      status = CASE WHEN ? = 0 AND status = 'disponible' THEN 'vendido'
                    WHEN ? > 0 AND status = 'vendido' THEN 'disponible' ELSE status END,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(total, sizeSummary(inStock.length ? inStock : sizes), total, total, productId);
}

// Una unidad de esa talla para un pedido (dentro de la transacción de createOrder).
export function takeSize(productId, size) {
  const row = db.prepare('SELECT quantity FROM product_sizes WHERE product_id = ? AND size = ?').get(productId, size);
  if (!size || !row) throw new UserError('Elige tu talla en la página del artículo antes de comprar u ofertar.');
  if (row.quantity < 1) throw new UserError(`Ya no queda la talla ${size}. Elige otra en la página del artículo.`);
  db.prepare('UPDATE product_sizes SET quantity = quantity - 1 WHERE product_id = ? AND size = ?').run(productId, size);
  syncTotals(productId);
  return size;
}

export function restockSize(productId, size) {
  const changed = db.prepare('UPDATE product_sizes SET quantity = quantity + 1 WHERE product_id = ? AND size = ?').run(productId, size).changes;
  if (changed) syncTotals(productId);
  return changed > 0;
}

export const zeroSizes = (productId) => db.prepare('UPDATE product_sizes SET quantity = 0 WHERE product_id = ?').run(productId);

// La talla que eligió el comprador para esta conversación (se valida contra las del artículo).
export function chooseSize(conversationId, productId, size) {
  if (!size) return null;
  const ok = db.prepare('SELECT 1 FROM product_sizes WHERE product_id = ? AND size = ?').get(productId, size);
  if (!ok) throw new UserError('Esa talla no existe en este artículo.');
  db.prepare('UPDATE conversations SET chosen_size = ? WHERE id = ?').run(size, conversationId);
  return size;
}
