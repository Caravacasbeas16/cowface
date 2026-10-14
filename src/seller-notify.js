// Correo al vendedor cuando un comprador le escribe y no lo ha leído en unos minutos.
// Corre cada minuto desde server.js. Para no llenar el buzón: como máximo un correo por
// conversación cada hora, y solo por mensajes recientes. Cada vendedor lo apaga en "Mi cuenta".
import { db } from './db.js';
import { SITE_NAME, formatColones } from './catalog.js';
import { sendMail } from './mailer.js';
import { siteBaseUrl } from './urls.js';
import { openText } from './crypto-box.js';

export const WAIT_MINUTES = 5;      // si lo lee antes (o tiene el chat abierto), no se manda
export const GAP_MINUTES = 60;      // entre correos de la misma conversación
const RECENT_HOURS = 48;            // no avisar de mensajes viejos (p. ej. al activar esta función)

const iso = (ms) => new Date(ms).toISOString();

export async function runMessageEmails(nowMs = Date.now()) {
  const ready = iso(nowMs - WAIT_MINUTES * 60e3);
  const recent = iso(nowMs - RECENT_HOURS * 3600e3);
  const gap = iso(nowMs - GAP_MINUTES * 60e3);
  // Conversaciones con mensajes del comprador sin leer por el vendedor, que esperaron lo suficiente
  // y que llegaron después del último correo.
  const due = db.prepare(`
    SELECT c.id, c.product_title, c.seller_read_at, c.seller_notified_at,
      s.email, s.name AS seller_name, b.name AS buyer_name
    FROM conversations c JOIN users s ON s.id = c.seller_id JOIN users b ON b.id = c.buyer_id
    WHERE s.active = 1 AND s.email_messages = 1
      AND (c.seller_notified_at IS NULL OR c.seller_notified_at <= ?)
      AND EXISTS (
        SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.sender_id = c.buyer_id
          AND m.created_at > c.seller_read_at AND m.created_at > COALESCE(c.seller_notified_at, '')
          AND m.created_at > ? AND m.created_at <= ?
      )
    LIMIT 100
  `).all(gap, recent, ready);

  let sent = 0;
  for (const c of due) {
    // Se marca antes de enviar: si el correo falla, no se reintenta en bucle cada minuto.
    db.prepare('UPDATE conversations SET seller_notified_at = ? WHERE id = ?').run(iso(nowMs), c.id);
    const unread = db.prepare(`
      SELECT m.kind, m.body, m.attachment_type, o.amount FROM messages m LEFT JOIN offers o ON o.id = m.offer_id
      WHERE m.conversation_id = ? AND m.sender_id = (SELECT buyer_id FROM conversations WHERE id = ?) AND m.created_at > ?
      ORDER BY m.id DESC LIMIT 3
    `).all(c.id, c.id, c.seller_read_at).reverse();
    const lines = unread.map(describe).filter(Boolean);
    let link = '';
    try { link = `${siteBaseUrl()}/mensajes/${c.id}`; } catch { /* sin dirección pública configurada */ }
    const ok = await sendMail({
      to: c.email,
      subject: `💬 ${c.buyer_name} te escribió por «${c.product_title}»`,
      text: `Hola ${c.seller_name}:\n\n${c.buyer_name} te escribió en ${SITE_NAME} por «${c.product_title}»:\n\n`
        + `${lines.map((l) => `  ${l}`).join('\n')}\n\n${link ? `Responde aquí: ${link}\n\n` : ''}`
        + 'Responde por el chat de CowFace: ahí queda protegido el trato.\n'
        + 'Para no recibir estos correos, apágalos en Mi cuenta → Avisos por correo.',
      html: `<p>Hola ${esc(c.seller_name)}:</p><p><strong>${esc(c.buyer_name)}</strong> te escribió por <strong>«${esc(c.product_title)}»</strong>:</p>`
        + `<blockquote style="border-left:3px solid #111;margin:0;padding:.4rem .8rem;color:#333">${lines.map(esc).join('<br>')}</blockquote>`
        + (link ? `<p><a href="${link}" style="display:inline-block;background:#111;color:#fff;padding:.6rem 1rem;text-decoration:none;font-weight:700">Responder</a></p>` : '')
        + '<p style="color:#666;font-size:13px">Responde por el chat de CowFace: ahí queda protegido el trato. '
        + 'Para no recibir estos correos, apágalos en Mi cuenta → Avisos por correo.</p>',
    }).catch((err) => { console.error('Error avisando al vendedor por correo:', err.message); return false; });
    if (ok) sent += 1;
  }
  return { due: due.length, sent };
}

function describe(m) {
  if (m.kind === 'oferta') return m.amount ? `Te hizo una oferta de ${formatColones(m.amount)}` : 'Te hizo una oferta';
  const file = m.attachment_type === 'pdf' ? '📄 Te mandó un PDF' : m.attachment_type ? '📷 Te mandó una foto' : '';
  const text = String(openText(m.body) || '').trim();
  const short = text.length > 200 ? `${text.slice(0, 200)}…` : text;
  return [file, short && `«${short}»`].filter(Boolean).join(' ');
}

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
