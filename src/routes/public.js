import { Router } from 'express';
import { db, commissionRate } from '../db.js';
import { favoriteCount, isFavorite } from '../social.js';
import { endSession, hashPassword, startSession, verifyPassword } from '../auth.js';
import { CATEGORIES, CONDITIONS, DEPARTMENTS, formatColones } from '../catalog.js';
import { canonicalQuery, describe, saveSearch } from '../alerts.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { categoryCovers, countByCategory, countView, getProduct, moreFromStore, similarProducts, latestProducts, parseFilters, searchProducts, searchSuggestions } from '../products.js';
import { findConversation, minOffer } from '../chat.js';
import { isBlockedEither } from '../blocks.js';
import { paymentConfig, paymentsReady } from '../orders.js';
import { enabledProviders } from '../oauth.js';
import { ratingSummary, reviewsAbout, salesSummary } from '../reviews.js';
import { safeNext, validateSignup } from '../validate.js';
import { clientKey, rateLimit } from '../rate-limit.js';
import { adminEmail } from '../admin-account.js';
import { mailProvider } from '../mailer.js';
import { notifyAdmin } from '../admin-notify.js';
import { pickupPointsOf } from '../pickup.js';
import { untilLabel } from '../promos.js';
import { REPORT_REASONS, createReport } from '../reports.js';
import { UserError } from '../messages.js';
import { presenceOf, replyTime } from '../presence.js';
import { storeHoursInfo } from '../store-hours.js';

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
// Además del límite por conexión: 10 contraseñas fallidas por hora para un mismo correo desde la misma
// conexión (bloqueo). Por correo en total no se bloquea —así nadie puede dejar al admin sin poder
// entrar a propósito—, pero después de 20 fallos en una hora cada intento espera unos segundos, para
// que adivinar la contraseña repartiendo intentos entre muchas IP sea lentísimo.
const loginPerEmail = rateLimit({ windowMs: 60 * MIN, max: 10, message: 'Demasiados intentos para esta cuenta. Espera una hora o recupera tu contraseña.', key: () => null });
const loginPerEmailAll = rateLimit({ windowMs: 60 * MIN, max: 20, message: '', key: () => null });
const LOGIN_SLOWDOWN_MS = 3000;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
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
    envioCorreo: mailProvider() || 'sin configurar',
    volumen: Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH),
  });
});

router.get('/terminos', (req, res) => res.render('terms', {
  title: 'Términos de uso', ratePercent: +(commissionRate() * 100).toFixed(2), pay: paymentConfig(),
}));
router.get('/privacidad', (req, res) => res.render('privacy', { title: 'Política de privacidad' }));
router.get('/como-funciona', (req, res) => res.render('how-it-works', {
  title: 'Cómo funciona la compra protegida', ratePercent: +(commissionRate() * 100).toFixed(2), pay: paymentConfig(),
}));

router.get('/', (req, res) => {
  res.render('home', {
    title: null, latest: latestProducts(15, req.user?.id), counts: countByCategory(), covers: categoryCovers(), brandPhotos,
    commissionRateNow: commissionRate(),
  });
});

// Sugerencias mientras se escribe (JSON para la barra de búsqueda).
const suggestLimit = rateLimit({ windowMs: MIN, max: 120, message: 'Demasiadas búsquedas seguidas.' });
// Reportar un artículo, una cuenta o una conversación (hay que tener sesión).
const reportLimit = rateLimit({ windowMs: 60 * MIN, max: 20, message: 'Enviaste muchos reportes seguidos. Intenta más tarde.' });
router.post('/reportar', reportLimit, (req, res, next) => {
  const back = safeNext(req.body.back, '/');
  if (!req.user || req.user.role !== 'usuario') return res.redirect(`/entrar?next=${encodeURIComponent(back)}`);
  try {
    const id = createReport(req.user, req.body.type, req.body.id, req.body.reason, req.body.details);
    if (!id) return next();
    res.cookie('flash', 'Gracias por avisar. CowFace revisa el reporte y toma acción si hace falta; tu nombre no se le muestra a la persona reportada.', { httpOnly: true, sameSite: 'lax', maxAge: 60_000 });
  } catch (err) {
    if (!(err instanceof UserError)) return next(err);
    res.cookie('flash', err.message, { httpOnly: true, sameSite: 'lax', maxAge: 60_000 });
  }
  res.redirect(back);
});

// Para Google Play / App Store: cómo borrar la cuenta y qué datos se borran (pública, sin sesión).
router.get('/borrar-cuenta', (req, res) => res.render('delete-info', { title: 'Borrar tu cuenta' }));

// Cómo instalar CowFace como app (para compartir en Instagram y para iPhone, que no tiene botón).
router.get('/instalar', (req, res) => {
  res.render('install', { title: 'Instalar la app', og: { title: 'Instala CowFace en tu celular', description: 'Ten CowFace como una app: pantalla completa, más rápido y con avisos cuando te escriben.' } });
});

router.get('/buscar/sugerencias', suggestLimit, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(searchSuggestions(String(req.query.q ?? '').slice(0, 60)));
});

router.get('/buscar', (req, res) => {
  const filters = parseFilters(req.query, req.user?.id);
  const result = searchProducts(filters);
  // Para paginación, orden y avisos: solo los filtros válidos (sin "pagina" ni restos de otra
  // categoría, como una talla de ropa después de cambiar a zapatos).
  const params = new URLSearchParams(canonicalQuery(req.query));
  if (filters.sort !== 'recientes') params.set('orden', filters.sort);
  // Filtros activos como etiquetas que se pueden quitar: [{ label, href sin ese filtro }].
  const without = (key, value) => {
    const p = new URLSearchParams(params);
    if (value === undefined) p.delete(key);
    else { const keep = p.getAll(key).filter((v) => v !== value); p.delete(key); keep.forEach((v) => p.append(key, v)); }
    return `/buscar${p.toString() ? `?${p}` : ''}`;
  };
  const chips = [];
  if (filters.q) chips.push({ label: `"${filters.q}"`, href: without('q') });
  if (filters.category) chips.push({ label: CATEGORIES[filters.category].label, href: without('categoria') });
  if (filters.item_type) chips.push({ label: filters.item_type, href: without('tipo') });
  if (filters.department) chips.push({ label: DEPARTMENTS[filters.department], href: without('para') });
  for (const s of filters.sizes) chips.push({ label: `Talla ${s}`, href: without('talla', s) });
  if (filters.condition) chips.push({ label: filters.condition === 'nuevo' ? 'Solo nuevo' : 'Solo usado', href: without('estado') });
  if (filters.province) chips.push({ label: filters.province, href: without('provincia') });
  if (filters.min) chips.push({ label: `Desde ${formatColones(filters.min)}`, href: without('min') });
  if (filters.max) chips.push({ label: `Hasta ${formatColones(filters.max)}`, href: without('max') });
  if (filters.onSale) chips.push({ label: 'En oferta', href: without('oferta') });
  res.render('search', {
    title: 'Buscar', filters, ...result, baseQuery: params.toString(), chips,
    alertLabel: describe(canonicalQuery(req.query)), counts: result.total ? null : countByCategory(),
  });
});

// "Avísame cuando haya…": guarda la búsqueda actual para recibir un correo con lo nuevo.
router.post('/avisos', (req, res) => {
  const query = String(req.body.query ?? '').slice(0, 500);
  if (!req.user || req.user.role !== 'usuario') return res.redirect(`/entrar?next=${encodeURIComponent(`/buscar?${query}`)}`);
  const obj = {};
  for (const [k, v] of new URLSearchParams(query)) obj[k] = k === 'talla' ? [...(obj[k] || []), v] : v;
  const result = saveSearch(req.user.id, obj);
  res.cookie('flash', result.message, { httpOnly: true, sameSite: 'lax', maxAge: 60_000 });
  res.redirect(`/buscar?${query}`);
});

router.get('/p/:id', (req, res, next) => {
  const product = getProduct(Number(req.params.id));
  if (!product || !product.seller_active) return next();
  const isOwner = req.user?.id === product.seller_id;
  if (product.status === 'borrador' && !isOwner) return next(); // los borradores solo los ve su dueño
  const conversationId = req.user && !isOwner ? findConversation(product.id, req.user.id) : null;
  // Talla que ya eligió en su conversación (artículos con varias tallas).
  const chosen = conversationId && product.has_sizes ? db.prepare('SELECT chosen_size FROM conversations WHERE id = ?').get(conversationId)?.chosen_size : null;
  const blocked = Boolean(req.user && !isOwner && isBlockedEither(req.user.id, product.seller_id));
  if (!isOwner && req.user?.role !== 'admin') countView(product.id, req.user ? `u${req.user.id}` : req.ip);
  const cover = product.images[0];
  const og = {
    type: 'product', path: `/p/${product.id}`, price: product.price,
    title: `${product.title} · ${formatColones(product.price)}`,
    description: [
      product.status === 'vendido' ? 'Vendido' : null, product.brand, product.size && `Talla ${product.size}`,
      CONDITIONS[product.condition], product.province,
    ].filter(Boolean).join(' · ') + `. Compra protegida en CowFace: pagas a CowFace y le pagamos al vendedor cuando lo recibes.`,
    image: cover ? `/fotos/${cover.thumb || cover.filename}` : undefined, imageAlt: product.title,
  };
  res.render('product', {
    og, title: product.title, product, isOwner, conversationId, chosen,
    favCount: favoriteCount(product.id), isFav: req.user ? isFavorite(req.user.id, product.id) : false,
    similar: blocked ? [] : similarProducts(product, req.user?.role === 'usuario' ? req.user.id : null),
    moreFromStore: blocked ? [] : moreFromStore(product), minOffer: minOffer(product.price), blocked,
    sellerRating: ratingSummary(product.seller_id), sellerSales: salesSummary(product.seller_id), pickupPoints: pickupPointsOf(product.seller_id),
    sellerReviews: reviewsAbout(product.seller_id, 10).filter((r) => r.role === 'vendedor' && r.comment).slice(0, 3),
    untilLabel,
    sellerPresence: presenceOf(product.seller_id), sellerReply: replyTime(product.seller_id), sellerHours: storeHoursInfo(product.seller_id).status, justPublished: isOwner && req.query.publicado === '1',
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
  notifyAdmin('registro', `Cuenta nueva: ${data.store_name || data.name}`,
    `${data.name}${data.store_name ? ` (tienda ${data.store_name})` : ''} se registró con ${data.email} · ${data.province}.`, '/admin#usuarios');
  res.redirect(safeNext(req.body.next, '/'));
});

router.get('/entrar', (req, res) => {
  res.render('login', { title: 'Entrar', error: null, email: '', next: safeNext(req.query.next, '') });
});

router.post('/entrar', loginLimit, async (req, res) => {
  const email = String(req.body.email ?? '').trim().toLowerCase().slice(0, 120);
  const password = String(req.body.password ?? '').slice(0, 200);
  const fail = (status, error) => res.status(status).render('login', { title: 'Entrar', error, email, next: safeNext(req.body.next, '') });
  const fromHere = `${email}|${clientKey(req.ip)}`;
  if (loginPerEmail.blocked(fromHere)) {
    return fail(429, 'Demasiados intentos para esta cuenta. Espera una hora o usa “¿Olvidaste tu contraseña?”.');
  }
  if (loginPerEmailAll.blocked(email)) await sleep(LOGIN_SLOWDOWN_MS);
  const user = db.prepare('SELECT id, role, password_hash, active FROM users WHERE email = ?').get(email);
  const passwordOk = verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !user.active || !passwordOk) {
    loginPerEmail.hit(fromHere);
    loginPerEmailAll.hit(email);
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
