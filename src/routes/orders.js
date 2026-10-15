import { Router } from 'express';
import { requireRole } from '../auth.js';
import { UserError } from '../messages.js';
import {
  cancelUnpaid, confirmReceived, markShipped, openDispute, quoteDelivery, reportPayment, requestDelivery, sellerCannotDeliver,
} from '../orders.js';
import { perUser, rateLimit } from '../rate-limit.js';
import { attachment, discardAttachment } from '../uploads.js';

const router = Router();
router.use(requireRole('usuario'));
router.use(rateLimit({ windowMs: 60 * 60 * 1000, max: 60, key: perUser, message: 'Demasiadas acciones seguidas. Intenta más tarde.' }));

// Cada acción recibe el archivo opcional del formulario (campo "comprobante"): captura del SINPE,
// foto de la guía de envío o foto del problema en un reclamo. Se guarda como adjunto privado.
const ACTIONS = {
  entrega: (id, user, body) => requestDelivery(id, user.id, body),
  cotizar: (id, user, body) => quoteDelivery(id, user.id, body),
  pago: (id, user, body, file) => reportPayment(id, user.id, body, file),
  cancelar: (id, user) => cancelUnpaid(id, user.id),
  enviado: (id, user, body, file) => markShipped(id, user.id, body.note, file, body.track),
  recibido: (id, user) => confirmReceived(id, user.id),
  reclamo: (id, user, body, file) => openDispute(id, user.id, body.reason, file),
  'no-puedo-entregar': (id, user) => sellerCannotDeliver(id, user.id),
};
const USES_FILE = new Set(['pago', 'enviado', 'reclamo']);

// Cada acción verifica que el pedido sea del usuario y que esté en el estado correcto;
// al terminar vuelve a la conversación del pedido.
router.post('/:id/:action', attachment('comprobante'), (req, res, next) => {
  const action = ACTIONS[req.params.action];
  const back = (req.get('Referer') || '').match(/\/mensajes\/\d+$/)?.[0] || '/vendedor';
  const fail = (message) => {
    discardAttachment(req);
    res.cookie('flash', message, { httpOnly: true, sameSite: 'lax', maxAge: 60_000 });
    return res.redirect(back);
  };
  if (!action) { discardAttachment(req); return next(); }
  if (req.uploadError) return fail(req.uploadError);
  if (req.attachment && !USES_FILE.has(req.params.action)) discardAttachment(req);
  try {
    const order = action(Number(req.params.id), req.user, req.body, req.attachment?.name || null);
    if (!order) { discardAttachment(req); return next(); }
    res.redirect(order.conversation_id ? `/mensajes/${order.conversation_id}` : '/vendedor');
  } catch (err) {
    if (!(err instanceof UserError)) { discardAttachment(req); throw err; }
    return fail(err.message);
  }
});

export default router;
