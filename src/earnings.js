// Ganancias del admin: la comisión cuenta cuando la venta se completa (el comprador la recibió
// o pasó el plazo sin reclamo). Los meses se calculan en hora de Costa Rica (UTC−6).
import { db } from './db.js';

const CR = "'-6 hours'";
const crMonth = (col) => `strftime('%Y-%m', ${col}, ${CR})`;
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

const validYear = (y) => (Number.isInteger(y) && y >= 2020 && y <= 2100 ? y : null);

// Mes actual en Costa Rica, como "2026-10".
function crNow() {
  const d = new Date(Date.now() - 6 * 3600e3);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}
const key = (y, m) => `${y}-${String(m).padStart(2, '0')}`;

// Lista de meses a mostrar: los 12 de un año, o los últimos 12 hasta hoy.
function monthKeys(year) {
  if (year) return Array.from({ length: 12 }, (_, i) => key(year, i + 1));
  const now = crNow();
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(now.year, now.month - 1 - (11 - i), 1));
    return key(d.getUTCFullYear(), d.getUTCMonth() + 1);
  });
}

export function earningsReport(rawYear) {
  const year = validYear(rawYear);
  const keys = monthKeys(year);
  const [from, to] = [keys[0], keys[keys.length - 1]];

  const sales = db.prepare(`
    SELECT ${crMonth('completed_at')} AS month, COUNT(*) AS n, SUM(price) AS gmv, SUM(commission_amount) AS commission
    FROM orders WHERE status = 'completado' AND ${crMonth('completed_at')} BETWEEN ? AND ? GROUP BY month
  `).all(from, to);
  const refunds = db.prepare(`
    SELECT ${crMonth('refunded_at')} AS month, COUNT(*) AS n, SUM(COALESCE(total, price)) AS amount
    FROM orders WHERE status = 'reembolsado' AND ${crMonth('refunded_at')} BETWEEN ? AND ? GROUP BY month
  `).all(from, to);
  const byMonth = Object.fromEntries(sales.map((r) => [r.month, r]));
  const refundsByMonth = Object.fromEntries(refunds.map((r) => [r.month, r]));
  const months = keys.map((k) => {
    const [y, m] = k.split('-').map(Number);
    const s = byMonth[k] || {};
    return {
      key: k, label: `${MONTHS[m - 1]} ${String(y).slice(2)}`,
      sales: s.n || 0, gmv: s.gmv || 0, commission: s.commission || 0,
      refunds: refundsByMonth[k]?.n || 0, refunded: refundsByMonth[k]?.amount || 0,
    };
  });
  const maxCommission = Math.max(1, ...months.map((m) => m.commission));

  const now = crNow();
  const thisMonth = key(now.year, now.month);
  const prev = new Date(Date.UTC(now.year, now.month - 2, 1));
  const lastMonth = key(prev.getUTCFullYear(), prev.getUTCMonth() + 1);
  const sumMonth = db.prepare(`
    SELECT COALESCE(SUM(commission_amount), 0) AS commission, COUNT(*) AS n
    FROM orders WHERE status = 'completado' AND ${crMonth('completed_at')} = ?
  `);
  const allTime = db.prepare(`
    SELECT COALESCE(SUM(commission_amount), 0) AS commission, COALESCE(SUM(price), 0) AS gmv, COUNT(*) AS n
    FROM orders WHERE status = 'completado'
  `).get();
  const range = months.reduce((a, m) => ({ commission: a.commission + m.commission, gmv: a.gmv + m.gmv, sales: a.sales + m.sales }), { commission: 0, gmv: 0, sales: 0 });

  // Lo que todavía no es ganancia: pedidos pagados (o con pago avisado) que no se han completado.
  const pipeline = db.prepare(`
    SELECT COALESCE(SUM(commission_amount), 0) AS commission, COUNT(*) AS n FROM orders
    WHERE status IN ('pagado', 'enviado', 'en_disputa') OR (status = 'por_pagar' AND payment_reported_at IS NOT NULL)
  `).get();
  const owed = db.prepare(`
    SELECT COALESCE(SUM(payout_amount), 0) AS amount, COUNT(*) AS n FROM orders WHERE status = 'completado' AND payout_status = 'pendiente'
  `).get();

  const topStores = db.prepare(`
    SELECT u.id, COALESCE(u.store_name, u.name) AS store_name, COUNT(*) AS sales, SUM(o.price) AS gmv, SUM(o.commission_amount) AS commission
    FROM orders o JOIN users u ON u.id = o.seller_id
    WHERE o.status = 'completado' AND ${crMonth('o.completed_at')} BETWEEN ? AND ?
    GROUP BY u.id ORDER BY commission DESC, sales DESC LIMIT 15
  `).all(from, to);

  const years = db.prepare(`
    SELECT DISTINCT CAST(strftime('%Y', completed_at, ${CR}) AS INTEGER) AS y FROM orders WHERE status = 'completado' ORDER BY y DESC
  `).all().map((r) => r.y).filter(Boolean);

  return {
    year, years, months, maxCommission, range, topStores, pipeline, owed, allTime,
    thisMonth: sumMonth.get(thisMonth), lastMonth: sumMonth.get(lastMonth),
    average: allTime.n ? Math.round(allTime.commission / allTime.n) : 0,
  };
}

// CSV de ventas completadas (para la contabilidad). Excel en español abre bien el separador ";".
export function earningsCsv(rawYear) {
  const year = validYear(rawYear);
  const rows = db.prepare(`
    SELECT o.code, strftime('%Y-%m-%d %H:%M', o.completed_at, ${CR}) AS fecha, o.product_title,
      COALESCE(s.store_name, s.name) AS tienda, b.name AS comprador, o.price, o.shipping_cost,
      COALESCE(o.total, o.price) AS total, o.commission_rate, o.commission_amount, o.payout_amount, o.payout_status
    FROM orders o JOIN users s ON s.id = o.seller_id JOIN users b ON b.id = o.buyer_id
    WHERE o.status = 'completado' ${year ? `AND strftime('%Y', o.completed_at, ${CR}) = ?` : ''}
    ORDER BY o.completed_at
  `).all(...(year ? [String(year)] : []));
  const head = ['Pedido', 'Completado', 'Artículo', 'Tienda', 'Comprador', 'Precio', 'Envío', 'Pagó el comprador', 'Comisión %', 'Comisión', 'Al vendedor', 'Pago al vendedor'];
  const cell = (v) => {
    let t = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; // evita fórmulas al abrirlo en Excel
    return /[";\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const lines = rows.map((r) => [
    r.code, r.fecha, r.product_title, r.tienda, r.comprador, r.price, r.shipping_cost, r.total,
    +(r.commission_rate * 100).toFixed(2), r.commission_amount, r.payout_amount, r.payout_status === 'pagado' ? 'pagado' : 'pendiente',
  ].map(cell).join(';'));
  return `﻿${[head.join(';'), ...lines].join('\r\n')}\r\n`;
}
