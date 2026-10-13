import { Router } from 'express';
import crypto from 'node:crypto';
import { startSession } from '../auth.js';
import { UserError } from '../messages.js';
import { PROVIDERS, authorizeUrl, enabledProviders, fetchProfile, loginWithProvider, redirectUri } from '../oauth.js';
import { safeNext } from '../validate.js';
import { rateLimit } from '../rate-limit.js';

const router = Router();
const limit = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: 'Demasiados intentos de entrar. Espera 15 minutos.' });
const COOKIE = 'oauth_state';

function flash(res, message) {
  res.cookie('flash', message, { httpOnly: true, sameSite: 'lax', maxAge: 60_000 });
}

router.param('provider', (req, res, next, provider) => {
  if (!PROVIDERS[provider] || !enabledProviders().includes(provider)) return res.status(404).render('error', { title: 'No disponible', message: 'Ese medio de inicio de sesión no está activo.' });
  next();
});

// Envía a la persona a Google/Facebook con un "state" aleatorio que se guarda en una cookie
// para comprobar al regreso que la respuesta corresponde a esta misma solicitud.
router.get('/:provider', limit, (req, res) => {
  const state = crypto.randomBytes(24).toString('hex');
  const next = safeNext(req.query.next, '');
  res.cookie(COOKIE, JSON.stringify({ state, next, provider: req.params.provider }), {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 10 * 60 * 1000,
  });
  res.redirect(authorizeUrl(req.params.provider, state, redirectUri(req, req.params.provider)));
});

router.get('/:provider/callback', limit, async (req, res) => {
  const { provider } = req.params;
  let saved = {};
  try { saved = JSON.parse(req.cookies[COOKIE] || '{}'); } catch { /* cookie dañada: se trata como ausente */ }
  res.clearCookie(COOKIE);

  if (req.query.error) {
    flash(res, `Cancelaste el inicio de sesión con ${PROVIDERS[provider].label}.`);
    return res.redirect('/entrar');
  }
  const state = String(req.query.state || '');
  if (!saved.state || saved.provider !== provider || saved.state.length !== state.length
      || !crypto.timingSafeEqual(Buffer.from(saved.state), Buffer.from(state))) {
    flash(res, 'El inicio de sesión expiró o no es válido. Intenta de nuevo.');
    return res.redirect('/entrar');
  }

  try {
    const profile = await fetchProfile(provider, String(req.query.code || ''), redirectUri(req, provider));
    const { userId, isNew } = loginWithProvider(provider, profile);
    startSession(res, userId);
    const next = safeNext(saved.next, '/');
    // Las cuentas nuevas completan teléfono y provincia antes de seguir (lo pide el middleware de perfil).
    res.redirect(isNew ? `/completar-perfil?next=${encodeURIComponent(next)}` : next);
  } catch (err) {
    if (!(err instanceof UserError)) console.error(`Error de OAuth (${provider}):`, err.message);
    flash(res, err instanceof UserError ? err.message : `No pudimos conectar con ${PROVIDERS[provider].label}. Intenta de nuevo.`);
    res.redirect('/entrar');
  }
});

export default router;
