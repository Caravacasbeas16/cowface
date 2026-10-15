// Panel de la tienda (inspirado en el Merchant Portal de DoorDash): inicio con lo urgente,
// pedidos por etapa, inventario con filtros y acciones en lote, y estado de la tienda.
import { db } from './db.js';
import { CATEGORIES, PRODUCT_STATUS, allSizes } from './catalog.js';
import { sizeField, sizesOf } from './variants.js';
import { OPEN_STATUSES, sellerOrders } from './orders.js';
import { listConversations } from './chat.js';
import { ratingSummary, salesSummary } from './reviews.js';
import { normalize } from './search-text.js';

// ---------- Pedidos por etapa ----------

// Qué le toca a la tienda en cada pedido (lo que DoorDash llama "Nuevo / En preparación / Listo").
export const STAGES = {
  cotizar: { label: 'Cotiza el envío', tab: 'atender', action: true },
  enviar: { label: 'Pagado · envíalo', tab: 'atender', action: true },
  reclamo: { label: 'Reclamo abierto', tab: 'atender', action: true },
  eleccion: { label: 'El comprador elige la entrega', tab: 'proceso' },
  pago: { label: 'Esperando el SINPE', tab: 'proceso' },
  verificando: { label: 'CowFace verifica el pago', tab: 'proceso' },
  camino: { label: 'Enviado · en camino', tab: 'proceso' },
  completado: { label: 'Completado', tab: 'completados' },
  cancelado: { label: 'Cancelado', tab: 'cancelados' },
  reembolso: { label: 'Reembolso', tab: 'cancelados' },
};

export const ORDER_TABS = {
  atender: 'Por atender',
  proceso: 'En proceso',
  completados: 'Completados',
  cancelados: 'Cancelados',
};

export function orderStage(o) {
  switch (o.status) {
    case 'por_pagar':
      if (o.payment_reported_at) return 'verificando';
      if (o.delivery_quote_at) return 'pago';
      return o.delivery_requested ? 'cotizar' : 'eleccion';
    case 'pagado': return 'enviar';
    case 'enviado': return 'camino';
    case 'en_disputa': return 'reclamo';
    case 'completado': return 'completado';
    case 'cancelado': return 'cancelado';
    default: return 'reembolso';
  }
}

export function ordersByTab(sellerId) {
  const out = Object.fromEntries(Object.keys(ORDER_TABS).map((k) => [k, []]));
  for (const o of sellerOrders(sellerId)) {
    const stage = orderStage(o);
    out[STAGES[stage].tab].push({ ...o, stage, stageLabel: STAGES[stage].label });
  }
  return out;
}

// ---------- Inicio ----------

const CR_DAY = "date('now', '-6 hours')";

export function homeSummary(user) {
  const id = user.id;
  const tabs = ordersByTab(id);
  const sales = (days) => db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(price), 0) AS amount FROM orders
    WHERE seller_id = ? AND status NOT IN ('cancelado', 'reembolsado', 'reembolso_pendiente')
      AND date(created_at, '-6 hours') > date(${CR_DAY}, ?)
  `).get(id, `-${days} days`);
  const stock = db.prepare(`
    SELECT
      SUM(status = 'disponible') AS live, SUM(status = 'borrador') AS drafts, SUM(status = 'pausado') AS paused,
      SUM(status = 'disponible' AND quantity = 1) AS lastUnit, COALESCE(SUM(CASE WHEN status = 'disponible' THEN views END), 0) AS views
    FROM products WHERE seller_id = ?
  `).get(id);
  const payout = db.prepare(`
    SELECT COALESCE(SUM(payout_amount), 0) AS n FROM orders WHERE seller_id = ? AND status = 'completado' AND payout_status = 'pendiente'
  `).get(id).n;
  const offers = db.prepare(`
    SELECT COUNT(*) AS n FROM offers f JOIN conversations c ON c.id = f.conversation_id
    WHERE c.seller_id = ? AND f.status = 'pendiente' AND f.made_by != ?
  `).get(id, id).n;
  const unread = listConversations(id).filter((c) => c.role === 'vendedor' && c.unread).length;
  const top = db.prepare(`
    SELECT p.id, p.title, p.price, p.views, p.quantity, p.category,
      (SELECT COALESCE(thumb, filename) FROM product_images i WHERE i.product_id = p.id ORDER BY position LIMIT 1) AS image
    FROM products p WHERE p.seller_id = ? AND p.status = 'disponible' ORDER BY p.views DESC, p.created_at DESC LIMIT 5
  `).all(id);
  return {
    tabs, today: sales(1), week: sales(7), month: sales(30), stock, payout, offers, unread, top,
    rating: ratingSummary(id).asSeller, salesTotal: salesSummary(id).total,
    todo: tabs.atender,
  };
}

// Lista para que la tienda quede completa (como el "checklist" de DoorDash al abrir una tienda).
export function setupChecklist(user, { hours, points, products }) {
  return [
    { done: Boolean(user.payout_phone), label: 'Agrega tu número SINPE para recibir pagos', href: '/vendedor/pagos' },
    { done: Boolean(user.store_about), label: 'Escribe la descripción de tu tienda', href: '/vendedor/configuracion#perfil' },
    { done: Object.keys(hours).length > 0, label: 'Pon tu horario de atención', href: '/vendedor/configuracion#horario' },
    { done: points.length > 0, label: 'Agrega tus puntos de pick up', href: '/vendedor/configuracion#tienda' },
    { done: products >= 5, label: 'Publica al menos 5 artículos', href: '/vendedor/productos/nuevo' },
  ];
}

// ---------- Estado de la tienda (pausar, como "Pausar pedidos" en DoorDash) ----------

export const MAX_PAUSE_NOTE = 80;

export function pauseStore(userId, note) {
  const text = String(note ?? '').trim().slice(0, MAX_PAUSE_NOTE) || 'Tienda en pausa';
  db.prepare('UPDATE users SET store_paused = ? WHERE id = ?').run(text, userId);
}

export const resumeStore = (userId) => db.prepare("UPDATE users SET store_paused = '' WHERE id = ?").run(userId);

export const isPaused = (sellerId) => Boolean(db.prepare('SELECT store_paused FROM users WHERE id = ?').get(sellerId)?.store_paused);

// ---------- Inventario ----------

export const INVENTORY_FILTERS = {
  todos: 'Todos',
  disponible: 'Disponibles',
  ultima: 'Última unidad',
  agotado: 'Agotados',
  pausado: 'Pausados',
  borrador: 'Borradores',
  reservado: 'Reservados',
};

export const INVENTORY_SORTS = {
  recientes: 'Más recientes',
  vistas: 'Más vistos',
  stock: 'Menos unidades',
  precio_asc: 'Precio: menor a mayor',
  precio_desc: 'Precio: mayor a menor',
  nombre: 'Nombre (A–Z)',
};

const FILTER_SQL = {
  todos: '1',
  disponible: "p.status = 'disponible'",
  ultima: "p.status = 'disponible' AND p.quantity = 1",
  agotado: "p.status = 'vendido'",
  pausado: "p.status = 'pausado'",
  borrador: "p.status = 'borrador'",
  reservado: "p.status = 'reservado'",
};

const SORT_SQL = {
  recientes: 'p.created_at DESC, p.id DESC',
  vistas: 'p.views DESC, p.id DESC',
  stock: "p.status != 'disponible', p.quantity ASC, p.id DESC",
  precio_asc: 'p.price ASC, p.id DESC',
  precio_desc: 'p.price DESC, p.id DESC',
  nombre: 'p.title COLLATE NOCASE ASC',
};

export function parseInventoryQuery(query) {
  return {
    estado: FILTER_SQL[query.estado] ? query.estado : 'todos',
    orden: SORT_SQL[query.orden] ? query.orden : 'recientes',
    categoria: CATEGORIES[query.categoria] ? query.categoria : '',
    q: String(query.q ?? '').trim().slice(0, 60),
  };
}

export function inventory(sellerId, f) {
  const where = ['p.seller_id = ?', FILTER_SQL[f.estado]];
  const params = [sellerId];
  if (f.categoria) { where.push('p.category = ?'); params.push(f.categoria); }
  const rows = db.prepare(`
    SELECT p.id, p.title, p.brand, p.category, p.item_type, p.size, p.price, p.compare_at_price, p.promo_until, p.promo_store,
      p.quantity, p.status, p.views, p.admin_hidden, p.created_at, p.updated_at, p.condition, p.has_sizes, p.bumped_at,
      (SELECT COALESCE(thumb, filename) FROM product_images i WHERE i.product_id = p.id ORDER BY position LIMIT 1) AS image,
      EXISTS (SELECT 1 FROM orders o WHERE o.product_id = p.id AND o.status IN (${OPEN_STATUSES.map(() => '?').join(',')})) AS locked
    FROM products p WHERE ${where.join(' AND ')} ORDER BY ${SORT_SQL[f.orden]}
  `).all(...OPEN_STATUSES, ...params);
  // Tallas con su cantidad y el nombre de su campo (vs_<categoría>_<n>) para editarlas ahí mismo.
  for (const p of rows) {
    if (!p.has_sizes) continue;
    const all = allSizes(p.category);
    p.sizes = sizesOf(p.id).map((s) => ({ ...s, field: sizeField(p.category, all.indexOf(s.size)) }));
  }
  if (!f.q) return rows;
  // Búsqueda sin tildes por nombre, marca, tipo o talla.
  const words = normalize(f.q).split(' ').filter(Boolean);
  return rows.filter((p) => {
    const text = normalize([p.title, p.brand, p.item_type, p.size].join(' '));
    return words.every((w) => text.includes(w));
  });
}

export function inventoryCounts(sellerId) {
  const counts = {};
  for (const [k, sql] of Object.entries(FILTER_SQL)) {
    counts[k] = db.prepare(`SELECT COUNT(*) AS n FROM products p WHERE p.seller_id = ? AND ${sql}`).get(sellerId).n;
  }
  return counts;
}

export const BULK_ACTIONS = {
  pausar: 'Pausar',
  activar: 'Activar',
  vendidos: 'Marcar como vendidos',
  borrar: 'Borrar',
};

// Lo que no se puede tocar (pedido en curso, oculto por CowFace) se salta y se cuenta aparte.
export function bulkTargets(sellerId, ids) {
  const clean = [...new Set([ids].flat().map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 300);
  if (!clean.length) return [];
  return db.prepare(`
    SELECT p.*, EXISTS (SELECT 1 FROM orders o WHERE o.product_id = p.id AND o.status IN (${OPEN_STATUSES.map(() => '?').join(',')})) AS locked
    FROM products p WHERE p.seller_id = ? AND p.id IN (${clean.map(() => '?').join(',')})
  `).all(...OPEN_STATUSES, sellerId, ...clean);
}

export const statusLabel = (p) => (p.status === 'vendido' ? 'Agotado' : PRODUCT_STATUS[p.status]);


// Botón principal de cada pedido según lo que le toca a la tienda.
export const STAGE_ACTION = { cotizar: 'Cotizar envío', enviar: 'Enviar y subir la foto', reclamo: 'Ver el reclamo' };
