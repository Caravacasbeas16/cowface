import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { requireRole } from '../auth.js';
import { db, commissionRate } from '../db.js';
import { ORDER_STATUS, PRODUCT_STATUS } from '../catalog.js';
import {
  createProduct, deleteImage, deleteProduct, getProduct, imageCount, sellerProducts, setProductStatus, updateProduct,
} from '../products.js';
import { listConversations } from '../chat.js';
import { OPEN_STATUSES, buyerOrders, sellerOrders } from '../orders.js';
import { perUser, rateLimit } from '../rate-limit.js';
import { normalizePhone } from '../validate.js';
import { logFlagged } from '../moderation.js';
import { safeNext, validateProduct } from '../validate.js';

const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH;
export const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || (VOLUME ? path.join(VOLUME, 'uploads') : 'uploads'));
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_IMAGES = 6;
const MAX_ACTIVE_LISTINGS = 300;
// Publicar y editar: máximo 30 por hora por persona (sube fotos al disco del servidor).
const listingLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, key: perUser, message: 'Estás publicando muy rápido. Espera un rato e intenta de nuevo.' });

// El tipo que manda el navegador se puede falsificar: se revisan los primeros bytes del archivo.
const SIGNATURES = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};
function realImages(files) {
  return files.every((f) => {
    const head = Buffer.alloc(12);
    const fd = fs.openSync(f.path, 'r');
    try { fs.readSync(fd, head, 0, 12, 0); } finally { fs.closeSync(fd); }
    return SIGNATURES[f.mimetype]?.(head) === true;
  });
}

// Con un pedido en curso, el artículo no se edita ni se borra: es la evidencia si hay un reclamo.
const hasOpenOrder = (productId) => Boolean(db.prepare(
  `SELECT 1 FROM orders WHERE product_id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})`,
).get(productId, ...OPEN_STATUSES));
function lockedWhileOrdered(req, res, next) {
  if (!hasOpenOrder(req.product.id)) return next();
  removeFiles((req.files || []).map((f) => f.filename));
  res.cookie('flash', 'Este artículo tiene un pedido en curso: no se puede editar ni borrar hasta que se complete o se cancele.', { httpOnly: true, sameSite: 'lax', maxAge: 60_000 });
  return res.redirect('/vendedor#articulos');
}
const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + IMAGE_TYPES[file.mimetype]),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: MAX_IMAGES },
  fileFilter: (req, file, cb) => cb(null, Boolean(IMAGE_TYPES[file.mimetype])),
});

// Envuelve multer para mostrar sus errores (archivo muy grande, demasiados) en el formulario.
function photos(req, res, next) {
  upload.array('photos', MAX_IMAGES)(req, res, (err) => {
    req.uploadError = err ? (err.code === 'LIMIT_FILE_SIZE' ? 'Cada foto debe pesar menos de 5 MB.' : `Máximo ${MAX_IMAGES} fotos.`) : null;
    if (!req.uploadError && req.files?.length && !realImages(req.files)) req.uploadError = 'Una de las fotos no es una imagen válida (JPG, PNG o WebP).';
    next();
  });
}

function removeFiles(names) {
  for (const name of names) fs.rm(path.join(UPLOAD_DIR, path.basename(name)), { force: true }, () => {});
}

// Si la publicación traía teléfono, redes o enlaces, queda registrado para el admin.
function flagListing(req, errors) {
  if (!errors._blocked) return;
  const b = req.body;
  logFlagged({ userId: req.user.id, context: 'publicación', body: [b.title, b.description].join(' — '), matched: errors._blocked });
  delete errors._blocked;
}

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
    unreadSelling,
    toShip: orders.filter((o) => o.status === 'pagado').length,
    soldTotal: done.reduce((s, o) => s + o.price, 0),
    payoutPending: done.filter((o) => o.payout_status === 'pendiente').reduce((s, o) => s + o.payout_amount, 0),
  };
  res.render('seller/dashboard', { title: 'Mi cuenta', products, orders, purchases, stats, PRODUCT_STATUS, ORDER_STATUS });
});

// Datos para recibir los pagos de CowFace (SINPE Móvil). Se piden antes de publicar.
router.get('/pagos', (req, res) => {
  res.render('seller/payout', { title: 'Datos para recibir pagos', commissionRateNow: commissionRate(), error: null, form: req.user, next: req.query.next === 'publicar' ? 'publicar' : '' });
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

router.get('/productos/nuevo', (req, res) => {
  if (needsPayout(req)) return res.redirect('/vendedor/pagos?next=publicar');
  res.render('seller/product-form', {
    title: 'Publicar artículo', product: null, form: { quantity: 1 }, errors: {}, welcome: req.query.bienvenida === '1',
  });
});

router.post('/productos/nuevo', listingLimit, photos, (req, res) => {
  const active = db.prepare("SELECT COUNT(*) AS n FROM products WHERE seller_id = ? AND status IN ('disponible', 'pausado', 'reservado')").get(req.user.id).n;
  if (active >= MAX_ACTIVE_LISTINGS) {
    removeFiles((req.files || []).map((f) => f.filename));
    return res.status(400).render('error', { title: 'Límite de artículos', message: `Puedes tener hasta ${MAX_ACTIVE_LISTINGS} artículos activos. Borra o marca como vendidos algunos antes de publicar más.` });
  }
  if (needsPayout(req)) { removeFiles((req.files || []).map((f) => f.filename)); return res.redirect('/vendedor/pagos?next=publicar'); }
  const { data, errors } = validateProduct(req.body);
  const files = (req.files || []).map((f) => f.filename);
  if (req.uploadError) errors.photos = req.uploadError;
  flagListing(req, errors);
  if (Object.keys(errors).length) {
    removeFiles(files);
    return res.status(400).render('seller/product-form', { title: 'Publicar artículo', product: null, form: req.body, errors, welcome: false });
  }
  const id = createProduct(req.user.id, data, files);
  res.redirect(`/p/${id}`);
});

router.get('/productos/:id/editar', lockedWhileOrdered, (req, res) => {
  res.render('seller/product-form', { title: 'Editar artículo', product: req.product, form: req.product, errors: {}, welcome: false });
});

router.post('/productos/:id/editar', listingLimit, photos, lockedWhileOrdered, (req, res) => {
  const { data, errors } = validateProduct(req.body);
  const files = (req.files || []).map((f) => f.filename);
  if (req.uploadError) errors.photos = req.uploadError;
  else if (imageCount(req.product.id) + files.length > MAX_IMAGES) errors.photos = `Máximo ${MAX_IMAGES} fotos por artículo.`;
  flagListing(req, errors);
  if (Object.keys(errors).length) {
    removeFiles(files);
    return res.status(400).render('seller/product-form', { title: 'Editar artículo', product: req.product, form: req.body, errors, welcome: false });
  }
  updateProduct(req.product.id, data, files);
  res.redirect(`/p/${req.product.id}`);
});

router.post('/productos/:id/fotos/:imageId/borrar', lockedWhileOrdered, (req, res) => {
  const name = deleteImage(req.product.id, Number(req.params.imageId));
  if (name) removeFiles([name]);
  res.redirect(`/vendedor/productos/${req.product.id}/editar`);
});

// El vendedor solo pausa o reactiva; "reservado" y "vendido" los maneja el flujo de ventas.
router.post('/productos/:id/estado', (req, res) => {
  const manual = ['disponible', 'pausado'];
  if (manual.includes(req.product.status) && manual.includes(req.body.status) && req.product.quantity > 0) {
    setProductStatus(req.product.id, req.body.status);
  }
  res.redirect('/vendedor');
});

router.post('/productos/:id/borrar', lockedWhileOrdered, (req, res) => {
  removeFiles(deleteProduct(req.product.id));
  res.redirect('/vendedor');
});


export default router;
