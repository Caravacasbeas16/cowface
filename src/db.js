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
const SCHEMA_VERSION = 6;
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
INSERT OR IGNORE INTO settings (key, value) VALUES ('commission_rate', '0.02');

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

`);

// Columnas nuevas en tablas que ya existen (CREATE TABLE IF NOT EXISTS no las agrega).
const hasColumn = (table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
if (!hasColumn('product_images', 'thumb')) db.exec('ALTER TABLE product_images ADD COLUMN thumb TEXT');

db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

// Una sola vez: la comisión por defecto bajó de 5 % a 2 %. Si nadie la había cambiado a mano, se ajusta.
if (db.prepare("SELECT 1 FROM settings WHERE key = 'migration_commission_2pct'").get() == null) {
  db.prepare("UPDATE settings SET value = '0.02' WHERE key = 'commission_rate' AND value = '0.05'").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('migration_commission_2pct', '1')").run();
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
  return Number.isFinite(rate) ? rate : 0.02;
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
