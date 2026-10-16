// Cifrado de los chats guardados: el texto de los mensajes y los archivos privados (fotos y PDF del
// chat, capturas del SINPE, guías de envío y evidencia de reclamos) quedan ilegibles en la base de
// datos, en el disco y en los respaldos. Solo el servidor los abre, con la clave CHAT_KEY (variable
// de Railway). No es cifrado "punta a punta": el servidor tiene que leer los mensajes para bloquear
// teléfonos y redes, para los avisos y para que el admin resuelva reclamos.
// Sin CHAT_KEY todo funciona igual, sin cifrar. Si se pierde la clave, lo cifrado no se recupera.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TEXT_PREFIX = 'enc1:';
const FILE_MAGIC = Buffer.from('CFE1');
const MIN_KEY = 16;

let cached = { raw: null, key: null };
function key() {
  const raw = process.env.CHAT_KEY || '';
  if (raw.length < MIN_KEY) return null;
  if (cached.raw !== raw) cached = { raw, key: crypto.scryptSync(raw, 'cowface-chat-v1', 32) };
  return cached.key;
}

export const encryptionEnabled = () => Boolean(key());
export const isSealedText = (s) => typeof s === 'string' && s.startsWith(TEXT_PREFIX);

function seal(buf, k) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const data = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}

function open(buf, k) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
}

// Texto: vacío queda vacío; sin clave queda tal cual.
export function sealText(text) {
  const k = key();
  const s = String(text ?? '');
  if (!k || !s) return s;
  // Ya cifrado (y se abre con esta clave): se deja igual. Un texto que alguien escribió empezando
  // con "enc1:" no se abre, así que se cifra como cualquier otro.
  if (isSealedText(s)) {
    try { open(Buffer.from(s.slice(TEXT_PREFIX.length), 'base64'), k); return s; } catch { /* no es nuestro: se cifra */ }
  }
  return TEXT_PREFIX + seal(Buffer.from(s, 'utf8'), k).toString('base64');
}

export function openText(stored) {
  if (!isSealedText(stored)) return stored ?? '';
  const k = key();
  if (!k) return '🔒 Mensaje cifrado (falta la clave CHAT_KEY en el servidor)';
  try {
    return open(Buffer.from(stored.slice(TEXT_PREFIX.length), 'base64'), k).toString('utf8');
  } catch {
    return '🔒 Mensaje cifrado con otra clave';
  }
}

const isSealedFile = (buf) => buf.subarray(0, 4).equals(FILE_MAGIC);

// Cifra un archivo en su lugar (si hay clave y no estaba cifrado).
export function sealFile(file) {
  const k = key();
  if (!k) return false;
  const buf = fs.readFileSync(file);
  if (isSealedFile(buf)) return false;
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, Buffer.concat([FILE_MAGIC, seal(buf, k)]));
  fs.renameSync(tmp, file);
  return true;
}

// Contenido original de un archivo privado (lo descifra si hace falta). null si no se puede abrir.
export function readPrivateFile(file) {
  const buf = fs.readFileSync(file);
  if (!isSealedFile(buf)) return buf;
  const k = key();
  if (!k) return null;
  try {
    return open(buf.subarray(4), k);
  } catch {
    return null;
  }
}

// Al arrancar con clave: cifra los mensajes y archivos que se guardaron antes sin cifrar.
export function encryptExisting(db, attachDir) {
  if (!key()) return { messages: 0, files: 0 };
  let messages = 0;
  const pending = db.prepare(`SELECT id, body FROM messages WHERE body != '' AND body NOT LIKE '${TEXT_PREFIX}%' LIMIT 1000`);
  const update = db.prepare('UPDATE messages SET body = ? WHERE id = ?');
  for (let rows = pending.all(); rows.length; rows = pending.all()) {
    for (const r of rows) update.run(sealText(r.body), r.id);
    messages += rows.length;
  }
  let files = 0;
  for (const name of fs.existsSync(attachDir) ? fs.readdirSync(attachDir) : []) {
    if (!/^[a-f0-9]{24}\.(jpg|png|pdf)$/.test(name)) continue;
    try { if (sealFile(path.join(attachDir, name))) files += 1; } catch (err) { console.error(`No se pudo cifrar ${name}:`, err.message); }
  }
  return { messages, files };
}
