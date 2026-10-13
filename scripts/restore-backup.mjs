// Convierte un respaldo de CowFace en un archivo de base de datos (.db) listo para usar.
//   node scripts/restore-backup.mjs cowface-2026-10-13.cfbk      (cifrado: pide la contraseña)
//   node scripts/restore-backup.mjs cowface-2026-10-13.db.gz     (copia del panel, sin cifrar)
// Deja "cowface-restaurado.db" en la misma carpeta. Para ponerlo en Railway, ver el README.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline/promises';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('Uso: node scripts/restore-backup.mjs <archivo .cfbk o .db.gz>');
  process.exit(1);
}
let buf = fs.readFileSync(file);
if (buf.subarray(0, 5).toString('latin1') === 'CFBK1') {
  let pass = process.env.BACKUP_PASSWORD;
  if (!pass) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    pass = await rl.question('Contraseña de respaldos (BACKUP_PASSWORD): ');
    rl.close();
  }
  // Mismo formato que src/backup.js: "CFBK1" + sal (16) + iv (12) + etiqueta (16) + datos AES-256-GCM.
  const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(pass, buf.subarray(5, 21), 32), buf.subarray(21, 33));
  decipher.setAuthTag(buf.subarray(33, 49));
  try {
    buf = Buffer.concat([decipher.update(buf.subarray(49)), decipher.final()]);
  } catch {
    console.error('Contraseña incorrecta o archivo dañado.');
    process.exit(1);
  }
}
const db = zlib.gunzipSync(buf);
if (db.subarray(0, 15).toString('latin1') !== 'SQLite format 3') {
  console.error('El archivo no contiene una base de datos de CowFace.');
  process.exit(1);
}
const out = path.join(path.dirname(path.resolve(file)), 'cowface-restaurado.db');
fs.writeFileSync(out, db);
console.log(`Listo: ${out} (${(db.length / 1024).toFixed(0)} KB)`);
