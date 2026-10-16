// Páginas del panel del admin: Tiendas (aprobar, prioridad, destacar, suspender), Pagos (verificar
// SINPE y pagarle a cada tienda de una vez) y Pedidos (buscar cualquier pedido).
import { Router } from 'express';
import { requireRole } from '../auth.js';
import { ORDER_STATUS } from '../catalog.js';
import { DELIVERY_LABELS, adminQueues, paymentConfig } from '../orders.js';
import { pendingStores, approvalRequired } from '../approval.js';
import {
  PRIORITIES, STORE_TABS, adminBack, adminLocals, orderSearch, payAllDue, payoutBoard, payoutHistory, payoutsCsv, setPriority,
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
  });
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

export default router;
