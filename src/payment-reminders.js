// Recordatorio de pago: si el comprador ya tiene la entrega cotizada y no ha pagado, 3 horas antes de
// que venza el plazo le llega un aviso al celular y un correo (una sola vez por pedido). Así se
// pierden menos ventas por pedidos que se cancelan solos.
import { db } from './db.js';
import { SITE_NAME, formatColones } from './catalog.js';
import { paymentConfig } from './orders.js';
import { pushToUser } from './push.js';
import { sendMail } from './mailer.js';

export const REMIND_BEFORE_HOURS = 3;

export async function sendPaymentReminders(baseUrl = '', nowMs = Date.now()) {
  const limit = new Date(nowMs + REMIND_BEFORE_HOURS * 3600e3).toISOString();
  const due = db.prepare(`
    SELECT o.*, u.email, u.name FROM orders o JOIN users u ON u.id = o.buyer_id
    WHERE o.status = 'por_pagar' AND o.payment_reported_at IS NULL AND o.delivery_quote_at IS NOT NULL
      AND o.payment_reminded_at IS NULL AND o.payment_due_at > ? AND o.payment_due_at <= ? AND u.active = 1
  `).all(new Date(nowMs).toISOString(), limit);
  const pay = paymentConfig();
  for (const o of due) {
    db.prepare('UPDATE orders SET payment_reminded_at = ? WHERE id = ?').run(new Date(nowMs).toISOString(), o.id);
    const total = formatColones(o.total || o.price);
    const link = `${baseUrl}/mensajes/${o.conversation_id}`;
    pushToUser(o.buyer_id, {
      title: `⏰ Tu pedido ${o.code} vence pronto`, body: `Paga ${total} por SINPE para no perder «${o.product_title}».`, url: `/mensajes/${o.conversation_id}`, tag: `pago-${o.id}`,
    });
    try {
      await sendMail({
        to: o.email,
        subject: `Tu pedido ${o.code} vence en menos de ${REMIND_BEFORE_HOURS} horas`,
        text: `Hola ${o.name}:\n\nTodavía no recibimos el pago de «${o.product_title}». Para no perderlo, paga ${total} por SINPE Móvil `
          + `al ${pay.phone} (${pay.holder}) con el detalle ${o.code}, y avísanos en el pedido:\n${link}\n\n`
          + `Si no pagas a tiempo, el pedido se cancela solo y el artículo vuelve a estar a la venta.\n\n${SITE_NAME}`,
      });
    } catch (err) {
      console.error('Error enviando recordatorio de pago:', err.message);
    }
  }
  return due.length;
}
