import { createApp } from './app.js';
import { SITE_NAME } from './catalog.js';
import { db } from './db.js';
import { adminFromEnv, ensureAdmin } from './admin-account.js';
import { runOrderTimers } from './orders.js';
import { runMessageEmails } from './seller-notify.js';
import { runDailyBackup } from './backup.js';
import { expirePromos } from './promos.js';
import { notifyPriceDrops } from './social.js';
import { sendPaymentReminders } from './payment-reminders.js';
import { siteBaseUrl } from './urls.js';
import { encryptExisting } from './crypto-box.js';
import { ATTACH_DIR } from './storage.js';
import { checkDiskAlert } from './disk.js';

// La cuenta admin sale de ADMIN_EMAIL / ADMIN_PASSWORD (en Railway: pestaña Variables).
const admin = adminFromEnv();
if (admin) ensureAdmin(admin);
else if (process.env.NODE_ENV === 'production') console.warn('Aviso: ADMIN_EMAIL / ADMIN_PASSWORD no están definidas; no hay cuenta admin.');

db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());

// Con CHAT_KEY: cifra los mensajes y archivos privados que se guardaron antes sin cifrar.
try {
  const sealed = encryptExisting(db, ATTACH_DIR);
  if (sealed.messages || sealed.files) console.log(`Cifrados: ${sealed.messages} mensajes y ${sealed.files} archivos.`);
} catch (err) { console.error('Error cifrando el historial del chat:', err); }

// Cancela pedidos no pagados a tiempo y libera pagos de envíos sin reclamo.
const timers = () => {
  try { runOrderTimers(); } catch (err) { console.error('Error en tareas de pedidos:', err); }
  try { expirePromos(); } catch (err) { console.error('Error terminando promos vencidas:', err); }
  // Después de las promos: si un artículo guardado bajó de precio, se avisa a quien lo guardó.
  try {
    sendPaymentReminders(siteBaseUrl()).catch((err) => console.error('Error en recordatorios de pago:', err));
  } catch (err) { console.error('Error en recordatorios de pago:', err); }
  try {
    notifyPriceDrops(siteBaseUrl()).catch((err) => console.error('Error avisando bajadas de precio:', err));
  } catch (err) { console.error('Error avisando bajadas de precio:', err); }
};
timers();
setInterval(timers, 5 * 60 * 1000).unref();

// Correos a vendedores con mensajes sin leer (revisa cada minuto).
setInterval(() => {
  runMessageEmails().catch((err) => console.error('Error en avisos de mensajes:', err));
}, 60 * 1000).unref();

// Respaldo diario: se revisa cada hora (y 2 minutos después de arrancar) si ya se hizo el de hoy.
const backup = () => runDailyBackup()
  .then((r) => { if (!r.skipped) console.log(`Respaldo ${r.name} (${(r.size / 1024).toFixed(0)} KB, correo: ${r.emailed})`); })
  .catch((err) => console.error('Error en el respaldo diario:', err));
setTimeout(backup, 2 * 60 * 1000).unref();
setInterval(backup, 60 * 60 * 1000).unref();

// Espacio del volumen: se calcula al arrancar y cada 10 minutos; avisa al admin si se está llenando.
const disk = () => checkDiskAlert().catch((err) => console.error('Error revisando el espacio:', err));
setTimeout(disk, 30 * 1000).unref();
setInterval(disk, 10 * 60 * 1000).unref();

const port = Number(process.env.PORT) || 3100;
createApp().listen(port, () => {
  console.log(`${SITE_NAME} corriendo en el puerto ${port}`);
});
