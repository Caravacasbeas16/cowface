// Límite simple de intentos, en memoria (suficiente para un solo servidor).
// Por defecto cuenta por IP; con `key` se puede contar por usuario o por correo.
// Las IPv6 se agrupan por su prefijo /64, porque una sola persona suele tener miles de direcciones.

export function clientKey(ip) {
  const s = String(ip || '');
  if (s.includes(':') && !s.startsWith('::ffff:')) return s.split(':').slice(0, 4).join(':');
  return s.replace(/^::ffff:/, '');
}

export function rateLimit({ windowMs, max, message, key = (req) => clientKey(req.ip) }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, entry] of hits) if (entry.reset <= now) hits.delete(k);
  }, windowMs).unref();

  const limiter = (req, res, next) => {
    const k = key(req);
    if (!k || limiter.hit(k)) return next();
    res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
    return res.status(429).render('error', { title: 'Demasiados intentos', message });
  };
  // Cuenta un intento para la clave; devuelve false si ya pasó el límite.
  limiter.hit = (k) => {
    const now = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(k, entry);
    }
    entry.count += 1;
    return entry.count <= max;
  };
  limiter.blocked = (k) => {
    const entry = hits.get(k);
    return Boolean(entry && entry.reset > Date.now() && entry.count >= max);
  };
  return limiter;
}

// Límite por usuario con sesión (cae a la IP si no hay sesión).
export const perUser = (req) => (req.user ? `u${req.user.id}` : clientKey(req.ip));
