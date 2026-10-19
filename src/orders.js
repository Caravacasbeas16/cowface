// Pedidos con pago a través de CowFace (modelo Grailed).
// El comprador paga a CowFace por SINPE Móvil; el admin confirma el pago; el vendedor envía;
// al recibir (o a los N días) se libera el pago al vendedor menos la comisión.
import crypto from 'node:crypto';
import path from 'node:path';
import { ATTACH_DIR } from './storage.js';
import { db, commissionRateFor, transaction } from './db.js';
import { formatColones } from './catalog.js';
import { UserError, addMessage, now, systemNote } from './messages.js';
import { notifyAdmin } from './admin-notify.js';
import { pickupPointsOf } from './pickup.js';
import { payoutDay, payoutDayLabel, sameDayRelease } from './payout-schedule.js';
import { paymentConfig, paymentsReady, payoutDayOf, savedCutoff } from './payment-config.js';
import { normalizePhone } from './validate.js';
import { isBlockedEither } from './blocks.js';
import { restockSize, takeSize } from './variants.js';
import { trackUrlFor, uberShippedNote } from './uber-flash.js';
import { availability, courierOn, deliveryLocation, isCourier } from './courier.js';
import { checkPaymentProof } from './payment-proof.js';

export const MAX_UNPAID_PER_BUYER = 3;
export const OPEN_STATUSES =['por_pagar', 'pagado', 'enviado', 'en_disputa', 'reembolso_pendiente'];
// Formas de entrega que se pueden elegir. Correos: la tienda cotiza el envío en cada pedido.
// Mensajería CowFace (GAM): tarifa fija de CowFace, que coordina con la tienda (ver courier.js).
export const DELIVERY_METHODS = {
  correos: 'Correos de Costa Rica',
  mensajeria: 'Mensajería CowFace (GAM)',
  pick_up: 'Pick up (recoger en persona)',
};
// Las que el comprador puede elegir hoy (sin la mensajería si está apagada).
export const deliveryMethods = () => Object.fromEntries(Object.entries(DELIVERY_METHODS).filter(([k]) => !isCourier(k) || courierOn()));
// Para mostrar pedidos viejos que usaban otras formas de entrega.
export const DELIVERY_LABELS = { ...DELIVERY_METHODS, uber_flash: 'Uber Flash', mensajero: 'Mensajero', en_persona: 'Entrega en persona' };
// Sin envío: no se cobra y no se exige foto del envío.
export const isPickUp = (method) => method === 'pick_up' || method === 'en_persona';

// Configuración de pagos (la llena el admin en su panel): ver payment-config.js.
export { paymentConfig, paymentsReady, payoutDayOf, savePaymentConfig } from './payment-config.js';

const addHours = (h) => new Date(Date.now() + h * 3600e3).toISOString();

// ---------- Inventario ----------

// Devuelve la unidad reservada al inventario (cancelación o reembolso antes del envío).
function restock(order) {
  if (!order.product_id) return;
  const bySize = order.chosen_size && restockSize(order.product_id, order.chosen_size); // con tallas, vuelve a su talla
  db.prepare(`
    UPDATE products SET quantity = quantity + ${bySize ? 0 : 1},
      status = CASE WHEN status IN ('reservado', 'vendido') THEN 'disponible' ELSE status END,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(order.product_id);
}

function markSoldIfEmpty(order) {
  if (order.product_id) {
    db.prepare("UPDATE products SET status = 'vendido', updated_at = datetime('now') WHERE id = ? AND quantity = 0").run(order.product_id);
  }
}

// ---------- Crear ----------

function newOrderCode() {
  return 'CF-' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
}

// Reserva una unidad y crea el pedido "por pagar". Debe correr dentro de una transacción.
export function createOrder(conv, price, source) {
  if (!paymentsReady()) throw new UserError('CowFace todavía no está recibiendo pagos. Intenta más tarde.');
  if (isBlockedEither(conv.buyer_id, conv.seller_id)) throw new UserError('No puedes tratar con esta persona: una de las dos cuentas bloqueó a la otra.');
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(conv.product_id);
  if (!product || product.status !== 'disponible' || product.quantity < 1) throw new UserError('Este artículo ya no está disponible.');
  const open = db.prepare(`SELECT 1 FROM orders WHERE conversation_id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})`)
    .get(conv.id, ...OPEN_STATUSES);
  if (open) throw new UserError('Ya tienes un pedido en curso para este artículo.');
  // Nadie puede reservar medio catálogo sin pagar: máximo 3 pedidos sin pagar por comprador.
  const unpaid = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE buyer_id = ? AND status = 'por_pagar'").get(conv.buyer_id).n;
  if (unpaid >= MAX_UNPAID_PER_BUYER) {
    throw new UserError(`Tienes ${unpaid} pedidos sin pagar. Paga o cancela alguno antes de comprar otro artículo.`);
  }

  // Con varias tallas se reserva una unidad de la talla que eligió el comprador.
  const size = product.has_sizes ? takeSize(product.id, conv.chosen_size) : null;
  const left = product.quantity - 1;
  db.prepare("UPDATE products SET quantity = ?, status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(left, left === 0 ? 'reservado' : 'disponible', product.id);

  // La comisión se cobra sobre el precio de la prenda. El envío todavía no existe: el comprador elige
  // cómo recibirlo y la tienda lo cotiza; ese monto se suma al total y llega completo al vendedor.
  const rate = commissionRateFor(conv.seller_id); // la acordada con la tienda, o la general
  const commission = Math.round(price * rate);
  const code = newOrderCode();
  const { windowHours } = paymentConfig();
  db.prepare(`
    INSERT INTO orders (code, product_id, product_title, seller_id, buyer_id, conversation_id, source, list_price, price,
      commission_rate, commission_amount, payout_amount, payment_due_at, shipping_cost, total, chosen_size)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(code, product.id, size ? `${product.title} · Talla ${size}` : product.title, conv.seller_id, conv.buyer_id, conv.id, source, product.price, price,
    rate, commission, price - commission, addHours(windowHours), price, size);
  addMessage(conv, null, 'sistema',
    `🛒 Pedido ${code} creado: ${formatColones(price)}. Comprador: elige cómo quieres recibirlo `
    + `(${courierOn() ? 'Correos o Mensajería CowFace en el GAM' : 'Correos de Costa Rica'}${product.meetup ? ' o pick up' : ''}) y luego pagas a CowFace.`);

  // Si era la última unidad, las demás ofertas por este artículo quedan sin efecto.
  if (left === 0) {
    const others = db.prepare("SELECT DISTINCT conversation_id FROM offers WHERE product_id = ? AND status = 'pendiente' AND conversation_id != ?")
      .all(product.id, conv.id);
    db.prepare("UPDATE offers SET status = 'expirada', responded_at = ? WHERE product_id = ? AND status = 'pendiente'").run(now(), product.id);
    for (const { conversation_id } of others) systemNote(conversation_id, 'Este artículo se vendió a otra persona; tu oferta quedó sin efecto.');
  }
  return code;
}

// ---------- Transiciones ----------

const getOrder = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);

function update(order, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE orders SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), order.id);
}

// Carga el pedido, verifica quién actúa y en qué estado está; si no cuadra, error para el usuario.
function load(orderId, { buyerId, sellerId, from }) {
  const order = getOrder(orderId);
  if (!order || (buyerId && order.buyer_id !== buyerId) || (sellerId && order.seller_id !== sellerId)) return null;
  if (from && !from.includes(order.status)) throw new UserError('Este pedido ya cambió de estado. Recarga la página.');
  return order;
}

function complete(order, text) {
  const completedAt = now();
  update(order, { status: 'completado', completed_at: completedAt, payout_status: 'pendiente' });
  markSoldIfEmpty(order);
  const when = payoutDayLabel(payoutDay(completedAt, savedCutoff()));
  systemNote(order.conversation_id, `${text} Pago a la tienda (ya con la comisión rebajada): ${when}.`);
  notifyAdmin('vendedor', `Pagar al vendedor: ${order.code}`,
    `El pedido ${order.code} se completó. Transfiere ${formatColones(order.payout_amount)} al vendedor por SINPE ${when} y márcalo como pagado.`, '/admin#pagos');
}

const MAX_SHIPPING = 100_000;
const productMeetup = (order) => (order.product_id ? db.prepare('SELECT meetup FROM products WHERE id = ?').get(order.product_id)?.meetup !== 0 : true);

// Monto, total y pago al vendedor con un costo de envío dado. El envío llega completo al vendedor,
// salvo en la Mensajería CowFace, donde lo cobra CowFace (toStore = false).
const withShipping = (order, shipping, toStore = true) => ({
  shipping_cost: shipping, total: order.price + shipping, payout_amount: order.price - order.commission_amount + (toStore ? shipping : 0),
});

// Paso 1 (comprador): cómo y dónde lo quiere. Pick up y Mensajería CowFace quedan listos para pagar
// (sin costo / tarifa fija); Correos espera la cotización de la tienda.
export function requestDelivery(orderId, buyerId, body) {
  return transaction(() => {
    const order = load(orderId, { buyerId, from: ['por_pagar'] });
    if (!order) return null;
    if (order.payment_reported_at) throw new UserError('Ya avisaste el pago: la entrega ya no se puede cambiar.');
    const method = DELIVERY_METHODS[body.method] ? body.method : null;
    const address = String(body.address ?? '').trim().slice(0, 500);
    if (!method) throw new UserError('Elige cómo quieres recibir el artículo.');
    if (isCourier(method) && !courierOn()) throw new UserError('La Mensajería CowFace no está disponible: elige Correos de Costa Rica o pick up.');
    if (method === 'pick_up' && !productMeetup(order)) throw new UserError('Esta tienda no ofrece pick up: elige Correos de Costa Rica.');
    if (method !== 'pick_up' && address.length < 5) {
      throw new UserError(isCourier(method) ? 'Escribe la dirección exacta con señas (dentro del GAM).' : 'Escribe la dirección para el envío por Correos.');
    }
    const { windowHours, courierFee } = paymentConfig();
    if (isCourier(method)) {
      const { text: days, dates } = availability(body);
      update(order, {
        delivery_requested: method, delivery_method: method, delivery_address: address, delivery_note: '', delivery_days: days, delivery_dates: dates,
        delivery_quote_at: now(), payment_due_at: laterOf(order.payment_due_at, addHours(windowHours)),
        ...withShipping(order, courierFee, false), ...deliveryLocation(method, body),
      });
      systemNote(order.conversation_id, `🛵 El comprador eligió la Mensajería CowFace para el pedido ${order.code} (envío ${formatColones(courierFee)}). `
        + `Puede recibir: ${days}. CowFace coordina con la tienda cuándo recoger el paquete. Total a pagar: ${formatColones(order.price + courierFee)}.`);
    } else if (method === 'pick_up') {
      // Si la tienda tiene puntos de pick up, el comprador elige uno de ellos.
      const points = pickupPointsOf(order.seller_id);
      const point = String(body.point ?? '').trim();
      if (points.length && !points.includes(point)) throw new UserError('Elige en cuál punto vas a recoger el pedido.');
      update(order, {
        delivery_requested: method, delivery_method: method, delivery_address: point || 'Pick up', delivery_note: '', delivery_days: null,
        delivery_quote_at: now(), payment_due_at: laterOf(order.payment_due_at, addHours(windowHours)), ...withShipping(order, 0),
      });
      systemNote(order.conversation_id, `📍 El comprador va a recoger el pedido ${order.code} (pick up, sin costo de envío)`
        + `${point ? ` en: «${point}». Tienda: confirmen el día y la hora por este chat.` : '. Tienda: dile dónde y cuándo por este chat.'} Total a pagar: ${formatColones(order.price)}.`);
    } else {
      update(order, {
        delivery_requested: method, delivery_address: address, delivery_method: null, delivery_quote_at: null, delivery_note: '',
        delivery_days: null, ...withShipping(order, 0), ...deliveryLocation(method, body),
      });
      systemNote(order.conversation_id, `📦 El comprador quiere recibir el pedido ${order.code} por ${DELIVERY_METHODS[method]} en: «${address}». Tienda: cotiza el envío aquí arriba.`);
    }
    return order;
  });
}

// Paso 2 (tienda): forma de entrega y costo del envío. Se puede volver a cotizar mientras no paguen.
export function quoteDelivery(orderId, sellerId, body) {
  return transaction(() => {
    const order = load(orderId, { sellerId, from: ['por_pagar'] });
    if (!order) return null;
    if (order.payment_reported_at) throw new UserError('El comprador ya avisó el pago: la cotización ya no se puede cambiar.');
    const method = DELIVERY_METHODS[body.method] ? body.method : null;
    if (!method) throw new UserError('Elige la forma de entrega.');
    if (isCourier(method)) throw new UserError('La Mensajería CowFace la elige el comprador (con su ubicación y los días en que puede recibir); CowFace coordina contigo la recogida.');
    if (method === 'pick_up' && !productMeetup(order)) throw new UserError('Este artículo no tiene pick up activado.');
    const raw = String(body.cost ?? '').replace(/[₡,.\s]/g, '');
    const cost = method === 'pick_up' ? 0 : Number(raw);
    if (method !== 'pick_up' && (!raw || !Number.isInteger(cost) || cost < 0 || cost > MAX_SHIPPING)) {
      throw new UserError('Escribe el costo del envío en colones (0 si lo envías gratis).');
    }
    const note = String(body.note ?? '').trim().slice(0, 200);
    const { windowHours } = paymentConfig();
    update(order, {
      delivery_method: method, delivery_note: note, delivery_quote_at: now(),
      payment_due_at: laterOf(order.payment_due_at, addHours(windowHours)), ...withShipping(order, cost),
    });
    const total = order.price + cost;
    systemNote(order.conversation_id, `🧾 La tienda cotizó la entrega del pedido ${order.code}: ${DELIVERY_METHODS[method]}`
      + `${method === 'pick_up' ? '' : ` · envío ${cost ? formatColones(cost) : 'gratis'}`}${note ? ` (${note})` : ''}. Total a pagar: ${formatColones(total)}.`);
    return order;
  });
}

const laterOf = (a, b) => (!a || b > a ? b : a);

// proof: nombre del comprobante (foto/PDF) ya guardado como adjunto privado, o null.
export function reportPayment(orderId, buyerId, body, proof = null) {
  return transaction(() => {
    const order = load(orderId, { buyerId, from: ['por_pagar'] });
    if (!order) return null;
    if (order.payment_reported_at) throw new UserError('Ya nos avisaste de este pago; lo estamos verificando.');
    // Se paga el total que ya quedó definido con la entrega (cotizada por la tienda, o pick up).
    if (!order.delivery_quote_at || !order.delivery_method) {
      throw new UserError('Primero elijan la forma de entrega: la tienda te cotiza el envío y ahí ves el total exacto.');
    }
    // Si la tienda cotizó otra forma de entrega que la que pidió el comprador, él tiene que aceptarla.
    const asked = order.delivery_requested === order.delivery_method;
    if (!asked && body.accept_method !== '1') {
      throw new UserError(`La tienda te cotizó ${DELIVERY_METHODS[order.delivery_method]}, no lo que pediste. Marca que lo aceptas para pagar, o pídele otra cotización por el chat.`);
    }
    // La dirección con la que se cotizó el envío ya no cambia al pagar (cambiarla sería otro envío).
    const locked = asked && !isPickUp(order.delivery_method) && order.delivery_address;
    const address = locked ? order.delivery_address : String(body.address ?? order.delivery_address ?? '').trim().slice(0, 500);
    const phone = normalizePhone(body.phone);
    if (!isPickUp(order.delivery_method) && address.length < 5) throw new UserError('Escribe la dirección de entrega.');
    if (!phone) throw new UserError('Teléfono de contacto para la entrega (8 dígitos).');
    // Nombre de quien pagó y captura obligatoria (que no se haya usado en otro pedido).
    const { payer, hash } = checkPaymentProof(order, body, proof);
    const t = { total: order.total };
    update(order, {
      payment_reported_at: now(), payer_name: payer, payment_proof_hash: hash, delivery_address: address || 'Pick up',
      delivery_phone: phone, payment_proof: proof,
    });
    systemNote(order.conversation_id, `💸 El comprador avisó que pagó ${formatColones(t.total)} por el pedido ${order.code}. CowFace está verificando el pago.`);
    notifyAdmin('pago', `Pago por verificar: ${order.code} · ${formatColones(t.total)} · ${payer}`,
      `El comprador avisó que pagó ${formatColones(t.total)} por el pedido ${order.code}. El SINPE lo hizo: ${payer}.\n`
        + 'La captura del SINPE va adjunta. Revisa en tu banco que entró el SINPE y confírmalo.',
      '/admin#pagos', { attachments: [{ path: path.join(ATTACH_DIR, proof) }] });
    return order;
  });
}

export function cancelUnpaid(orderId, userId) {
  return transaction(() => {
    const order = getOrder(orderId);
    if (!order || (order.buyer_id !== userId && order.seller_id !== userId)) return null;
    if (order.status !== 'por_pagar') throw new UserError('Este pedido ya no se puede cancelar desde aquí.');
    if (order.payment_reported_at) throw new UserError('El comprador ya reportó el pago; escríbenos para cancelarlo.');
    update(order, { status: 'cancelado' });
    restock(order);
    systemNote(order.conversation_id, `El pedido ${order.code} se canceló ${order.buyer_id === userId ? 'por el comprador' : 'por el vendedor'}. El artículo vuelve a estar disponible.`);
    return order;
  });
}

// proof: foto de la guía, del recibo del courier o del paquete (adjunto privado), o null.
// Si es por envío, se exige la foto (el número de guía es opcional): sin foto del envío no se le paga al vendedor.
export function markShipped(orderId, sellerId, note, proof = null, track = '') {
  return transaction(() => {
    const order = load(orderId, { sellerId, from: ['pagado'] });
    if (!order) return null;
    const text = String(note ?? '').trim().slice(0, 300);
    // Mensajería CowFace: el paquete lo recoge nuestro mensajero, así que la foto es opcional.
    const courier = isCourier(order.delivery_method);
    if (!isPickUp(order.delivery_method) && !courier && !proof) {
      throw new UserError('Sube una foto de la guía, del recibo o del paquete enviado. Sin la foto del envío no podemos pagarte la venta.');
    }
    const { releaseDays } = paymentConfig();
    const uber = order.delivery_method === 'uber_flash';
    const trackUrl = trackUrlFor(order, track);
    // Uber Flash con el link del viaje: se da por recibido al final del día. Sin link, el plazo normal.
    const release = uber && trackUrl ? sameDayRelease(Date.now(), savedCutoff()) : addHours(releaseDays * 24);
    update(order, { status: 'enviado', shipped_at: now(), shipping_note: text, shipping_proof: proof, track_url: trackUrl, auto_release_at: release });
    systemNote(order.conversation_id, uber ? uberShippedNote(order, trackUrl, releaseDays)
      : courier ? `🛵 La tienda le entregó el pedido ${order.code} al mensajero de CowFace: va en camino (${order.delivery_days || 'el día coordinado'}). Cuando te llegue, confirma que lo recibiste; si no hay reclamo, el pago se libera en ${releaseDays} días.`
        : `📦 El vendedor marcó el pedido ${order.code} como enviado/entregado. Si no hay reclamo, el pago se libera en ${releaseDays} días.`);
    return order;
  });
}

export function confirmReceived(orderId, buyerId) {
  return transaction(() => {
    const order = load(orderId, { buyerId, from: ['pagado', 'enviado'] });
    if (!order) return null;
    complete(order, `✅ El comprador confirmó que recibió el pedido ${order.code}. ¡Trato cerrado!`);
    return order;
  });
}

// evidence: foto del problema (adjunto privado), o null.
export function openDispute(orderId, buyerId, reason, evidence = null) {
  return transaction(() => {
    const order = load(orderId, { buyerId, from: ['pagado', 'enviado'] });
    if (!order) return null;
    const text = String(reason ?? '').trim().slice(0, 1000);
    if (text.length < 10) throw new UserError('Cuéntanos qué pasó (al menos una frase).');
    update(order, { status: 'en_disputa', dispute_reason: text, dispute_evidence: evidence, auto_release_at: null });
    systemNote(order.conversation_id, `⚠️ El comprador abrió un reclamo en el pedido ${order.code}. El pago queda retenido hasta que CowFace lo resuelva.`);
    notifyAdmin('reclamo', `Reclamo en ${order.code}`, `El comprador abrió un reclamo en el pedido ${order.code}:\n«${text}»`, `/admin/conversaciones/${order.conversation_id}`);
    return order;
  });
}

export function sellerCannotDeliver(orderId, sellerId) {
  return transaction(() => {
    const order = load(orderId, { sellerId, from: ['pagado'] });
    if (!order) return null;
    update(order, { status: 'reembolso_pendiente' });
    restock(order);
    systemNote(order.conversation_id, `El vendedor no puede entregar el pedido ${order.code}. CowFace le devolverá el dinero al comprador.`);
    notifyAdmin('reembolso', `Reembolso pendiente: ${order.code}`,
      `El vendedor no puede entregar el pedido ${order.code}. Devuélvele ${formatColones(order.total || order.price)} al comprador.`, '/admin#pagos');
    return order;
  });
}

// ---------- Acciones del admin ----------

export const admin = {
  confirmPayment(orderId) {
    return transaction(() => {
      const order = load(orderId, { from: ['por_pagar'] });
      if (!order) return null;
      update(order, { status: 'pagado', paid_at: now() });
      systemNote(order.conversation_id, `✅ CowFace confirmó el pago del pedido ${order.code}. Vendedor: ya puedes enviarlo; arriba están los datos de entrega. Te pagamos después de que subas la foto del envío y el comprador lo reciba.`);
      return order;
    });
  },
  rejectPayment(orderId, note) {
    return transaction(() => {
      const order = load(orderId, { from: ['por_pagar'] });
      if (!order) return null;
      const { windowHours } = paymentConfig();
      update(order, { payment_reported_at: null, admin_note: String(note ?? '').slice(0, 300), payment_due_at: addHours(windowHours) });
      systemNote(order.conversation_id, `No encontramos el pago del pedido ${order.code}. Revisa el monto y el número, y vuelve a avisarnos.`);
      return order;
    });
  },
  // Reclamo resuelto a favor del vendedor: se completa y se le paga.
  release(orderId) {
    return transaction(() => {
      const order = load(orderId, { from: ['en_disputa'] });
      if (!order) return null;
      complete(order, `CowFace resolvió el reclamo del pedido ${order.code} a favor del vendedor. El pago se libera.`);
      return order;
    });
  },
  // Reclamo resuelto a favor del comprador: queda pendiente devolverle el dinero.
  refund(orderId) {
    return transaction(() => {
      const order = load(orderId, { from: ['en_disputa'] });
      if (!order) return null;
      update(order, { status: 'reembolso_pendiente' });
      if (!order.shipped_at) restock(order);
      systemNote(order.conversation_id, `CowFace resolvió el reclamo del pedido ${order.code} a favor del comprador. Le devolveremos el dinero.`);
      return order;
    });
  },
  markRefunded(orderId) {
    return transaction(() => {
      const order = load(orderId, { from: ['reembolso_pendiente'] });
      if (!order) return null;
      update(order, { status: 'reembolsado', refunded_at: now() });
      systemNote(order.conversation_id, `💸 CowFace devolvió ${formatColones(order.total || order.price)} al comprador (pedido ${order.code}).`);
      return order;
    });
  },
  markPayout(orderId) {
    const order = getOrder(orderId);
    if (!order || order.status !== 'completado' || order.payout_status !== 'pendiente') return null;
    update(order, { payout_status: 'pagado', payout_paid_at: now() });
    systemNote(order.conversation_id, `💰 CowFace le transfirió ${formatColones(order.payout_amount)} al vendedor por el pedido ${order.code}.`);
    return order;
  },
};

// ---------- Tareas automáticas (cada pocos minutos) ----------

export function runOrderTimers() {
  const ts = now();
  const expired = db.prepare("SELECT * FROM orders WHERE status = 'por_pagar' AND payment_reported_at IS NULL AND payment_due_at < ?").all(ts);
  for (const order of expired) {
    transaction(() => {
      update(order, { status: 'cancelado' });
      restock(order);
      systemNote(order.conversation_id, `El pedido ${order.code} se canceló porque no se recibió el pago a tiempo. El artículo vuelve a estar disponible.`);
    });
  }
  const due = db.prepare("SELECT * FROM orders WHERE status = 'enviado' AND auto_release_at < ?").all(ts);
  for (const order of due) {
    transaction(() => complete(order, `✅ Pasó el plazo sin reclamos: el pedido ${order.code} se dio por recibido.`));
  }
  return { expired: expired.length, released: due.length };
}

// ---------- Listas ----------

export function orderForConversation(conversationId) {
  return db.prepare("SELECT * FROM orders WHERE conversation_id = ? AND status != 'cancelado' ORDER BY id DESC LIMIT 1").get(conversationId) || null;
}

export function sellerOrders(sellerId) {
  return db.prepare(`
    SELECT o.*, u.name AS buyer_name FROM orders o JOIN users u ON u.id = o.buyer_id
    WHERE o.seller_id = ? ORDER BY o.created_at DESC, o.id DESC LIMIT 200
  `).all(sellerId);
}

export function buyerOrders(buyerId) {
  return db.prepare(`
    SELECT o.*, COALESCE(u.store_name, u.name) AS store_name FROM orders o JOIN users u ON u.id = o.seller_id
    WHERE o.buyer_id = ? ORDER BY o.created_at DESC, o.id DESC LIMIT 200
  `).all(buyerId);
}

export function adminQueues() {
  const q = (where) => db.prepare(`
    SELECT o.*, COALESCE(s.store_name, s.name) AS store_name, s.payout_phone, s.payout_name, s.email AS store_email, b.name AS buyer_name
    FROM orders o JOIN users s ON s.id = o.seller_id JOIN users b ON b.id = o.buyer_id
    WHERE ${where} ORDER BY o.updated_at, o.id
  `).all();
  return {
    toVerify: q("o.status = 'por_pagar' AND o.payment_reported_at IS NOT NULL"),
    toShip: q("o.status = 'pagado'"),
    disputes: q("o.status = 'en_disputa'"),
    refunds: q("o.status = 'reembolso_pendiente'"),
    payouts: q("o.status = 'completado' AND o.payout_status = 'pendiente'").map((o) => ({ ...o, payout_day: payoutDayOf(o) })),
  };
}

// Tareas pendientes del admin (para el número junto a "Admin" en el menú).
export function adminPendingCount() {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM orders
    WHERE (status = 'por_pagar' AND payment_reported_at IS NOT NULL) OR status IN ('en_disputa', 'reembolso_pendiente')
      OR (status = 'completado' AND payout_status = 'pendiente') OR (status = 'pagado' AND data_sent_at IS NULL)
  `).get().n + db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'usuario' AND active = 1 AND seller_status = 'pendiente'").get().n
    + db.prepare("SELECT COUNT(*) AS n FROM help_requests WHERE status = 'abierta'").get().n
    + db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'abierto'").get().n;
}
