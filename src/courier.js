// Mensajería CowFace dentro del GAM: el comprador manda su ubicación y los días en que puede recibir,
// paga una tarifa fija (Admin → Cobro) y CowFace coordina con la tienda cuándo recoger el paquete.
// El envío queda para CowFace: no se le suma al pago de la tienda.
import { UserError } from './messages.js';

export const COURIER = 'mensajeria';
export const isCourier = (method) => method === COURIER;
export const DEFAULT_COURIER_FEE = 2000;

export const TIME_SLOTS = { cualquiera: 'a cualquier hora', manana: 'en la mañana', tarde: 'en la tarde' };

// Los próximos 7 días desde mañana, en hora de Costa Rica (UTC−6, sin horario de verano).
export function nextDays(from = Date.now(), n = 7) {
  const cr = new Date(from - 6 * 3600e3);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(cr.getUTCFullYear(), cr.getUTCMonth(), cr.getUTCDate() + i + 1));
    const label = d.toLocaleDateString('es-CR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(/[.,]/g, '');
    return { value: d.toISOString().slice(0, 10), label };
  });
}

// "lun 19 oct, mié 21 oct · en la tarde": los días que marcó el comprador (de los próximos 7) y la franja.
export function availabilityText(body, from = Date.now()) {
  const allowed = new Map(nextDays(from).map((d) => [d.value, d.label]));
  const days = [...new Set([body.days ?? []].flat().map(String))].filter((v) => allowed.has(v)).sort();
  if (!days.length) throw new UserError('Marca al menos un día en que puedas recibir el paquete.');
  const slot = TIME_SLOTS[body.slot] ? body.slot : 'cualquiera';
  return `${days.map((d) => allowed.get(d)).join(', ')} · ${TIME_SLOTS[slot]}`;
}

// Ubicación que mandó el comprador desde su celular (dentro de Costa Rica). También la tienen
// los pedidos viejos de Uber Flash.
export function deliveryLocation(method, body) {
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const ok = ['mensajeria', 'uber_flash'].includes(method) && lat >= 8 && lat <= 11.3 && lng >= -86 && lng <= -82.5;
  return { delivery_lat: ok ? lat : null, delivery_lng: ok ? lng : null };
}

// Link de Waze para el mensajero: al punto exacto si el comprador mandó su ubicación, o buscando la
// dirección escrita si no la mandó.
export function wazeLink(o) {
  if (o.delivery_lat && o.delivery_lng) return `https://waze.com/ul?ll=${o.delivery_lat},${o.delivery_lng}&navigate=yes`;
  return o.delivery_address ? `https://waze.com/ul?${new URLSearchParams({ q: o.delivery_address, navigate: 'yes' })}` : null;
}
