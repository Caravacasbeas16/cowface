// Páginas del panel del admin: Tiendas (aprobar, prioridad, destacar, suspender), Pagos (verificar
// SINPE y pagarle a cada tienda de una vez) y Pedidos (buscar cualquier pedido).
import { Router } from 'express';
import { requireRole } from '../auth.js';
import { ORDER_STATUS } from '../catalog.js';
import { DELIVERY_LABELS, adminQueues, paymentConfig } from '../orders.js';
import { pendingStores, approvalRequired } from '../approval.js';
import { commissionRate, db } from '../db.js';
import { UserError } from '../messages.js';
import { publicBaseUrl } from '../urls.js';
import { MAX_SUPPORT_TEXT, adminWrites, markSupportRead, supportInbox, supportThread } from '../support.js';
import {
  PRIORITIES, STORE_TABS, adminBack, adminLocals, orderSearch, setCommission, payAllDue, payoutBoard, payoutHistory, payoutsCsv, setPriority,
  storeList, storeTabCounts,
} from '../admin-panel.js';

const router = Router();
router.use(requireRole('admin'));
// Este router va primero en /admin: los contadores del menú quedan para todas las páginas del admin.
router.use(adminLocals);

const flash = (res, message) => res.cookie('flash', message, { httpOnly: true, sameSite: 'lax', maxAge: 60_000 });

router.get('/tiendas', (req, res) => {
  const counts = storeTabCounts();
  const tab = STORE_TABS[req.query.tab] ? req.query.tab : (counts.pendientes ? 'pendientes' : 'aprobadas');
  const q = String(req.query.q ?? '').slice(0, 60);
  res.render('admin/stores', {
    title: 'Tiendas', adminActive: 'tiendas', tab, q, counts, STORE_TABS, PRIORITIES, stores: storeList(tab, q),
    requests: tab === 'pendientes' ? pendingStores() : [], approvalOn: approvalRequired(), back: req.originalUrl,
    generalRate: commissionRate(),
  });
});

router.post('/tiendas/:id/comision', (req, res) => {
  const r = setCommission(Number(req.params.id), req.body.percent);
  flash(res, r.error || (r.rate === null ? `Comisión: la general (${+(commissionRate() * 100).toFixed(2)} %).` : `Comisión de esta tienda: ${+(r.rate * 100).toFixed(2)} % (en los pedidos nuevos).`));
  res.redirect(adminBack(req, '/admin/tiendas'));
});

router.post('/tiendas/:id/prioridad', (req, res) => {
  const p = setPriority(Number(req.params.id), req.body.priority);
  flash(res, p === null ? 'No se pudo cambiar la prioridad.' : `Prioridad: ${PRIORITIES[p]}.`);
  res.redirect(adminBack(req, '/admin/tiendas'));
});

router.get('/pagos', (req, res) => {
  const q = adminQueues();
  res.render('admin/payments', {
    title: 'Pagos', adminActive: 'pagos', toVerify: q.toVerify, refunds: q.refunds, board: payoutBoard(), history: payoutHistory(),
    pay: paymentConfig(), DELIVERY_LABELS,
  });
});

router.post('/pagos/tienda/:id', (req, res) => {
  const r = payAllDue(Number(req.params.id));
  flash(res, r ? `Listo: ${r.n} pedido${r.n === 1 ? '' : 's'} de ${r.store} marcado${r.n === 1 ? '' : 's'} como pagado${r.n === 1 ? '' : 's'}.` : 'Esa tienda no tiene pagos pendientes para hoy.');
  res.redirect('/admin/pagos');
});

router.get('/pagos.csv', (req, res) => {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="cowface-pagos-a-tiendas.csv"' });
  res.send(payoutsCsv());
});

router.get('/pedidos', (req, res) => {
  const estado = ORDER_STATUS[req.query.estado] ? req.query.estado : '';
  const q = String(req.query.q ?? '').slice(0, 60);
  res.render('admin/orders', {
    title: 'Pedidos', adminActive: 'pedidos', q, estado, ORDER_STATUS, DELIVERY_LABELS, orders: orderSearch({ q, status: estado }),
  });
});

// ---------- Chat directo con tiendas ----------
router.get('/mensajes', (req, res) => {
  const q = String(req.query.q ?? '').slice(0, 60);
  res.render('admin/support-inbox', {
    title: 'Mensajes', adminActive: 'mensajes', threads: supportInbox(), q, matches: q ? storeList('todos', q).slice(0, 20) : [],
  });
});

router.get('/mensajes/:userId', (req, res, next) => {
  const u = db.prepare("SELECT id, name, COALESCE(store_name, name) AS store_name, email, phone, store_logo, seller_status FROM users WHERE id = ? AND role = 'usuario' AND deleted_at IS NULL").get(Number(req.params.userId));
  if (!u) return next();
  markSupportRead(u.id, 'admin');
  res.render('admin/support-thread', { title: `Mensajes · ${u.store_name}`, adminActive: 'mensajes', u, messages: supportThread(u.id), max: MAX_SUPPORT_TEXT });
});

router.post('/mensajes/:userId', (req, res, next) => {
  try {
    const u = adminWrites(Number(req.params.userId), req.body.body, publicBaseUrl(req));
    if (!u) return next();
  } catch (err) {
    if (!(err instanceof UserError)) return next(err);
    flash(res, err.message);
  }
  res.redirect(`/admin/mensajes/${Number(req.params.userId)}#fin`);
});

export default router;
