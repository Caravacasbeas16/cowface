// Rutas de la Mensajería CowFace: los mensajeros (conocidos a los que se les paga por envío), los
// pedidos de cada día, el plan de rutas (route-planner.js) guardado por día y mensajero, el texto
// para mandarle a cada uno por WhatsApp y lo que se le debe a cada mensajero.
import { db, getSetting, setSetting, transaction } from './db.js';
import { UserError, now } from './messages.js';
import { formatColones } from './catalog.js';
import { normalizePhone } from './validate.js';
import { wazeLink } from './courier.js';
import { planRoutes } from './route-planner.js';

export const DEFAULT_COURIER_PAY = 2000;
export function courierPay() {
  const n = Number.parseInt(getSetting('courier_pay'), 10);
  return n >= 0 && n <= 50_000 ? n : DEFAULT_COURIER_PAY;
}
export const setCourierPay = (n) => setSetting('courier_pay', String(n));

// ---------- Ubicaciones ----------

const inCostaRica = (lat, lng) => lat >= 8 && lat <= 11.3 && lng >= -86 && lng <= -82.5;

// Coordenadas desde lo que pegue el admin: "9.93, -84.05", o un link de Google Maps o Waze que las traiga.
export function parseCoords(text) {
  const s = String(text ?? '').trim();
  const m = s.match(/(-?\d{1,2}\.\d{3,})\s*(?:,|%2C)\s*(-?\d{2,3}\.\d{3,})/i);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return inCostaRica(lat, lng) ? { lat, lng } : null;
}

const coordsOrError = (text) => {
  const c = parseCoords(text);
  if (!c) throw new UserError('No encontré coordenadas de Costa Rica. Pega algo como 9.9335, -84.0510 (en Google Maps: mantén presionado el punto y copia las coordenadas).');
  return c;
};

export function setOrderLocation(orderId, text) {
  const c = coordsOrError(text);
  db.prepare('UPDATE orders SET delivery_lat = ?, delivery_lng = ? WHERE id = ?').run(c.lat, c.lng, orderId);
  return c;
}

export function setStorePickup(userId, text) {
  const c = coordsOrError(text);
  db.prepare('UPDATE users SET pickup_lat = ?, pickup_lng = ? WHERE id = ?').run(c.lat, c.lng, userId);
  return c;
}

// La tienda manda su ubicación desde el celular (configuración de la tienda).
export function storePickupFromGps(userId, body) {
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!body.lat || !inCostaRica(lat, lng)) return false;
  db.prepare('UPDATE users SET pickup_lat = ?, pickup_lng = ? WHERE id = ?').run(lat, lng, userId);
  return true;
}

// ---------- Mensajeros ----------

export const listCouriers = (onlyActive = false) => db.prepare(
  `SELECT * FROM couriers ${onlyActive ? 'WHERE active = 1' : ''} ORDER BY active DESC, name`,
).all();

export function addCourier(body) {
  const name = String(body.name ?? '').trim().slice(0, 60);
  const phone = normalizePhone(body.phone);
  if (name.length < 2) throw new UserError('Escribe el nombre del mensajero.');
  if (!phone) throw new UserError('Teléfono de WhatsApp del mensajero, 8 dígitos.');
  const start = String(body.start ?? '').trim() ? coordsOrError(body.start) : null;
  db.prepare('INSERT INTO couriers (name, phone, start_lat, start_lng) VALUES (?, ?, ?, ?)').run(name, phone, start?.lat ?? null, start?.lng ?? null);
  return name;
}

export const setCourierActive = (id, on) => db.prepare('UPDATE couriers SET active = ? WHERE id = ?').run(on ? 1 : 0, id);

// ---------- Pedidos de un día ----------

const ORDER_SQL = `
  SELECT o.id, o.code, o.product_title, o.delivery_address, o.delivery_lat, o.delivery_lng, o.delivery_phone,
    o.delivery_days, o.delivery_dates, o.route_date, o.courier_id, o.status, o.conversation_id,
    b.name AS buyer_name, s.id AS store_id, COALESCE(s.store_name, s.name) AS store_name, s.phone AS store_phone,
    s.store_address, s.pickup_lat, s.pickup_lng
  FROM orders o JOIN users b ON b.id = o.buyer_id JOIN users s ON s.id = o.seller_id`;
const hasDate = (o, date) => !o.delivery_dates || `,${o.delivery_dates},`.includes(`,${date},`);

// Pagados por Mensajería CowFace que todavía no salen: los que el comprador puede recibir ese día
// (o ya asignados a ese día), y los demás, para verlos.
export function ordersForDay(date) {
  const all = db.prepare(`${ORDER_SQL} WHERE o.delivery_method = 'mensajeria' AND o.status = 'pagado' ORDER BY o.id`).all();
  const today = all.filter((o) => o.route_date === date || (!o.route_date && hasDate(o, date)));
  return {
    day: today,
    ready: today.filter((o) => o.delivery_lat && o.pickup_lat),
    missing: today.filter((o) => !o.delivery_lat || !o.pickup_lat),
    otherDays: all.filter((o) => !today.includes(o)),
  };
}

export const unroutedCount = () => db.prepare(
  "SELECT COUNT(*) AS n FROM orders WHERE delivery_method = 'mensajeria' AND status = 'pagado' AND route_date IS NULL",
).get().n;

// Arma y guarda las rutas de un día con los mensajeros elegidos (reemplaza las de ese día).
export function buildRoutes(date, courierIds) {
  return transaction(() => {
    const couriers = listCouriers(true).filter((c) => courierIds.includes(c.id));
    if (!couriers.length) throw new UserError('Elige al menos un mensajero.');
    clearRoutes(date);
    const { ready } = ordersForDay(date);
    if (!ready.length) throw new UserError('No hay pedidos con ubicación para ese día.');
    const input = ready.map((o) => ({
      id: o.id, store: { id: o.store_id, lat: o.pickup_lat, lng: o.pickup_lng }, buyer: { lat: o.delivery_lat, lng: o.delivery_lng },
    }));
    const plans = planRoutes(input, couriers.map((c) => ({ id: c.id, lat: c.start_lat ?? undefined, lng: c.start_lng ?? undefined })));
    const save = db.prepare('INSERT INTO courier_routes (route_date, courier_id, plan) VALUES (?, ?, ?)');
    const assign = db.prepare('UPDATE orders SET courier_id = ?, route_date = ? WHERE id = ?');
    for (const p of plans.filter((x) => x.orders.length)) {
      save.run(date, p.courier.id, JSON.stringify({
        km: p.km, minutes: p.minutes, stops: p.stops.map((s) => ({ kind: s.kind, orders: s.orders.map((o) => o.id) })),
      }));
      for (const o of p.orders) assign.run(p.courier.id, date, o.id);
    }
    return plans.filter((x) => x.orders.length).length;
  });
}

// Deshace las rutas de un día; los pedidos que todavía no salen quedan libres otra vez.
export function clearRoutes(date) {
  db.prepare('DELETE FROM courier_routes WHERE route_date = ?').run(date);
  db.prepare("UPDATE orders SET courier_id = NULL, route_date = NULL WHERE route_date = ? AND status = 'pagado'").run(date);
}

// Las rutas guardadas de un día, con los datos de cada parada al día de hoy.
export function routesFor(date) {
  const one = db.prepare(`${ORDER_SQL} WHERE o.id = ?`);
  return db.prepare(`
    SELECT r.*, c.name AS courier_name, c.phone AS courier_phone FROM courier_routes r JOIN couriers c ON c.id = r.courier_id
    WHERE r.route_date = ? ORDER BY c.name
  `).all(date).map((r) => {
    const plan = JSON.parse(r.plan);
    const stops = plan.stops.map((s) => {
      const orders = s.orders.map((id) => one.get(id)).filter(Boolean);
      const o = orders[0] || {};
      const pickup = s.kind === 'recoger';
      const point = pickup ? { lat: o.pickup_lat, lng: o.pickup_lng, address: o.store_address } : { lat: o.delivery_lat, lng: o.delivery_lng, address: o.delivery_address };
      return {
        kind: s.kind, orders, ...point,
        who: pickup ? o.store_name : o.buyer_name,
        phone: pickup ? o.store_phone : o.delivery_phone,
        days: pickup ? null : o.delivery_days,
        waze: wazeLink({ delivery_lat: point.lat, delivery_lng: point.lng, delivery_address: point.address }),
      };
    });
    const deliveries = new Set(stops.filter((s) => s.kind === 'entregar').flatMap((s) => s.orders.map((o) => o.id))).size;
    const route = { ...r, km: plan.km, minutes: plan.minutes, stops, deliveries, pay: deliveries * courierPay() };
    return { ...route, mapsLink: mapsLink(stops), text: courierText(route, date) };
  });
}

// Ruta completa en Google Maps (hasta 9 paradas intermedias; si hay más, se abre por partes en Waze).
function mapsLink(stops) {
  const pts = stops.filter((s) => s.lat).map((s) => `${s.lat},${s.lng}`);
  if (pts.length < 2 || pts.length > 11) return null;
  const q = new URLSearchParams({ api: '1', origin: pts[0], destination: pts.at(-1), travelmode: 'driving' });
  if (pts.length > 2) q.set('waypoints', pts.slice(1, -1).join('|'));
  return `https://www.google.com/maps/dir/?${q}`;
}

// Mensaje para el mensajero: cada parada en orden, con quién, dirección, teléfono y Waze.
export function courierText(route, date) {
  const lines = [`Ruta CowFace · ${date} · ${route.courier_name}`, `${route.stops.length} paradas · ${route.km} km · unas ${Math.round(route.minutes / 60 * 10) / 10} h`, ''];
  route.stops.forEach((s, i) => {
    const codes = s.orders.map((o) => o.code).join(', ');
    lines.push(`${i + 1}. ${s.kind === 'recoger' ? 'RECOGER' : 'ENTREGAR'} · ${s.who} · ${codes}`);
    if (s.address) lines.push(`   ${s.address}`);
    if (s.phone) lines.push(`   Tel: ${s.phone}`);
    if (s.days) lines.push(`   Puede recibir: ${s.days}`);
    if (s.waze) lines.push(`   Waze: ${s.waze}`);
  });
  lines.push('', `Pago: ${route.deliveries} envío${route.deliveries === 1 ? '' : 's'} × ${formatColones(courierPay())} = ${formatColones(route.pay)}`);
  return lines.join('\n');
}

// ---------- Pagos a mensajeros ----------

// Envíos que ya salieron (la tienda se los entregó) y todavía no se le pagan a cada mensajero.
export function courierBalances() {
  return db.prepare(`
    SELECT c.id, c.name, c.phone, COUNT(o.id) AS trips FROM couriers c
    JOIN orders o ON o.courier_id = c.id AND o.courier_paid_at IS NULL AND o.status IN ('enviado', 'completado', 'en_disputa')
    GROUP BY c.id ORDER BY c.name
  `).all().map((c) => ({ ...c, amount: c.trips * courierPay() }));
}

export function payCourier(courierId) {
  return db.prepare(`UPDATE orders SET courier_paid_at = ? WHERE courier_id = ? AND courier_paid_at IS NULL
    AND status IN ('enviado', 'completado', 'en_disputa')`).run(now(), courierId).changes;
}
