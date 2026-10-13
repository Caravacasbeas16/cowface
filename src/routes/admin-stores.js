// Admin: crear la cuenta de una tienda y cargarle el inventario de una sola vez (CSV + fotos).
import { Router } from 'express';
import crypto from 'node:crypto';
import { requireRole, hashPassword } from '../auth.js';
import { db } from '../db.js';
import { CATEGORIES, DEPARTMENTS, PROVINCES, SITE_NAME } from '../catalog.js';
import { normalizePhone } from '../validate.js';
import { adminEmail } from '../admin-account.js';
import { createResetToken } from '../password-reset.js';
import { publicBaseUrl } from '../urls.js';
import { mailConfigured, sendMail } from '../mailer.js';
import { findBlocked } from '../moderation.js';
import { BULK_MAX_PHOTOS, bulkFiles, discardBulk } from '../uploads.js';
import { COLUMNS, MAX_ROWS, importRows, templateCsv } from '../bulk.js';
import { notifyMatches } from '../alerts.js';
import { ImageError } from '../images.js';

const router = Router();
router.use(requireRole('admin'));

const INVITE_HOURS = 72;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const formView = (form = {}, errors = {}) => ({ title: 'Crear tienda', form, errors, PROVINCES, mailReady: mailConfigured() });

router.get('/tiendas/nueva', (req, res) => res.render('admin/store-new', formView()));

router.post('/tiendas/nueva', async (req, res, next) => {
  const b = req.body;
  const data = {
    name: String(b.name ?? '').trim().slice(0, 80),
    store_name: String(b.store_name ?? '').trim().slice(0, 80),
    email: String(b.email ?? '').trim().toLowerCase().slice(0, 120),
    phone: normalizePhone(b.phone),
    province: PROVINCES.includes(b.province) ? b.province : '',
    payout_phone: normalizePhone(b.payout_phone || b.phone),
    payout_name: String(b.payout_name ?? '').trim().slice(0, 80),
  };
  const errors = {};
  if (data.name.length < 2) errors.name = 'Nombre de la persona encargada.';
  if (!EMAIL_RE.test(data.email)) errors.email = 'Correo válido de la tienda.';
  else if (data.email === adminEmail() || db.prepare('SELECT 1 FROM users WHERE email = ?').get(data.email)) errors.email = 'Ya existe una cuenta con ese correo.';
  if (!data.phone) errors.phone = 'Teléfono de 8 dígitos.';
  if (!data.province) errors.province = 'Elige la provincia.';
  if (b.payout_phone && !normalizePhone(b.payout_phone)) errors.payout_phone = 'SINPE Móvil de 8 dígitos.';
  const blocked = findBlocked(`${data.name}\n${data.store_name}`);
  if (blocked) errors.store_name = 'El nombre no puede tener teléfonos, redes ni enlaces.';
  if (Object.keys(errors).length) return res.status(400).render('admin/store-new', formView(b, errors));

  try {
    // Contraseña al azar que nadie conoce: la tienda crea la suya con el enlace de invitación.
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO users (role, name, store_name, email, phone, province, payout_phone, payout_name, password_hash)
      VALUES ('usuario', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(data.name, data.store_name || null, data.email, data.phone, data.province, data.payout_phone,
      data.payout_name || data.name, hashPassword(crypto.randomBytes(32).toString('base64url')));
    const id = Number(lastInsertRowid);
    const link = `${publicBaseUrl(req)}/restablecer/${createResetToken(id, INVITE_HOURS * 60)}`;
    let emailed = false;
    if (b.send_email === '1' && mailConfigured()) {
      const shop = data.store_name || data.name;
      emailed = await sendMail({
        to: data.email,
        subject: `Tu tienda ${shop} ya está en ${SITE_NAME}`,
        text: `Hola ${data.name}:\n\nCreamos la cuenta de ${shop} en ${SITE_NAME}. Para entrar, crea tu contraseña aquí (el enlace vence en ${INVITE_HOURS} horas):\n${link}\n\nDespués entra con ${data.email} y tu contraseña.\n\n${SITE_NAME}`,
        html: `<p>Hola ${esc(data.name)}:</p><p>Creamos la cuenta de <strong>${esc(shop)}</strong> en ${SITE_NAME}. Para entrar, crea tu contraseña (el enlace vence en ${INVITE_HOURS} horas):</p>`
          + `<p><a href="${link}" style="display:inline-block;background:#111;color:#fff;padding:.6rem 1rem;text-decoration:none;font-weight:700">Crear mi contraseña</a></p>`
          + `<p style="color:#666">Después entra con ${esc(data.email)} y tu contraseña.</p>`,
      });
    }
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.render('admin/store-created', { title: 'Tienda creada', store: { id, ...data }, link, hours: INVITE_HOURS, emailed });
  } catch (err) { next(err); }
});

const storeOf = (id) => db.prepare("SELECT id, name, COALESCE(store_name, name) AS store_name, email, payout_phone FROM users WHERE id = ? AND role = 'usuario'").get(id);

const bulkView = (store, extra = {}) => ({
  title: `Carga rápida · ${store.store_name}`, store, COLUMNS, CATEGORIES, DEPARTMENTS, maxPhotos: BULK_MAX_PHOTOS, maxRows: MAX_ROWS,
  results: null, error: null, ...extra,
});

router.get('/tiendas/:id/carga', (req, res, next) => {
  const store = storeOf(Number(req.params.id));
  if (!store) return next();
  res.render('admin/bulk', bulkView(store));
});

router.post('/tiendas/:id/carga', bulkFiles, async (req, res, next) => {
  const store = storeOf(Number(req.params.id));
  if (!store) { discardBulk(req); return next(); }
  try {
    if (req.bulk.error) throw new ImageError(req.bulk.error);
    const results = await importRows({ sellerId: store.id, csv: req.bulk.csv, photos: req.bulk.photos, publish: req.body.publish === '1' });
    const base = publicBaseUrl(req);
    for (const r of results) if (r.ok && r.status === 'disponible') notifyMatches(r.id, base);
    res.render('admin/bulk', bulkView(store, { results }));
  } catch (err) {
    if (!(err instanceof ImageError)) return next(err);
    res.status(400).render('admin/bulk', bulkView(store, { error: err.message }));
  } finally {
    discardBulk(req);
  }
});

router.get('/carga/plantilla.csv', (req, res) => {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="cowface-plantilla.csv"' });
  res.send(templateCsv());
});

export default router;
