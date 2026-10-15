// "En línea" / "Activa hace 20 min": en línea si tiene CowFace abierto ahora (canal en vivo) o usó el
// sitio hace menos de 3 minutos; si no, cuánto hace de su última actividad.
import { db } from './db.js';
import { isOnline } from './realtime.js';

const WRITE_EVERY_MS = 60_000;   // no se escribe en la base en cada petición
const ONLINE_MS = 3 * 60_000;
const lastWrite = new Map();

// Se llama en cada petición de un usuario con sesión.
export function touch(userId, nowMs = Date.now()) {
  if (!userId || nowMs - (lastWrite.get(userId) || 0) < WRITE_EVERY_MS) return;
  lastWrite.set(userId, nowMs);
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(new Date(nowMs).toISOString(), userId);
}

// Al cerrar la pestaña (se corta el canal en vivo) queda la hora exacta.
export function markSeen(userId) {
  lastWrite.set(userId, Date.now());
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), userId);
}

export function presenceLabel(lastSeenAt, online, nowMs = Date.now()) {
  if (online) return 'En línea';
  if (!lastSeenAt) return 'Sin actividad reciente';
  const mins = Math.max(1, Math.round((nowMs - Date.parse(lastSeenAt)) / 60_000));
  if (mins < 60) return `Activa hace ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `Activa hace ${hours} h`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'Activa ayer';
  if (days < 30) return `Activa hace ${days} días`;
  return 'Activa hace más de un mes';
}

export function presenceOf(userId, nowMs = Date.now()) {
  const lastSeen = db.prepare('SELECT last_seen_at FROM users WHERE id = ?').get(userId)?.last_seen_at || null;
  const online = isOnline(userId) || Boolean(lastSeen && nowMs - Date.parse(lastSeen) < ONLINE_MS);
  return { online, lastSeen, label: presenceLabel(lastSeen, online, nowMs) };
}

// "Suele responder en…" (como DoorDash / Grailed): mediana del tiempo entre el primer mensaje de un
// comprador y la primera respuesta de la tienda, en las conversaciones de los últimos 90 días.
// Necesita al menos 3 conversaciones respondidas. Se guarda 10 minutos en memoria.
const replyCache = new Map();
export function replyTime(sellerId, nowMs = Date.now()) {
  const hit = replyCache.get(sellerId);
  if (hit && nowMs - hit.at < 10 * 60_000) return hit.value;
  const rows = db.prepare(`
    SELECT c.id,
      (SELECT MIN(m.created_at) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id = c.buyer_id) AS asked,
      (SELECT MIN(m.created_at) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id = c.seller_id
        AND m.created_at >= (SELECT MIN(m2.created_at) FROM messages m2 WHERE m2.conversation_id = c.id AND m2.sender_id = c.buyer_id)) AS replied
    FROM conversations c WHERE c.seller_id = ? AND c.created_at > datetime('now', '-90 days')
  `).all(sellerId);
  const toMs = (s) => Date.parse(String(s).includes('T') ? s : `${String(s).replace(' ', 'T')}Z`);
  const mins = rows.filter((r) => r.asked && r.replied).map((r) => (toMs(r.replied) - toMs(r.asked)) / 60_000).sort((a, b) => a - b);
  let value = null;
  if (mins.length >= 3) {
    const median = mins[Math.floor(mins.length / 2)];
    value = median < 60 ? 'Suele responder en menos de 1 h'
      : median < 6 * 60 ? 'Suele responder en unas horas'
        : median < 24 * 60 ? 'Suele responder el mismo día' : 'Suele responder en uno o dos días';
  }
  replyCache.set(sellerId, { at: nowMs, value });
  return value;
}
