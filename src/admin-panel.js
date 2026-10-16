// Panel del admin por secciones: tiendas (aprobar, prioridad, destacar, suspender), pagos (verificar
// SINPE y pagarle a cada tienda de una vez al final del día) y búsqueda de pedidos.
import { db, transaction } from './db.js';
import { FEATURED_SQL } from './products.js';
import { ratingSummary, salesSummary } from './reviews.js';
import { adminQueues, admin } from './orders.js';
import { todayCR } from './payout-schedule.js';
import { adminUnreadSupport } from './support.js';

// ---------- Tiendas ----------

export const PRIORITIES = { 0: 'Normal', 1: 'Alta', 2: 'Máxima' };

export const STORE_TABS = {
  pendientes: 'Por aprobar',
  aprobadas: 'Aprobadas',
  suspendidas: 'Suspendidas',
  rechazadas: 'No aprobadas',
  todos: 'Todos los usuarios',
};

const TAB_SQL = {
  pendientes: "u.seller_status = 'pendiente' AND u.active = 1",
  aprobadas: "u.seller_status = 'aprobado' AND u.active = 1",
  suspendidas: 'u.active = 0',
  rechazadas: "u.seller_status = 'rechazado' AND u.active = 1",
  todos: '1',
};

const BASE = "u.role = 'usuario' AND u.deleted_at IS NULL";

export function storeTabCounts() {
  return Object.fromEntries(Object.entries(TAB_SQL).map(([k, sql]) => [k, db.prepare(`SELECT COUNT(*) AS n FROM users u WHERE ${BASE} AND ${sql}`).get().n]));
}

export function storeList(tab, q = '') {
  const where = [BASE, TAB_SQL[tab] || TAB_SQL.aprobadas];
  const params = [];
  const term = String(q).trim().slice(0, 60).toLowerCase();
  if (term) {
    where.push('(lower(COALESCE(u.store_name, u.name)) LIKE ? OR lower(u.name) LIKE ? OR lower(u.email) LIKE ? OR u.phone LIKE ?)');
    params.push(...Array(4).fill(`%${term}%`));
  }
  return db.prepare(`
    SELECT u.id, u.name, COALESCE(u.store_name, u.name) AS store_name, u.email, u.phone, u.province, u.active, u.created_at,
      u.seller_status, u.priority, u.commission_rate, u.featured_until, ${FEATURED_SQL} AS featured, u.store_logo, u.store_paused, u.last_seen_at,
      u.payout_phone, u.payout_name,
      (SELECT COUNT(*) FROM products p WHERE p.seller_id = u.id AND p.status = 'disponible') AS listings,
      (SELECT COUNT(*) FROM products p WHERE p.seller_id = u.id AND p.status = 'borrador') AS drafts,
      (SELECT COUNT(*) FROM store_follows f WHERE f.store_id = u.id) AS followers,
      (SELECT COUNT(*) FROM favorites f JOIN products p ON p.id = f.product_id WHERE p.seller_id = u.id) AS favs,
      (SELECT COUNT(*) FROM orders o WHERE o.seller_id = u.id AND o.status IN ('en_disputa', 'reembolso_pendiente', 'reembolsado')) AS problems,
      (SELECT COUNT(*) FROM flagged_messages f WHERE f.user_id = u.id) AS flagged,
      (SELECT COUNT(*) FROM reports r WHERE r.status = 'abierto' AND ((r.target_type = 'usuario' AND r.target_id = u.id)
        OR (r.target_type = 'articulo' AND r.target_id IN (SELECT id FROM products WHERE seller_id = u.id)))) AS reports
    FROM users u WHERE ${where.join(' AND ')}
    ORDER BY featured DESC, u.priority DESC, listings DESC, u.created_at DESC LIMIT 300
  `).all(...params).map((s) => ({ ...s, sales: salesSummary(s.id).total, rating: ratingSummary(s.id).asSeller }));
}

// Comisión acordada con una tienda, en %. Vacío = vuelve a la comisión general. Solo afecta pedidos nuevos.
export const MAX_COMMISSION_PCT = 50;
export function setCommission(userId, percent) {
  const raw = String(percent ?? '').trim().replace(',', '.');
  let rate = null;
  if (raw !== '') {
    const pct = Number(raw);
    if (!Number.isFinite(pct) || pct < 0 || pct > MAX_COMMISSION_PCT) return { error: `La comisión debe ser de 0 % a ${MAX_COMMISSION_PCT} %.` };
    rate = Math.round(pct * 100) / 10000;
  }
  const r = db.prepare("UPDATE users SET commission_rate = ? WHERE id = ? AND role = 'usuario'").run(rate, userId);
  return r.changes ? { rate } : { error: 'Esa tienda no existe.' };
}

export function setPriority(userId, level) {
  const p = Number.parseInt(level, 10);
  if (!PRIORITIES[p]) return null;
  const r = db.prepare("UPDATE users SET priority = ? WHERE id = ? AND role = 'usuario'").run(p, userId);
  return r.changes ? p : null;
}

// ---------- Pagos ----------

// Pagos a tiendas agrupados: lo que toca hoy (o ya se atrasó) por tienda, y lo de los próximos días.
export function payoutBoard(nowMs = Date.now()) {
  const today = todayCR(nowMs);
  const all = adminQueues().payouts;
  const groups = new Map();
  for (const o of all.filter((x) => x.payout_day <= today)) {
    const g = groups.get(o.seller_id) || {
      sellerId: o.seller_id, store: o.store_name, phone: o.payout_phone, holder: o.payout_name, total: 0, orders: [],
      changedAt: db.prepare('SELECT payout_changed_at FROM users WHERE id = ?').get(o.seller_id)?.payout_changed_at || null,
    };
    g.total += o.payout_amount;
    g.orders.push(o);
    groups.set(o.seller_id, g);
  }
  const upcoming = all.filter((x) => x.payout_day > today);
  return {
    today,
    due: [...groups.values()].sort((a, b) => b.total - a.total),
    dueTotal: [...groups.values()].reduce((a, g) => a + g.total, 0),
    upcoming,
    upcomingTotal: upcoming.reduce((a, o) => a + o.payout_amount, 0),
  };
}

// "Ya le pagué todo": marca como pagados todos los pedidos de esa tienda que tocaba pagar hasta hoy.
export function payAllDue(sellerId, nowMs = Date.now()) {
  const g = payoutBoard(nowMs).due.find((x) => x.sellerId === sellerId);
  if (!g) return null;
  transaction(() => { for (const o of g.orders) admin.markPayout(o.id); });
  return { store: g.store, total: g.total, n: g.orders.length };
}

export function payoutHistory(limit = 60) {
  return db.prepare(`
    SELECT o.id, o.code, o.product_title, o.payout_amount, o.payout_paid_at, COALESCE(s.store_name, s.name) AS store_name, s.payout_phone
    FROM orders o JOIN users s ON s.id = o.seller_id
    WHERE o.payout_status = 'pagado' ORDER BY o.payout_paid_at DESC, o.id DESC LIMIT ?
  `).all(limit);
}

const cell = (v) => {
  const s = String(v ?? '');
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",;\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

// Pagos a tiendas en CSV (para la contabilidad).
export function payoutsCsv() {
  const rows = db.prepare(`
    SELECT o.code, o.completed_at, o.payout_paid_at, o.price, o.shipping_cost, o.commission_amount, o.payout_amount,
      COALESCE(s.store_name, s.name) AS store_name, s.payout_phone, s.payout_name
    FROM orders o JOIN users s ON s.id = o.seller_id WHERE o.status = 'completado' ORDER BY o.completed_at DESC
  `).all();
  const head = ['Pedido', 'Completado', 'Pagado a la tienda', 'Tienda', 'SINPE', 'Titular', 'Venta', 'Envío', 'Comisión', 'Pago a la tienda'];
  const lines = rows.map((r) => [r.code, r.completed_at, r.payout_paid_at || 'pendiente', r.store_name, r.payout_phone, r.payout_name,
    r.price, r.shipping_cost, r.commission_amount, r.payout_amount].map(cell).join(','));
  return `﻿${[head.map(cell).join(','), ...lines].join('\r\n')}\r\n`;
}

// ---------- Pedidos ----------

export function orderSearch({ q = '', status = '' } = {}, limit = 150) {
  const where = ['1'];
  const params = [];
  const term = String(q).trim().slice(0, 60).toLowerCase();
  if (term) {
    where.push(`(lower(o.code) LIKE ? OR lower(o.product_title) LIKE ? OR lower(b.name) LIKE ? OR lower(b.email) LIKE ?
      OR lower(COALESCE(s.store_name, s.name)) LIKE ? OR o.payment_reference LIKE ? OR lower(o.payer_name) LIKE ? OR o.delivery_phone LIKE ?)`);
    params.push(...Array(8).fill(`%${term}%`));
  }
  if (status) { where.push('o.status = ?'); params.push(status); }
  return db.prepare(`
    SELECT o.*, COALESCE(s.store_name, s.name) AS store_name, b.name AS buyer_name, b.email AS buyer_email
    FROM orders o JOIN users s ON s.id = o.seller_id JOIN users b ON b.id = o.buyer_id
    WHERE ${where.join(' AND ')} ORDER BY o.created_at DESC, o.id DESC LIMIT ?
  `).all(...params, limit);
}

// Después de una acción, se vuelve a la página del admin desde donde se hizo (solo rutas /admin).
const SAFE_BACK = /^\/admin(\/[a-z0-9/-]*)?(\?[a-z0-9=&%+._-]*)?$/i;
export const adminBack = (req, fallback) => (typeof req.body?.back === 'string' && SAFE_BACK.test(req.body.back) ? req.body.back : fallback);

// Contadores del menú del admin: lo pendiente en cada sección.
export function adminLocals(req, res, next) {
  if (req.method !== 'GET') return next();
  const q = adminQueues();
  res.locals.adminNav = {
    pagos: q.toVerify.length + payoutBoard().due.length + q.refunds.length,
    tiendas: storeTabCounts().pendientes,
    pedidos: q.disputes.length + q.toShip.filter((o) => !o.data_sent_at).length,
    mensajes: adminUnreadSupport(),
    soporte: db.prepare("SELECT (SELECT COUNT(*) FROM reports WHERE status = 'abierto') + (SELECT COUNT(*) FROM help_requests WHERE status = 'abierta') AS n").get().n,
  };
  res.locals.adminArea = true;
  next();
}
