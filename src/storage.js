// Carpetas de archivos. En Railway viven en el volumen, así sobreviven a cada publicación.
//  - UPLOAD_DIR: fotos de artículos (públicas, se sirven en /fotos).
//  - TMP_DIR: subidas a medio procesar (nunca se sirven).
//  - ATTACH_DIR: adjuntos privados del chat, comprobantes de pago/envío y evidencia de reclamos.
//    Solo se entregan a quienes participan en esa conversación o pedido, y al admin.
import fs from 'node:fs';
import path from 'node:path';

const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH;
export const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || (VOLUME ? path.join(VOLUME, 'uploads') : 'uploads'));
export const TMP_DIR = path.join(UPLOAD_DIR, 'tmp');
export const ATTACH_DIR = path.resolve(process.env.ATTACH_DIR || (VOLUME ? path.join(VOLUME, 'attachments') : path.join(path.dirname(UPLOAD_DIR), 'attachments')));

for (const dir of [UPLOAD_DIR, TMP_DIR, ATTACH_DIR]) fs.mkdirSync(dir, { recursive: true });

export function removeFrom(dir, names) {
  for (const name of names) if (name) fs.rm(path.join(dir, path.basename(name)), { force: true }, () => {});
}
