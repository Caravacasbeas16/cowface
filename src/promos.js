// Promos y descuentos de las tiendas.
//  - Descuento por artículo: X % (opcionalmente hasta una fecha).
//  - Promo en toda la tienda: X % en todos sus artículos (también los que publique durante la promo).
// El precio de venta (products.price) baja de verdad, así pedidos, ofertas y filtros usan el precio con
// descuento; el precio de antes queda en compare_at_price y se muestra tachado. Al vencer, vuelve solo.
import { db, transaction } from './db.js';

export const MIN_PCT = 5;
export const MAX_PCT = 80;
const MAX_DAYS = 90;

const roundPrice = (n) => Math.max(100, Math.round(n / 100) * 100);
export const discountPct = (p) => (p.compare_at_price && p.compare_at_price > p.price ? Math.round((1 - p.price / p.compare_at_price) * 100) : 0);

// "AAAA-MM-DD" (fin de ese día en Costa Rica) → ISO. Vacío = sin fecha de fin.
export function parseUntil(value, nowMs = Date.now()) {
  const v = String(value ?? '').trim();
  if (!v) return { until: null, error: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return { until: null, error: 'Fecha de fin no válida.' };
  const ms = Date.parse(`${v}T23:59:59-06:00`);
  if (Number.isNaN(ms) || ms < nowMs) return { until: null, error: 'La fecha de fin ya pasó.' };
  if (ms - nowMs > MAX_DAYS * 86400e3) return { until: null, error: `La promo puede durar máximo ${MAX_DAYS} días.` };
  return { until: new Date(ms).toISOString(), error: null };
}

export function parsePct(value) {
  const pct = Number.parseInt(String(value ?? '').replace('%', ''), 10);
  return pct >= MIN_PCT && pct <= MAX_PCT ? pct : null;
}

const productRow = (id) => db.prepare('SELECT id, seller_id, price, compare_at_price, promo_store, promo_until FROM products WHERE id = ?').get(id);
const basePrice = (p) => (p.compare_at_price && p.compare_at_price > p.price ? p.compare_at_price : p.price);

function applyDiscount(p, pct, until, store) {
  const base = basePrice(p);
  db.prepare("UPDATE products SET compare_at_price = ?, price = ?, promo_until = ?, promo_store = ?, updated_at = datetime('now') WHERE id = ?")
    .run(base, roundPrice(base * (1 - pct / 100)), until, store ? 1 : 0, p.id);
}

function restore(p) {
  db.prepare("UPDATE products SET price = ?, compare_at_price = NULL, promo_until = NULL, promo_store = 0, updated_at = datetime('now') WHERE id = ?")
    .run(basePrice(p), p.id);
}

export function setProductDiscount(productId, pct, until) {
  transaction(() => applyDiscount(productRow(productId), pct, until, false));
}

export function removeProductDiscount(productId) {
  const p = productRow(productId);
  if (p?.compare_at_price) restore(p);
}

// Precio "normal" que el vendedor edita, y si tenía descuento, se vuelve a aplicar igual sobre el precio nuevo.
export function reapplyAfterPriceChange(productId, before) {
  const pct = discountPct(before);
  if (!pct) return;
  const p = productRow(productId);
  db.prepare('UPDATE products SET compare_at_price = NULL WHERE id = ?').run(productId);
  applyDiscount({ ...p, compare_at_price: null }, pct, before.promo_until, before.promo_store);
}

export function storePromoOf(sellerId, nowMs = Date.now()) {
  try {
    const promo = JSON.parse(db.prepare('SELECT store_promo FROM users WHERE id = ?').get(sellerId)?.store_promo || '{}');
    if (!promo.pct) return null;
    if (promo.until && Date.parse(promo.until) < nowMs) return null;
    return promo;
  } catch {
    return null;
  }
}

export function startStorePromo(sellerId, pct, until, label) {
  transaction(() => {
    db.prepare('UPDATE users SET store_promo = ? WHERE id = ?')
      .run(JSON.stringify({ pct, until, label: String(label ?? '').trim().slice(0, 40) }), sellerId);
    // Los artículos con descuento propio se quedan con el suyo.
    const items = db.prepare(`SELECT id, seller_id, price, compare_at_price, promo_store, promo_until FROM products
      WHERE seller_id = ? AND status IN ('disponible', 'pausado', 'borrador') AND (compare_at_price IS NULL OR promo_store = 1)`).all(sellerId);
    for (const p of items) applyDiscount(p, pct, until, true);
  });
}

export function endStorePromo(sellerId) {
  transaction(() => {
    db.prepare("UPDATE users SET store_promo = '{}' WHERE id = ?").run(sellerId);
    for (const p of db.prepare('SELECT id, price, compare_at_price FROM products WHERE seller_id = ? AND promo_store = 1').all(sellerId)) restore(p);
  });
}

// Un artículo nuevo (o recién publicado) entra a la promo de la tienda si hay una activa.
export function applyStorePromoTo(productId) {
  const p = productRow(productId);
  const promo = p && storePromoOf(p.seller_id);
  if (promo && !p.compare_at_price) applyDiscount(p, promo.pct, promo.until || null, true);
}

// Cada pocos minutos: descuentos y promos vencidos vuelven al precio normal.
export function expirePromos(nowMs = Date.now()) {
  const now = new Date(nowMs).toISOString();
  let n = 0;
  for (const s of db.prepare("SELECT id, store_promo FROM users WHERE store_promo != '{}'").all()) {
    try {
      const promo = JSON.parse(s.store_promo);
      if (promo.until && promo.until < now) { endStorePromo(s.id); n += 1; }
    } catch { /* promo dañada: se ignora */ }
  }
  for (const p of db.prepare('SELECT id, price, compare_at_price FROM products WHERE promo_until IS NOT NULL AND promo_until < ? AND promo_store = 0').all(now)) {
    restore(p);
    n += 1;
  }
  return n;
}

// "hasta el domingo 19 oct" para mostrar.
const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export function untilLabel(iso) {
  if (!iso) return '';
  const d = new Date(Date.parse(iso) - 6 * 3600e3);
  return `hasta el ${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
