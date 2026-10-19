import { Router } from 'express';
import { requireRole } from '../auth.js';
import { db, commissionRate, setSetting } from '../db.js';
import { ORDER_STATUS } from '../catalog.js';
import { blockedWords, saveBlockedWords } from '../moderation.js';
import { ADMIN_LINK_HOURS, createResetToken } from '../password-reset.js';
import { publicBaseUrl } from '../urls.js';
import { DELIVERY_LABELS, admin, adminQueues, paymentConfig, savePaymentConfig } from '../orders.js';
import { markDataSent, orderDataText } from '../order-data.js';
import { sendMail } from '../mailer.js';
import { SITE_NAME } from '../catalog.js';
import { NOTIFY_EVENTS, notifySettings, saveNotifySettings } from '../admin-notify.js';
import { mailConfigured } from '../mailer.js';
import { FEATURED_SQL } from '../products.js';
import { earningsReport, earningsCsv } from '../earnings.js';
import path from 'node:path';
import { encryptionEnabled, openText } from '../crypto-box.js';
import { approvalRequired, pendingStores } from '../approval.js';
import { adminSay, openHelpRequests, resolveHelp } from '../help.js';
import { openReports, resolveReport } from '../reports.js';
import { UserError } from '../messages.js';
import { BACKUP_DIR, BACKUP_NAME, backupStatus, runDailyBackup, streamFullBackup } from '../backup.js';
import { adminBack } from '../admin-panel.js';
import { diskStatus, formatBytes, refreshDisk, setVolumeGb, volumeGbSetting } from '../disk.js';
import { setStoreSupport, storeSupport } from '../support.js';
import { normalizePhone } from '../validate.js';

const router = Router();
router.use(requireRole('admin'));

function flash(res, message) {
  res.cookie('flash', message, { httpOnly: true, sameSite: 'lax', maxAge: 60_000 });
}

router.get('/', (req, res) => {
  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE role = 'usuario') AS users,
      (SELECT COUNT(*) FROM products WHERE status = 'disponible') AS products,
      (SELECT COUNT(*) FROM conversations) AS conversations,
      (SELECT COUNT(*) FROM offers) AS offers,
      (SELECT COUNT(*) FROM orders WHERE status = 'completado') AS completed,
      (SELECT COALESCE(SUM(price), 0) FROM orders WHERE status = 'completado') AS gmv,
      (SELECT COALESCE(SUM(commission_amount), 0) FROM orders WHERE status = 'completado') AS commission,
      (SELECT COALESCE(SUM(COALESCE(total, price)), 0) FROM orders WHERE status IN ('pagado', 'enviado', 'en_disputa', 'reembolso_pendiente'))
        + (SELECT COALESCE(SUM(payout_amount), 0) FROM orders WHERE status = 'completado' AND payout_status = 'pendiente') AS held,
      (SELECT COUNT(*) FROM flagged_messages WHERE created_at > datetime('now', '-7 days')) AS flagged_week
  `).get();

  const sellers = db.prepare(`
    SELECT u.id, u.name, COALESCE(u.store_name, u.name) AS store_name, u.email, u.phone, u.province, u.active,
      u.payout_phone, u.payout_name, u.featured_until, ${FEATURED_SQL} AS featured, u.seller_status,
      (SELECT COUNT(*) FROM products p WHERE p.seller_id = u.id AND p.status = 'disponible') AS products,
      (SELECT COUNT(*) FROM orders o WHERE o.seller_id = u.id AND o.status = 'completado') AS sales,
      (SELECT COUNT(*) FROM orders o WHERE o.seller_id = u.id AND o.status IN ('en_disputa', 'reembolso_pendiente', 'reembolsado')) AS problems,
      (SELECT COUNT(*) FROM flagged_messages f WHERE f.user_id = u.id) AS flagged
    FROM users u WHERE u.role = 'usuario' AND u.deleted_at IS NULL ORDER BY featured DESC, flagged DESC, problems DESC, u.created_at DESC LIMIT 300
  `).all();

  const orders = db.prepare(`
    SELECT o.*, COALESCE(s.store_name, s.name) AS store_name, b.name AS buyer_name
    FROM orders o JOIN users s ON s.id = o.seller_id JOIN users b ON b.id = o.buyer_id
    ORDER BY o.created_at DESC, o.id DESC LIMIT 100
  `).all();

  const flagged = db.prepare(`
    SELECT f.*, u.name, u.email FROM flagged_messages f JOIN users u ON u.id = f.user_id ORDER BY f.id DESC LIMIT 50
  `).all();

  res.render('admin/dashboard', {
    title: 'Administración', totals, sellers, orders, flagged, queues: adminQueues(), pay: paymentConfig(), orderDataText, siteUrl: res.locals.siteUrl,
    rate: commissionRate(), words: blockedWords(), ORDER_STATUS, DELIVERY_METHODS: DELIVERY_LABELS,
    disk: diskStatus(), formatBytes, volumeGb: volumeGbSetting(), support: storeSupport(),
    notify: notifySettings(), NOTIFY_EVENTS, mailReady: mailConfigured(), backups: backupStatus(), chatEncrypted: encryptionEnabled(), storesToApprove: pendingStores(), approvalOn: approvalRequired(), helpRequests: openHelpRequests(), reports: openReports(),
  });
});

// Tamaño del volumen que se eligió en Railway (vacío = el que reporta el disco).
router.post('/espacio', async (req, res) => {
  const raw = String(req.body.volume_gb ?? '').trim().replace(',', '.');
  const n = raw === '' ? 0 : Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 10_000) { flash(res, 'Escribe el tamaño en GB (por ejemplo 5).'); return res.redirect('/admin#espacio'); }
  setVolumeGb(n);
  await refreshDisk().catch(() => {});
  flash(res, n ? `Tamaño del volumen: ${n} GB.` : 'Se usa el tamaño que reporta el disco.');
  res.redirect('/admin#espacio');
});

// Acciones sobre pedidos: confirmar/rechazar pago, resolver reclamos, registrar reembolsos y pagos a vendedores.
const ORDER_ACTIONS = {
  'confirmar-pago': (id) => admin.confirmPayment(id),
  'rechazar-pago': (id, body) => admin.rejectPayment(id, body.note),
  liberar: (id) => admin.release(id),
  reembolsar: (id) => admin.refund(id),
  reembolsado: (id) => admin.markRefunded(id),
  'pago-vendedor': (id) => admin.markPayout(id),
};

// Después de confirmar el SINPE: mandarle a la tienda los datos de entrega por correo,
// o marcarlos como enviados si se los pasaste por WhatsApp.
const paidOrder = (id) => adminQueues().toShip.find((o) => o.id === id);

router.post('/pedidos/:id/enviar-datos', async (req, res, next) => {
  const o = paidOrder(Number(req.params.id));
  if (!o) { flash(res, 'Ese pedido ya no está pagado y por enviar.'); return res.redirect('/admin#envios'); }
  try {
    const text = orderDataText(o, publicBaseUrl(req));
    const ok = await sendMail({
      to: o.store_email,
      subject: `[${SITE_NAME}] Pedido ${o.code}: envíalo a ${o.buyer_name}`,
      text: `Hola ${o.store_name}:\n\n${text}\n\n${SITE_NAME}`,
      html: `<p>Hola ${escapeHtml(o.store_name)}:</p><p style="white-space:pre-line">${escapeHtml(text)}</p>`,
    });
    if (ok) markDataSent(o.id);
    flash(res, ok ? `Datos del pedido ${o.code} enviados a ${o.store_email}.` : 'No se pudo mandar el correo (revisa Brevo). Puedes copiarlos y mandarlos por WhatsApp.');
    res.redirect('/admin#envios');
  } catch (err) { next(err); }
});

router.post('/pedidos/:id/datos-enviados', (req, res) => {
  const o = paidOrder(Number(req.params.id));
  if (o) markDataSent(o.id);
  res.redirect('/admin#envios');
});

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

router.post('/pedidos/:id/:action', (req, res, next) => {
  const action = ORDER_ACTIONS[req.params.action];
  if (!action) return next();
  try {
    if (!action(Number(req.params.id), req.body)) flash(res, 'Ese pedido no existe.');
  } catch (err) {
    flash(res, err.message);
  }
  res.redirect(adminBack(req, '/admin#pagos'));
});

// WhatsApp de soporte para tiendas (vacío = no se muestra).
router.post('/soporte-tiendas', (req, res) => {
  const raw = String(req.body.phone ?? '').trim();
  const phone = raw ? normalizePhone(raw) : '';
  if (raw && !phone) { flash(res, 'Número de WhatsApp de 8 dígitos.'); return res.redirect('/admin#config'); }
  setStoreSupport(phone);
  flash(res, phone ? 'Número de soporte para tiendas guardado.' : 'Ya no se muestra un número de soporte a las tiendas.');
  res.redirect('/admin#config');
});

router.post('/pagos-config', (req, res) => {
  const errors = savePaymentConfig(req.body);
  flash(res, errors.length ? errors.join(' ') : 'Datos de cobro guardados.');
  res.redirect('/admin#config');
});

router.post('/vendedores/:id/activo', (req, res) => {
  db.prepare("UPDATE users SET active = ? WHERE id = ? AND role = 'usuario'").run(req.body.active === '1' ? 1 : 0, Number(req.params.id));
  // Al suspender, se cierran sus sesiones abiertas.
  if (req.body.active !== '1') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(Number(req.params.id));
  res.redirect(adminBack(req, '/admin#usuarios'));
});

// Lectura de una conversación para resolver un reclamo (solo lectura; el admin no escribe en ella).
router.get('/conversaciones/:id', (req, res, next) => {
  const conv = db.prepare(`
    SELECT c.*, b.name AS buyer_name, COALESCE(s.store_name, s.name) AS store_name
    FROM conversations c JOIN users b ON b.id = c.buyer_id JOIN users s ON s.id = c.seller_id WHERE c.id = ?
  `).get(Number(req.params.id));
  if (!conv) return next();
  const messages = db.prepare(`
    SELECT m.*, o.amount, o.status AS offer_status FROM messages m LEFT JOIN offers o ON o.id = m.offer_id
    WHERE m.conversation_id = ? ORDER BY m.id
  `).all(conv.id).map((m) => ({ ...m, body: openText(m.body) }));
  const order = db.prepare('SELECT * FROM orders WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(conv.id);
  const help = openHelpRequests().filter((h) => h.conversation_id === conv.id);
  res.render('admin/conversation', { title: `Conversación · ${conv.product_title}`, conv, messages, order, help, ORDER_STATUS_LABEL: ORDER_STATUS });
});

// Respaldo de "¿Olvidaste tu contraseña?": el admin genera el enlace y se lo manda a la persona
// (por ejemplo, después de verificar que te escribe desde el correo de su cuenta).
router.post('/vendedores/:id/enlace-contrasena', (req, res, next) => {
  const target = db.prepare("SELECT id, name, email FROM users WHERE id = ? AND role = 'usuario' AND active = 1").get(Number(req.params.id));
  if (!target) return next();
  const link = `${publicBaseUrl(req)}/restablecer/${createResetToken(target.id, ADMIN_LINK_HOURS * 60)}`;
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin' });
  res.render('admin/reset-link', { title: 'Enlace de contraseña', target, link, hours: ADMIN_LINK_HOURS });
});

// Ganancias: comisión por mes, por tienda y lo que está por entrar. ?formato=csv descarga las ventas.
router.get('/ganancias', (req, res) => {
  const year = Number.parseInt(req.query.anio, 10);
  if (req.query.formato === 'csv') {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="cowface-ventas${year ? `-${year}` : ''}.csv"` });
    return res.send(earningsCsv(year));
  }
  res.render('admin/earnings', { title: 'Ganancias', report: earningsReport(year) });
});

// Prioridad: los artículos de una tienda destacada salen primero (con la marca "Destacada").
const FEATURE_DAYS = { 7: 7, 30: 30, 90: 90, siempre: 36500 };
router.post('/tiendas/:id/destacar', (req, res) => {
  const days = FEATURE_DAYS[req.body.days];
  const until = days ? new Date(Date.now() + days * 86400e3).toISOString() : null;
  const r = db.prepare("UPDATE users SET featured_until = ? WHERE id = ? AND role = 'usuario'").run(until, Number(req.params.id));
  if (r.changes) flash(res, until ? (req.body.days === 'siempre' ? 'Tienda destacada sin fecha de fin.' : `Tienda destacada por ${days} días.`) : 'La tienda ya no está destacada.');
  res.redirect(adminBack(req, '/admin#usuarios'));
});

// ---------- Respaldos ----------
router.post('/respaldos/ahora', async (req, res, next) => {
  try {
    const r = await runDailyBackup({ force: true });
    const mail = { enviado: ' y se mandó a tu correo', 'sin-clave': '. Para recibirlo por correo falta BACKUP_PASSWORD', 'muy-grande': '; es muy grande para el correo: descárgalo aquí', error: '; el correo falló', 'sin-correo': '' }[r.emailed] ?? '';
    flash(res, `Respaldo hecho (${(r.size / 1024).toFixed(0)} KB)${mail}.`);
    res.redirect('/admin#respaldos');
  } catch (err) { next(err); }
});

router.get('/respaldos/completo', async (req, res, next) => {
  const day = new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
  res.set({ 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="cowface-completo-${day}.tar.gz"`, 'Cache-Control': 'no-store' });
  try { await streamFullBackup(res); } catch (err) { if (!res.headersSent) next(err); else res.destroy(err); }
});

router.get('/respaldos/:name', (req, res, next) => {
  if (!BACKUP_NAME.test(req.params.name)) return next();
  res.set('Cache-Control', 'no-store');
  res.download(path.join(BACKUP_DIR, req.params.name), req.params.name, (err) => { if (err && !res.headersSent) next(); });
});

// ---------- Ayuda: CowFace se hace cargo ----------
router.post('/conversaciones/:id/mensaje', (req, res, next) => {
  try {
    if (!adminSay(Number(req.params.id), req.body.body)) return next();
    flash(res, 'Mensaje enviado como CowFace.');
  } catch (err) {
    if (!(err instanceof UserError)) return next(err);
    flash(res, err.message);
  }
  res.redirect(`/admin/conversaciones/${Number(req.params.id)}`);
});

router.post('/reportes/:id/:action', (req, res, next) => {
  if (!['ocultar', 'suspender', 'descartar'].includes(req.params.action)) return next();
  const r = resolveReport(Number(req.params.id), req.params.action);
  if (!r) return next();
  flash(res, `Reporte resuelto: ${r.resolution.toLowerCase()}.`);
  res.redirect('/admin#reportes');
});

router.post('/ayuda/:id/resolver', (req, res, next) => {
  const h = resolveHelp(Number(req.params.id), req.body.note);
  if (!h) return next();
  flash(res, 'Solicitud de ayuda resuelta.');
  res.redirect(req.body.back === 'conversacion' && h.conversation_id ? `/admin/conversaciones/${h.conversation_id}` : '/admin#ayuda');
});

router.post('/notificaciones', (req, res) => {
  const error = saveNotifySettings(req.body);
  flash(res, error || 'Notificaciones guardadas.');
  res.redirect('/admin#notificaciones');
});

router.post('/comision', (req, res) => {
  const pct = Number(req.body.percent);
  if (Number.isFinite(pct) && pct >= 0 && pct <= 50) setSetting('commission_rate', (pct / 100).toFixed(4));
  res.redirect('/admin#config');
});

router.post('/palabras', (req, res) => {
  saveBlockedWords(String(req.body.words ?? '').slice(0, 10_000));
  res.redirect('/admin#filtro');
});

export default router;
