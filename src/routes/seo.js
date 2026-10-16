// Para Google y los navegadores: robots.txt (qué se puede indexar), sitemap.xml (las páginas
// públicas, artículos a la venta y tiendas) y /favicon.ico (algunos navegadores lo piden directo).
import { Router } from 'express';
import { db } from '../db.js';
import { publicBaseUrl } from '../urls.js';

const router = Router();
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const day = (sqlDate) => String(sqlDate || '').slice(0, 10);

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send([
    'User-agent: *',
    'Disallow: /admin', 'Disallow: /vendedor', 'Disallow: /mensajes', 'Disallow: /pedidos', 'Disallow: /adjuntos',
    'Disallow: /entrar', 'Disallow: /registro', 'Disallow: /olvide', 'Disallow: /restablecer', 'Disallow: /buscar/sugerencias', 'Disallow: /push',
    '', `Sitemap: ${publicBaseUrl(req)}/sitemap.xml`, '',
  ].join('\n'));
});

router.get('/sitemap.xml', (req, res) => {
  const base = publicBaseUrl(req);
  const pages = ['/', '/buscar', '/tiendas', '/como-funciona', '/terminos', '/privacidad'].map((p) => ({ loc: p }));
  const products = db.prepare(`
    SELECT p.id, p.created_at FROM products p JOIN users u ON u.id = p.seller_id
    WHERE p.status = 'disponible' AND u.active = 1 AND u.deleted_at IS NULL ORDER BY p.id DESC LIMIT 20000
  `).all().map((p) => ({ loc: `/p/${p.id}`, lastmod: day(p.created_at) }));
  const stores = db.prepare(`
    SELECT DISTINCT u.id FROM users u JOIN products p ON p.seller_id = u.id
    WHERE u.active = 1 AND u.deleted_at IS NULL AND p.status = 'disponible' LIMIT 5000
  `).all().map((u) => ({ loc: `/u/${u.id}` }));
  const urls = [...pages, ...stores, ...products]
    .map((u) => `  <url><loc>${xml(base + u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`);
  res.type('application/xml').set('Cache-Control', 'public, max-age=3600')
    .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
});

router.get('/favicon.ico', (req, res) => res.redirect(301, '/img/logo.jpg'));

export default router;
