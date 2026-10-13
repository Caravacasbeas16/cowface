import { createApp } from './app.js';
import { SITE_NAME } from './catalog.js';
import { db } from './db.js';
import { adminFromEnv, ensureAdmin } from './admin-account.js';
import { runOrderTimers } from './orders.js';
import { runMessageEmails } from './seller-notify.js';

// La cuenta admin sale de ADMIN_EMAIL / ADMIN_PASSWORD (en Railway: pestaña Variables).
const admin = adminFromEnv();
if (admin) ensureAdmin(admin);
else if (process.env.NODE_ENV === 'production') console.warn('Aviso: ADMIN_EMAIL / ADMIN_PASSWORD no están definidas; no hay cuenta admin.');

db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());

// Cancela pedidos no pagados a tiempo y libera pagos de envíos sin reclamo.
const timers = () => {
  try { runOrderTimers(); } catch (err) { console.error('Error en tareas de pedidos:', err); }
};
timers();
setInterval(timers, 5 * 60 * 1000).unref();

// Correos a vendedores con mensajes sin leer (revisa cada minuto).
setInterval(() => {
  runMessageEmails().catch((err) => console.error('Error en avisos de mensajes:', err));
}, 60 * 1000).unref();

const port = Number(process.env.PORT) || 3100;
createApp().listen(port, () => {
  console.log(`${SITE_NAME} corriendo en el puerto ${port}`);
});
