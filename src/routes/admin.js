import { Router } from 'express';
import { requireRole } from '../auth.js';
import { db, commissionRate, setSetting } from '../db.js';
import { ORDER_STATUS } from '../catalog.js';
import { blockedWords, saveBlockedWords } from '../moderation.js';
import { ADMIN_LINK_HOURS, createResetToken } from '../password-reset.js';
import { publicBaseUrl } from '../urls.js';
import { DELIVERY_METHODS, admin, adminQueues, paymentConfig, savePaymentConfig } from '../orders.js';

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
      u.payout_phone, u.payout_name,
      (SELECT COUNT(*) FROM products p WHERE p.seller_id = u.id AND p.status = 'disponible') AS products,
      (SELECT COUNT(*) FROM orders o WHERE o.seller_id = u.id AND o.status = 'completado') AS sales,
      (SELECT COUNT(*) FROM orders o WHERE o.seller_id = u.id AND o.status IN ('en_disputa', 'reembolso_pendiente', 'reembolsado')) AS problems,
      (SELECT COUNT(*) FROM flagged_messages f WHERE f.user_id = u.id) AS flagged
    FROM users u WHERE u.role = 'usuario' ORDER BY flagged DESC, problems DESC, u.created_at DESC LIMIT 300
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
    title: 'Administración', totals, sellers, orders, flagged, queues: adminQueues(), pay: paymentConfig(),
    rate: commissionRate(), words: blockedWords(), ORDER_STATUS, DELIVERY_METHODS,
  });
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

router.post('/pedidos/:id/:action', (req, res, next) => {
  const action = ORDER_ACTIONS[req.params.action];
  if (!action) return next();
  try {
    if (!action(Number(req.params.id), req.body)) flash(res, 'Ese pedido no existe.');
  } catch (err) {
    flash(res, err.message);
  }
  res.redirect('/admin#pagos');
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
  res.redirect('/admin#usuarios');
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
  `).all(conv.id);
  const order = db.prepare('SELECT * FROM orders WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(conv.id);
  res.render('admin/conversation', { title: `Conversación · ${conv.product_title}`, conv, messages, order, ORDER_STATUS_LABEL: ORDER_STATUS });
});

// Respaldo de "¿Olvidaste tu contraseña?": el admin genera el enlace y se lo manda a la persona
// (por ejemplo, después de verificar que te escribe desde el correo de su cuenta).
router.post('/vendedores/:id/enlace-contrasena', (req, res, next) => {
  const target = db.prepare("SELECT id, name, email FROM users WHERE id = ? AND role = 'usuario' AND active = 1").get(Number(req.params.id));
  if (!target) return next();
  const link = `${publicBaseUrl(req)}/restablecer/${createResetToken(target.id, ADMIN_LINK_HOURS * 60)}`;
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.render('admin/reset-link', { title: 'Enlace de contraseña', target, link, hours: ADMIN_LINK_HOURS });
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
