import { Router } from 'express';
import { requireRole } from '../auth.js';
import { getProduct } from '../products.js';
import {
  UserError, buyNow, getConversationForUser, getOrCreateConversation, listConversations, makeOffer, markRead,
  minOffer, respondOffer, sendAttachment, sendText, threadMessages, unreadCount,
} from '../chat.js';
import { attachment, discardAttachment } from '../uploads.js';
import path from 'node:path';
import { ATTACH_DIR } from '../storage.js';
import { notifyAdmin } from '../admin-notify.js';
import { orderForConversation } from '../orders.js';
import { formatColones } from '../catalog.js';
import { blockedMessage, findBlocked, logFlagged } from '../moderation.js';
import { subscribe } from '../realtime.js';
import { markSeen, presenceOf } from '../presence.js';
import { storeHoursInfo } from '../store-hours.js';
import { requestHelp } from '../help.js';
import { parsePrice } from '../validate.js';
import { perUser, rateLimit } from '../rate-limit.js';
import { hasBlocked, isBlockedEither } from '../blocks.js';
import { ratingSummary } from '../reviews.js';

const router = Router();
const signedIn = requireRole('usuario');
// Límites por persona (no solo por conexión), para que no se evadan cambiando de IP.
const messageLimit = rateLimit({ windowMs: 60 * 1000, max: 30, key: perUser, message: 'Estás enviando mensajes muy rápido. Espera un momento.' });
const dealLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 40, key: perUser, message: 'Demasiadas ofertas o compras seguidas. Intenta más tarde.' });
const attachLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, key: perUser, message: 'Enviaste muchos archivos seguidos. Espera un rato.' });

const wantsJson = (req) => (req.get('Accept') || '').includes('application/json');

function flash(res, message) {
  res.cookie('flash', message, { httpOnly: true, sameSite: 'lax', maxAge: 60_000 });
}

// Responde a un error de negocio: JSON para el chat en vivo, o aviso + redirección para formularios.
function fail(req, res, status, message, back) {
  if (wantsJson(req)) return res.status(status).json({ error: message });
  flash(res, message);
  return res.redirect(back);
}

function cleanText(v) {
  return String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, 1000);
}

// Revisa el texto; si trae contacto prohibido, lo registra para el admin y devuelve el aviso.
function moderate(req, text, conversationId, context) {
  const matched = findBlocked(text);
  if (!matched) return null;
  logFlagged({ userId: req.user.id, conversationId, context, body: text, matched });
  return blockedMessage(matched);
}

function productFor(req) {
  const product = getProduct(Number(req.params.id));
  return product && product.seller_active && product.status !== 'borrador' ? product : null;
}

// ---------- Desde la página del artículo ----------

router.post('/p/:id/mensaje', signedIn, messageLimit, (req, res, next) => {
  const product = productFor(req);
  if (!product) return next();
  const back = `/p/${product.id}`;
  const text = cleanText(req.body.body);
  if (!text) return fail(req, res, 400, 'Escribe un mensaje.', back);
  const blocked = moderate(req, text, null, 'primer mensaje');
  if (blocked) return fail(req, res, 422, blocked, back);
  try {
    const conv = getConversationForUser(getOrCreateConversation(product, req.user.id), req.user.id);
    sendText(conv, req.user.id, text);
    res.redirect(`/mensajes/${conv.id}`);
  } catch (err) {
    if (err instanceof UserError) return fail(req, res, 400, err.message, back);
    throw err;
  }
});

router.post('/p/:id/ofertar', signedIn, dealLimit, (req, res, next) => {
  const product = productFor(req);
  if (!product) return next();
  try {
    const amount = parsePrice(req.body.amount);
    if (!amount) throw new UserError(`Escribe un monto en colones (mínimo ${minOffer(product.price).toLocaleString('es-CR')}).`);
    const conv = getConversationForUser(getOrCreateConversation(product, req.user.id), req.user.id);
    makeOffer(conv, req.user.id, amount);
    res.redirect(`/mensajes/${conv.id}`);
  } catch (err) {
    if (err instanceof UserError) return fail(req, res, 400, err.message, `/p/${product.id}`);
    throw err;
  }
});

router.post('/p/:id/comprar', signedIn, dealLimit, (req, res, next) => {
  const product = productFor(req);
  if (!product) return next();
  try {
    res.redirect(`/mensajes/${buyNow(product, req.user.id)}`);
  } catch (err) {
    if (err instanceof UserError) return fail(req, res, 409, err.message, `/p/${product.id}`);
    throw err;
  }
});

// ---------- Bandeja y conversación ----------

router.get('/mensajes', signedIn, (req, res) => {
  res.render('chat/inbox', { title: 'Mensajes', conversations: listConversations(req.user.id) });
});

// Canal en vivo (Server-Sent Events). Va antes de /mensajes/:id.
router.get('/mensajes/eventos', signedIn, (req, res) => {
  const id = req.user.id;
  req.on('close', () => markSeen(id)); // al cerrar la pestaña queda la hora de su última actividad
  subscribe(id, req, res);
});

function loadConversation(req, res, next) {
  const conv = getConversationForUser(Number(req.params.id), req.user.id);
  if (!conv) return res.status(404).render('error', { title: 'No encontrado', message: 'Esa conversación no existe o no es tuya.' });
  req.conv = conv;
  next();
}

router.get('/mensajes/:id', signedIn, loadConversation, (req, res) => {
  markRead(req.conv, req.user.id);
  res.locals.unread = unreadCount(req.user.id);
  const otherId = req.conv.role === 'comprador' ? req.conv.seller_id : req.conv.buyer_id;
  res.render('chat/conversation', {
    title: req.conv.product_title, conv: req.conv, messages: threadMessages(req.conv.id), minOffer: minOffer(req.conv.price || 0),
    otherId, otherRating: ratingSummary(otherId), otherPresence: presenceOf(otherId),
    otherHours: req.conv.role === 'comprador' ? storeHoursInfo(otherId).status : null, blocked: isBlockedEither(req.conv.buyer_id, req.conv.seller_id),
    iBlocked: hasBlocked(req.user.id, otherId),
  });
});

// Solo el hilo y el panel del trato, para refrescar en vivo sin recargar la página.
router.get('/mensajes/:id/hilo', signedIn, loadConversation, (req, res) => {
  markRead(req.conv, req.user.id);
  res.render('chat/thread', { conv: req.conv, messages: threadMessages(req.conv.id), minOffer: minOffer(req.conv.price || 0) });
});

router.post('/mensajes/:id', signedIn, messageLimit, loadConversation, (req, res) => {
  const back = `/mensajes/${req.conv.id}`;
  const text = cleanText(req.body.body);
  if (!text) return fail(req, res, 400, 'Escribe un mensaje.', back);
  const blocked = moderate(req, text, req.conv.id, 'chat');
  if (blocked) return fail(req, res, 422, blocked, back);
  try {
    sendText(req.conv, req.user.id, text);
  } catch (err) {
    if (err instanceof UserError) return fail(req, res, 403, err.message, back);
    throw err;
  }
  if (wantsJson(req)) return res.json({ ok: true });
  res.redirect(back);
});

// Foto o PDF en el chat (comprobantes, detalles de la prenda). Se guarda privado y sin metadatos.
// Si el comprador manda una foto o PDF mientras el pedido está por pagar, casi siempre es la
// captura del SINPE: se le avisa al admin con el archivo adjunto en el correo.
function notifyIfProof(req, caption) {
  if (req.user.id !== req.conv.buyer_id) return;
  const order = orderForConversation(req.conv.id);
  if (!order || order.status !== 'por_pagar') return;
  const kind = req.attachment.type === 'pdf' ? 'un PDF' : 'una foto';
  notifyAdmin('comprobante', `Posible captura del SINPE: ${order.code} · ${formatColones(order.total || order.price)}`,
    `El comprador mandó ${kind} en el chat del pedido ${order.code}, que está por pagar (${formatColones(order.total || order.price)}).`
      + `${caption ? `\nMensaje: «${caption}»` : ''}\nVa adjunto. Si es el SINPE, revísalo en tu banco y confirma el pago en el panel.`,
    `/admin/conversaciones/${req.conv.id}`, { attachments: [{ path: path.join(ATTACH_DIR, req.attachment.name) }] });
}

// "Pedir ayuda a CowFace" desde la conversación (cualquiera de las dos partes, haya o no pedido).
const helpLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, key: perUser, message: 'Ya nos pediste ayuda varias veces; te respondemos pronto.' });
router.post('/mensajes/:id/ayuda', signedIn, helpLimit, loadConversation, (req, res) => {
  const back = `/mensajes/${req.conv.id}`;
  try {
    requestHelp(req.user, req.conv, req.body.body);
    res.cookie('flash', 'Listo: CowFace ya está al tanto y se hace cargo. Te respondemos por esta conversación.', { httpOnly: true, sameSite: 'lax', maxAge: 60_000 });
    res.redirect(back);
  } catch (err) {
    if (err instanceof UserError) return fail(req, res, 400, err.message, back);
    throw err;
  }
});

router.post('/mensajes/:id/adjunto', signedIn, attachLimit, loadConversation, attachment('file'), (req, res) => {
  const back = `/mensajes/${req.conv.id}`;
  if (req.uploadError) return fail(req, res, 400, req.uploadError, back);
  if (!req.attachment) return fail(req, res, 400, 'Elige una foto o un PDF.', back);
  const caption = cleanText(req.body.body);
  const blocked = caption && moderate(req, caption, req.conv.id, 'chat');
  if (blocked) { discardAttachment(req); return fail(req, res, 422, blocked, back); }
  try {
    sendAttachment(req.conv, req.user.id, req.attachment, caption);
    notifyIfProof(req, caption);
  } catch (err) {
    discardAttachment(req);
    if (err instanceof UserError) return fail(req, res, 403, err.message, back);
    throw err;
  }
  if (wantsJson(req)) return res.json({ ok: true });
  res.redirect(back);
});

// Oferta o contraoferta desde la conversación (cualquiera de las dos partes).
router.post('/mensajes/:id/oferta', signedIn, dealLimit, loadConversation, (req, res) => {
  const back = `/mensajes/${req.conv.id}`;
  try {
    const amount = parsePrice(req.body.amount);
    if (!amount) throw new UserError('Escribe un monto en colones.');
    makeOffer(req.conv, req.user.id, amount);
    if (wantsJson(req)) return res.json({ ok: true });
    res.redirect(back);
  } catch (err) {
    if (err instanceof UserError) return fail(req, res, 400, err.message, back);
    throw err;
  }
});

router.post('/ofertas/:offerId/:action', signedIn, dealLimit, (req, res, next) => {
  if (!['aceptar', 'rechazar', 'retirar'].includes(req.params.action)) return next();
  try {
    const conv = respondOffer(Number(req.params.offerId), req.user.id, req.params.action);
    if (!conv) return next();
    if (wantsJson(req)) return res.json({ ok: true });
    res.redirect(`/mensajes/${conv.id}`);
  } catch (err) {
    if (err instanceof UserError) return fail(req, res, 409, err.message, req.get('Referer')?.match(/\/mensajes\/\d+$/)?.[0] || '/mensajes');
    throw err;
  }
});

export default router;
