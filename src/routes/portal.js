// Panel de la tienda: Inicio, Pedidos, Inventario, Promos, Ganancias, Reseñas y Configuración
// (como el Merchant Portal de DoorDash). Quien no tiene tienda ve su cuenta de comprador.
import { Router } from 'express';
import { requireRole } from '../auth.js';
import { db } from '../db.js';
import { CATEGORIES, ORDER_STATUS, PRODUCT_STATUS } from '../catalog.js';
import { DELIVERY_LABELS, buyerOrders } from '../orders.js';
import { listConversations } from '../chat.js';
import { listSearches } from '../alerts.js';
import { canPublish, sellerStatus } from '../approval.js';
import { MAX_POINTS, pickupPointsOf, storeAddressOf } from '../pickup.js';
import { DAYS, hoursOf, hoursStatus } from '../store-hours.js';
import { MAX_PCT, MIN_PCT, discountPct, storePromoOf, untilLabel } from '../promos.js';
import { ratingSummary, reviewsAbout } from '../reviews.js';
import { WAIT_MINUTES } from '../seller-notify.js';
import { sellerEarnings } from '../seller-earnings.js';
import { deleteProduct, markSoldElsewhere, setProductStatus } from '../products.js';
import { systemNote } from '../messages.js';
import { UPLOAD_DIR, removeFrom } from '../storage.js';
import { perUser, rateLimit } from '../rate-limit.js';
import { brandOf, brandPhotos, removeBrand, saveBrand } from '../store-branding.js';
import { favoriteCounts, followerCount } from '../social.js';
import { bumpState, inventoryCsv } from '../listing-tools.js';
import { publicBaseUrl } from '../urls.js';
import {
  BULK_ACTIONS, INVENTORY_FILTERS, INVENTORY_SORTS, MAX_PAUSE_NOTE, ORDER_TABS, STAGE_ACTION, bulkTargets, homeSummary, inventory,
  inventoryCounts, ordersByTab, parseInventoryQuery, pauseStore, resumeStore, setupChecklist, statusLabel,
} from '../store-portal.js';

const router = Router();
router.use(requireRole('usuario'));

const flash = (res, message) => res.cookie('flash', message, { httpOnly: true, sameSite: 'lax', maxAge: 60_000 });
const productCount = (id) => db.prepare("SELECT COUNT(*) AS n FROM products WHERE seller_id = ? AND status != 'borrador'").get(id).n;

// Tiene tienda: ya pidió vender (o la aprobaron), o ya publicó algo.
export const isStore = (user) => sellerStatus(user) !== 'nuevo'
  || Boolean(db.prepare('SELECT 1 FROM products WHERE seller_id = ? LIMIT 1').get(user.id));

// Lo que necesita el menú lateral en todas las páginas del panel.
function portalLocals(req, active) {
  const toAttend = ordersByTab(req.user.id).atender.length;
  const row = db.prepare('SELECT store_paused, store_logo FROM users WHERE id = ?').get(req.user.id) || {};
  return {
    portal: true, active, toAttend, paused: row.store_paused || '', storeLogo: row.store_logo || null,
    sellerState: sellerStatus(req.user), storeOpen: hoursStatus(hoursOf(req.user.id)),
  };
}

// Las páginas de tienda: si no tiene tienda, a su cuenta.
function storeOnly(req, res, next) {
  if (!isStore(req.user)) return res.redirect('/vendedor');
  next();
}

// ---------- Inicio ----------
router.get('/', (req, res) => {
  if (!isStore(req.user)) {
    return res.render('seller/account', {
      title: 'Mi cuenta', conversations: listConversations(req.user.id).slice(0, 6), purchases: buyerOrders(req.user.id).slice(0, 5),
      ORDER_STATUS, emailWait: WAIT_MINUTES,
    });
  }
  const hours = hoursOf(req.user.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.render('seller/home', {
    title: 'Mi tienda', ...portalLocals(req, 'inicio'), s: homeSummary(req.user),
    checklist: setupChecklist(user, { hours, points: pickupPointsOf(req.user.id), products: productCount(req.user.id) }),
    storePromo: storePromoOf(req.user.id), untilLabel, MAX_PAUSE_NOTE,
  });
});

// Pausar la tienda: los artículos salen de la búsqueda y nadie puede comprar hasta que la reanudes.
router.post('/pausa', storeOnly, (req, res) => {
  if (req.body.action === 'reanudar') {
    resumeStore(req.user.id);
    flash(res, '¡Tu tienda volvió a estar abierta! Tus artículos se ven otra vez en la búsqueda.');
  } else {
    pauseStore(req.user.id, req.body.note);
    flash(res, 'Tienda en pausa: tus artículos no salen en la búsqueda y nadie puede comprar hasta que la reanudes.');
  }
  res.redirect('/vendedor');
});

// ---------- Pedidos ----------
router.get('/pedidos', storeOnly, (req, res) => {
  const tabs = ordersByTab(req.user.id);
  const tab = ORDER_TABS[req.query.tab] ? req.query.tab : (tabs.atender.length || !tabs.proceso.length ? 'atender' : 'proceso');
  res.render('seller/orders', {
    title: 'Pedidos', ...portalLocals(req, 'pedidos'), tabs, tab, ORDER_TABS, DELIVERY_LABELS, STAGE_ACTION,
  });
});

// ---------- Inventario ----------
router.get('/inventario', storeOnly, (req, res) => {
  const f = parseInventoryQuery(req.query);
  res.render('seller/inventory', {
    title: 'Inventario', ...portalLocals(req, 'inventario'), f, items: inventory(req.user.id, f), counts: inventoryCounts(req.user.id),
    INVENTORY_FILTERS, INVENTORY_SORTS, BULK_ACTIONS, CATEGORIES, PRODUCT_STATUS, statusLabel, discountPct, untilLabel, favs: favoriteCounts(req.user.id),
    canPublish: canPublish(req.user), back: req.originalUrl, bumpState,
  });
});

// Todo el inventario en CSV (abre en Excel o Google Sheets).
router.get('/inventario.csv', storeOnly, (req, res) => {
  const day = new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="inventario-cowface-${day}.csv"`);
  res.send(inventoryCsv(req.user.id, publicBaseUrl(req)));
});

const safeBack = (v) => (typeof v === 'string' && /^\/vendedor\/inventario(\?[^\s]*)?$/.test(v) ? v : '/vendedor/inventario');

router.post('/inventario/lote', storeOnly, (req, res) => {
  const action = BULK_ACTIONS[req.body.action] ? req.body.action : null;
  const items = bulkTargets(req.user.id, req.body.ids ?? []);
  const back = safeBack(req.body.back);
  if (!action || !items.length) {
    flash(res, !items.length ? 'Selecciona al menos un artículo.' : 'Elige qué hacer con los artículos seleccionados.');
    return res.redirect(back);
  }
  let done = 0;
  let skipped = 0;
  const files = [];
  for (const p of items) {
    const ok = {
      pausar: () => p.status === 'disponible' && (setProductStatus(p.id, 'pausado'), true),
      activar: () => p.status === 'pausado' && p.quantity > 0 && !p.admin_hidden && canPublish(req.user) && (setProductStatus(p.id, 'disponible'), true),
      vendidos: () => ['disponible', 'pausado'].includes(p.status) && !p.locked && (markSoldElsewhere(p.id)
        .forEach((conv) => systemNote(conv, 'Este artículo ya se vendió; tu oferta quedó sin efecto.')), true),
      borrar: () => !p.locked && (files.push(...deleteProduct(p.id)), true),
    }[action]();
    if (ok) done += 1; else skipped += 1;
  }
  removeFrom(UPLOAD_DIR, files);
  const verb = { pausar: 'pausado', activar: 'activado', vendidos: 'marcado como vendido', borrar: 'borrado' }[action];
  flash(res, `${done} artículo${done === 1 ? '' : 's'} ${verb}${done === 1 ? '' : 's'}.`
    + (skipped ? ` ${skipped} no se pudo${skipped === 1 ? '' : 'ieron'} cambiar (tiene${skipped === 1 ? '' : 'n'} un pedido en curso o no estaba${skipped === 1 ? '' : 'n'} en ese estado).` : ''));
  res.redirect(back);
});

// ---------- Promos ----------
router.get('/promos', storeOnly, (req, res) => {
  const discounted = db.prepare(`
    SELECT p.id, p.title, p.price, p.compare_at_price, p.promo_until, p.promo_store, p.category,
      (SELECT COALESCE(thumb, filename) FROM product_images i WHERE i.product_id = p.id ORDER BY position LIMIT 1) AS image
    FROM products p WHERE p.seller_id = ? AND p.compare_at_price > p.price AND p.status IN ('disponible', 'pausado') ORDER BY p.promo_store, p.id DESC
  `).all(req.user.id);
  res.render('seller/promos', {
    title: 'Promos', ...portalLocals(req, 'promos'), storePromo: storePromoOf(req.user.id), discounted, discountPct, untilLabel, MIN_PCT, MAX_PCT,
  });
});

// ---------- Ganancias ----------
router.get('/ganancias', (req, res) => {
  res.render('seller/earnings', { title: 'Mis ganancias', ...(isStore(req.user) ? portalLocals(req, 'ganancias') : {}), e: sellerEarnings(req.user.id) });
});

// ---------- Reseñas ----------
router.get('/resenas', storeOnly, (req, res) => {
  const all = reviewsAbout(req.user.id, 200).filter((r) => r.role === 'vendedor');
  const dist = [5, 4, 3, 2, 1].map((n) => ({ n, count: all.filter((r) => r.rating === n).length }));
  res.render('seller/reviews', { title: 'Reseñas', ...portalLocals(req, 'resenas'), summary: ratingSummary(req.user.id).asSeller, reviews: all, dist });
});

// ---------- Configuración ----------
router.get('/configuracion', storeOnly, (req, res) => {
  const user = db.prepare('SELECT store_about FROM users WHERE id = ?').get(req.user.id);
  res.render('seller/settings', {
    title: 'Configuración', ...portalLocals(req, 'configuracion'), storeAbout: user.store_about,
    storeAddress: storeAddressOf(req.user.id), pickupPoints: pickupPointsOf(req.user.id), maxPoints: MAX_POINTS,
    hours: hoursOf(req.user.id), DAYS, emailWait: WAIT_MINUTES, brand: brandOf(req.user.id), followers: followerCount(req.user.id),
  });
});

// Logo y portada de la tienda.
const brandLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, key: perUser, message: 'Subiste muchas imágenes seguidas. Espera un rato.' });
router.post('/marca', storeOnly, brandLimit, brandPhotos, (req, res) => {
  if (req.uploadError) flash(res, req.uploadError);
  else if (!Object.keys(req.brand).length) flash(res, 'Elige una imagen para el logo o la portada.');
  else {
    saveBrand(req.user.id, req.brand);
    flash(res, req.brand.logo && req.brand.banner ? 'Logo y portada guardados.' : req.brand.logo ? 'Logo guardado.' : 'Portada guardada.');
  }
  res.redirect('/vendedor/configuracion#perfil');
});

router.post('/marca/:kind/quitar', storeOnly, (req, res) => {
  removeBrand(req.user.id, req.params.kind);
  flash(res, req.params.kind === 'logo' ? 'Logo quitado.' : 'Portada quitada.');
  res.redirect('/vendedor/configuracion#perfil');
});

export const MAX_ABOUT = 600;
router.post('/perfil', storeOnly, (req, res) => {
  const about = String(req.body.store_about ?? '').trim().slice(0, MAX_ABOUT);
  db.prepare('UPDATE users SET store_about = ? WHERE id = ?').run(about, req.user.id);
  flash(res, 'Descripción de la tienda guardada.');
  res.redirect('/vendedor/configuracion#perfil');
});

// ---------- Como comprador ----------
router.get('/compras', (req, res) => {
  res.render('seller/purchases', {
    title: 'Mis compras', ...(isStore(req.user) ? portalLocals(req, 'compras') : {}), purchases: buyerOrders(req.user.id),
    searches: listSearches(req.user.id), ORDER_STATUS,
  });
});

export default router;
