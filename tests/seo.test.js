// robots.txt, sitemap.xml y /favicon.ico para Google y los navegadores.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { get, publishPolo, signupSeller, startServer, stopServer } from './helpers.js';

before(startServer);
after(stopServer);

test('robots.txt deja fuera las páginas privadas y apunta al sitemap', async () => {
  const res = await get('/robots.txt');
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /Disallow: \/admin/);
  assert.match(text, /Disallow: \/mensajes/);
  assert.match(text, /Sitemap: http:\/\/localhost:\d+\/sitemap\.xml/);
});

test('sitemap.xml lista páginas públicas, artículos a la venta y sus tiendas', async () => {
  const seller = await signupSeller('tienda@test.cr', 'Tienda SEO');
  const id = await publishPolo(seller);
  const res = await get('/sitemap.xml');
  assert.match(res.headers.get('content-type'), /application\/xml/);
  const text = await res.text();
  assert.match(text, /<loc>http:\/\/localhost:\d+\/como-funciona<\/loc>/);
  assert.ok(text.includes(`/p/${id}</loc><lastmod>`));
  assert.match(text, /\/u\/\d+<\/loc>/);
  assert.doesNotMatch(text, /\/admin/);
});

test('/favicon.ico lleva al logo', async () => {
  const res = await get('/favicon.ico');
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/img/logo.jpg');
});
