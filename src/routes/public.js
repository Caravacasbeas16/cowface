import { Router } from 'express';
import { db, commissionRate } from '../db.js';
import { endSession, hashPassword, startSession, verifyPassword } from '../auth.js';
import { CATEGORIES } from '../catalog.js';
import { countByCategory, getProduct, latestProducts, parseFilters, searchProducts } from '../products.js';
import { findConversation, minOffer } from '../chat.js';
import { safeNext, validateSignup } from '../validate.js';
import { rateLimit } from '../rate-limit.js';

const router = Router();

const MIN = 60 * 1000;
const loginLimit = rateLimit({ windowMs: 15 * MIN, max: 10, message: 'Demasiados intentos de entrar. Espera 15 minutos.' });
const signupLimit = rateLimit({ windowMs: 60 * MIN, max: 5, message: 'Demasiados registros desde esta conexión. Intenta en una hora.' });

// Railway la usa para saber si el sitio está vivo.
router.get('/salud', (req, res) => {
  db.prepare('SELECT 1').get();
  res.type('text').send('ok');
});

router.get('/terminos', (req, res) => res.render('terms', { title: 'Términos de uso', ratePercent: +(commissionRate() * 100).toFixed(2) }));
router.get('/privacidad', (req, res) => res.render('privacy', { title: 'Política de privacidad' }));

router.get('/', (req, res) => {
  res.render('home', { title: null, latest: latestProducts(12), counts: countByCategory(), commissionRateNow: commissionRate() });
});

router.get('/buscar', (req, res) => {
  const filters = parseFilters(req.query);
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
  res.render('product', { title: product.title, product, isOwner, conversationId, minOffer: minOffer(product.price) });
});

// ---------- Cuentas (una sola para comprar y vender) ----------

router.get('/vender', (req, res) => res.redirect(req.user ? '/vendedor/productos/nuevo' : '/registro?next=/vendedor/productos/nuevo'));

router.get('/registro', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('register', { title: 'Crear cuenta', errors: {}, form: {}, next: safeNext(req.query.next, '') });
});

router.post('/registro', signupLimit, (req, res) => {
  const { data, errors } = validateSignup(req.body);
  if (!errors.email && db.prepare('SELECT 1 FROM users WHERE email = ?').get(data.email)) {
    errors.email = 'Ya existe una cuenta con ese correo. Inicia sesión.';
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
  const user = db.prepare('SELECT id, role, password_hash, active FROM users WHERE email = ?').get(email);
  const ok = user && user.active && verifyPassword(String(req.body.password ?? ''), user.password_hash);
  if (!ok) {
    return res.status(401).render('login', {
      title: 'Entrar', error: 'Correo o contraseña incorrectos.', email, next: safeNext(req.body.next, ''),
    });
  }
  startSession(res, user.id);
  res.redirect(safeNext(req.body.next, user.role === 'admin' ? '/admin' : '/'));
});

router.post('/salir', (req, res) => {
  endSession(req, res);
  res.redirect('/');
});

// Imagen de relleno para artículos sin foto: color estable según el id.
router.get('/sin-foto/:category/:id.svg', (req, res) => {
  const id = Number.parseInt(req.params.id, 10) || 0;
  const hue = (id * 47) % 360;
  const label = CATEGORIES[req.params.category]?.label || 'Artículo';
  const icon = { ropa: '👕', zapatos: '👟', bolsos: '👜', accesorios: '🧢' }[req.params.category] || '🛍️';
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500">` +
    `<rect width="400" height="500" fill="hsl(${hue},45%,88%)"/>` +
    `<text x="200" y="250" font-size="120" text-anchor="middle" dominant-baseline="middle">${icon}</text>` +
    `<text x="200" y="370" font-size="26" font-family="system-ui,sans-serif" fill="hsl(${hue},35%,30%)" text-anchor="middle">${label}</text>` +
    `</svg>`,
  );
});

export default router;
