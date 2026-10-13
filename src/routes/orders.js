import { Router } from 'express';
import { requireRole } from '../auth.js';
import { UserError } from '../messages.js';
import {
  cancelUnpaid, confirmReceived, markShipped, openDispute, reportPayment, sellerCannotDeliver,
} from '../orders.js';
import { rateLimit } from '../rate-limit.js';

const router = Router();
router.use(requireRole('usuario'));
router.use(rateLimit({ windowMs: 60 * 60 * 1000, max: 60, message: 'Demasiadas acciones seguidas. Intenta más tarde.' }));

const ACTIONS = {
  pago: (id, user, body) => reportPayment(id, user.id, body),
  cancelar: (id, user) => cancelUnpaid(id, user.id),
  enviado: (id, user, body) => markShipped(id, user.id, body.note),
  recibido: (id, user) => confirmReceived(id, user.id),
  reclamo: (id, user, body) => openDispute(id, user.id, body.reason),
  'no-puedo-entregar': (id, user) => sellerCannotDeliver(id, user.id),
};

// Cada acción verifica que el pedido sea del usuario y que esté en el estado correcto;
// al terminar vuelve a la conversación del pedido.
router.post('/:id/:action', (req, res, next) => {
  const action = ACTIONS[req.params.action];
  if (!action) return next();
  try {
    const order = action(Number(req.params.id), req.user, req.body);
    if (!order) return next();
    res.redirect(order.conversation_id ? `/mensajes/${order.conversation_id}` : '/vendedor');
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    res.cookie('flash', err.message, { httpOnly: true, sameSite: 'lax', maxAge: 60_000 });
    const back = (req.get('Referer') || '').match(/\/mensajes\/\d+$/)?.[0] || '/vendedor';
    res.redirect(back);
  }
});

export default router;
