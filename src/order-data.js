// Datos que el admin le manda a la tienda después de confirmar el SINPE (por correo o para pegar en WhatsApp).
import { db } from './db.js';
import { formatColones } from './catalog.js';
import { now } from './messages.js';
import { DELIVERY_LABELS, paymentConfig } from './orders.js';
import { cutoffLabel } from './payout-schedule.js';
import { uberLink } from './uber-flash.js';
import { isCourier, wazeLink } from './courier.js';

export function orderDataText(o, baseUrl = '') {
  const uber = o.delivery_method === 'uber_flash';
  const courier = isCourier(o.delivery_method);
  return [
    `Pedido ${o.code} en CowFace: pago confirmado ✅`,
    `Artículo: ${o.product_title}`,
    `Entrega: ${DELIVERY_LABELS[o.delivery_method] || o.delivery_method}`,
    `Nombre: ${o.buyer_name}`,
    `Dirección / punto de entrega: ${o.delivery_address}`,
    courier || (uber && o.delivery_lat) ? `Ubicación en Waze${o.delivery_lat ? '' : ' (por la dirección)'}: ${wazeLink(o)}` : null,
    courier && o.delivery_days ? `Puede recibir: ${o.delivery_days}` : null,
    `Teléfono: ${o.delivery_phone}`,
    o.shipping_cost && !courier ? `Envío pagado por el comprador: ${formatColones(o.shipping_cost)}` : null,
    uber ? `Pedir el Uber Flash con el destino ya puesto: ${uberLink(o)}` : null,
    `Te pagamos ${formatColones(o.payout_amount)} por SINPE (ya con la comisión rebajada) al final del día en que el comprador lo reciba; si es después de las ${cutoffLabel(paymentConfig().cutoffHour)} o en fin de semana, el siguiente día hábil.`,
    uber ? 'Envíalo y sube la captura del viaje de Uber (y el link de "Compartir viaje") en el pedido: sin la captura no se puede pagar.'
      : courier ? 'Nosotros pasamos a recoger el paquete con nuestro mensajero: te escribimos para cuadrar el día y la hora. Tenlo empacado y, cuando se lo entregues, márcalo como enviado en el pedido.'
        : 'Envíalo en máximo 3 días hábiles y sube la foto del envío (guía o paquete) en el pedido: sin esa foto no se puede pagar.',
    baseUrl && o.conversation_id ? `Pedido: ${baseUrl}/mensajes/${o.conversation_id}` : null,
  ].filter(Boolean).join('\n');
}

export function markDataSent(orderId) {
  db.prepare("UPDATE orders SET data_sent_at = ? WHERE id = ? AND status = 'pagado'").run(now(), orderId);
}
