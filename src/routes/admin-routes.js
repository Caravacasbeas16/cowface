// Admin → Rutas: los pedidos de la Mensajería CowFace de un día, repartidos entre los mensajeros en
// rutas ordenadas (recoger en tiendas → entregar a compradores), y lo que se le debe a cada mensajero.
import { Router } from 'express';
import { requireRole } from '../auth.js';
import { UserError } from '../messages.js';
import { todayCR } from '../payout-schedule.js';
import {
  addCourier, buildRoutes, clearRoutes, courierBalances, courierPay, listCouriers, ordersForDay, payCourier, routesFor,
  setCourierActive, setCourierPay, setOrderLocation, setStorePickup,
} from '../courier-runs.js';

const router = Router();
router.use(requireRole('admin'));

const flash = (res, message) => res.cookie('flash', message, { httpOnly: true, sameSite: 'lax', maxAge: 60_000 });
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dateOf = (v) => (DATE.test(String(v ?? '')) ? String(v) : todayCR());
const back = (res, date, hash = '') => res.redirect(`/admin/rutas?fecha=${date}${hash}`);

// Hoy y los próximos 7 días (los que el comprador puede elegir).
function dayTabs(selected) {
  const base = new Date(`${todayCR()}T12:00:00Z`);
  return Array.from({ length: 8 }, (_, i) => {
    const d = new Date(base.getTime() + i * 86400e3);
    const value = d.toISOString().slice(0, 10);
    const label = i === 0 ? 'Hoy' : i === 1 ? 'Mañana' : d.toLocaleDateString('es-CR', { weekday: 'short', day: 'numeric', timeZone: 'UTC' }).replace(/[.,]/g, '');
    return { value, label, active: value === selected };
  });
}

// Corre una acción; un UserError vuelve como aviso.
const act = (fn) => (req, res, next) => {
  const date = dateOf(req.body.fecha);
  try {
    flash(res, fn(req, date));
    back(res, date, req.body.hash || '');
  } catch (err) {
    if (!(err instanceof UserError)) return next(err);
    flash(res, err.message);
    back(res, date, req.body.hash || '');
  }
};

router.get('/rutas', (req, res) => {
  const date = dateOf(req.query.fecha);
  res.render('admin/routes', {
    title: 'Rutas', adminActive: 'rutas', date, days: dayTabs(date), ...ordersForDay(date), routes: routesFor(date),
    couriers: listCouriers(), balances: courierBalances(), pay: courierPay(),
  });
});

router.post('/rutas/armar', act((req, date) => {
  const ids = [req.body.couriers ?? []].flat().map(Number).filter(Boolean);
  const n = buildRoutes(date, ids);
  return `Listo: ${n} ruta${n === 1 ? '' : 's'} para el ${date}. Mándasela a cada mensajero.`;
}));

router.post('/rutas/deshacer', act((req, date) => { clearRoutes(date); return 'Rutas deshechas: los pedidos quedaron libres.'; }));

router.post('/rutas/ubicacion/pedido/:id', act((req) => { setOrderLocation(Number(req.params.id), req.body.coords); return 'Ubicación del comprador guardada.'; }));
router.post('/rutas/ubicacion/tienda/:id', act((req) => { setStorePickup(Number(req.params.id), req.body.coords); return 'Ubicación de recogida de la tienda guardada.'; }));

router.post('/mensajeros', act((req) => `${addCourier(req.body)} quedó en tu lista de mensajeros.`));
router.post('/mensajeros/:id/activo', act((req) => { setCourierActive(Number(req.params.id), req.body.on === '1'); return 'Mensajero actualizado.'; }));
router.post('/mensajeros/:id/pagado', act((req) => {
  const n = payCourier(Number(req.params.id));
  return n ? `${n} envío${n === 1 ? '' : 's'} marcado${n === 1 ? '' : 's'} como pagado${n === 1 ? '' : 's'} al mensajero.` : 'No tenía envíos por pagar.';
}));
router.post('/mensajeros/pago', act((req) => {
  const n = Number(String(req.body.pay ?? '').replace(/[₡,.\s]/g, ''));
  if (!Number.isInteger(n) || n < 0 || n > 50_000) throw new UserError('Pago por envío en colones, de 0 a ₡50 000.');
  setCourierPay(n);
  return 'Pago por envío guardado.';
}));

export default router;
