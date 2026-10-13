import { Router } from 'express';
import { db, commissionRate } from '../db.js';
import { endSession, hashPassword, startSession, verifyPassword } from '../auth.js';
import { CATEGORIES } from '../catalog.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { categoryCovers, countByCategory, getProduct, latestProducts, parseFilters, searchProducts } from '../products.js';
import { findConversation, minOffer } from '../chat.js';
import { isBlockedEither } from '../blocks.js';
import { paymentsReady } from '../orders.js';
import { enabledProviders } from '../oauth.js';
import { ratingSummary } from '../reviews.js';
import { safeNext, validateSignup } from '../validate.js';
import { rateLimit } from '../rate-limit.js';
import { adminEmail } from '../admin-account.js';

const router = Router();

// Fotos de marca para la portada: cualquier .jpg/.png/.webp en public/img/brand, en orden alfabético.
const BRAND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/img/brand');
const brandPhotos = (() => {
  try {
    return fs.readdirSync(BRAND_DIR).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort().map((f) => `/img/brand/${f}`);
  } catch {
    return [];
  }
})();

const MIN = 60 * 1000;
const loginLimit = rateLimit({ windowMs: 15 * MIN, max: 10, message: 'Demasiados intentos de entrar. Espera 15 minutos.' });
// Además del límite por conexión: 10 contraseñas fallidas por hora para un mismo correo,
// así no se puede adivinar la del admin (u otra) repartiendo intentos entre muchas IP.
const loginPerEmail = rateLimit({ windowMs: 60 * MIN, max: 10, message: 'Demasiados intentos para esta cuenta. Espera una hora o recupera tu contraseña.', key: () => null });
// Hash de relleno: si el correo no existe se verifica igual, para que el tiempo de respuesta no lo delate.
const DUMMY_HASH = hashPassword('contraseña-de-relleno');
const signupLimit = rateLimit({ windowMs: 60 * MIN, max: 5, message: 'Demasiados registros desde esta conexión. Intenta en una hora.' });

// Railway la usa para saber si el sitio está vivo.
router.get('/salud', (req, res) => {
  db.prepare('SELECT 1').get();
  if (req.query.detalle !== '1' || req.user?.role !== 'admin') return res.type('text').send('ok');
  // Diagnóstico para el admin: qué versión corre y qué configuración está presente.
  const rawContact = process.env.CONTACT_EMAIL;
  res.json({
    ok: true,
    version: (process.env.RAILWAY_GIT_COMMIT_SHA || 'local').slice(0, 7),
    modo: process.env.NODE_ENV || 'desarrollo',
    correoContacto: rawContact == null ? 'falta' : req.app.locals.contactEmail ? 'ok' : 'valor inválido',
    cobroConfigurado: paymentsReady(),
    accesoSocial: enabledProviders(),
    volumen: Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH),
  });
});

router.get('/terminos', (req, res) => res.render('terms', { title: 'Términos de uso', ratePercent: +(commissionRate() * 100).toFixed(2) }));
router.get('/privacidad', (req, res) => res.render('privacy', { title: 'Política de privacidad' }));

router.get('/', (req, res) => {
  res.render('home', {
    title: null, latest: latestProducts(15, req.user?.id), counts: countByCategory(), covers: categoryCovers(), brandPhotos,
    commissionRateNow: commissionRate(),
  });
});

router.get('/buscar', (req, res) => {
  const filters = parseFilters(req.query, req.user?.id);
  const result = searchProducts(filters);
  // Para los enlaces de paginación: la URL actual sin "pagina".
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (k === 'pagina') continue;
    for (const item of [v].flat()) if (typeof item === 'string' && item) params.append(k, item);
  }
  res.render('search', { title: 'Buscar', filters, ...result, baseQuery: params.toString() });
});

router.get('/p/:id', (req, res, next) => {
  const product = getProduct(Number(req.params.id));
  if (!product || !product.seller_active) return next();
  const isOwner = req.user?.id === product.seller_id;
  const conversationId = req.user && !isOwner ? findConversation(product.id, req.user.id) : null;
  const blocked = Boolean(req.user && !isOwner && isBlockedEither(req.user.id, product.seller_id));
  res.render('product', {
    title: product.title, product, isOwner, conversationId, minOffer: minOffer(product.price), blocked,
    sellerRating: ratingSummary(product.seller_id),
  });
});

// ---------- Cuentas (una sola para comprar y vender) ----------

router.get('/vender', (req, res) => res.redirect(req.user ? '/vendedor/productos/nuevo' : '/registro?next=/vendedor/productos/nuevo'));

router.get('/registro', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('register', { title: 'Crear cuenta', errors: {}, form: {}, next: safeNext(req.query.next, '') });
});

router.post('/registro', signupLimit, (req, res) => {
  const { data, errors } = validateSignup(req.body);
  if (!errors.email && (data.email === adminEmail() || db.prepare('SELECT 1 FROM users WHERE email = ?').get(data.email))) {
    errors.email = 'Ya existe una cuenta con ese correo. Inicia sesión o recupera tu contraseña.';
  }
  if (Object.keys(errors).length) {
    return res.status(400).render('register', {
      title: 'Crear cuenta', errors, form: { ...req.body, password: '' }, next: safeNext(req.body.next, ''),
    });
  }
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO users (role, name, store_name, email, phone, province, password_hash) VALUES ('usuario', ?, ?, ?, ?, ?, ?)
  `).run(data.name, data.store_name || null, data.email, data.phone, data.province, hashPassword(data.password));
  startSession(res, Number(lastInsertRowid));
  res.redirect(safeNext(req.body.next, '/'));
});

router.get('/entrar', (req, res) => {
  res.render('login', { title: 'Entrar', error: null, email: '', next: safeNext(req.query.next, '') });
});

router.post('/entrar', loginLimit, (req, res) => {
  const email = String(req.body.email ?? '').trim().toLowerCase().slice(0, 120);
  const password = String(req.body.password ?? '').slice(0, 200);
  const fail = (status, error) => res.status(status).render('login', { title: 'Entrar', error, email, next: safeNext(req.body.next, '') });
  if (loginPerEmail.blocked(email)) {
    return fail(429, 'Demasiados intentos para esta cuenta. Espera una hora o usa “¿Olvidaste tu contraseña?”.');
  }
  const user = db.prepare('SELECT id, role, password_hash, active FROM users WHERE email = ?').get(email);
  const passwordOk = verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !user.active || !passwordOk) {
    loginPerEmail.hit(email);
    return fail(401, 'Correo o contraseña incorrectos.');
  }
  startSession(res, user.id);
  res.redirect(safeNext(req.body.next, user.role === 'admin' ? '/admin' : '/'));
});

router.post('/salir', (req, res) => {
  endSession(req, res);
  res.redirect('/');
});

// Imagen de relleno para artículos sin foto: neutra, con el nombre de la categoría.
router.get('/sin-foto/:category/:id.svg', (req, res) => {
  const label = (CATEGORIES[req.params.category]?.label || 'Artículo').toUpperCase();
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500">' +
    '<rect width="500" height="500" fill="#f1efeb"/>' +
    '<text x="250" y="238" font-family="Inter,Arial,sans-serif" font-weight="900" font-size="38" letter-spacing="-1" fill="#c9c5bd" text-anchor="middle">COWFACE</text>' +
    `<text x="250" y="282" font-family="Inter,Arial,sans-serif" font-weight="700" font-size="16" letter-spacing="3" fill="#b3aea4" text-anchor="middle">${label} · SIN FOTO</text>` +
    '</svg>',
  );
});

export default router;
