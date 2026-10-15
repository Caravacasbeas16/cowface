// "Avísame cuando haya…": búsquedas guardadas. Cuando se publica un artículo que coincide, se manda
// un correo (como máximo uno cada 6 horas por búsqueda, para no llenar el buzón).
import { db } from './db.js';
import { CATEGORIES, DEPARTMENTS, SITE_NAME, formatColones } from './catalog.js';
import { parseFilters, productMatches } from './products.js';
import { sendMail } from './mailer.js';

const MAX_PER_USER = 20;
const COOLDOWN_MS = 6 * 3600e3;

// Normaliza la búsqueda (solo filtros conocidos, sin página ni orden) para guardarla y compararla.
export function canonicalQuery(query) {
  const f = parseFilters(query);
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.category) p.set('categoria', f.category);
  if (f.item_type) p.set('tipo', f.item_type);
  if (f.department) p.set('para', f.department);
  for (const s of f.sizes) p.append('talla', s);
  if (f.condition) p.set('estado', f.condition);
  if (f.province) p.set('provincia', f.province);
  if (f.min) p.set('min', String(f.min));
  if (f.max) p.set('max', String(f.max));
  if (f.onSale) p.set('oferta', '1');
  return p.toString();
}

const queryObject = (qs) => {
  const obj = {};
  for (const [k, v] of new URLSearchParams(qs)) obj[k] = k === 'talla' ? [...(obj[k] || []), v] : v;
  return obj;
};

export function describe(qs) {
  const f = parseFilters(queryObject(qs));
  const parts = [];
  if (f.q) parts.push(`"${f.q}"`);
  if (f.item_type) parts.push(f.item_type);
  else if (f.category) parts.push(CATEGORIES[f.category].label);
  if (f.department) parts.push(`para ${DEPARTMENTS[f.department].toLowerCase()}`);
  if (f.sizes.length) parts.push(`talla ${f.sizes.join(', ')}`);
  if (f.condition) parts.push(f.condition === 'nuevo' ? 'nuevo' : 'usado');
  if (f.province) parts.push(`en ${f.province}`);
  if (f.max) parts.push(`hasta ${formatColones(f.max)}`);
  return parts.join(' · ') || 'Todo lo nuevo';
}

export function saveSearch(userId, query) {
  const qs = canonicalQuery(query);
  const count = db.prepare('SELECT COUNT(*) AS n FROM saved_searches WHERE user_id = ?').get(userId).n;
  if (count >= MAX_PER_USER) return { ok: false, message: `Puedes tener hasta ${MAX_PER_USER} avisos. Borra alguno en "Mi cuenta".` };
  db.prepare('INSERT OR IGNORE INTO saved_searches (user_id, query, label) VALUES (?, ?, ?)').run(userId, qs, describe(qs));
  return { ok: true, message: `Listo: te avisamos por correo cuando haya ${describe(qs).toLowerCase()}.` };
}

export const listSearches = (userId) =>
  db.prepare('SELECT * FROM saved_searches WHERE user_id = ? ORDER BY created_at DESC').all(userId);

export function deleteSearch(userId, id) {
  db.prepare('DELETE FROM saved_searches WHERE id = ? AND user_id = ?').run(id, userId);
}

// Se llama al publicar un artículo. No bloquea la publicación: corre en segundo plano.
export function notifyMatches(productId, baseUrl) {
  setImmediate(async () => {
    try {
      const product = db.prepare("SELECT id, title, price, seller_id, status FROM products WHERE id = ? AND status = 'disponible'").get(productId);
      if (!product) return;
      const searches = db.prepare(`
        SELECT s.*, u.email, u.name FROM saved_searches s JOIN users u ON u.id = s.user_id
        WHERE u.active = 1 AND u.role = 'usuario' AND s.user_id != ?
      `).all(product.seller_id);
      for (const s of searches) {
        if (s.last_notified_at && Date.now() - new Date(s.last_notified_at).getTime() < COOLDOWN_MS) continue;
        if (!productMatches(parseFilters(queryObject(s.query), s.user_id), product.id)) continue;
        db.prepare('UPDATE saved_searches SET last_notified_at = ? WHERE id = ?').run(new Date().toISOString(), s.id);
        const link = `${baseUrl}/p/${product.id}`;
        await sendMail({
          to: s.email,
          subject: `Nuevo en ${SITE_NAME}: ${product.title}`,
          text: `Hola ${s.name}:\n\nSe publicó algo que buscabas (${s.label}):\n${product.title} · ${formatColones(product.price)}\n${link}\n\nPara dejar de recibir este aviso, bórralo en Mi cuenta → Avisos.\n\n${SITE_NAME}`,
          html: `<p>Hola ${escapeHtml(s.name)}:</p><p>Se publicó algo que buscabas (<strong>${escapeHtml(s.label)}</strong>):</p>`
            + `<p><a href="${link}">${escapeHtml(product.title)} · ${formatColones(product.price)}</a></p>`
            + `<p style="color:#666">Para dejar de recibir este aviso, bórralo en Mi cuenta → Avisos.</p>`,
        });
      }
    } catch (err) {
      console.error('Error enviando avisos de búsquedas guardadas:', err.message);
    }
  });
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

