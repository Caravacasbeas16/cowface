import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadUser } from './auth.js';
import * as catalog from './catalog.js';
import publicRoutes from './routes/public.js';
import sellerRoutes, { UPLOAD_DIR } from './routes/seller.js';
import adminRoutes from './routes/admin.js';
import chatRoutes from './routes/chat.js';
import orderRoutes from './routes/orders.js';
import { unreadCount } from './messages.js';
import { DELIVERY_METHODS, OPEN_STATUSES, paymentConfig } from './orders.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
    });
    next();
  });
  app.use(express.static(path.join(ROOT, 'public'), { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
  app.use('/fotos', express.static(UPLOAD_DIR, { maxAge: '7d' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(cookieParser());
  app.use(loadUser);

  // Disponible en todas las vistas.
  app.locals.siteName = catalog.SITE_NAME;
  app.locals.catalog = catalog;
  app.locals.paymentConfig = paymentConfig;
  app.locals.DELIVERY_METHODS = DELIVERY_METHODS;
  app.locals.OPEN_STATUSES = OPEN_STATUSES;
  const contact = (process.env.CONTACT_EMAIL || '').trim();
  app.locals.contactEmail = /^[w.+-]+@[w-]+(.[w-]+)+$/.test(contact) ? contact : '';
  app.locals.legalUpdated = '12 de octubre de 2026';
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
  app.locals.imageUrl = (p, filename = p.image) => filename ? `/fotos/${filename}` : `/sin-foto/${p.category}/${p.id}.svg`;
  app.use((req, res, next) => {
    res.locals.path = req.path;
    // Aviso de una sola vez (lo deja una acción que redirige).
    res.locals.flash = typeof req.cookies.flash === 'string' ? req.cookies.flash.slice(0, 500) : null;
    if (res.locals.flash) res.clearCookie('flash');
    res.locals.unread = req.user?.role === 'usuario' ? unreadCount(req.user.id) : 0;
    next();
  });

  app.use('/', publicRoutes);
  app.use('/', chatRoutes);
  app.use('/pedidos', orderRoutes);
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
