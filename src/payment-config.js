// Configuración de pagos que llena el admin en su panel: cuenta SINPE de CowFace, plazos,
// hora de corte de los pagos a tiendas y la tarifa de la mensajería CowFace dentro del GAM.
import { getSetting, setSetting } from './db.js';
import { DEFAULT_CUTOFF_HOUR, payoutDay } from './payout-schedule.js';
import { normalizePhone } from './validate.js';
import { DEFAULT_COURIER_FEE } from './courier.js';

export const MAX_COURIER_FEE = 50_000;
function savedCourierFee() {
  const raw = getSetting('courier_fee');
  const n = Number.parseInt(raw, 10);
  return raw !== null && raw !== undefined && raw !== '' && n >= 0 && n <= MAX_COURIER_FEE ? n : DEFAULT_COURIER_FEE;
}

export function paymentConfig() {
  return {
    phone: getSetting('payment_phone') || '',
    holder: getSetting('payment_holder') || '',
    windowHours: Number(getSetting('payment_window_hours')) || 24,
    releaseDays: Number(getSetting('auto_release_days')) || 3,
    // Hora (Costa Rica) desde la que una venta completada se paga el siguiente día hábil.
    cutoffHour: savedCutoff(),
    // Tarifa fija de la Mensajería CowFace dentro del GAM (la cobra CowFace, no la tienda).
    courierFee: savedCourierFee(),
  };
}

export function savedCutoff() {
  const h = Number.parseInt(getSetting('payout_cutoff_hour'), 10);
  return h >= 12 && h <= 23 ? h : DEFAULT_CUTOFF_HOUR;
}

// Día en que toca pagarle a la tienda una venta completada (ver payout-schedule.js).
export const payoutDayOf = (order) => payoutDay(order.completed_at, savedCutoff());

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
  // La hora de corte es opcional en el formulario (si no viene, se deja la que estaba).
  const cutoff = body.cutoff_hour === undefined || body.cutoff_hour === '' ? null : Number.parseInt(body.cutoff_hour, 10);
  if (cutoff !== null && !(cutoff >= 12 && cutoff <= 23)) errors.push('Hora de corte de pagos entre 12 (mediodía) y 23.');
  // La tarifa de mensajería es opcional en el formulario (si no viene, se deja la que estaba).
  const feeRaw = String(body.courier_fee ?? '').replace(/[₡,.\s]/g, '');
  const fee = feeRaw === '' ? null : Number(feeRaw);
  if (fee !== null && !(Number.isInteger(fee) && fee >= 0 && fee <= MAX_COURIER_FEE)) errors.push('Tarifa de mensajería en colones, de 0 a ₡50 000.');
  if (errors.length) return errors;
  setSetting('payment_phone', phone);
  setSetting('payment_holder', holder);
  setSetting('payment_window_hours', windowHours);
  setSetting('auto_release_days', releaseDays);
  if (cutoff !== null) setSetting('payout_cutoff_hour', cutoff);
  if (fee !== null) setSetting('courier_fee', fee);
  return [];
}
