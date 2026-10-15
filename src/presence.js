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
