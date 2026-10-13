// Envío de correos por API HTTP (Railway puede bloquear SMTP). Se activa con variables:
//   Brevo:  BREVO_API_KEY  + MAIL_FROM  (remitente verificado en Brevo; sirve un Gmail)
//   Resend: RESEND_API_KEY + MAIL_FROM  (requiere dominio propio verificado en Resend)
// Opcional: MAIL_FROM_NAME (por defecto el nombre del sitio).
// Sin configuración, mailConfigured() es false y el admin genera los enlaces desde su panel.
import { SITE_NAME } from './catalog.js';

const env = (k) => (process.env[k] || '').trim();

export function mailProvider() {
  if (!env('MAIL_FROM')) return null;
  if (env('BREVO_API_KEY')) return 'brevo';
  if (env('RESEND_API_KEY')) return 'resend';
  return null;
}

export const mailConfigured = () => Boolean(mailProvider());

// Para pruebas: guarda los correos en memoria en lugar de enviarlos.
export const outbox = [];

export async function sendMail({ to, subject, text, html }) {
  const provider = mailProvider();
  if (process.env.MAIL_TEST_OUTBOX === '1') {
    outbox.push({ to, subject, text, html });
    return true;
  }
  if (!provider) return false;
  const fromName = env('MAIL_FROM_NAME') || SITE_NAME;
  const request = provider === 'brevo'
    ? {
      url: 'https://api.brevo.com/v3/smtp/email',
      headers: { 'api-key': env('BREVO_API_KEY') },
      body: { sender: { email: env('MAIL_FROM'), name: fromName }, to: [{ email: to }], subject, textContent: text, htmlContent: html },
    }
    : {
      url: 'https://api.resend.com/emails',
      headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}` },
      body: { from: `${fromName} <${env('MAIL_FROM')}>`, to: [to], subject, text, html },
    };
  const res = await fetch(request.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...request.headers },
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    // Sin registrar el cuerpo del correo (lleva el enlace secreto); solo el código de error.
    console.error(`Error enviando correo con ${provider}: HTTP ${res.status}`);
    return false;
  }
  return true;
}
