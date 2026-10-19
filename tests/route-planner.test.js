// Planificador de rutas: reparte entre mensajeros por zona, nunca entrega antes de recoger, junta los
// pedidos de una misma tienda en una sola parada y da rutas cortas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignOrders, km, orderStops, planRoutes, routeLength } from '../src/route-planner.js';

// Puntos reales del GAM.
const P = {
  heredia: { lat: 9.9981, lng: -84.1166 },
  sanPedro: { lat: 9.9335, lng: -84.0510 },
  escazu: { lat: 9.9187, lng: -84.1395 },
  cartago: { lat: 9.8644, lng: -83.9194 },
  alajuela: { lat: 10.0163, lng: -84.2116 },
  curri: { lat: 9.9010, lng: -84.0570 },
  tibas: { lat: 9.9580, lng: -84.0830 },
  sabana: { lat: 9.9370, lng: -84.1010 },
};
const store = (id, p) => ({ id, ...p });
const order = (id, s, b) => ({ id, store: s, buyer: { ...b } });

test('distancia: Heredia–San Pedro unos 13 km por calle', () => {
  const d = km(P.heredia, P.sanPedro);
  assert.ok(d > 11 && d < 16, `${d}`);
});

test('nunca se entrega un pedido antes de recogerlo, aunque el comprador quede más cerca', () => {
  const tienda = store(1, P.cartago);
  const orders = [order(1, tienda, P.sanPedro), order(2, tienda, P.curri)];
  const [plan] = planRoutes(orders, [{ id: 1, ...P.sabana }]);
  assert.equal(plan.stops[0].kind, 'recoger', 'sale de la Sabana pero primero va a Cartago');
  assert.equal(plan.stops.length, 3, 'una sola parada en la tienda para los dos pedidos');
  assert.deepEqual(plan.stops[0].orders.map((o) => o.id).sort(), [1, 2]);
});

test('dos mensajeros: cada uno se queda con su zona', () => {
  const tHeredia = store(1, P.heredia);
  const tCartago = store(2, P.cartago);
  const orders = [
    order(1, tHeredia, P.alajuela), order(2, tHeredia, P.heredia), order(3, tHeredia, P.tibas),
    order(4, tCartago, P.curri), order(5, tCartago, P.cartago), order(6, tCartago, P.sanPedro),
  ];
  const groups = assignOrders(orders, [{ id: 1 }, { id: 2 }]);
  const ids = groups.map((g) => g.map((o) => o.id).sort().join(',')).sort();
  assert.deepEqual(ids, ['1,2,3', '4,5,6']);
});

test('con punto de salida, a cada mensajero le tocan los pedidos de su lado', () => {
  const tHeredia = store(1, P.heredia);
  const tCartago = store(2, P.cartago);
  const orders = [order(1, tHeredia, P.alajuela), order(2, tCartago, P.cartago)];
  const plans = planRoutes(orders, [{ id: 'este', ...P.cartago }, { id: 'oeste', ...P.alajuela }]);
  assert.deepEqual(plans[0].orders.map((o) => o.id), [2]);
  assert.deepEqual(plans[1].orders.map((o) => o.id), [1]);
});

test('reparto parejo: nadie se queda con casi todo', () => {
  const t = store(1, P.sabana);
  const orders = Array.from({ length: 9 }, (_, i) => order(i + 1, t, i < 8 ? P.escazu : P.cartago));
  const sizes = assignOrders(orders, [{ id: 1 }, { id: 2 }, { id: 3 }]).map((g) => g.length);
  assert.ok(Math.max(...sizes) <= 4, `${sizes}`);
  assert.equal(sizes.reduce((a, b) => a + b), 9);
});

test('la ruta optimizada no es más larga que el orden de llegada', () => {
  const tiendas = [store(1, P.heredia), store(2, P.sabana), store(3, P.cartago)];
  const buyers = [P.alajuela, P.curri, P.tibas, P.escazu, P.sanPedro, P.cartago];
  const orders = buyers.map((b, i) => order(i + 1, tiendas[i % 3], b));
  const [plan] = planRoutes(orders, [{ id: 1 }]);
  // Orden ingenuo: recoger todo en el orden de las tiendas y entregar en el orden de los pedidos.
  const naive = [...tiendas, ...buyers];
  assert.ok(plan.km <= routeLength(naive) + 0.1, `${plan.km} vs ${routeLength(naive)}`);
  const seen = new Set();
  for (const s of plan.stops) {
    for (const o of s.orders) if (s.kind === 'entregar') assert.ok(seen.has(o.store.id), 'recogido antes');
    if (s.kind === 'recoger') seen.add(s.orders[0].store.id);
  }
  assert.ok(plan.minutes > 0);
});

test('casos borde: sin pedidos, más mensajeros que pedidos', () => {
  assert.deepEqual(planRoutes([], [{ id: 1 }]).map((p) => p.stops.length), [0]);
  const plans = planRoutes([order(1, store(1, P.heredia), P.tibas)], [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(plans.map((p) => p.orders.length), [1, 0]);
  assert.equal(orderStops([]).length, 0);
});
