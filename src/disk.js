// Espacio del volumen de Railway: cuánto ocupan las fotos, los adjuntos, la base y los respaldos,
// cuánto queda y para cuántos artículos más alcanza. Se ve en /admin → Espacio, y al pasar el 80 %,
// 90 % y 95 % le llega un correo al admin (una vez por nivel).
// Recorrer las carpetas tarda con muchas fotos, así que se calcula en segundo plano y se guarda un rato.
import fs from 'node:fs';
import path from 'node:path';
import { DB_FILE, db, getSetting, setSetting } from './db.js';
import { ATTACH_DIR, UPLOAD_DIR } from './storage.js';
import { BACKUP_DIR } from './backup.js';
import { notifyAdmin } from './admin-notify.js';

const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const FRESH_MS = 10 * 60 * 1000;
export const ALERT_LEVELS = [80, 90, 95];
const GB = 1024 ** 3;

async function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return { bytes, files }; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = await dirSize(p);
      bytes += sub.bytes;
      files += sub.files;
    } else if (e.isFile()) {
      try { bytes += (await fs.promises.stat(p)).size; files += 1; } catch { /* se borró mientras tanto */ }
    }
  }
  return { bytes, files };
}

const fileSize = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

// Tamaño del disco. En Railway el volumen puede reportar el disco completo del servidor, por eso el
// admin puede escribir el tamaño que eligió en Railway (Volume Size) y ese manda.
export const volumeGbSetting = () => {
  const n = Number(getSetting('volume_gb'));
  return Number.isFinite(n) && n > 0 ? n : null;
};
export const setVolumeGb = (n) => setSetting('volume_gb', n ? String(n) : '');

function diskTotals() {
  try {
    const s = fs.statfsSync(VOLUME || path.dirname(UPLOAD_DIR));
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch { return null; }
}

let cache = null;
let running = null;

export async function refreshDisk() {
  if (running) return running;
  running = (async () => {
    const [photos, attachments, backups] = await Promise.all([dirSize(UPLOAD_DIR), dirSize(ATTACH_DIR), dirSize(BACKUP_DIR)]);
    const database = fileSize(DB_FILE) + fileSize(`${DB_FILE}-wal`);
    const ours = photos.bytes + attachments.bytes + backups.bytes + database;
    const fsTotals = diskTotals();
    const setGb = volumeGbSetting();
    const total = setGb ? setGb * GB : fsTotals?.total || 0;
    const used = setGb || !fsTotals ? ours : Math.max(ours, fsTotals.total - fsTotals.free);
    const free = Math.max(0, total - used);
    const withPhotos = db.prepare('SELECT COUNT(DISTINCT product_id) AS n FROM product_images').get().n;
    const perProduct = withPhotos ? photos.bytes / withPhotos : 0;
    cache = {
      at: Date.now(), total, used, free, percent: total ? Math.min(100, Math.round((used / total) * 100)) : null,
      fromSetting: Boolean(setGb), parts: { photos: photos.bytes, attachments: attachments.bytes, backups: backups.bytes, database },
      photoFiles: photos.files, products: withPhotos, perProduct, productsLeft: perProduct ? Math.floor(free / perProduct) : null,
    };
    return cache;
  })().finally(() => { running = null; });
  return running;
}

// Lo último calculado (o null la primera vez); si ya está viejo, lo recalcula en segundo plano.
export function diskStatus() {
  if (!cache || Date.now() - cache.at > FRESH_MS) refreshDisk().catch((err) => console.error('Error calculando el espacio:', err));
  return cache;
}

export const formatBytes = (n) => (n >= GB ? `${(n / GB).toFixed(2)} GB` : n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)} MB` : `${Math.max(0, Math.round(n / 1024))} KB`);

// Correo al admin al cruzar 80 %, 90 % y 95 % (uno por nivel). Si baja de 75 % se vuelve a avisar.
export async function checkDiskAlert() {
  const s = await refreshDisk();
  if (s.percent == null) return null;
  const sent = Number(getSetting('disk_alert_level')) || 0;
  if (s.percent < 75 && sent) { setSetting('disk_alert_level', '0'); return null; }
  const level = [...ALERT_LEVELS].reverse().find((l) => s.percent >= l);
  if (!level || level <= sent) return null;
  setSetting('disk_alert_level', String(level));
  notifyAdmin('espacio', `El espacio va en ${s.percent} %`,
    `El volumen de CowFace va en ${s.percent} % (${formatBytes(s.used)} de ${formatBytes(s.total)}). `
    + `Quedan ${formatBytes(s.free)}${s.productsLeft != null ? `, para unos ${s.productsLeft} artículos más` : ''}.\n\n`
    + 'Agrándalo en Railway → cowface-volume → Settings → Volume Size (y, si lo cambias, pon el tamaño nuevo en Admin → Espacio).',
    '/admin#espacio');
  return level;
}
