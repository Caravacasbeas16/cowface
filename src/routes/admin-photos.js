// Admin → Fotos: las fotos nuevas de los artículos, ya pasadas por el filtro automático (photo-check.js).
// El admin las aprueba ("Se ven bien") o pausa el artículo y le escribe a la tienda por el chat oficial.
import { Router } from 'express';
import { requireRole } from '../auth.js';
import { adminWrites } from '../support.js';
import { publicBaseUrl } from '../urls.js';
import { approvePhotos, holdForPhotos, photoQueue } from '../photo-check.js';

const router = Router();
router.use(requireRole('admin'));

const flash = (res, message) => res.cookie('flash', message, { httpOnly: true, sameSite: 'lax', maxAge: 60_000 });

export const HOLD_REASONS = {
  ajenas: 'parecen ser de otra tienda o de internet. En CowFace cada tienda sube fotos propias del artículo real',
  calidad: 'se ven borrosas, oscuras o no dejan ver bien el artículo. Tómalas con buena luz y bien enfocadas',
  contacto: 'tienen datos de contacto (teléfono, Instagram, WhatsApp o enlaces). Eso no se permite en CowFace',
  contenido: 'no son adecuadas para CowFace',
};

router.get('/fotos', (req, res) => {
  res.render('admin/photos', { title: 'Fotos', adminActive: 'fotos', queue: photoQueue(), HOLD_REASONS });
});

router.post('/fotos/:id/ok', (req, res, next) => {
  const p = approvePhotos(Number(req.params.id));
  if (!p) return next();
  flash(res, p.photo_hold ? `«${p.title}» volvió a la venta.` : `Fotos de «${p.title}» revisadas.`);
  res.redirect('/admin/fotos');
});

// Todas las que el filtro no marcó, de una vez.
router.post('/fotos/sin-marcas', (req, res) => {
  const clean = photoQueue().filter((p) => !p.photo_hold && !p.flagged);
  for (const p of clean) approvePhotos(p.id);
  flash(res, clean.length ? `${clean.length} artículo${clean.length === 1 ? '' : 's'} sin marcas aprobado${clean.length === 1 ? '' : 's'}.` : 'No había artículos sin marcas.');
  res.redirect('/admin/fotos');
});

router.post('/fotos/:id/pausar', (req, res, next) => {
  const reason = HOLD_REASONS[req.body.reason];
  if (!reason) { flash(res, 'Elige por qué lo pausas.'); return res.redirect('/admin/fotos'); }
  const p = holdForPhotos(Number(req.params.id));
  if (!p) return next();
  const note = String(req.body.note ?? '').trim().slice(0, 500);
  adminWrites(p.seller_id, `Pausamos tu artículo «${p.title}» porque sus fotos ${reason}.${note ? ` ${note}` : ''}\n\n`
    + 'Cámbialas desde Inventario → Editar (borra las anteriores y sube las nuevas) y lo revisamos de nuevo para ponerlo a la venta.', publicBaseUrl(req));
  flash(res, `«${p.title}» pausado; le escribimos a la tienda.`);
  res.redirect('/admin/fotos');
});

export default router;
