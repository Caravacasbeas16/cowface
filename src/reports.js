// Reportes de artículos, personas y conversaciones. El admin los ve en "Por hacer" y decide:
// ocultar el artículo, suspender la cuenta o descartar el reporte.
import { db, transaction } from './db.js';
import { UserError } from './messages.js';
import { notifyAdmin } from './admin-notify.js';

export const REPORT_REASONS = {
  replica: 'Réplica o falsificación',
  enganoso: 'Fotos o descripción engañosas',
  estafa: 'Estafa o comportamiento sospechoso',
  fuera: 'Pide pagar o hablar fuera de CowFace',
  prohibido: 'Artículo prohibido o robado',
  ofensivo: 'Contenido ofensivo o acoso',
  otro: 'Otro',
};
export const TARGET_LABEL = { articulo: 'artículo', usuario: 'cuenta', conversacion: 'conversación' };
const MAX_OPEN_PER_USER = 20;

// A quién apunta el reporte (y quién es la persona reportada), o null si no existe / no corresponde.
function resolveTarget(reporterId, type, id) {
  if (type === 'articulo') {
    const p = db.prepare('SELECT id, title, seller_id FROM products WHERE id = ?').get(id);
    return p && p.seller_id !== reporterId ? { label: p.title, userId: p.seller_id } : null;
  }
  if (type === 'usuario') {
    const u = db.prepare("SELECT id, COALESCE(store_name, name) AS name FROM users WHERE id = ? AND role = 'usuario' AND deleted_at IS NULL").get(id);
    return u && u.id !== reporterId ? { label: u.name, userId: u.id } : null;
  }
  if (type === 'conversacion') {
    const c = db.prepare('SELECT id, product_title, buyer_id, seller_id FROM conversations WHERE id = ?').get(id);
    if (!c || (c.buyer_id !== reporterId && c.seller_id !== reporterId)) return null;
    return { label: `conversación sobre «${c.product_title}»`, userId: c.buyer_id === reporterId ? c.seller_id : c.buyer_id };
  }
  return null;
}

export function createReport(reporter, type, id, reason, details) {
  if (!TARGET_LABEL[type]) return null;
  const target = resolveTarget(reporter.id, type, Number(id));
  if (!target) return null;
  if (!REPORT_REASONS[reason]) throw new UserError('Elige el motivo del reporte.');
  const text = String(details ?? '').trim().slice(0, 1000);
  if (reason === 'otro' && text.length < 10) throw new UserError('Cuéntanos qué pasa (al menos una frase).');
  const open = db.prepare("SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ? AND status = 'abierto'").get(reporter.id).n;
  const existing = db.prepare("SELECT id FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = 'abierto'").get(reporter.id, type, Number(id));
  if (existing) {
    db.prepare("UPDATE reports SET reason = ?, details = COALESCE(NULLIF(?, ''), details) WHERE id = ?").run(reason, text, existing.id);
    return existing.id;
  }
  if (open >= MAX_OPEN_PER_USER) throw new UserError('Ya tienes muchos reportes abiertos; los estamos revisando.');
  const { lastInsertRowid } = db.prepare('INSERT INTO reports (reporter_id, target_type, target_id, reason, details) VALUES (?, ?, ?, ?, ?)')
    .run(reporter.id, type, Number(id), reason, text);
  notifyAdmin('reporte', `Reporte: ${REPORT_REASONS[reason]} (${TARGET_LABEL[type]})`,
    `${reporter.store_name || reporter.name} reportó ${type === 'articulo' ? `el artículo «${target.label}»` : target.label}.\nMotivo: ${REPORT_REASONS[reason]}${text ? `\n«${text}»` : ''}`,
    '/admin#reportes');
  return Number(lastInsertRowid);
}

export function openReports() {
  return db.prepare(`
    SELECT r.*, COALESCE(u.store_name, u.name) AS reporter_name FROM reports r JOIN users u ON u.id = r.reporter_id
    WHERE r.status = 'abierto' ORDER BY r.id
  `).all().map((r) => {
    const t = resolveTarget(r.reporter_id, r.target_type, r.target_id);
    const reported = t && db.prepare('SELECT id, COALESCE(store_name, name) AS name, active FROM users WHERE id = ?').get(t.userId);
    const link = { articulo: `/p/${r.target_id}`, usuario: `/u/${r.target_id}`, conversacion: `/admin/conversaciones/${r.target_id}` }[r.target_type];
    return { ...r, reasonLabel: REPORT_REASONS[r.reason] || r.reason, targetLabel: t?.label || '(ya no existe)', reported, link };
  });
}

export const openReportCount = () => db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'abierto'").get().n;

// action: 'ocultar' (solo artículos), 'suspender' (la cuenta reportada) o 'descartar'.
export function resolveReport(id, action) {
  const r = db.prepare("SELECT * FROM reports WHERE id = ? AND status = 'abierto'").get(id);
  if (!r) return null;
  const target = resolveTarget(r.reporter_id, r.target_type, r.target_id);
  let resolution;
  transaction(() => {
    if (action === 'ocultar' && r.target_type === 'articulo') {
      db.prepare("UPDATE products SET status = CASE WHEN status IN ('disponible', 'pausado') THEN 'pausado' ELSE status END, admin_hidden = 1 WHERE id = ?").run(r.target_id);
      resolution = 'Artículo ocultado';
    } else if (action === 'suspender' && target) {
      db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(target.userId);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.userId);
      resolution = 'Cuenta suspendida';
    } else {
      resolution = 'Descartado';
    }
    // Se cierran también los otros reportes abiertos sobre lo mismo.
    db.prepare("UPDATE reports SET status = 'resuelto', resolution = ?, resolved_at = datetime('now') WHERE status = 'abierto' AND target_type = ? AND target_id = ?")
      .run(resolution, r.target_type, r.target_id);
  });
  return { ...r, resolution };
}
