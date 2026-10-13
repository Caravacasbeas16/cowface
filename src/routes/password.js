import { Router } from 'express';
import { db } from '../db.js';
import { SITE_NAME } from '../catalog.js';
import { UserError } from '../messages.js';
import { mailConfigured, sendMail } from '../mailer.js';
import { EMAIL_LINK_MINUTES, PASSWORD_MAX, PASSWORD_MIN, createResetToken, findValidReset, resetPassword } from '../password-reset.js';
import { publicBaseUrl } from '../urls.js';
import { rateLimit } from '../rate-limit.js';

const router = Router();
const ipLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: 'Demasiadas solicitudes. Espera 15 minutos e intenta de nuevo.' });

// Máximo 3 correos por hora a la misma dirección, para que nadie la llene de correos.
const perEmail = new Map();
function emailAllowed(email) {
  const now = Date.now();
  const recent = (perEmail.get(email) || []).filter((t) => now - t < 3600e3);
  if (recent.length >= 3) return false;
  recent.push(now);
  perEmail.set(email, recent);
  if (perEmail.size > 10_000) perEmail.clear();
  return true;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Los enlaces llevan un token secreto: que no se filtre a otros sitios por el encabezado Referer.
function noReferrer(req, res, next) {
  res.set('Referrer-Policy', 'no-referrer');
  next();
}

router.get('/olvide', (req, res) => {
  res.render('forgot', { title: 'Recuperar contraseña', sent: false, email: '' });
});

router.post('/olvide', ipLimit, async (req, res, next) => {
  const email = String(req.body.email ?? '').trim().toLowerCase().slice(0, 120);
  try {
    // Misma respuesta exista o no la cuenta: así nadie averigua qué correos están registrados.
    const user = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      && db.prepare("SELECT id, name FROM users WHERE email = ? AND role = 'usuario' AND active = 1").get(email);
    const allowed = user && emailAllowed(email);
    if (user && !allowed) console.log('Recuperación: límite de 3 correos por hora para esa cuenta; no se envía.');
    if (allowed) {
      const link = `${publicBaseUrl(req)}/restablecer/${createResetToken(user.id)}`;
      await sendMail({
        to: email,
        subject: `Restablece tu contraseña de ${SITE_NAME}`,
        text: `Hola ${user.name}:\n\nPara crear una contraseña nueva abre este enlace (vence en ${EMAIL_LINK_MINUTES} minutos y sirve una sola vez):\n${link}\n\nSi no lo pediste, ignora este correo: tu contraseña no cambia.\n\n${SITE_NAME}`,
        html: `<p>Hola ${escapeHtml(user.name)}:</p><p>Para crear una contraseña nueva toca este botón. Vence en ${EMAIL_LINK_MINUTES} minutos y sirve una sola vez.</p>`
          + `<p><a href="${link}" style="display:inline-block;background:#111;color:#fff;padding:12px 20px;text-decoration:none;font-weight:bold">Crear contraseña nueva</a></p>`
          + `<p style="color:#666">Si no lo pediste, ignora este correo: tu contraseña no cambia.</p><p>${SITE_NAME}</p>`,
      }).catch((err) => console.error('No se pudo enviar el correo de recuperación:', err.message));
    }
    // Para diagnosticar en los registros de Railway por qué no llegó un correo (sin anotar la dirección).
    if (!user) console.log('Recuperación: el correo no corresponde a una cuenta normal activa; no se envía nada.');
    else if (!mailConfigured()) console.log('Recuperación: el envío de correos no está configurado (BREVO_API_KEY / MAIL_FROM).');
    res.render('forgot', { title: 'Recuperar contraseña', sent: true, email, mailReady: mailConfigured() });
  } catch (err) {
    next(err);
  }
});

router.get('/restablecer/:token', noReferrer, (req, res) => {
  const valid = Boolean(findValidReset(req.params.token));
  res.status(valid ? 200 : 410).render('reset', { title: 'Contraseña nueva', valid, token: req.params.token, error: null, PASSWORD_MIN, PASSWORD_MAX });
});

router.post('/restablecer/:token', noReferrer, ipLimit, (req, res) => {
  try {
    resetPassword(req.params.token, req.body.password, req.body.confirm);
    res.cookie('flash', 'Listo, tu contraseña cambió. Entra con la nueva.', { httpOnly: true, sameSite: 'lax', maxAge: 60_000 });
    res.redirect('/entrar');
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    const valid = Boolean(findValidReset(req.params.token));
    res.status(400).render('reset', { title: 'Contraseña nueva', valid, token: req.params.token, error: err.message, PASSWORD_MIN, PASSWORD_MAX });
  }
});

export default router;
