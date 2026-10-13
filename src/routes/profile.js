import { Router } from 'express';
import { requireRole } from '../auth.js';
import { db } from '../db.js';
import { PROVINCES } from '../catalog.js';
import { UserError } from '../messages.js';
import { block, hasBlocked, isBlockedEither, myBlocks, unblock } from '../blocks.js';
import { createReview, ratingSummary, reviewsAbout } from '../reviews.js';
import { sellerProducts } from '../products.js';
import { normalizePhone, safeNext } from '../validate.js';
import { blockedMessage, findBlocked } from '../moderation.js';

const router = Router();
const signedIn = requireRole('usuario');

function flash(res, message) {
  res.cookie('flash', message, { httpOnly: true, sameSite: 'lax', maxAge: 60_000 });
}

const backTo = (req, fallback) => {
  const ref = (req.get('Referer') || '').replace(/^https?:\/\/[^/]+/, '');
  return safeNext(ref, fallback);
};

// ---------- Perfil público (como el de Grailed) ----------

router.get('/u/:id', (req, res, next) => {
  const profile = db.prepare(`
    SELECT id, name, COALESCE(store_name, name) AS store_name, province, created_at,
      (SELECT COUNT(*) FROM orders WHERE seller_id = users.id AND status = 'completado') AS sales,
      (SELECT COUNT(*) FROM orders WHERE buyer_id = users.id AND status = 'completado') AS purchases
    FROM users WHERE id = ? AND role = 'usuario' AND active = 1
  `).get(Number(req.params.id));
  if (!profile) return next();
  const viewer = req.user?.role === 'usuario' ? req.user.id : null;
  const blockedEither = viewer && viewer !== profile.id && isBlockedEither(viewer, profile.id);
  res.render('profile', {
    title: profile.store_name,
    profile,
    rating: ratingSummary(profile.id),
    reviews: reviewsAbout(profile.id),
    listings: blockedEither ? [] : sellerProducts(profile.id).filter((p) => p.status === 'disponible'),
    isMe: viewer === profile.id,
    iBlocked: viewer ? hasBlocked(viewer, profile.id) : false,
    blockedEither,
  });
});

router.post('/u/:id/bloquear', signedIn, (req, res) => {
  const id = Number(req.params.id);
  const exists = db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'usuario'").get(id);
  if (exists && id !== req.user.id) {
    block(req.user.id, id);
    flash(res, 'Bloqueaste a esta persona. Ya no pueden escribirse ni hacer tratos, y no verás sus artículos.');
  }
  res.redirect(backTo(req, `/u/${id}`));
});

router.post('/u/:id/desbloquear', signedIn, (req, res) => {
  unblock(req.user.id, Number(req.params.id));
  flash(res, 'Desbloqueado.');
  res.redirect(backTo(req, '/vendedor#bloqueados'));
});

router.get('/bloqueados', signedIn, (req, res) => {
  res.render('blocks', { title: 'Usuarios bloqueados', blocks: myBlocks(req.user.id) });
});

// ---------- Reseñas ----------

router.post('/resenas/:orderId', signedIn, (req, res, next) => {
  try {
    const order = createReview(Number(req.params.orderId), req.user.id, req.body);
    if (!order) return next();
    flash(res, '¡Gracias por tu reseña!');
    res.redirect(order.conversation_id ? `/mensajes/${order.conversation_id}` : '/vendedor');
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    flash(res, err.message);
    res.redirect(backTo(req, '/vendedor'));
  }
});

// ---------- Completar perfil (cuentas nuevas de Google/Facebook) ----------

router.get('/completar-perfil', signedIn, (req, res) => {
  res.render('complete-profile', { title: 'Completa tu perfil', errors: {}, form: req.user, next: safeNext(req.query.next, '/') });
});

router.post('/completar-perfil', signedIn, (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const province = PROVINCES.includes(req.body.province) ? req.body.province : null;
  const storeName = String(req.body.store_name ?? '').trim().slice(0, 80);
  const errors = {};
  if (!phone) errors.phone = 'Teléfono de 8 dígitos (ej. 8888-8888).';
  if (!province) errors.province = 'Elige una provincia.';
  if (storeName && findBlocked(storeName)) errors.store_name = blockedMessage(findBlocked(storeName));
  if (req.body.terms !== '1') errors.terms = 'Debes aceptar los términos y la política de privacidad.';
  const next = safeNext(req.body.next, '/');
  if (Object.keys(errors).length) {
    return res.status(400).render('complete-profile', { title: 'Completa tu perfil', errors, form: req.body, next });
  }
  db.prepare('UPDATE users SET phone = ?, province = ?, store_name = COALESCE(NULLIF(?, \'\'), store_name) WHERE id = ?')
    .run(phone, province, storeName, req.user.id);
  res.redirect(next);
});

export default router;
