// Aprobación de tiendas: cualquiera puede comprar, pero para publicar hay que pedirlo y el admin aprueba.
// Mientras espera, la tienda puede ir guardando borradores. Se puede apagar en /admin (Cobro).
import { db, getSetting, setSetting } from './db.js';
import { SITE_NAME } from './catalog.js';
import { sendMail } from './mailer.js';
import { notifyAdmin } from './admin-notify.js';
import { siteBaseUrl } from './urls.js';
import path from 'node:path';
import { ATTACH_DIR, removeFromNow } from './storage.js';
import { saveStoreLocation, validateStoreLocation } from './pickup.js';

export const approvalRequired = () => getSetting('seller_approval') !== '0';
export const setApprovalRequired = (on) => setSetting('seller_approval', on ? '1' : '0');

// Estado efectivo: si la aprobación está apagada, todos pueden publicar.
export const sellerStatus = (user) => (!user ? 'nuevo' : approvalRequired() ? user.seller_status || 'nuevo' : 'aprobado');
export const canPublish = (user) => sellerStatus(user) === 'aprobado';

const clean = (v, max) => String(v ?? '').trim().slice(0, max);

export const MIN_PRODUCT_PHOTOS = 2;
export const MIN_SHIPMENT_PHOTOS = 1;

// photos: { productos: [...], envios: [...] } ya guardadas como adjuntos privados (ver uploads.js).
// Si hay errores, quien llama descarta las fotos nuevas.
export function submitRequest(user, body, photos = { productos: [], envios: [] }) {
  const data = {
    store_name: clean(body.store_name, 80),
    instagram: clean(body.instagram, 60).replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/\/.*$/, ''),
    about: clean(body.about, 600),
    no_shipments: body.no_shipments === '1',
    store_address: String(body.store_address ?? '').slice(0, 300),
    pickup_points: String(body.pickup_points ?? '').slice(0, 1000),
  };
  const location = validateStoreLocation(body);
  const errors = { ...location.errors };
  if (data.store_name.length < 2) errors.store_name = 'El nombre de tu tienda (o tu nombre, si vendes como persona).';
  if (data.instagram && !/^[A-Za-z0-9._]{1,30}$/.test(data.instagram)) errors.instagram = 'Solo el usuario, sin @ (ej. closetdeana).';
  if (data.about.length < 10) errors.about = 'Cuéntanos en una o dos frases qué vas a vender.';
  if (photos.productos.length < MIN_PRODUCT_PHOTOS) errors.productos = `Sube al menos ${MIN_PRODUCT_PHOTOS} fotos de productos que tengas para vender.`;
  if (!data.no_shipments && photos.envios.length < MIN_SHIPMENT_PHOTOS) {
    errors.envios = 'Sube al menos una foto de un envío que hayas hecho (guía, paquete o captura), o marca que todavía no has hecho envíos.';
  }
  if (Object.keys(errors).length) return { errors, data };

  // Las fotos de una solicitud anterior (si la rechazaron y vuelve a pedir) se reemplazan.
  const previous = JSON.parse(db.prepare('SELECT seller_request FROM users WHERE id = ?').get(user.id)?.seller_request || '{}');
  removeFromNow(ATTACH_DIR, [...(previous.product_photos || []), ...(previous.shipment_photos || [])]);
  saveStoreLocation(user.id, location.address, location.points);
  db.prepare(`UPDATE users SET store_name = ?, seller_status = 'pendiente', seller_note = '', seller_request = ? WHERE id = ?`)
    .run(data.store_name, JSON.stringify({
      instagram: data.instagram, about: data.about, requested_at: new Date().toISOString(),
      product_photos: photos.productos, shipment_photos: photos.envios, no_shipments: data.no_shipments && !photos.envios.length,
    }), user.id);
  notifyAdmin('tienda', `Tienda por aprobar: ${data.store_name}`,
    `${data.store_name} (${user.email}) pidió vender en ${SITE_NAME}.\n${data.instagram ? `Instagram: @${data.instagram}\n` : ''}Qué vende: «${data.about}»\n`
      + `Dirección: ${location.address}\nPuntos de pick up: ${location.points.join(' · ')}\n`
      + `Fotos: ${photos.productos.length} de productos y ${photos.envios.length ? `${photos.envios.length} de envíos` : 'ninguna de envíos (dice que todavía no ha hecho)'}. Van adjuntas las primeras; todas están en el panel.`,
    '/admin#tiendas-por-aprobar',
    { attachments: [...photos.productos.slice(0, 2), ...photos.envios.slice(0, 2)].map((n) => ({ path: path.join(ATTACH_DIR, n) })) });
  return { errors: null, data };
}

export function pendingStores() {
  return db.prepare(`
    SELECT u.id, u.name, COALESCE(u.store_name, u.name) AS store_name, u.email, u.phone, u.province, u.seller_request, u.created_at,
      u.store_address, u.pickup_points,
      (SELECT COUNT(*) FROM products p WHERE p.seller_id = u.id AND p.status = 'borrador') AS drafts
    FROM users u WHERE u.role = 'usuario' AND u.active = 1 AND u.seller_status = 'pendiente' ORDER BY u.id
  `).all().map((u) => ({ ...u, request: JSON.parse(u.seller_request || '{}'), points: JSON.parse(u.pickup_points || '[]') }));
}

const userRow = (id) => db.prepare("SELECT id, name, COALESCE(store_name, name) AS store_name, email, seller_status FROM users WHERE id = ? AND role = 'usuario'").get(id);

function mailUser(u, subject, lines, button) {
  let base = '';
  try { base = siteBaseUrl(); } catch { /* sin dirección pública */ }
  const link = button && base ? `${base}${button.path}` : '';
  return sendMail({
    to: u.email,
    subject: `[${SITE_NAME}] ${subject}`,
    text: `Hola ${u.name}:\n\n${lines.join('\n')}${link ? `\n\n${button.label}: ${link}` : ''}\n\n${SITE_NAME}`,
    html: `<p>Hola ${esc(u.name)}:</p>${lines.map((l) => `<p>${esc(l)}</p>`).join('')}`
      + (link ? `<p><a href="${link}" style="display:inline-block;background:#111;color:#fff;padding:.6rem 1rem;text-decoration:none;font-weight:700">${esc(button.label)}</a></p>` : ''),
  }).catch(() => false);
}

export async function approve(id) {
  const u = userRow(id);
  if (!u) return null;
  db.prepare("UPDATE users SET seller_status = 'aprobado', seller_note = '' WHERE id = ?").run(id);
  await mailUser(u, '¡Tu tienda fue aprobada!', [
    `${u.store_name} ya puede vender en ${SITE_NAME}.`,
    'Publica tus artículos (y los borradores que ya tengas) desde Mi cuenta.',
    'Tus pagos: te transferimos por SINPE Móvil, ya con la comisión rebajada, al final del día en que se completa cada venta (si es en la noche o en fin de semana, el siguiente día hábil).',
  ], { label: 'Publicar ahora', path: '/vendedor/productos/nuevo' });
  return u;
}

export async function reject(id, reason) {
  const u = userRow(id);
  if (!u) return null;
  const note = clean(reason, 300);
  db.prepare("UPDATE users SET seller_status = 'rechazado', seller_note = ? WHERE id = ?").run(note, id);
  await mailUser(u, 'Sobre tu solicitud para vender', [
    `Revisamos la solicitud de ${u.store_name} y por ahora no la pudimos aprobar.`,
    note ? `Motivo: ${note}` : 'Si quieres, puedes completar tus datos y volver a enviarla.',
    'Puedes seguir comprando en CowFace con tu cuenta.',
  ], { label: 'Ver mi solicitud', path: '/vendedor/solicitud' });
  return u;
}

// Quitar la aprobación a una tienda que ya vendía: sus artículos a la venta pasan a "pausado".
export function revoke(id, reason) {
  const u = userRow(id);
  if (!u) return null;
  db.prepare("UPDATE users SET seller_status = 'rechazado', seller_note = ? WHERE id = ?").run(clean(reason, 300), id);
  db.prepare("UPDATE products SET status = 'pausado', updated_at = datetime('now') WHERE seller_id = ? AND status = 'disponible'").run(id);
  return u;
}

export const pendingCount = () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'usuario' AND active = 1 AND seller_status = 'pendiente'").get().n;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
