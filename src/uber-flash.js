// Uber Flash: la tienda pide el viaje en su app de Uber. CowFace le abre Uber con el destino del
// comprador ya puesto, guarda el link de "Compartir viaje" para que el comprador lo siga en vivo y,
// como llega el mismo día, el pedido se da por recibido al final del día (ver sameDayRelease).
import { UserError } from './messages.js';

// Ubicación que mandó el comprador desde su celular (solo para Uber Flash y dentro de Costa Rica).
export function deliveryLocation(method, body) {
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const ok = method === 'uber_flash' && lat >= 8 && lat <= 11.3 && lng >= -86 && lng <= -82.5;
  return { delivery_lat: ok ? lat : null, delivery_lng: ok ? lng : null };
}

// Link de "Compartir viaje" de la app de Uber (uber.com o su acortador ubr.to).
const TRACK_LINK = /^https:\/\/([a-z0-9-]+\.)*(uber\.com|ubr\.to)\/\S*$/i;
export const validTrackUrl = (url) => TRACK_LINK.test(url);

// Abre la app de Uber (o la web) con el destino del comprador; la tienda elige "Flash" y confirma.
export function uberLink(o) {
  const q = new URLSearchParams({ action: 'setPickup', pickup: 'my_location', 'dropoff[nickname]': `Pedido ${o.code}` });
  if (o.delivery_lat && o.delivery_lng) {
    q.set('dropoff[latitude]', String(o.delivery_lat));
    q.set('dropoff[longitude]', String(o.delivery_lng));
  }
  if (o.delivery_address) q.set('dropoff[formatted_address]', o.delivery_address);
  return `https://m.uber.com/ul/?${q}`;
}

// Al marcar como enviado: el link de seguimiento (solo Uber Flash, opcional) y el aviso en el chat.
export function trackUrlFor(order, track) {
  const url = String(track ?? '').trim();
  if (url && (order.delivery_method !== 'uber_flash' || !validTrackUrl(url))) {
    throw new UserError('Pega el link de "Compartir viaje" de la app de Uber (empieza con https:// y es de uber.com).');
  }
  return url || null;
}

export const uberShippedNote = (order, trackUrl, releaseDays) => `🚗 La tienda envió el pedido ${order.code} por Uber Flash.`
  + `${trackUrl ? ' Puedes seguir el viaje en vivo desde el pedido.' : ''}`
  + ` Cuando te llegue, confirma que lo recibiste; si no hay reclamo, se da por recibido ${trackUrl ? 'al final del día' : `en ${releaseDays} días`}.`;
