// "Mis ganancias" de una tienda: cuánto vendió, cuánto fue comisión, cuánto ya recibió y cuánto le
// toca (y cuándo). La comisión y el pago se toman de cada pedido (la comisión queda fija al crearse).
import { db } from './db.js';
import { payoutDayOf } from './orders.js';
import { payoutDayLabel } from './payout-schedule.js';

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const CR = "'-6 hours'";

export function sellerEarnings(sellerId) {
  const done = db.prepare(`
    SELECT id, code, product_title, price, shipping_cost, commission_rate, commission_amount, payout_amount, payout_status,
      completed_at, payout_paid_at, conversation_id
    FROM orders WHERE seller_id = ? AND status = 'completado' ORDER BY completed_at DESC, id DESC
  `).all(sellerId);
  const inProgress = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(payout_amount), 0) AS amount FROM orders
    WHERE seller_id = ? AND status IN ('pagado', 'enviado', 'en_disputa')
  `).get(sellerId);
  const sum = (list, k) => list.reduce((a, o) => a + (o[k] || 0), 0);
  const paid = done.filter((o) => o.payout_status === 'pagado');
  const pending = done.filter((o) => o.payout_status !== 'pagado')
    .map((o) => ({ ...o, when: payoutDayLabel(payoutDayOf(o)) }));

  const months = db.prepare(`
    SELECT strftime('%Y-%m', completed_at, ${CR}) AS month, COUNT(*) AS sales, SUM(price) AS sold,
      SUM(commission_amount) AS commission, SUM(payout_amount) AS net
    FROM orders WHERE seller_id = ? AND status = 'completado'
    GROUP BY month ORDER BY month DESC LIMIT 12
  `).all(sellerId).map((m) => {
    const [y, mo] = m.month.split('-').map(Number);
    return { ...m, label: `${MONTHS[mo - 1]} ${y}` };
  });

  return {
    totals: {
      sales: done.length,
      sold: sum(done, 'price'),
      shipping: sum(done, 'shipping_cost'),
      commission: sum(done, 'commission_amount'),
      net: sum(done, 'payout_amount'),
      received: sum(paid, 'payout_amount'),
      pending: sum(pending, 'payout_amount'),
      inProgress: inProgress.amount,
      inProgressCount: inProgress.n,
    },
    pending,
    history: done.slice(0, 100).map((o) => (o.payout_status === 'pagado' ? o : { ...o, when: payoutDayLabel(payoutDayOf(o)) })),
    months,
  };
}
