// Del lado de la tienda (o cualquier persona): su chat directo con CowFace, en /mensajes/cowface.
import { Router } from 'express';
import { requireRole } from '../auth.js';
import { UserError, unreadCount } from '../messages.js';
import { notify } from '../realtime.js';
import { perUser, rateLimit } from '../rate-limit.js';
import { MAX_SUPPORT_TEXT, markSupportRead, supportThread, userWrites } from '../support.js';

const router = Router();
const signedIn = requireRole('usuario');
const limit = rateLimit({ windowMs: 60 * 1000, max: 20, key: perUser, message: 'Estás enviando mensajes muy rápido. Espera un momento.' });

router.get('/mensajes/cowface', signedIn, (req, res) => {
  markSupportRead(req.user.id, 'usuario');
  res.locals.unread = unreadCount(req.user.id);
  notify([req.user.id], 'no-leidos', { count: res.locals.unread });
  res.render('chat/support', { title: 'CowFace · Equipo oficial', messages: supportThread(req.user.id), max: MAX_SUPPORT_TEXT });
});

router.post('/mensajes/cowface', signedIn, limit, (req, res) => {
  try {
    userWrites(req.user, req.body.body);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    res.cookie('flash', err.message, { httpOnly: true, sameSite: 'lax', maxAge: 60_000 });
  }
  res.redirect('/mensajes/cowface#fin');
});

export default router;
