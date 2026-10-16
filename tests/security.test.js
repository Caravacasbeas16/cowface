// "¿Olvidaste tu contraseña?", protección CSRF y encabezados de seguridad.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { adminLogin, ctx, db, flashOf, get, post, signup, startServer, stopServer } from './helpers.js';

const { outbox } = await import('../src/mailer.js');
const { publicBaseUrl } = await import('../src/urls.js');

process.env.MAIL_TEST_OUTBOX = '1';
before(startServer);
after(stopServer);

const linkIn = (mail) => mail.text.match(/https?:\/\/\S+\/restablecer\/([\w-]+)/);

test('olvidé mi contraseña: misma respuesta exista o no la cuenta', async () => {
  await signup('ana@test.cr', 'Ana');
  const unknown = await (await post('/olvide', '', { email: 'nadie@test.cr' })).text();
  assert.match(unknown, /Si existe una cuenta/);
  assert.equal(outbox.length, 0, 'no se envía nada a correos sin cuenta');

  const known = await (await post('/olvide', '', { email: 'ANA@test.cr ' })).text();
  assert.match(known, /Si existe una cuenta/);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].to, 'ana@test.cr');
  assert.ok(linkIn(outbox[0]), 'el correo lleva el enlace');
  const stored = db.prepare('SELECT token_hash FROM password_resets').get().token_hash;
  assert.ok(!outbox[0].text.includes(stored), 'en la base solo está el hash, no el token');
});

test('el enlace cambia la contraseña una sola vez y cierra las sesiones abiertas', async () => {
  const oldSession = (await post('/entrar', '', { email: 'ana@test.cr', password: 'clave-segura-1' })).headers.get('set-cookie').split(';')[0];
  assert.equal((await get('/vendedor', oldSession)).status, 200);

  const token = linkIn(outbox.at(-1))[1];
  assert.equal((await get(`/restablecer/${token}`)).status, 200);
  assert.equal((await get(`/restablecer/${token}`)).headers.get('referrer-policy'), 'same-origin');
  assert.equal((await post(`/restablecer/${token}`, '', { password: 'nueva-clave-123', confirm: 'otra' })).status, 400);
  assert.equal((await post(`/restablecer/${token}`, '', { password: 'corta', confirm: 'corta' })).status, 400);

  const ok = await post(`/restablecer/${token}`, '', { password: 'nueva-clave-123', confirm: 'nueva-clave-123' });
  assert.equal(ok.headers.get('location'), '/entrar');
  assert.equal((await get('/vendedor', oldSession)).status, 302, 'la sesión vieja se cerró');
  assert.equal((await post('/entrar', '', { email: 'ana@test.cr', password: 'clave-segura-1' })).status, 401);
  assert.equal((await post('/entrar', '', { email: 'ana@test.cr', password: 'nueva-clave-123' })).status, 302);

  assert.equal((await get(`/restablecer/${token}`)).status, 410, 'no se puede reutilizar');
  assert.equal((await get('/restablecer/inventado-inventado-inventado-inventado-1234')).status, 410);
});

test('enlaces vencidos no sirven; pedir uno nuevo anula el anterior', async () => {
  await post('/olvide', '', { email: 'ana@test.cr' });
  const first = linkIn(outbox.at(-1))[1];
  await post('/olvide', '', { email: 'ana@test.cr' });
  const second = linkIn(outbox.at(-1))[1];
  assert.equal((await get(`/restablecer/${first}`)).status, 410);
  db.prepare("UPDATE password_resets SET expires_at = '2000-01-01T00:00:00.000Z'").run();
  assert.equal((await get(`/restablecer/${second}`)).status, 410);
});

test('máximo 3 correos por hora a la misma dirección', async () => {
  // Ya se pidieron 3 para ana@test.cr en las pruebas anteriores.
  const before = outbox.length;
  await post('/olvide', '', { email: 'ana@test.cr' });
  assert.equal(outbox.length, before, 'el cuarto no se envía');
});

test('el admin puede generar un enlace de respaldo', async () => {
  const admin = await adminLogin();
  const id = db.prepare("SELECT id FROM users WHERE email = 'ana@test.cr'").get().id;
  const page = await (await post(`/admin/vendedores/${id}/enlace-contrasena`, admin)).text();
  const token = page.match(/\/restablecer\/([\w-]+)/)[1];
  assert.equal((await get(`/restablecer/${token}`)).status, 200);
  const outsider = await signup('otro@test.cr', 'Otro');
  assert.equal((await post(`/admin/vendedores/${id}/enlace-contrasena`, outsider)).status, 403);
});

test('los enlaces en producción no dependen del encabezado Host (no se pueden falsificar)', () => {
  const fakeReq = { protocol: 'https', get: () => 'sitio-del-atacante.com' };
  const saved = { ...process.env };
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.PUBLIC_URL;
    delete process.env.RAILWAY_PUBLIC_DOMAIN;
    assert.throws(() => publicBaseUrl(fakeReq), /PUBLIC_URL/);
    process.env.RAILWAY_PUBLIC_DOMAIN = 'cowface-production.up.railway.app';
    assert.equal(publicBaseUrl(fakeReq), 'https://cowface-production.up.railway.app');
    process.env.PUBLIC_URL = 'https://cowface.cr/';
    assert.equal(publicBaseUrl(fakeReq), 'https://cowface.cr');
  } finally {
    process.env = saved;
  }
});

test('formularios enviados desde otro sitio se rechazan (CSRF)', async () => {
  const evil = await fetch(`${ctx.base}/entrar`, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ email: 'ana@test.cr', password: 'nueva-clave-123' }),
    headers: { Origin: 'https://sitio-malo.example' },
  });
  assert.equal(evil.status, 403);
  const same = await fetch(`${ctx.base}/entrar`, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ email: 'ana@test.cr', password: 'nueva-clave-123' }),
    headers: { Origin: ctx.base },
  });
  assert.equal(same.status, 302);
  const viaReferer = await fetch(`${ctx.base}/salir`, { method: 'POST', redirect: 'manual', headers: { Referer: 'https://sitio-malo.example/x' } });
  assert.equal(viaReferer.status, 403);
});

test('encabezados de seguridad en todas las páginas', async () => {
  const res = await get('/');
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-powered-by'), null);
  // El inicio de sesión tiene el enlace de recuperación.
  assert.match(await (await get('/entrar')).text(), /href="\/olvide"/);
  assert.equal(flashOf(res), '');
});
