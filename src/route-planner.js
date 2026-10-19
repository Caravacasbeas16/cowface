// Planificador de rutas de la Mensajería CowFace: reparte los pedidos de un día entre los mensajeros
// y ordena las paradas de cada uno (recoger en las tiendas, entregar a los compradores) para que
// recorran la menor distancia posible. Cada pedido se recoge y se entrega por el mismo mensajero,
// y siempre se recoge antes de entregarse.
// Sin servicios externos: la distancia es en línea recta × 1,35 (lo que suelen alargarse las calles
// en el GAM), y el tiempo, a 22 km/h más unos minutos por parada.
//
// orders: [{ id, store: { id, lat, lng }, buyer: { lat, lng } }]
// couriers: [{ id, lat?, lng? }]  (lat/lng = desde dónde sale; opcional)
export const ROAD_FACTOR = 1.35;
export const AVG_KMH = 22;
export const STOP_MINUTES = 6;

export function km(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h)) * ROAD_FACTOR;
}

const mid = (o) => ({ lat: (o.store.lat + o.buyer.lat) / 2, lng: (o.store.lng + o.buyer.lng) / 2 });
const hasPoint = (c) => Number.isFinite(c?.lat) && Number.isFinite(c?.lng);

// Reparte los pedidos en grupos cercanos (k-medias sobre el punto medio tienda–comprador), con un tope
// por mensajero para que nadie se quede con casi todo. Si el mensajero tiene punto de salida, su grupo
// arranca cerca de ahí.
export function assignOrders(orders, couriers) {
  const k = Math.min(couriers.length, orders.length);
  if (!k) return couriers.map(() => []);
  const pts = orders.map(mid);
  let centers = couriers.slice(0, k).map((c, i) => (hasPoint(c) ? { lat: c.lat, lng: c.lng } : null));
  // Centros que faltan: el primero en un pedido cualquiera; los demás, en el pedido más lejano de los
  // centros ya puestos (así los grupos arrancan repartidos por el mapa).
  for (let i = 0; i < k; i++) {
    if (centers[i]) continue;
    const placed = centers.filter(Boolean);
    const far = (p) => Math.min(...placed.map((c) => km(c, p)));
    centers[i] = { ...(placed.length ? pts.reduce((b, p) => (far(p) > far(b) ? p : b)) : pts[0]) };
  }
  const cap = Math.ceil(orders.length / k) + 1;
  let groups = [];
  for (let iter = 0; iter < 20; iter++) {
    groups = centers.map(() => []);
    // Primero los pedidos con una preferencia más marcada, para que el tope afecte a los dudosos.
    const order = pts.map((p, j) => {
      const ds = centers.map((c) => km(c, p)).sort((a, b) => a - b);
      return { j, margin: (ds[1] ?? ds[0]) - ds[0] };
    }).sort((a, b) => b.margin - a.margin);
    for (const { j } of order) {
      const ranked = centers.map((c, i) => ({ i, d: km(c, pts[j]) })).sort((a, b) => a.d - b.d);
      const pick = ranked.find((r) => groups[r.i].length < cap) || ranked[0];
      groups[pick.i].push(j);
    }
    const next = groups.map((g, i) => (g.length && !hasPoint(couriers[i])
      ? { lat: g.reduce((s, j) => s + pts[j].lat, 0) / g.length, lng: g.reduce((s, j) => s + pts[j].lng, 0) / g.length }
      : centers[i]));
    if (next.every((c, i) => km(c, centers[i]) < 0.01)) break;
    centers = next;
  }
  return couriers.map((_, i) => (groups[i] || []).map((j) => orders[j]));
}

// Paradas de un mensajero: una parada por tienda para recoger (todos sus pedidos juntos) y una por
// comprador para entregar (pedidos a la misma ubicación, juntos).
function stopsFor(orders) {
  const pickups = new Map();
  const drops = new Map();
  for (const o of orders) {
    const pk = `t${o.store.id}`;
    if (!pickups.has(pk)) pickups.set(pk, { kind: 'recoger', key: pk, lat: o.store.lat, lng: o.store.lng, orders: [] });
    pickups.get(pk).orders.push(o);
    const dk = `c${o.buyer.lat.toFixed(5)},${o.buyer.lng.toFixed(5)}`;
    if (!drops.has(dk)) drops.set(dk, { kind: 'entregar', key: dk, lat: o.buyer.lat, lng: o.buyer.lng, orders: [] });
    drops.get(dk).orders.push(o);
  }
  // Una entrega necesita haber pasado por la tienda de cada uno de sus pedidos.
  for (const d of drops.values()) d.needs = [...new Set(d.orders.map((o) => `t${o.store.id}`))];
  return [...pickups.values(), ...drops.values()];
}

const feasible = (seq) => {
  const seen = new Set();
  for (const s of seq) {
    if (s.needs && s.needs.some((k) => !seen.has(k))) return false;
    seen.add(s.key);
  }
  return true;
};

export function routeLength(seq, start = null) {
  let total = 0;
  let prev = start;
  for (const s of seq) { if (prev) total += km(prev, s); prev = s; }
  return total;
}

// Orden de las paradas: la más cercana posible en cada paso, y después se mejora probando invertir
// tramos y mover paradas (sin entregar nunca antes de recoger).
export function orderStops(stops, start = null) {
  if (!stops.length) return [];
  const left = [...stops];
  const seq = [];
  const visited = new Set();
  // Sin punto de salida, se arranca en la tienda más alejada del centro: la ruta barre de un extremo.
  const center = centroid(left);
  let here = start || left.filter((s) => s.kind === 'recoger').reduce((b, s) => (km(center, s) > km(center, b) ? s : b));
  while (left.length) {
    const ok = left.filter((s) => !s.needs || s.needs.every((k) => visited.has(k)));
    const next = here ? ok.reduce((b, s) => (km(here, s) < km(here, b) ? s : b), ok[0]) : ok[0];
    seq.push(next);
    visited.add(next.key);
    left.splice(left.indexOf(next), 1);
    here = next;
  }
  return improve(seq, start);
}

function centroid(list) {
  return { lat: list.reduce((s, p) => s + p.lat, 0) / list.length, lng: list.reduce((s, p) => s + p.lng, 0) / list.length };
}

function improve(seq, start) {
  let best = seq;
  let bestLen = routeLength(best, start);
  for (let round = 0, better = true; better && round < 50; round++) {
    better = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        // Invertir el tramo i..j.
        const flipped = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)];
        // Mover la parada i a la posición j.
        const moved = [...best];
        moved.splice(j, 0, moved.splice(i, 1)[0]);
        for (const cand of [flipped, moved]) {
          const len = routeLength(cand, start);
          if (len < bestLen - 1e-9 && feasible(cand)) { best = cand; bestLen = len; better = true; }
        }
      }
    }
  }
  return best;
}

// Plan completo: por mensajero, sus pedidos, las paradas en orden, km y minutos estimados.
export function planRoutes(orders, couriers) {
  const groups = assignOrders(orders, couriers);
  return couriers.map((c, i) => {
    const start = hasPoint(c) ? { lat: c.lat, lng: c.lng } : null;
    const mine = groups[i];
    const stops = mine.length ? orderStops(stopsFor(mine), start) : [];
    const distance = routeLength(stops, start);
    return {
      courier: c, orders: mine, stops,
      km: Math.round(distance * 10) / 10,
      minutes: Math.round((distance / AVG_KMH) * 60 + stops.length * STOP_MINUTES),
    };
  });
}
