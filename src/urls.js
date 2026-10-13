// Dirección pública del sitio para enlaces que salen del sitio (correos, regreso de OAuth).
// En producción NO se usa el encabezado Host de la petición: un atacante podría falsificarlo
// para que el enlace de un correo apunte a su propio sitio y robar el token.
//   1. PUBLIC_URL (si la defines, p. ej. tu dominio propio)
//   2. RAILWAY_PUBLIC_DOMAIN (Railway la pone sola)
//   3. Solo fuera de producción: el host de la petición (para probar en tu computadora)
export function publicBaseUrl(req) {
  const configured = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\/[^\s/]+$/.test(configured)) return configured;
  const railway = (process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
  if (/^[a-z0-9.-]+$/i.test(railway)) return `https://${railway}`;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Define PUBLIC_URL para generar enlaces en producción.');
  }
  return `${req.protocol}://${req.get('host')}`;
}

// Para tareas en segundo plano (sin petición): la misma dirección pública, o localhost fuera de producción.
export function siteBaseUrl() {
  return publicBaseUrl({ protocol: 'http', get: () => `localhost:${process.env.PORT || 3100}` });
}
