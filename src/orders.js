// Pedidos con pago a través de CowFace (modelo Grailed).
// El comprador paga a CowFace por SINPE Móvil; el admin confirma el pago; el vendedor envía;
// al recibir (o a los N días) se libera el pago al vendedor menos la comisión.
import crypto from 'node:crypto';
import { db, commissionRate, getSetting, setSetting, transaction } from './db.js';
import { formatColones } from './catalog.js';
import { UserError, addMessage, now, systemNote } from './messages.js';
import { normalizePhone } from './validate.js';
import { isBlockedEither } from './blocks.js';

export const MAX_UNPAID_PER_BUYER = 3;
export const OPEN_STATUSES =['por_pagar', 'pagado', 'enviado', 'en_disputa', 'reembolso_pendiente'];
export const DELIVERY_METHODS = {
  correos: 'Correos de Costa Rica',
  mensajero: 'Mensajero / envío a domicilio',
  en_persona: 'Entrega en persona (lugar público)',
};

// ---------- Configuración de pagos (la llena el admin en su panel) ----------

export function paymentConfig() {
  return {
    phone: getSetting('payment_phone') || '',
    holder: getSetting('payment_holder') || '',
    windowHours: Number(getSetting('payment_window_hours')) || 24,
    releaseDays: Number(getSetting('auto_release_days')) || 3,
  };
}

export function paymentsReady() {
  const c = paymentConfig();
  return Boolean(c.phone && c.holder);
}

export function savePaymentConfig(body) {
  const phone = normalizePhone(body.phone);
  const holder = String(body.holder ?? '').trim().slice(0, 80);
  const windowHours = Number.parseInt(body.window_hours, 10);
  const releaseDays = Number.parseInt(body.release_days, 10);
  const errors = [];
  if (!phone) errors.push('Número SINPE Móvil de 8 dígitos.');
  if (holder.length < 3) errors.push('Nombre del titular de la cuenta.');
  if (!(windowHours >= 1 && windowHours <= 168)) errors.push('Plazo para pagar entre 1 y 168 horas.');
  if (!(releaseDays >= 1 && releaseDays <= 30)) errors.push('Liberación automática entre 1 y 30 días.');
  if (errors.length) return errors;
  setSetting('payment_phone', phone);
  setSetting('payment_holder', holder);
  setSetting('payment_window_hours', windowHours);
  setSetting('auto_release_days', releaseDays);
  return [];
}

const addHours = (h) => new Date(Date.now() + h * 3600e3).toISOString();

// ---------- Inventario ----------

// Devuelve la unidad reservada al inventario (cancelación o reembolso antes del envío).
function restock(order) {
  if (!order.product_id) return;
  db.prepare(`
    UPDATE products SET quantity = quantity + 1,
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

  const left = product.quantity - 1;
  db.prepare("UPDATE products SET quantity = ?, status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(left, left === 0 ? 'reservado' : 'disponible', product.id);

  const rate = commissionRate();
  const commission = Math.round(price * rate);
  const code = newOrderCode();
  const { windowHours } = paymentConfig();
  db.prepare(`
    INSERT INTO orders (code, product_id, product_title, seller_id, buyer_id, conversation_id, source, list_price, price,
      commission_rate, commission_amount, payout_amount, payment_due_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(code, product.id, product.title, conv.seller_id, conv.buyer_id, conv.id, source, product.price, price,
    rate, commission, price - commission, addHours(windowHours));
  addMessage(conv, null, 'sistema',
    `🛒 Pedido ${code} creado por ${formatColones(price)}. El comprador tiene ${windowHours} h para pagar a CowFace; ` +
    'el vendedor envía cuando confirmemos el pago.');

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
  update(order, { status: 'completado', completed_at: now(), payout_status: 'pendiente' });
  markSoldIfEmpty(order);
  systemNote(order.conversation_id, text);
}

export function reportPayment(orderId, buyerId, body) {
  return transaction(() => {
    const order = load(orderId, { buyerId, from: ['por_pagar'] });
    if (!order) return null;
    if (order.payment_reported_at) throw new UserError('Ya nos avisaste de este pago; lo estamos verificando.');
    const reference = String(body.reference ?? '').replace(/\s/g, '').slice(0, 40);
    const method = DELIVERY_METHODS[body.method] ? body.method : null;
    const address = String(body.address ?? '').trim().slice(0, 500);
    const phone = normalizePhone(body.phone);
    if (!/^[\w-]{4,40}$/.test(reference)) throw new UserError('Escribe el número de comprobante del SINPE.');
    // Un comprobante solo puede respaldar un pedido (evita pagar una vez y reportarlo en varios).
    const reused = db.prepare("SELECT 1 FROM orders WHERE payment_reference = ? AND id != ? AND status != 'cancelado'").get(reference, order.id);
    if (reused) throw new UserError('Ese comprobante ya se usó en otro pedido. Revisa el número; si crees que es un error, escríbenos.');
    if (!method) throw new UserError('Elige cómo quieres recibir el artículo.');
    if (address.length < 5) throw new UserError(method === 'en_persona' ? 'Indica dónde y cuándo te queda bien recibirlo.' : 'Escribe la dirección de entrega.');
    if (!phone) throw new UserError('Teléfono de contacto para la entrega (8 dígitos).');
    update(order, { payment_reported_at: now(), payment_reference: reference, delivery_method: method, delivery_address: address, delivery_phone: phone });
    systemNote(order.conversation_id, `💸 El comprador avisó que pagó el pedido ${order.code}. CowFace está verificando el pago.`);
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

export function markShipped(orderId, sellerId, note) {
  return transaction(() => {
    const order = load(orderId, { sellerId, from: ['pagado'] });
    if (!order) return null;
    const { releaseDays } = paymentConfig();
    update(order, { status: 'enviado', shipped_at: now(), shipping_note: String(note ?? '').trim().slice(0, 300), auto_release_at: addHours(releaseDays * 24) });
    systemNote(order.conversation_id,
      `📦 El vendedor marcó el pedido ${order.code} como enviado/entregado. Si no hay reclamo, el pago se libera en ${releaseDays} días.`);
    return order;
  });
}

export function confirmReceived(orderId, buyerId) {
  return transaction(() => {
    const order = load(orderId, { buyerId, from: ['pagado', 'enviado'] });
    if (!order) return null;
    complete(order, `✅ El comprador confirmó que recibió el pedido ${order.code}. ¡Trato cerrado! CowFace le transferirá el pago al vendedor.`);
    return order;
  });
}

export function openDispute(orderId, buyerId, reason) {
  return transaction(() => {
    const order = load(orderId, { buyerId, from: ['pagado', 'enviado'] });
    if (!order) return null;
    const text = String(reason ?? '').trim().slice(0, 1000);
    if (text.length < 10) throw new UserError('Cuéntanos qué pasó (al menos una frase).');
    update(order, { status: 'en_disputa', dispute_reason: text, auto_release_at: null });
    systemNote(order.conversation_id, `⚠️ El comprador abrió un reclamo en el pedido ${order.code}. El pago queda retenido hasta que CowFace lo resuelva.`);
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
      systemNote(order.conversation_id, `✅ CowFace confirmó el pago del pedido ${order.code}. Vendedor: ya puedes enviarlo; arriba están los datos de entrega.`);
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
      systemNote(order.conversation_id, `💸 CowFace devolvió ${formatColones(order.price)} al comprador (pedido ${order.code}).`);
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
    transaction(() => complete(order, `✅ Pasó el plazo sin reclamos: el pedido ${order.code} se dio por recibido. CowFace le transferirá el pago al vendedor.`));
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
    SELECT o.*, COALESCE(s.store_name, s.name) AS store_name, s.payout_phone, s.payout_name, b.name AS buyer_name
    FROM orders o JOIN users s ON s.id = o.seller_id JOIN users b ON b.id = o.buyer_id
    WHERE ${where} ORDER BY o.updated_at, o.id
  `).all();
  return {
    toVerify: q("o.status = 'por_pagar' AND o.payment_reported_at IS NOT NULL"),
    disputes: q("o.status = 'en_disputa'"),
    refunds: q("o.status = 'reembolso_pendiente'"),
    payouts: q("o.status = 'completado' AND o.payout_status = 'pendiente'"),
  };
}
