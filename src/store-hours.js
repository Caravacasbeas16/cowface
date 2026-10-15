// Horario de atención de cada tienda (hora de Costa Rica): qué días y de qué hora a qué hora responde
// y entrega. Se muestra en su perfil, sus artículos y el directorio, con "Abierta ahora" o "Cerrada".
import { db } from './db.js';

export const DAYS = [
  ['lun', 'Lunes'], ['mar', 'Martes'], ['mie', 'Miércoles'], ['jue', 'Jueves'], ['vie', 'Viernes'], ['sab', 'Sábado'], ['dom', 'Domingo'],
];
const KEYS = DAYS.map(([k]) => k);
// getUTCDay(): 0 = domingo … 6 = sábado
const KEY_OF_WEEKDAY = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'];
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const CR_OFFSET_MS = 6 * 3600e3;

const toMinutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

// Formulario: open_lun = "1", from_lun = "09:00", to_lun = "18:00", …
export function parseHours(body) {
  const hours = {};
  for (const k of KEYS) {
    if (body[`open_${k}`] !== '1') continue;
    const from = String(body[`from_${k}`] ?? '');
    const to = String(body[`to_${k}`] ?? '');
    const label = DAYS.find(([d]) => d === k)[1];
    if (!TIME.test(from) || !TIME.test(to)) return { hours, error: `${label}: escribe la hora de apertura y de cierre.` };
    if (toMinutes(to) <= toMinutes(from)) return { hours, error: `${label}: la hora de cierre debe ser después de la de apertura.` };
    hours[k] = [from, to];
  }
  return { hours, error: null };
}

export function hoursOf(userId) {
  try {
    const parsed = JSON.parse(db.prepare('SELECT store_hours FROM users WHERE id = ?').get(userId)?.store_hours || '{}');
    const clean = {};
    for (const k of KEYS) {
      const v = parsed[k];
      if (Array.isArray(v) && TIME.test(v[0]) && TIME.test(v[1])) clean[k] = v;
    }
    return clean;
  } catch {
    return {};
  }
}

export const saveHours = (userId, hours) => db.prepare('UPDATE users SET store_hours = ? WHERE id = ?').run(JSON.stringify(hours), userId);

// "9 a. m.", "6:30 p. m."
export function timeLabel(t) {
  const h = Number(t.slice(0, 2));
  const m = t.slice(3);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m === '00' ? '' : `:${m}`} ${h < 12 ? 'a. m.' : 'p. m.'}`;
}

// Filas para mostrar: [{ label: "Lunes", text: "9 a. m. – 6 p. m." | "Cerrado" }]
export const hoursTable = (hours) => DAYS.map(([k, label]) => ({ label, text: hours[k] ? `${timeLabel(hours[k][0])} – ${timeLabel(hours[k][1])}` : 'Cerrado' }));

// Estado ahora: { has, open, label } — "Abierta ahora · cierra 6 p. m." / "Cerrada · abre mañana a las 9 a. m."
export function hoursStatus(hours, nowMs = Date.now()) {
  if (!Object.keys(hours).length) return { has: false, open: false, label: '' };
  const now = new Date(nowMs - CR_OFFSET_MS);
  const today = KEY_OF_WEEKDAY[now.getUTCDay()];
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  const t = hours[today];
  if (t && minute >= toMinutes(t[0]) && minute < toMinutes(t[1])) {
    return { has: true, open: true, label: `Abierta ahora · cierra ${timeLabel(t[1])}` };
  }
  if (t && minute < toMinutes(t[0])) return { has: true, open: false, label: `Cerrada · abre hoy a las ${timeLabel(t[0])}` };
  for (let i = 1; i <= 7; i++) {
    const key = KEY_OF_WEEKDAY[(now.getUTCDay() + i) % 7];
    if (hours[key]) {
      const when = i === 1 ? 'mañana' : `el ${DAYS.find(([d]) => d === key)[1].toLowerCase()}`;
      return { has: true, open: false, label: `Cerrada · abre ${when} a las ${timeLabel(hours[key][0])}` };
    }
  }
  return { has: true, open: false, label: 'Cerrada' };
}

export const storeHoursInfo = (userId, nowMs = Date.now()) => {
  const hours = hoursOf(userId);
  return { hours, table: hoursTable(hours), status: hoursStatus(hours, nowMs) };
};
