import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// En Railway, si hay un volumen montado, todo se guarda ahí (sobrevive a cada publicación).
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const DATA_DIR = path.resolve(process.env.DATA_DIR || (VOLUME ? path.join(VOLUME, 'db') : 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(process.env.DB_PATH || path.join(DATA_DIR, 'cowface.db'));

// Versiones del esquema. Desde la 3 (la primera publicada) los cambios son migraciones que
// conservan los datos: solo se agregan tablas o columnas, nunca se borra nada.
//   3 → 4: reseñas, bloqueos entre usuarios y cuentas de Google/Facebook.
//   4 → 5: enlaces para restablecer la contraseña.
//   5 → 6: miniatura de cada foto (product_images.thumb).
//   6 → 7: foto original, medidas y envío por artículo, adjuntos en el chat, envío y comprobantes
//          en pedidos, búsquedas guardadas ("Avísame").
const SCHEMA_VERSION = 23;
const FIRST_MIGRATABLE = 3;
const hasTables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'users'").get().n > 0;
const version = db.prepare('PRAGMA user_version').get().user_version;
if (hasTables && version < FIRST_MIGRATABLE) {
  throw new Error('La base de datos es de una versión de prueba muy anterior. Bórrala (carpeta data/) y corre "npm run seed".');
}

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Una sola cuenta sirve para comprar y vender, como en Grailed.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  role          TEXT NOT NULL CHECK (role IN ('usuario', 'admin')),
  name          TEXT NOT NULL,
  store_name    TEXT,
  email         TEXT NOT NULL UNIQUE,
  phone         TEXT,               -- privado: nunca se muestra a otros usuarios
  payout_phone  TEXT,               -- SINPE Móvil donde el vendedor recibe sus pagos
  payout_name   TEXT,               -- titular de esa cuenta
  province      TEXT,
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY,
  seller_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  brand       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL,
  department  TEXT NOT NULL,
  item_type   TEXT NOT NULL,
  size        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '',
  condition   TEXT NOT NULL,
  price       INTEGER NOT NULL CHECK (price > 0),
  quantity    INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  status      TEXT NOT NULL DEFAULT 'disponible',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_search ON products (status, category, size);

CREATE TABLE IF NOT EXISTS product_images (
  id         INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0
);

-- Una conversación por (artículo, comprador).
CREATE TABLE IF NOT EXISTS conversations (
  id              INTEGER PRIMARY KEY,
  product_id      INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_title   TEXT NOT NULL,
  buyer_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_message_at TEXT NOT NULL DEFAULT (datetime('now')),
  buyer_read_at   TEXT NOT NULL DEFAULT '',
  seller_read_at  TEXT NOT NULL DEFAULT '',
  UNIQUE (product_id, buyer_id)
);
CREATE INDEX IF NOT EXISTS idx_conv_buyer ON conversations (buyer_id, last_message_at);
CREATE INDEX IF NOT EXISTS idx_conv_seller ON conversations (seller_id, last_message_at);

CREATE TABLE IF NOT EXISTS offers (
  id              INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  product_id      INTEGER REFERENCES products(id) ON DELETE SET NULL,
  amount          INTEGER NOT NULL CHECK (amount > 0),
  made_by         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pendiente',
  expires_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  responded_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_offers_conv ON offers (conversation_id, status);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('texto', 'oferta', 'sistema')),
  body            TEXT NOT NULL DEFAULT '',
  offer_id        INTEGER REFERENCES offers(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (conversation_id, id);

-- Venta con pago a través de CowFace (como Grailed): el comprador le paga a CowFace,
-- CowFace retiene el dinero y se lo pasa al vendedor (menos la comisión) cuando el comprador recibe.
-- Estados: por_pagar → pagado → enviado → completado
--          por_pagar → cancelado · pagado/enviado → en_disputa → completado | reembolso_pendiente → reembolsado
CREATE TABLE IF NOT EXISTS orders (
  id                  INTEGER PRIMARY KEY,
  code                TEXT NOT NULL UNIQUE,
  product_id          INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_title       TEXT NOT NULL,
  seller_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  buyer_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id     INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  source              TEXT NOT NULL CHECK (source IN ('compra', 'oferta')),
  list_price          INTEGER NOT NULL,
  price               INTEGER NOT NULL,
  commission_rate     REAL NOT NULL,
  commission_amount   INTEGER NOT NULL,
  payout_amount       INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'por_pagar',
  payment_due_at      TEXT NOT NULL,
  payment_reported_at TEXT,
  payment_reference   TEXT,
  delivery_method     TEXT,
  delivery_address    TEXT,
  delivery_phone      TEXT,
  paid_at             TEXT,
  shipped_at          TEXT,
  shipping_note       TEXT,
  auto_release_at     TEXT,
  completed_at        TEXT,
  dispute_reason      TEXT,
  admin_note          TEXT,
  payout_status       TEXT NOT NULL DEFAULT '',   -- '' | pendiente | pagado
  payout_paid_at      TEXT,
  refunded_at         TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);

-- Mensajes que el filtro bloqueó: el admin los revisa para detectar a quien intenta sacar la venta.
CREATE TABLE IF NOT EXISTS flagged_messages (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  context         TEXT NOT NULL,
  body            TEXT NOT NULL,
  matched         TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('commission_rate', '0.05');

-- Reseñas: una por pedido completado y por dirección (comprador → vendedor, vendedor → comprador).
CREATE TABLE IF NOT EXISTS reviews (
  id          INTEGER PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  author_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('comprador', 'vendedor')),  -- papel de quien recibe la reseña
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (order_id, author_id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_subject ON reviews (subject_id, created_at);

-- Bloqueos entre usuarios: si cualquiera de los dos bloqueó al otro, no hay chat ni tratos nuevos.
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id != blocked_id)
);

-- Inicios de sesión con Google o Facebook vinculados a una cuenta.
CREATE TABLE IF NOT EXISTS oauth_accounts (
  provider    TEXT NOT NULL CHECK (provider IN ('google', 'facebook')),
  subject     TEXT NOT NULL,      -- id del usuario en ese proveedor
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, subject)
);

-- Enlaces de un solo uso para restablecer la contraseña. Solo se guarda el hash del token:
-- si alguien leyera la base, no podría usar los enlaces.
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets (user_id);

-- "Avísame cuando haya…": búsquedas guardadas que mandan un correo cuando se publica algo que coincide.
CREATE TABLE IF NOT EXISTS saved_searches (
  id               INTEGER PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query            TEXT NOT NULL,       -- la búsqueda como querystring (?categoria=ropa&talla=M…)
  label            TEXT NOT NULL,
  last_notified_at TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, query)
);

`);

// Columnas nuevas en tablas que ya existen (CREATE TABLE IF NOT EXISTS no las agrega).
const hasColumn = (table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
const addColumn = (table, column, definition) => {
  if (!hasColumn(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
};
addColumn('product_images', 'thumb', 'TEXT');
addColumn('product_images', 'original', 'TEXT');        // la foto tal como se subió (sin metadatos)
addColumn('products', 'measurements', "TEXT NOT NULL DEFAULT '{}'"); // JSON: { pecho: 56, largo: 72, … } en cm
addColumn('products', 'shipping_cost', 'INTEGER NOT NULL DEFAULT 0'); // lo paga el comprador; 0 = envío gratis
addColumn('products', 'meetup', 'INTEGER NOT NULL DEFAULT 1');      // acepta entrega en persona sin costo
addColumn('messages', 'attachment', 'TEXT');           // foto o PDF enviado en el chat
addColumn('messages', 'attachment_type', 'TEXT');      // 'imagen' | 'pdf'
addColumn('orders', 'shipping_cost', 'INTEGER NOT NULL DEFAULT 0');
addColumn('orders', 'total', 'INTEGER');               // precio + envío: lo que paga el comprador
addColumn('orders', 'payment_proof', 'TEXT');          // captura del SINPE que sube el comprador
addColumn('orders', 'shipping_proof', 'TEXT');         // foto de la guía o del paquete que sube el vendedor
addColumn('orders', 'dispute_evidence', 'TEXT');       // foto que adjunta el comprador al reclamar
addColumn('users', 'featured_until', 'TEXT');         // tienda destacada hasta esta fecha (ISO); NULL = no destacada
addColumn('users', 'email_messages', 'INTEGER NOT NULL DEFAULT 1');   // 1 = recibe un correo cuando le escriben y no lo ha leído
addColumn('conversations', 'seller_notified_at', 'TEXT'); // último correo al vendedor por esta conversación
addColumn('products', 'search_text', "TEXT NOT NULL DEFAULT ''"); // texto normalizado para buscar (ver search-text.js)
// Historial de antes de CowFace (lo pone el admin): se suma a las ventas y reseñas de la plataforma.
addColumn('users', 'sales_base', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'reviews_base_count', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'reviews_base_avg', 'REAL NOT NULL DEFAULT 0');
addColumn('users', 'history_source', "TEXT NOT NULL DEFAULT ''");  // de dónde viene (ej. "Instagram")
addColumn('orders', 'data_sent_at', 'TEXT');           // cuándo el admin le mandó a la tienda los datos de entrega
// Entrega "como un Uber": el comprador pide una forma de entrega y la tienda cotiza el envío.
addColumn('orders', 'delivery_requested', 'TEXT');     // lo que pidió el comprador (correos, uber_flash, pick_up)
addColumn('orders', 'delivery_quote_at', 'TEXT');      // cuándo quedó definida la entrega (cotización o pick up)
addColumn('orders', 'delivery_note', "TEXT NOT NULL DEFAULT ''"); // nota de la tienda en la cotización
// Pedidos ya pagados o con pago avisado tenían la entrega definida.
db.exec("UPDATE orders SET delivery_quote_at = COALESCE(payment_reported_at, created_at) WHERE delivery_quote_at IS NULL AND delivery_method IS NOT NULL");

// Aprobación de tiendas: 'nuevo' (no ha pedido vender), 'pendiente', 'aprobado' o 'rechazado'.
// Al crear la columna, quien ya venía vendiendo (artículos, ventas o datos de pago) queda aprobado.
const hadSellerStatus = hasColumn('users', 'seller_status');
addColumn('users', 'seller_status', "TEXT NOT NULL DEFAULT 'nuevo'");
addColumn('users', 'seller_request', "TEXT NOT NULL DEFAULT '{}'"); // JSON: { instagram, about, requested_at }
addColumn('users', 'seller_note', "TEXT NOT NULL DEFAULT ''");       // motivo si se rechazó
addColumn('users', 'store_address', "TEXT NOT NULL DEFAULT ''");     // dirección de la tienda (privada: solo el admin)
addColumn('users', 'pickup_points', "TEXT NOT NULL DEFAULT '[]'");   // JSON: puntos públicos para pick up / entrega en persona
addColumn('users', 'store_hours', "TEXT NOT NULL DEFAULT '{}'");     // JSON: { lun: ["09:00","18:00"], … } horario de atención
addColumn('users', 'last_seen_at', 'TEXT');             // última vez que usó el sitio (para "activa hace…")
// Promos y descuentos: el precio de venta baja y el de antes queda en compare_at_price (se muestra tachado).
addColumn('products', 'compare_at_price', 'INTEGER');   // precio antes del descuento (NULL = sin descuento)
addColumn('products', 'promo_until', 'TEXT');           // cuándo termina el descuento (ISO); NULL = sin fecha
addColumn('products', 'promo_store', 'INTEGER NOT NULL DEFAULT 0'); // 1 = el descuento viene de la promo de toda la tienda
addColumn('users', 'store_promo', "TEXT NOT NULL DEFAULT '{}'");    // JSON: { pct, until, label } promo de toda la tienda
addColumn('users', 'deleted_at', 'TEXT');               // la persona borró su cuenta (queda anónima)
addColumn('products', 'admin_hidden', 'INTEGER NOT NULL DEFAULT 0'); // 1 = el admin lo ocultó por un reporte
// Panel de la tienda (como el de DoorDash): pausar la tienda, descripción y vistas de cada artículo.
addColumn('users', 'store_paused', "TEXT NOT NULL DEFAULT ''");     // '' = abierta; si no, el aviso (ej. "Volvemos el lunes")
const hadStoreAbout = hasColumn('users', 'store_about');
addColumn('users', 'store_about', "TEXT NOT NULL DEFAULT ''");      // descripción pública de la tienda
// Una sola vez: arranca con lo que la tienda escribió en su solicitud.
if (!hadStoreAbout) db.exec("UPDATE users SET store_about = COALESCE(json_extract(seller_request, '$.about'), '') WHERE json_valid(seller_request)");
addColumn('products', 'views', 'INTEGER NOT NULL DEFAULT 0');       // veces que otra persona abrió el artículo

// Tallas con su propia cantidad (ver variants.js) y detalles por categoría (como Grailed y StockX).
db.exec(`
CREATE TABLE IF NOT EXISTS product_sizes (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size       TEXT NOT NULL,
  quantity   INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  position   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, size)
);
`);
addColumn('products', 'has_sizes', 'INTEGER NOT NULL DEFAULT 0');   // 1 = varias tallas con su cantidad (product_sizes)
addColumn('products', 'details', "TEXT NOT NULL DEFAULT '{}'");     // JSON: { material, modelo, sku, caja, defectos, … }
addColumn('products', 'retail_price', 'INTEGER');                  // precio original en tienda (opcional)
addColumn('conversations', 'chosen_size', 'TEXT');                 // talla que eligió el comprador
addColumn('orders', 'chosen_size', 'TEXT');                        // talla vendida (para devolverla al inventario)

// Logo y portada de la tienda; seguir tiendas y guardar artículos en favoritos (como Grailed).
addColumn('users', 'store_logo', 'TEXT');
addColumn('users', 'store_banner', 'TEXT');
db.exec(`
CREATE TABLE IF NOT EXISTS store_follows (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, store_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_store ON store_follows (store_id);
CREATE TABLE IF NOT EXISTS favorites (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  notified_price INTEGER NOT NULL,   -- último precio que vio o del que se le avisó (para avisar si baja)
  PRIMARY KEY (user_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_favorites_product ON favorites (product_id);
`);
addColumn('products', 'bumped_at', 'TEXT');   // "Subir al inicio" (como Grailed): cuenta como recién publicado

// Reportes de artículos, personas y conversaciones (requisito de Google Play / App Store).
db.exec(`
CREATE TABLE IF NOT EXISTS reports (
  id           INTEGER PRIMARY KEY,
  reporter_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type  TEXT NOT NULL CHECK (target_type IN ('articulo', 'usuario', 'conversacion')),
  target_id    INTEGER NOT NULL,
  reason       TEXT NOT NULL,
  details      TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'abierto' CHECK (status IN ('abierto', 'resuelto')),
  resolution   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status, id);
`);

// "Pedir ayuda a CowFace": cualquier problema con una compra o conversación; el admin se hace cargo.
db.exec(`
CREATE TABLE IF NOT EXISTS help_requests (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  order_id        INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  body            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'abierta' CHECK (status IN ('abierta', 'resuelta')),
  admin_note      TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_help_status ON help_requests (status, id);
`);
if (!hadSellerStatus) {
  db.exec(`UPDATE users SET seller_status = 'aprobado' WHERE role = 'usuario' AND (payout_phone IS NOT NULL
    OR EXISTS (SELECT 1 FROM products p WHERE p.seller_id = users.id) OR sales_base > 0)`);
}

// Notificaciones en el celular/navegador (Web Push): una fila por dispositivo que las activó.
db.exec(`
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  device      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_ok_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions (user_id);
`);

db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

// Una sola vez: la comisión por defecto bajó de 5 % a 2 %. Si nadie la había cambiado a mano, se ajusta.
if (db.prepare("SELECT 1 FROM settings WHERE key = 'migration_commission_2pct'").get() == null) {
  db.prepare("UPDATE settings SET value = '0.02' WHERE key = 'commission_rate' AND value = '0.05'").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('migration_commission_2pct', '1')").run();
}
// Una sola vez (2026-10-14): el dueño decidió cobrar 5 %. Los pedidos ya creados conservan su comisión.
if (db.prepare("SELECT 1 FROM settings WHERE key = 'migration_commission_5pct'").get() == null) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('commission_rate', '0.05') ON CONFLICT(key) DO UPDATE SET value = '0.05'").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('migration_commission_5pct', '1')").run();
}

export function getSetting(key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export function commissionRate() {
  const rate = Number(getSetting('commission_rate'));
  return Number.isFinite(rate) ? rate : 0.05;
}

let depth = 0;
// Transacción simple; las llamadas anidadas se unen a la de afuera.
export function transaction(fn) {
  if (depth > 0) return fn();
  depth += 1;
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth -= 1;
  }
}
