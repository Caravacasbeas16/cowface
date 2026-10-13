// Respaldos de la base de datos (usuarios, artículos, mensajes, pedidos…).
//  1. Todos los días: una copia comprimida en el volumen (se guardan las últimas 7). Sirve si alguien
//     borra algo por error o la base se daña, pero vive en el mismo disco.
//  2. Todos los días, si BACKUP_PASSWORD está en las variables de Railway: la copia cifrada se manda
//     por correo al admin. Esa vive fuera de Railway: si se pierde el volumen, se recupera con ella.
//  3. En /admin: descargar cualquier copia, o un respaldo completo (base + fotos + adjuntos).
// Las sesiones abiertas y los enlaces para cambiar contraseña no se guardan en los respaldos.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { db, getSetting, setSetting } from './db.js';
import { ATTACH_DIR, UPLOAD_DIR } from './storage.js';
import { sendMail, mailConfigured } from './mailer.js';
import { notifySettings } from './admin-notify.js';
import { SITE_NAME } from './catalog.js';

const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH;
export const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || (VOLUME ? path.join(VOLUME, 'backups') : path.join(path.dirname(UPLOAD_DIR), 'backups')));
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const KEEP = 7;
const MAX_EMAIL_BYTES = 4 * 1024 * 1024; // los proveedores de correo limitan los adjuntos
const MAGIC = Buffer.from('CFBK1');
export const BACKUP_NAME = /^cowface-\d{4}-\d{2}-\d{2}\.db\.gz$/;

const password = () => process.env.BACKUP_PASSWORD || '';
export const encryptionReady = () => password().length >= 12;

// Fecha de hoy en Costa Rica (UTC−6), como "2026-10-13".
const crDay = (ms = Date.now()) => new Date(ms - 6 * 3600e3).toISOString().slice(0, 10);

// Copia consistente de la base (aunque se esté usando), sin sesiones ni tokens de contraseña.
export function snapshotDb(target) {
  fs.rmSync(target, { force: true });
  db.prepare('VACUUM INTO ?').run(target);
  const copy = new DatabaseSync(target);
  try {
    copy.exec('DELETE FROM sessions; DELETE FROM password_resets; VACUUM;');
  } finally {
    copy.close();
  }
}

// Formato cifrado: "CFBK1" + sal (16) + iv (12) + etiqueta (16) + datos (AES-256-GCM, clave por scrypt).
export function encrypt(buf, pass = password()) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(pass, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), data]);
}

export function decrypt(buf, pass) {
  if (!buf.subarray(0, 5).equals(MAGIC)) throw new Error('No es un respaldo cifrado de CowFace.');
  const salt = buf.subarray(5, 21);
  const iv = buf.subarray(21, 33);
  const tag = buf.subarray(33, 49);
  const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(pass, salt, 32), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(buf.subarray(49)), decipher.final()]);
  } catch {
    throw new Error('Contraseña incorrecta o archivo dañado.');
  }
}

export function listBackups() {
  return fs.readdirSync(BACKUP_DIR).filter((n) => BACKUP_NAME.test(n)).sort().reverse()
    .map((name) => ({ name, size: fs.statSync(path.join(BACKUP_DIR, name)).size, day: name.slice(8, 18) }));
}

// Hace la copia del día (si no existe) y la manda por correo. force: aunque ya se haya hecho hoy.
export async function runDailyBackup({ force = false, now = Date.now() } = {}) {
  const day = crDay(now);
  if (!force && getSetting('backup_last_day') === day) return { skipped: true };
  const tmp = path.join(BACKUP_DIR, `tmp-${process.pid}-${Date.now()}.db`);
  const name = `cowface-${day}.db.gz`;
  try {
    snapshotDb(tmp);
    const gz = zlib.gzipSync(fs.readFileSync(tmp), { level: 9 });
    fs.writeFileSync(path.join(BACKUP_DIR, name), gz);
    for (const old of listBackups().slice(KEEP)) fs.rmSync(path.join(BACKUP_DIR, old.name), { force: true });
    setSetting('backup_last_day', day);
    setSetting('backup_last_at', new Date(now).toISOString());
    const emailed = await emailBackup(name, gz);
    setSetting('backup_last_email', emailed);
    return { name, size: gz.length, emailed };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function emailBackup(name, gz) {
  const to = notifySettings().email;
  if (!to || (!mailConfigured() && process.env.MAIL_TEST_OUTBOX !== '1')) return 'sin-correo';
  if (!encryptionReady()) return 'sin-clave';
  const file = encrypt(gz);
  if (file.length > MAX_EMAIL_BYTES) {
    await sendMail({
      to, subject: `[${SITE_NAME}] Respaldo del ${name.slice(8, 18)}: descárgalo del panel`,
      text: `El respaldo de hoy pesa ${(file.length / 1048576).toFixed(1)} MB, demasiado para mandarlo por correo.\n`
        + 'Descárgalo en Admin → Respaldos y guárdalo en tu computadora o en Google Drive.',
      html: '<p>El respaldo de hoy es demasiado grande para mandarlo por correo.</p><p>Descárgalo en <strong>Admin → Respaldos</strong> y guárdalo en tu computadora o en Google Drive.</p>',
    });
    return 'muy-grande';
  }
  const tmpFile = path.join(BACKUP_DIR, `${name.replace('.db.gz', '')}.cfbk`);
  fs.writeFileSync(tmpFile, file);
  try {
    const ok = await sendMail({
      to, subject: `[${SITE_NAME}] Respaldo del ${name.slice(8, 18)}`,
      text: 'Va adjunto el respaldo cifrado de la base de datos de CowFace (usuarios, artículos, mensajes y pedidos).\n'
        + 'Guárdalo; no hace falta abrirlo. Solo sirve con la contraseña de respaldos (BACKUP_PASSWORD).\n'
        + 'Las fotos no van en el correo: para un respaldo completo usa Admin → Respaldos → "Descargar todo".',
      html: '<p>Va adjunto el respaldo <strong>cifrado</strong> de la base de datos de CowFace (usuarios, artículos, mensajes y pedidos).</p>'
        + '<p>Guárdalo; no hace falta abrirlo. Solo sirve con la contraseña de respaldos (BACKUP_PASSWORD).</p>'
        + '<p style="color:#666">Las fotos no van en el correo: para un respaldo completo usa Admin → Respaldos → "Descargar todo".</p>',
      attachments: [{ path: tmpFile }],
    });
    return ok ? 'enviado' : 'error';
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

export function backupStatus() {
  return {
    lastAt: getSetting('backup_last_at') || null,
    lastEmail: getSetting('backup_last_email') || null,
    encryption: encryptionReady(),
    mail: mailConfigured(),
    files: listBackups(),
  };
}

// ---------- Respaldo completo: .tar.gz con la base, las fotos y los adjuntos ----------

function tarHeader(name, size, mtime) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write(`${Math.floor(mtime / 1000).toString(8).padStart(11, '0')}\0`, 136);
  h.write('        ', 148);
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

async function* tarEntries(entries) {
  for (const { name, file } of entries) {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile()) continue;
    yield tarHeader(name, stat.size, stat.mtimeMs);
    for await (const chunk of fs.createReadStream(file)) yield chunk;
    const pad = (512 - (stat.size % 512)) % 512;
    if (pad) yield Buffer.alloc(pad);
  }
  yield Buffer.alloc(1024);
}

const filesIn = (dir, prefix) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [])
  .filter((d) => d.isFile() && d.name.length <= 80)
  .map((d) => ({ name: `${prefix}/${d.name}`, file: path.join(dir, d.name) }));

export async function streamFullBackup(out) {
  const tmp = path.join(BACKUP_DIR, `full-${process.pid}-${Date.now()}.db`);
  snapshotDb(tmp);
  try {
    const entries = [
      { name: 'cowface.db', file: tmp },
      ...filesIn(UPLOAD_DIR, 'uploads'),
      ...filesIn(ATTACH_DIR, 'attachments'),
    ];
    await pipeline(tarEntries(entries), zlib.createGzip({ level: 6 }), out);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
