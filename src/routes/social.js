// Favoritos (corazón en cada artículo), seguir tiendas y la pestaña "Siguiendo" (como Grailed).
import { Router } from 'express';
import { requireRole } from '../auth.js';
import { perUser, rateLimit } from '../rate-limit.js';
import { safeNext } from '../validate.js';
import {
  favoritesOf, follow, followedStores, followingFeed, toggleFavorite, unfollow,
} from '../social.js';

const router = Router();
const signedIn = requireRole('usuario');
const socialLimit = rateLimit({ windowMs: 60 * 1000, max: 60, key: perUser, message: 'Vas muy rápido. Espera un momento.' });
const wantsJson = (req) => (req.get('Accept') || '').includes('application/json');
const back = (req, fallback) => safeNext((req.get('Referer') || '').replace(/^https?:\/\/[^/]+/, ''), fallback);

// Guardar / quitar de favoritos. Con JS responde JSON y el corazón cambia sin recargar.
router.post('/p/:id/favorito', signedIn, socialLimit, (req, res, next) => {
  const saved = toggleFavorite(req.user.id, Number(req.params.id));
  if (saved === null) return wantsJson(req) ? res.status(404).json({ ok: false }) : next();
  if (wantsJson(req)) return res.json({ ok: true, saved });
  res.cookie('flash', saved ? 'Guardado en tus favoritos. Te avisamos si baja de precio.' : 'Quitado de tus favoritos.', { httpOnly: true, sameSite: 'lax', maxAge: 60_000 });
  res.redirect(back(req, `/p/${req.params.id}`));
});

router.get('/favoritos', signedIn, (req, res) => {
  res.render('favorites', { title: 'Favoritos', items: favoritesOf(req.user.id) });
});

router.post('/u/:id/seguir', signedIn, socialLimit, (req, res) => {
  const ok = follow(req.user.id, Number(req.params.id));
  if (wantsJson(req)) return res.json({ ok, following: ok });
  res.redirect(back(req, `/u/${req.params.id}`));
});

router.post('/u/:id/dejar-de-seguir', signedIn, socialLimit, (req, res) => {
  unfollow(req.user.id, Number(req.params.id));
  if (wantsJson(req)) return res.json({ ok: true, following: false });
  res.redirect(back(req, `/u/${req.params.id}`));
});

router.get('/siguiendo', signedIn, (req, res) => {
  res.render('following', { title: 'Siguiendo', stores: followedStores(req.user.id), items: followingFeed(req.user.id) });
});

export default router;
