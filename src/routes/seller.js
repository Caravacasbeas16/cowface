import { Router } from 'express';
import { requireRole } from '../auth.js';
import { db, commissionRate } from '../db.js';
import { ORDER_STATUS, PRODUCT_STATUS } from '../catalog.js';
import {
  createProduct, deleteImage, deleteProduct, getProduct, imageCount, quickUpdate, sellerProducts, setCoverImage,
  setProductStatus, updateProduct,
} from '../products.js';
import { listConversations } from '../chat.js';
import { OPEN_STATUSES, buyerOrders, paymentConfig, sellerOrders } from '../orders.js';
import { perUser, rateLimit } from '../rate-limit.js';
import { normalizePhone, parsePrice, validateProduct } from '../validate.js';
import { logFlagged } from '../moderation.js';
import { MAX_IMAGES, REQUEST_MAX_PHOTOS, discardRequestPhotos, photoFiles, photos, requestPhotos } from '../uploads.js';
import { UPLOAD_DIR, removeFrom } from '../storage.js';
import { deleteSearch, listSearches, notifyMatches } from '../alerts.js';
import { publicBaseUrl } from '../urls.js';
import { notifyAdmin } from '../admin-notify.js';
import { WAIT_MINUTES } from '../seller-notify.js';
import { approvalRequired, canPublish, sellerStatus, submitRequest } from '../approval.js';
import { MAX_POINTS, pickupPointsOf, saveStoreLocation, storeAddressOf, validateStoreLocation } from '../pickup.js';
import { DAYS, hoursOf, parseHours, saveHours } from '../store-hours.js';

// Al publicar: avisos a quien guardó una búsqueda que coincide, y al admin si lo pidió.
function announce(req, id, title) {
  notifyMatches(id, publicBaseUrl(req));
  notifyAdmin('publicacion', `Nuevo artículo: ${title}`, `${req.user.store_name || req.user.name} publicó «${title}».`, `/p/${id}`);
}

const MAX_ACTIVE_LISTINGS = 300;
// Publicar y editar: máximo 30 por hora por persona (sube fotos al disco del servidor).
const listingLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, key: perUser, message: 'Estás publicando muy rápido. Espera un rato e intenta de nuevo.' });

const removeFiles = (names) => removeFrom(UPLOAD_DIR, names);
const flash = (res, message) => res.cookie('flash', message, { httpOnly: true, sameSite: 'lax', maxAge: 60_000 });

// Con un pedido en curso, el artículo no se edita ni se borra: es la evidencia si hay un reclamo.
const hasOpenOrder = (productId) => Boolean(db.prepare(
  `SELECT 1 FROM orders WHERE product_id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})`,
).get(productId, ...OPEN_STATUSES));
function lockedWhileOrdered(req, res, next) {
  if (!hasOpenOrder(req.product.id)) return next();
  removeFiles(photoFiles(req));
  flash(res, 'Este artículo tiene un pedido en curso: no se puede editar ni borrar hasta que se complete o se cancele.');
  return res.redirect('/vendedor#articulos');
}

// Si la publicación traía teléfono, redes o enlaces, queda registrado para el admin.
function flagListing(req, errors) {
  if (!errors._blocked) return;
  const b = req.body;
  logFlagged({ userId: req.user.id, context: 'publicación', body: [b.title, b.description].join(' — '), matched: errors._blocked });
  delete errors._blocked;
}

const formView = (title, product, form, errors, user = null) => ({
  title, product, form, errors, welcome: false, commissionRateNow: commissionRate(), releaseDays: paymentConfig().releaseDays,
  canPublish: user ? canPublish(user) : true, sellerState: user ? sellerStatus(user) : 'aprobado',
});

const router = Router();
router.use(requireRole('usuario'));

// Carga el producto y verifica que sea del vendedor que tiene la sesión.
router.param('id', (req, res, next, id) => {
  const product = getProduct(Number(id));
  if (!product || product.seller_id !== req.user.id) return res.status(404).render('error', { title: 'No encontrado', message: 'Ese producto no existe o no es tuyo.' });
  req.product = product;
  next();
});

router.get('/', (req, res) => {
  const products = sellerProducts(req.user.id);
  const orders = sellerOrders(req.user.id);
  const purchases = buyerOrders(req.user.id);
  const unreadSelling = listConversations(req.user.id).filter((c) => c.role === 'vendedor' && c.unread).length;
  const done = orders.filter((o) => o.status === 'completado');
  const stats = {
    available: products.filter((p) => p.status === 'disponible').length,
    drafts: products.filter((p) => p.status === 'borrador').length,
    unreadSelling,
    toShip: orders.filter((o) => o.status === 'pagado').length,
    soldTotal: done.reduce((s, o) => s + o.price, 0),
    payoutPending: done.filter((o) => o.payout_status === 'pendiente').reduce((s, o) => s + o.payout_amount, 0),
  };
  res.render('seller/dashboard', {
    title: 'Mi cuenta', products, orders, purchases, stats, searches: listSearches(req.user.id), PRODUCT_STATUS, ORDER_STATUS,
    emailWait: WAIT_MINUTES, conversations: listConversations(req.user.id).slice(0, 6), sellerState: sellerStatus(req.user),
    storeAddress: storeAddressOf(req.user.id), pickupPoints: pickupPointsOf(req.user.id), maxPoints: MAX_POINTS,
    hours: hoursOf(req.user.id), DAYS,
  });
});

// Datos para recibir los pagos de CowFace (SINPE Móvil). Se piden antes de publicar.
router.get('/pagos', (req, res) => {
  res.render('seller/payout', { title: 'Datos para recibir pagos', commissionRateNow: commissionRate(), error: null, form: req.user, next: req.query.next === 'publicar' ? 'publicar' : '' });
});

// Dirección de la tienda y puntos de pick up (se piden en la solicitud y se pueden cambiar aquí).
// Horario de atención (qué días y de qué hora a qué hora responde y entrega).
router.post('/horario', (req, res) => {
  const { hours, error } = parseHours(req.body);
  if (error) {
    flash(res, error);
    return res.redirect('/vendedor#horario');
  }
  saveHours(req.user.id, hours);
  flash(res, Object.keys(hours).length ? 'Horario guardado.' : 'Horario borrado: tu tienda ya no muestra horario.');
  res.redirect('/vendedor#horario');
});

router.post('/tienda', (req, res) => {
  const { address, points, errors } = validateStoreLocation(req.body);
  if (Object.keys(errors).length) {
    flash(res, Object.values(errors).join(' '));
    return res.redirect('/vendedor#tienda');
  }
  saveStoreLocation(req.user.id, address, points);
  flash(res, 'Dirección y puntos de entrega guardados.');
  res.redirect('/vendedor#tienda');
});

router.post('/avisos-correo', (req, res) => {
  const on = req.body.email_messages === '1';
  db.prepare('UPDATE users SET email_messages = ? WHERE id = ?').run(on ? 1 : 0, req.user.id);
  flash(res, on ? 'Te avisaremos por correo cuando te escriban.' : 'Ya no te mandaremos correos por mensajes nuevos.');
  res.redirect('/vendedor#avisos-correo');
});

router.post('/pagos', (req, res) => {
  const phone = normalizePhone(req.body.payout_phone);
  const name = String(req.body.payout_name ?? '').trim().slice(0, 80);
  if (!phone || name.length < 3) {
    return res.status(400).render('seller/payout', {
      title: 'Datos para recibir pagos', commissionRateNow: commissionRate(), error: 'Escribe un número SINPE Móvil de 8 dígitos y el nombre del titular.', form: req.body, next: req.body.next,
    });
  }
  db.prepare('UPDATE users SET payout_phone = ?, payout_name = ? WHERE id = ?').run(phone, name, req.user.id);
  res.redirect(req.body.next === 'publicar' ? '/vendedor/productos/nuevo' : '/vendedor');
});

const needsPayout = (req) => !req.user.payout_phone || !req.user.payout_name;

// Solicitud para vender: el admin aprueba cada tienda antes de que pueda publicar.
const requestView = (req, form = null, errors = {}) => {
  const saved = db.prepare('SELECT seller_request, seller_note, store_address, pickup_points FROM users WHERE id = ?').get(req.user.id);
  const request = JSON.parse(saved?.seller_request || '{}');
  return {
    title: 'Vender en CowFace', status: sellerStatus(req.user), note: saved?.seller_note || '', errors, maxPhotos: REQUEST_MAX_PHOTOS,
    form: form || {
      store_name: req.user.store_name || '', instagram: request.instagram || '', about: request.about || '',
      store_address: saved?.store_address || '', pickup_points: pickupPointsOf(req.user.id).join('\n'),
    },
    maxPoints: MAX_POINTS,
  };
};

router.get('/solicitud', (req, res) => {
  if (needsPayout(req)) return res.redirect('/vendedor/pagos?next=publicar');
  if (canPublish(req.user)) return res.redirect('/vendedor/productos/nuevo');
  res.render('seller/request', requestView(req));
});

router.post('/solicitud', requestPhotos, (req, res) => {
  if (canPublish(req.user) || sellerStatus(req.user) === 'pendiente') {
    discardRequestPhotos(req);
    return res.redirect(canPublish(req.user) ? '/vendedor/productos/nuevo' : '/vendedor/solicitud');
  }
  if (req.uploadError) return res.status(400).render('seller/request', requestView(req, req.body, { productos: req.uploadError }));
  const { errors, data } = submitRequest(req.user, req.body, req.requestPhotos);
  if (errors) {
    discardRequestPhotos(req);
    return res.status(400).render('seller/request', requestView(req, data, errors));
  }
  flash(res, 'Recibimos tu solicitud. Te avisamos por correo cuando la revisemos; mientras tanto puedes ir guardando borradores.');
  res.redirect('/vendedor/solicitud');
});

// Sin aprobación (y sin solicitud en revisión) no se entra al formulario de publicar.
const needsRequest = (req) => approvalRequired() && ['nuevo', 'rechazado'].includes(sellerStatus(req.user));

router.get('/productos/nuevo', (req, res) => {
  if (needsPayout(req)) return res.redirect('/vendedor/pagos?next=publicar');
  if (needsRequest(req)) return res.redirect('/vendedor/solicitud');
  res.render('seller/product-form', {
    ...formView('Publicar artículo', null, { quantity: 1, meetup: 1, shipping_cost: '' }, {}, req.user), welcome: req.query.bienvenida === '1',
  });
});

// action=borrador guarda sin publicar (no exige fotos); cualquier otro valor publica.
router.post('/productos/nuevo', listingLimit, photos, (req, res) => {
  const active = db.prepare("SELECT COUNT(*) AS n FROM products WHERE seller_id = ? AND status IN ('disponible', 'pausado', 'reservado', 'borrador')").get(req.user.id).n;
  if (active >= MAX_ACTIVE_LISTINGS) {
    removeFiles(photoFiles(req));
    return res.status(400).render('error', { title: 'Límite de artículos', message: `Puedes tener hasta ${MAX_ACTIVE_LISTINGS} artículos activos o en borrador. Borra o marca como vendidos algunos antes de publicar más.` });
  }
  if (needsPayout(req)) { removeFiles(photoFiles(req)); return res.redirect('/vendedor/pagos?next=publicar'); }
  if (needsRequest(req)) { removeFiles(photoFiles(req)); return res.redirect('/vendedor/solicitud'); }
  // Tienda en revisión: todo queda como borrador hasta que la aprueben.
  const draft = req.body.action === 'borrador' || !canPublish(req.user);
  const { data, errors } = validateProduct(req.body);
  if (req.uploadError) errors.photos = req.uploadError;
  else if (!draft && !req.photos.length) errors.photos = 'Agrega al menos una foto para publicar (o guarda como borrador).';
  flagListing(req, errors);
  if (Object.keys(errors).length) {
    removeFiles(photoFiles(req));
    return res.status(400).render('seller/product-form', formView('Publicar artículo', null, req.body, errors, req.user));
  }
  const id = createProduct(req.user.id, data, req.photos, draft ? 'borrador' : 'disponible');
  if (draft) {
    flash(res, canPublish(req.user) ? 'Borrador guardado. Nadie lo ve hasta que lo publiques.' : 'Borrador guardado. Lo vas a poder publicar cuando aprobemos tu tienda.');
    return res.redirect(`/vendedor/productos/${id}/editar`);
  }
  announce(req, id, data.title);
  res.redirect(`/p/${id}?publicado=1`);
});

router.get('/productos/:id/editar', lockedWhileOrdered, (req, res) => {
  const form = { ...req.product };
  for (const [k, v] of Object.entries(req.product.measurements || {})) form[`m_${k}`] = v;
  res.render('seller/product-form', formView(req.product.status === 'borrador' ? 'Borrador' : 'Editar artículo', req.product, form, {}, req.user));
});

router.post('/productos/:id/editar', listingLimit, photos, lockedWhileOrdered, (req, res) => {
  const { data, errors } = validateProduct(req.body);
  const current = imageCount(req.product.id);
  const publish = req.product.status === 'borrador' && req.body.action !== 'borrador' && canPublish(req.user);
  if (req.uploadError) errors.photos = req.uploadError;
  else if (current + req.photos.length > MAX_IMAGES) errors.photos = `Máximo ${MAX_IMAGES} fotos por artículo (ya tiene ${current}).`;
  else if (current + req.photos.length === 0 && (publish || req.product.status !== 'borrador')) errors.photos = 'El artículo necesita al menos una foto.';
  flagListing(req, errors);
  if (Object.keys(errors).length) {
    removeFiles(photoFiles(req));
    return res.status(400).render('seller/product-form', formView('Editar artículo', req.product, req.body, errors, req.user));
  }
  updateProduct(req.product.id, data, req.photos, { publish });
  if (publish) announce(req, req.product.id, data.title);
  if (req.product.status === 'borrador' && !publish) {
    flash(res, 'Borrador guardado.');
    return res.redirect(`/vendedor/productos/${req.product.id}/editar`);
  }
  res.redirect(`/p/${req.product.id}${publish ? '?publicado=1' : ''}`);
});

router.post('/productos/:id/fotos/:imageId/borrar', lockedWhileOrdered, (req, res) => {
  if (req.product.images.length <= 1 && req.product.status !== 'borrador') {
    flash(res, 'El artículo necesita al menos una foto: sube otra antes de borrar esta.');
  } else {
    removeFiles(deleteImage(req.product.id, Number(req.params.imageId)));
  }
  res.redirect(`/vendedor/productos/${req.product.id}/editar`);
});

router.post('/productos/:id/fotos/:imageId/portada', (req, res) => {
  setCoverImage(req.product.id, Number(req.params.imageId));
  res.redirect(`/vendedor/productos/${req.product.id}/editar`);
});

// Edición rápida de precio y cantidad desde "Mi cuenta".
router.post('/productos/:id/rapido', lockedWhileOrdered, (req, res) => {
  const price = parsePrice(req.body.price);
  const quantity = Number.parseInt(req.body.quantity, 10);
  if (quantity > 0 && req.product.status === 'vendido' && !canPublish(req.user)) {
    flash(res, 'Tu tienda no está aprobada para vender en este momento.');
  } else if (!price || !Number.isInteger(quantity) || quantity < 0 || quantity > 999) {
    flash(res, 'Revisa el precio (en colones) y la cantidad (0 a 999).');
  } else {
    quickUpdate(req.product.id, price, quantity);
    flash(res, `"${req.product.title}" actualizado.`);
  }
  res.redirect('/vendedor#articulos');
});

// El vendedor solo pausa o reactiva; "reservado" y "vendido" los maneja el flujo de ventas.
router.post('/productos/:id/estado', (req, res) => {
  const manual = ['disponible', 'pausado'];
  if (req.body.status === 'disponible' && !canPublish(req.user)) {
    flash(res, 'Tu tienda no está aprobada para vender en este momento.');
    return res.redirect('/vendedor#articulos');
  }
  if (manual.includes(req.product.status) && manual.includes(req.body.status) && req.product.quantity > 0) {
    setProductStatus(req.product.id, req.body.status);
  }
  res.redirect('/vendedor#articulos');
});

router.post('/productos/:id/borrar', lockedWhileOrdered, (req, res) => {
  removeFiles(deleteProduct(req.product.id));
  res.redirect('/vendedor#articulos');
});

router.post('/avisos/:searchId/borrar', (req, res) => {
  deleteSearch(req.user.id, Number(req.params.searchId));
  res.redirect('/vendedor#avisos');
});

export default router;
