// Activar y desactivar las notificaciones en este dispositivo, y mandar una de prueba.
import { Router } from 'express';
import { requireRole } from '../auth.js';
import { perUser, rateLimit } from '../rate-limit.js';
import { deviceCount, pushToUser, removeSubscription, saveSubscription, vapidPublicKey } from '../push.js';

const router = Router();
const limit = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, message: 'Demasiados intentos. Espera un rato.', key: perUser });

router.get('/clave', (req, res) => {
  res.set('Cache-Control', 'no-store').json({ key: vapidPublicKey() });
});

router.use(requireRole('usuario'));

router.post('/suscribir', limit, (req, res) => {
  const sub = { endpoint: req.body.endpoint, keys: { p256dh: req.body.p256dh, auth: req.body.auth } };
  if (!saveSubscription(req.user.id, sub, req.body.device)) return res.status(400).json({ error: 'Este navegador no se pudo registrar para notificaciones.' });
  res.json({ ok: true, devices: deviceCount(req.user.id) });
});

router.post('/quitar', (req, res) => {
  removeSubscription(req.user.id, req.body.endpoint);
  res.json({ ok: true, devices: deviceCount(req.user.id) });
});

router.post('/prueba', limit, (req, res) => {
  pushToUser(req.user.id, { title: 'CowFace', body: '¡Listo! Así te avisaremos cuando te escriban.', url: '/vendedor/configuracion#celular', tag: 'prueba' });
  res.json({ ok: true, devices: deviceCount(req.user.id) });
});

export default router;
