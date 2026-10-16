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
import {
  StoreLimitError, approve, limitMessage, reject, revoke, setApprovalRequired, setStoreLimit, storesFull,
} from '../approval.js';
import { adminBack } from '../admin-panel.js';

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
  if (!errors.email && storesFull()) errors.email = limitMessage();
  if (Object.keys(errors).length) return res.status(400).render('admin/store-new', formView(b, errors));

  try {
    // Contraseña al azar que nadie conoce: la tienda crea la suya con el enlace de invitación.
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO users (role, name, store_name, email, phone, province, payout_phone, payout_name, password_hash, seller_status)
      VALUES ('usuario', ?, ?, ?, ?, ?, ?, ?, ?, 'aprobado')
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
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin' });
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

// Historial de antes de CowFace: ventas y reseñas que la tienda ya tenía (por ejemplo en Instagram).
// Se suman a las de la plataforma, que se van agregando solas, y el perfil aclara cuánto es previo.
const historyOf = (id) => db.prepare(`
  SELECT id, COALESCE(store_name, name) AS store_name, sales_base, reviews_base_count, reviews_base_avg, history_source,
    (SELECT COUNT(*) FROM orders WHERE seller_id = users.id AND status = 'completado') AS platform_sales,
    (SELECT COUNT(*) FROM reviews WHERE subject_id = users.id) AS platform_reviews
  FROM users WHERE id = ? AND role = 'usuario'
`).get(id);

router.get('/tiendas/:id/historial', (req, res, next) => {
  const store = historyOf(Number(req.params.id));
  if (!store) return next();
  res.render('admin/store-history', { title: `Historial · ${store.store_name}`, store, form: store, errors: {} });
});

router.post('/tiendas/:id/historial', (req, res, next) => {
  const store = historyOf(Number(req.params.id));
  if (!store) return next();
  const int = (v) => (String(v ?? '').trim() === '' ? 0 : Number(String(v).replace(/[.,\s]/g, '')));
  const data = {
    sales: int(req.body.sales_base),
    count: int(req.body.reviews_base_count),
    avg: Number(String(req.body.reviews_base_avg ?? '').replace(',', '.')) || 0,
    source: String(req.body.history_source ?? '').trim().slice(0, 40),
  };
  const errors = {};
  if (!Number.isInteger(data.sales) || data.sales < 0 || data.sales > 100_000) errors.sales_base = 'Un número entero de 0 a 100 000.';
  if (!Number.isInteger(data.count) || data.count < 0 || data.count > 100_000) errors.reviews_base_count = 'Un número entero de 0 a 100 000.';
  if (data.count > 0 && !(data.avg >= 1 && data.avg <= 5)) errors.reviews_base_avg = 'Promedio de 1 a 5 (ej. 4.8).';
  // Lo escribe el admin: puede decir "Instagram" (que el filtro del chat bloquea), pero sin enlaces ni @usuarios.
  if (!/^[\p{L}\p{N} .,&'()-]*$/u.test(data.source) || /https?|www\.|\.(com|cr|net|org)\b/i.test(data.source)) {
    errors.history_source = 'Solo el nombre del lugar (ej. Instagram), sin enlaces ni usuarios.';
  }
  if (Object.keys(errors).length) {
    return res.status(400).render('admin/store-history', { title: `Historial · ${store.store_name}`, store, form: req.body, errors });
  }
  db.prepare('UPDATE users SET sales_base = ?, reviews_base_count = ?, reviews_base_avg = ?, history_source = ? WHERE id = ?')
    .run(data.sales, data.count, data.count ? Math.round(data.avg * 10) / 10 : 0, data.source, store.id);
  res.cookie('flash', `Historial de ${store.store_name} guardado.`, { httpOnly: true, sameSite: 'lax', maxAge: 60_000 });
  res.redirect('/admin#usuarios');
});

// ---------- Aprobación de tiendas ----------
const flashTo = (res, message, anchor, req = null) => {
  res.cookie('flash', message, { httpOnly: true, sameSite: 'lax', maxAge: 60_000 });
  res.redirect(req ? adminBack(req, `/admin#${anchor}`) : `/admin#${anchor}`);
};

router.post('/tiendas/:id/aprobar', async (req, res, next) => {
  try {
    const u = await approve(Number(req.params.id)).catch((err) => {
      if (err instanceof StoreLimitError) { flashTo(res, err.message, 'tiendas-por-aprobar', req); return false; }
      throw err;
    });
    if (u === false) return;
    if (!u) return next();
    flashTo(res, `${u.store_name} aprobada: ya puede publicar (le avisamos por correo).`, 'tiendas-por-aprobar', req);
  } catch (err) { next(err); }
});

router.post('/tiendas/:id/rechazar', async (req, res, next) => {
  try {
    const u = await reject(Number(req.params.id), req.body.reason);
    if (!u) return next();
    flashTo(res, `Solicitud de ${u.store_name} rechazada (le avisamos por correo).`, 'tiendas-por-aprobar', req);
  } catch (err) { next(err); }
});

router.post('/tiendas/:id/quitar-aprobacion', (req, res, next) => {
  const u = revoke(Number(req.params.id), req.body.reason);
  if (!u) return next();
  flashTo(res, `${u.store_name} ya no puede publicar; sus artículos a la venta quedaron pausados.`, 'usuarios', req);
});

// Cupo de tiendas aprobadas (0 = sin límite).
router.post('/tiendas/limite', (req, res) => {
  const n = Number.parseInt(req.body.limit, 10);
  if (!Number.isInteger(n) || n < 0 || n > 10_000) return flashTo(res, 'Escribe un número de tiendas (0 = sin límite).', 'usuarios', req);
  setStoreLimit(n);
  flashTo(res, n ? `Cupo de tiendas: ${n}.` : 'Sin límite de tiendas.', 'usuarios', req);
});

router.post('/aprobacion', (req, res) => {
  setApprovalRequired(req.body.on === '1');
  flashTo(res, req.body.on === '1' ? 'Las tiendas nuevas necesitan tu aprobación para publicar.' : 'Cualquiera puede publicar sin aprobación.', 'config');
});

router.get('/carga/plantilla.csv', (req, res) => {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="cowface-plantilla.csv"' });
  res.send(templateCsv());
});

export default router;
