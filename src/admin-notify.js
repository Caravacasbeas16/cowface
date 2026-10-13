// Avisos por correo al admin cuando pasa algo que requiere su atención (o que quiere saber).
// Se eligen en /admin → Notificaciones; el correo de destino es ADMIN_EMAIL o el que se ponga ahí.
import { getSetting, setSetting } from './db.js';
import { SITE_NAME } from './catalog.js';
import { adminEmail } from './admin-account.js';
import { sendMail } from './mailer.js';
import { publicBaseUrl } from './urls.js';

export const NOTIFY_EVENTS = {
  pago: { label: 'Un comprador avisó que pagó (hay que verificar el SINPE)', default: true },
  reclamo: { label: 'Se abrió un reclamo', default: true },
  vendedor: { label: 'Venta completada: hay que pagarle al vendedor', default: true },
  reembolso: { label: 'Un vendedor no puede entregar: hay que reembolsar', default: true },
  registro: { label: 'Se registró una persona nueva', default: false },
  publicacion: { label: 'Se publicó un artículo nuevo', default: false },
  bloqueado: { label: 'Alguien intentó compartir su contacto', default: false },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function notifySettings() {
  const saved = getSetting('notify_events');
  const on = saved === null || saved === undefined
    ? Object.keys(NOTIFY_EVENTS).filter((k) => NOTIFY_EVENTS[k].default)
    : String(saved).split(',').filter((k) => NOTIFY_EVENTS[k]);
  const custom = getSetting('notify_email') || '';
  return { events: new Set(on), customEmail: custom, email: custom || adminEmail() };
}

export function saveNotifySettings(body) {
  const email = String(body.email ?? '').trim().toLowerCase().slice(0, 120);
  if (email && !EMAIL_RE.test(email)) return 'Ese correo no es válido.';
  const events = [body.events ?? []].flat().flatMap((v) => String(v).split(',')).filter((k) => NOTIFY_EVENTS[k]);
  setSetting('notify_events', events.join(','));
  setSetting('notify_email', email);
  return null;
}

// No bloquea a quien hizo la acción: el correo sale en segundo plano y un error solo se registra.
// path: dónde atenderlo en el sitio (p. ej. "/admin#pagos").
export function notifyAdmin(event, subject, text, path = '/admin') {
  const { events, email } = notifySettings();
  if (!events.has(event) || !email) return;
  setImmediate(async () => {
    try {
      let link = '';
      try { link = `${publicBaseUrl({ protocol: 'http', get: () => `localhost:${process.env.PORT || 3100}` })}${path}`; } catch { /* sin URL pública */ }
      await sendMail({
        to: email,
        subject: `[${SITE_NAME}] ${subject}`,
        text: `${text}${link ? `\n\nAbrir: ${link}` : ''}\n\nCambia qué avisos recibes en Admin → Notificaciones.`,
        html: `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>${link ? `<p><a href="${link}">Abrir en ${SITE_NAME}</a></p>` : ''}`
          + '<p style="color:#666">Cambia qué avisos recibes en Admin → Notificaciones.</p>',
      });
    } catch (err) {
      console.error(`Error avisando al admin (${event}):`, err.message);
    }
  });
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
