// Avisos en vivo con Server-Sent Events: cada usuario conectado mantiene un canal abierto
// y el servidor le avisa cuando algo cambia en una de sus conversaciones.
// En memoria: suficiente mientras el sitio corra en un solo servidor.
const channels = new Map(); // userId → Set<res>
const MAX_PER_USER = 5;      // pestañas abiertas por persona
const MAX_TOTAL = 3000;      // conexiones en total, para no agotar la memoria del servidor
let total = 0;

export function subscribe(userId, req, res) {
  if (total >= MAX_TOTAL) return res.status(503).set('Retry-After', '30').end();
  // Si la persona ya tiene muchas pestañas conectadas, se cierra la más vieja.
  const existing = channels.get(userId);
  if (existing && existing.size >= MAX_PER_USER) existing.values().next().value.end();

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');

  if (!channels.has(userId)) channels.set(userId, new Set());
  channels.get(userId).add(res);
  total += 1;
  // Comentario cada 25 s para que el proxy no cierre la conexión por inactividad.
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    total -= 1;
    clearInterval(ping);
    const set = channels.get(userId);
    set?.delete(res);
    if (set && !set.size) channels.delete(userId);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

export function notify(userIds, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const id of new Set(userIds)) {
    for (const res of channels.get(id) || []) res.write(payload);
  }
}

export function isOnline(userId) {
  return channels.has(userId);
}
