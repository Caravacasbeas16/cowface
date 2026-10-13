import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadUser } from './auth.js';
import * as catalog from './catalog.js';
import publicRoutes from './routes/public.js';
import sellerRoutes from './routes/seller.js';
import attachmentRoutes from './routes/attachments.js';
import { MAX_ATTACH_MB, MAX_IMAGES, MAX_PHOTO_MB } from './uploads.js';
import { UPLOAD_DIR } from './storage.js';
import adminRoutes from './routes/admin.js';
import chatRoutes from './routes/chat.js';
import orderRoutes from './routes/orders.js';
import oauthRoutes from './routes/oauth.js';
import profileRoutes from './routes/profile.js';
import passwordRoutes from './routes/password.js';
import { enabledProviders } from './oauth.js';
import { myReview, ratingSummary, reviewTarget } from './reviews.js';
import { unreadCount } from './messages.js';
import { DELIVERY_METHODS, OPEN_STATUSES, adminPendingCount, paymentConfig } from './orders.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  const production = process.env.NODE_ENV === 'production';
  // Encabezados de seguridad. La CSP solo permite scripts del propio sitio: aunque alguien lograra
  // colar HTML en un mensaje o descripción, el navegador no ejecutaría su código.
  const csp = [
    "default-src 'self'",
    // 'wasm-unsafe-eval' solo permite WebAssembly (lo usa pdf.js para leer PDF); no habilita eval de JS.
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    "style-src 'self' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    ...(production ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      ...(production ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    });
    next();
  });

  // Protección CSRF: los navegadores siempre mandan Origin en un POST desde otra página.
  // Si viene de otro sitio, se rechaza (p. ej. una página que intente confirmar un pago en /admin).
  const ownHosts = (req) => new Set([
    req.get('host'), req.get('x-forwarded-host'), process.env.RAILWAY_PUBLIC_DOMAIN,
    (() => { try { return new URL(process.env.PUBLIC_URL).host; } catch { return null; } })(),
  ].filter(Boolean).map((h) => h.toLowerCase()));
  const hostOf = (url) => { try { return new URL(url).host.toLowerCase(); } catch { return null; } };
  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const source = req.get('origin') || req.get('referer');
    if (source && !ownHosts(req).has(hostOf(source))) {
      return res.status(403).type('text').send('Solicitud bloqueada: viene de otro sitio.');
    }
    next();
  });
  app.use(express.static(path.join(ROOT, 'public'), { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
  // Fotos de artículos: nombres aleatorios que nunca cambian, así que se guardan en caché un año.
  // La carpeta temporal de subidas no se sirve.
  app.use('/fotos/tmp', (req, res) => res.status(404).end());
  app.use('/fotos', express.static(UPLOAD_DIR, { maxAge: '365d', immutable: true, index: false }));
  // pdf.js (para importar fotos desde un PDF) servido desde el propio sitio: solo las carpetas que usa.
  const PDFJS = path.join(ROOT, 'node_modules', 'pdfjs-dist');
  for (const dir of ['build', 'wasm', 'cmaps', 'standard_fonts', 'iccs']) {
    app.use(`/vendor/pdfjs/${dir}`, express.static(path.join(PDFJS, dir), { maxAge: production ? '7d' : 0, index: false }));
  }
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(cookieParser());
  app.use(loadUser);

  // Disponible en todas las vistas.
  app.locals.siteName = catalog.SITE_NAME;
  app.locals.catalog = catalog;
  app.locals.paymentConfig = paymentConfig;
  app.locals.maxImages = MAX_IMAGES;
  app.locals.maxPhotoMb = MAX_PHOTO_MB;
  app.locals.maxAttachMb = MAX_ATTACH_MB;
  app.locals.enabledProviders = enabledProviders;
  app.locals.reviewTarget = reviewTarget;
  app.locals.myReview = myReview;
  app.locals.ratingSummary = ratingSummary;
  // ★★★★☆ para un promedio o calificación.
  app.locals.stars = (n) => { const r = Math.round(Number(n) || 0); return '★'.repeat(r) + '☆'.repeat(5 - r); };
  app.locals.DELIVERY_METHODS = DELIVERY_METHODS;
  app.locals.OPEN_STATUSES = OPEN_STATUSES;
  const contact = (process.env.CONTACT_EMAIL || '').trim();
  app.locals.contactEmail = /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(contact) ? contact : '';
  if (contact && !app.locals.contactEmail) console.warn('Aviso: CONTACT_EMAIL tiene un valor que no parece un correo; no se mostrará.');
  app.locals.legalUpdated = '12 de octubre de 2026';
  // "hace 5 min", "hace 3 h", "hace 2 d", como en Grailed.
  app.locals.timeAgo = (value) => {
    const v = String(value || '');
    const d = new Date(v.includes('T') ? v : v.replace(' ', 'T') + 'Z');
    const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
    if (Number.isNaN(mins)) return '';
    if (mins < 1) return 'ahora';
    if (mins < 60) return `hace ${mins} min`;
    if (mins < 60 * 24) return `hace ${Math.round(mins / 60)} h`;
    if (mins < 60 * 24 * 30) return `hace ${Math.round(mins / 1440)} d`;
    return d.toLocaleDateString('es-CR', { day: 'numeric', month: 'short', timeZone: 'America/Costa_Rica' });
  };
  // Fecha/hora en hora de Costa Rica. Acepta ISO o el formato de SQLite (UTC sin zona).
  app.locals.when = (value, withDate = false) => {
    const s = String(value || '');
    const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
    if (Number.isNaN(d.getTime())) return '';
    const sameDay = d.toDateString() === new Date().toDateString();
    return d.toLocaleString('es-CR', {
      timeZone: 'America/Costa_Rica', hour: 'numeric', minute: '2-digit',
      ...(withDate || !sameDay ? { day: 'numeric', month: 'short' } : {}),
    });
  };
  app.locals.money = catalog.formatColones;
  app.locals.imageUrl = (p, filename = p.image) => filename ? `/fotos/${filename}` : `/sin-foto/${p.category}/${p.id}.svg?v=2`;
  app.use((req, res, next) => {
    res.locals.path = req.path;
    // Aviso de una sola vez (lo deja una acción que redirige).
    res.locals.flash = typeof req.cookies.flash === 'string' ? req.cookies.flash.slice(0, 500) : null;
    if (res.locals.flash) res.clearCookie('flash');
    res.locals.unread = req.user?.role === 'usuario' ? unreadCount(req.user.id) : 0;
    res.locals.adminPending = req.user?.role === 'admin' ? adminPendingCount() : 0;
    next();
  });

  // Las cuentas creadas con Google/Facebook completan teléfono y provincia antes de usar el sitio.
  const PROFILE_FREE = /^\/(completar-perfil|salir|terminos|privacidad|salud|sin-foto|auth)(\/|$)/;
  app.use((req, res, next) => {
    const u = req.user;
    if (u?.role === 'usuario' && (!u.phone || !u.province) && !PROFILE_FREE.test(req.path)) {
      return res.redirect(`/completar-perfil?next=${encodeURIComponent(req.method === 'GET' ? req.originalUrl : '/')}`);
    }
    next();
  });

  app.use('/', publicRoutes);
  app.use('/auth', oauthRoutes);
  app.use('/', profileRoutes);
  app.use('/', passwordRoutes);
  app.use('/', chatRoutes);
  app.use('/pedidos', orderRoutes);
  app.use('/adjuntos', attachmentRoutes);
  app.use('/vendedor', sellerRoutes);
  app.use('/admin', adminRoutes);

  app.use((req, res) => {
    res.status(404).render('error', { title: 'No encontrado', message: 'Esta página no existe o el artículo ya no está publicado.' });
  });
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('error', { title: 'Error', message: 'Algo salió mal. Intenta de nuevo.' });
  });
  return app;
}
