// Vigila la clave del cifrado de los chats (CHAT_KEY, ver crypto-box.js). La primera vez que hay clave
// se guarda una "prueba" cifrada con ella; así, si después la clave falta o cambia, se sabe — y se le
// avisa al admin — en vez de que los mensajes viejos aparezcan como "🔒 cifrado" sin explicación.
import { db, getSetting, setSetting } from './db.js';
import { encryptionEnabled, isSealedText, openText, sealText } from './crypto-box.js';
import { notifyAdmin } from './admin-notify.js';

const CANARY = 'cowface-chat-ok';

// 'ok' (cifrando con la misma clave de siempre), 'apagado' (nunca se ha usado clave),
// 'falta' (hay chats cifrados pero hoy no hay clave) u 'otra' (la clave cambió: lo viejo no se lee).
export function chatKeyStatus() {
  const saved = getSetting('chat_key_canary');
  if (!encryptionEnabled()) return saved ? 'falta' : 'apagado';
  if (!saved) {
    setSetting('chat_key_canary', sealText(CANARY));
    return 'ok';
  }
  return isSealedText(saved) && openText(saved) === CANARY ? 'ok' : 'otra';
}

export const CHAT_KEY_PROBLEMS = {
  apagado: 'Los chats se están guardando sin cifrar: el servicio cowface no tiene la variable CHAT_KEY. En Railway → servicio cowface (el que tiene cowfacecr.com) → Variables, agrega CHAT_KEY con una contraseña larga (16+ caracteres) y guárdala junto a BACKUP_PASSWORD. Al reiniciarse se cifra todo lo anterior.',
  falta: 'Falta la clave CHAT_KEY en el servidor: los chats que ya estaban cifrados no se pueden leer y los nuevos se guardan sin cifrar. Vuelve a poner en Railway → servicio cowface → Variables la misma CHAT_KEY de antes.',
  otra: 'La clave CHAT_KEY cambió: los chats cifrados con la clave anterior no se pueden leer. Vuelve a poner en Railway → servicio cowface → Variables la CHAT_KEY de antes (la que guardaste junto a BACKUP_PASSWORD).',
};

// Al arrancar: si no hay clave, o si falta o cambió, correo al admin (cada arranque, hasta que se arregle).
export function checkChatKey() {
  const status = chatKeyStatus();
  if (CHAT_KEY_PROBLEMS[status]) {
    console.error(`Cifrado de chats: ${status}`);
    notifyAdmin('seguridad', 'Problema con el cifrado de los chats', CHAT_KEY_PROBLEMS[status], '/admin#cifrado');
  }
  return status;
}

// Textos del chat guardados antes de tener clave (soporte, intentos bloqueados, pedidos de ayuda):
// se cifran como los mensajes. Devuelve cuántos.
export function sealOldTexts() {
  if (!encryptionEnabled()) return 0;
  let n = 0;
  for (const [table, col] of [['support_messages', 'body'], ['flagged_messages', 'body'], ['help_requests', 'body']]) {
    const rows = db.prepare(`SELECT id, ${col} AS v FROM ${table} WHERE ${col} != '' AND ${col} NOT LIKE 'enc1:%'`).all();
    const save = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`);
    for (const r of rows) save.run(sealText(r.v), r.id);
    n += rows.length;
  }
  return n;
}
