// Notificaciones en el celular o la computadora (Web Push), como las de una app.
// Las claves VAPID se crean solas la primera vez y se guardan en la base (no hay que configurar nada);
// si se definen VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY en las variables, se usan esas.
import webpush from 'web-push';
import { db, getSetting, setSetting } from './db.js';
import { siteBaseUrl } from './urls.js';

const MAX_DEVICES = 10;

// Solo se aceptan direcciones de los servicios de notificaciones de los navegadores: el servidor
// les hace peticiones, así que no puede ser cualquier URL que mande alguien.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.apple\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/,
];
const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

let configured = null;
export function vapidPublicKey() {
  if (configured) return configured;
  let pub = (process.env.VAPID_PUBLIC_KEY || '').trim();
  let priv = (process.env.VAPID_PRIVATE_KEY || '').trim();
  if (!pub || !priv) {
    pub = getSetting('vapid_public');
    priv = getSetting('vapid_private');
    if (!pub || !priv) {
      ({ publicKey: pub, privateKey: priv } = webpush.generateVAPIDKeys());
      setSetting('vapid_public', pub);
      setSetting('vapid_private', priv);
    }
  }
  let subject = 'mailto:avisos@cowface.cr';
  const contact = (process.env.CONTACT_EMAIL || '').trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) subject = `mailto:${contact}`;
  webpush.setVapidDetails(subject, pub, priv);
  configured = pub;
  return pub;
}

export function validSubscription(sub) {
  try {
    const url = new URL(String(sub?.endpoint ?? ''));
    if (url.protocol !== 'https:' || !PUSH_HOSTS.some((re) => re.test(url.hostname))) return null;
    const { p256dh, auth } = sub.keys || {};
    if (!B64URL.test(p256dh || '') || !B64URL.test(auth || '') || p256dh.length > 200 || auth.length > 100) return null;
    if (url.href.length > 1000) return null;
    return { endpoint: url.href, p256dh, auth };
  } catch {
    return null;
  }
}

export function saveSubscription(userId, sub, device = '') {
  const s = validSubscription(sub);
  if (!s) return false;
  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device
  `).run(userId, s.endpoint, s.p256dh, s.auth, String(device).slice(0, 120));
  // Un tope de dispositivos por cuenta: se quedan los más recientes.
  db.prepare(`
    DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN (
      SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT ${MAX_DEVICES})
  `).run(userId, userId);
  return true;
}

export function removeSubscription(userId, endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, String(endpoint ?? ''));
}

export const deviceCount = (userId) => db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(userId).n;

// Para pruebas: guarda las notificaciones en memoria en lugar de enviarlas.
export const pushOutbox = [];

// payload: { title, body, url, tag }. No bloquea: corre en segundo plano y nunca lanza errores.
export function pushToUser(userId, payload) {
  if (!userId) return;
  setImmediate(async () => {
    const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
    if (!subs.length) return;
    let url = payload.url || '/';
    try { url = new URL(url, siteBaseUrl()).href; } catch { /* queda la ruta relativa */ }
    const data = JSON.stringify({ ...payload, url });
    for (const s of subs) {
      if (process.env.PUSH_TEST_OUTBOX === '1') { pushOutbox.push({ userId, endpoint: s.endpoint, ...payload }); continue; }
      try {
        vapidPublicKey();
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, data, { TTL: 24 * 3600, urgency: 'high' });
        db.prepare('UPDATE push_subscriptions SET last_ok_at = ? WHERE id = ?').run(new Date().toISOString(), s.id);
      } catch (err) {
        // 404/410: el dispositivo ya no acepta notificaciones (las desactivaron o desinstalaron).
        if (err.statusCode === 404 || err.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
        else console.error(`Error enviando notificación (HTTP ${err.statusCode || '?'}):`, String(err.body || err.message).slice(0, 200));
      }
    }
  });
}
