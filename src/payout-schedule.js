// Cuándo se le paga a la tienda: al final del día en que se completa la venta, si fue un día hábil
// antes de la hora de corte (6 p. m. por defecto, hora de Costa Rica). Si se completa después de esa
// hora, o en sábado o domingo, se paga el siguiente día hábil (lunes a viernes).
const CR_OFFSET_MS = 6 * 3600e3; // Costa Rica: UTC−6, sin horario de verano
const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export const DEFAULT_CUTOFF_HOUR = 18;

// Fecha y hora "de pared" en Costa Rica, como un Date en UTC (para leer con getUTC*).
const crClock = (ms) => new Date(ms - CR_OFFSET_MS);
const isWeekend = (d) => d.getUTCDay() === 0 || d.getUTCDay() === 6;
const ymd = (d) => d.toISOString().slice(0, 10);

const parseTs = (value) => {
  const s = String(value || '');
  const ms = Date.parse(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? Date.now() : ms;
};

// Día (en Costa Rica, "AAAA-MM-DD") en que toca pagar una venta completada en completedAt.
export function payoutDay(completedAt, cutoffHour = DEFAULT_CUTOFF_HOUR) {
  const d = crClock(parseTs(completedAt));
  const late = d.getUTCHours() >= cutoffHour;
  if (!late && !isWeekend(d)) return ymd(d);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  while (isWeekend(next)) next.setUTCDate(next.getUTCDate() + 1);
  return ymd(next);
}

export const todayCR = (nowMs = Date.now()) => ymd(crClock(nowMs));

// "hoy", "mañana" o "el lunes 20 oct", para mostrarle a la tienda.
export function payoutDayLabel(day, nowMs = Date.now()) {
  const today = todayCR(nowMs);
  if (day <= today) return 'hoy al final del día';
  const tomorrow = ymd(new Date(Date.parse(`${today}T00:00:00Z`) + 86400e3));
  if (day === tomorrow) return 'mañana al final del día';
  const d = new Date(`${day}T00:00:00Z`);
  return `el ${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} al final del día`;
}

// Hora de corte como texto ("6 p. m.").
export function cutoffLabel(hour) {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h} ${hour < 12 ? 'a. m.' : 'p. m.'}`;
}
