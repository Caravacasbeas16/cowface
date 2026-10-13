// Dominio propio: con PUBLIC_URL, la dirección de Railway y "www." redirigen al dominio principal.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from './helpers.js';

let server;
after(() => server?.close());

// fetch no deja cambiar el encabezado Host: se usa http directamente.
const request = (port, host, path, method = 'GET') => new Promise((resolve, reject) => {
  http.request({ port, path, method, headers: { host } }, (res) => { res.resume(); resolve(res); }).on('error', reject).end();
});

test('redirige al dominio principal, salvo la revisión de salud y el service worker', async () => {
  const before = { env: process.env.NODE_ENV, url: process.env.PUBLIC_URL };
  process.env.NODE_ENV = 'production';
  process.env.PUBLIC_URL = 'https://cowface.store';
  try {
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address();

    const old = await request(port, 'cowface-production.up.railway.app', '/p/12?publicado=1');
    assert.equal(old.statusCode, 301);
    assert.equal(old.headers.location, 'https://cowface.store/p/12?publicado=1');
    assert.equal((await request(port, 'www.cowface.store', '/buscar?q=nike')).headers.location, 'https://cowface.store/buscar?q=nike');
    assert.notEqual((await request(port, 'cowface.store', '/salud')).statusCode, 301);
    assert.equal((await request(port, 'cowface-production.up.railway.app', '/salud')).statusCode, 200);
    assert.equal((await request(port, 'cowface-production.up.railway.app', '/sw.js')).statusCode, 200);
    assert.notEqual((await request(port, 'cowface-production.up.railway.app', '/entrar', 'POST')).statusCode, 301, 'los POST no se redirigen');
  } finally {
    process.env.NODE_ENV = before.env ?? '';
    if (before.url === undefined) delete process.env.PUBLIC_URL; else process.env.PUBLIC_URL = before.url;
  }
});
