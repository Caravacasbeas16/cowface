import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// En Railway, si hay un volumen montado, todo se guarda ahí (sobrevive a cada publicación).
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const DATA_DIR = path.resolve(process.env.DATA_DIR || (VOLUME ? path.join(VOLUME, 'db') : 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(process.env.DB_PATH || path.join(DATA_DIR, 'cowface.db'));

const SCHEMA_VERSION = 3;
const hasTables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'users'").get().n > 0;
const version = db.prepare('PRAGMA user_version').get().user_version;
if (hasTables && version < SCHEMA_VERSION) {
  throw new Error('La base de datos es de una versión anterior. Bórrala (carpeta data/) y corre "npm run seed".');
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

PRAGMA user_version = ${SCHEMA_VERSION};
`);

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
