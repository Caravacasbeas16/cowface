// Genera todos los íconos de la app a partir del logo en buena calidad.
//   node scripts/make-icons.mjs ruta/al/logo.png
// Deja en public/img: logo.jpg (encabezado), icon-192.png, icon-512.png, icon-maskable-512.png,
// apple-touch-icon.png y badge-96.png (silueta blanca para la barra de notificaciones de Android).
// Ideal: logo cuadrado de 1024 px o más, con fondo blanco o transparente.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const src = process.argv[2];
if (!src) {
  console.error('Uso: node scripts/make-icons.mjs ruta/al/logo.png');
  process.exit(1);
}
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'img');
const meta = await sharp(src).metadata();
if (Math.min(meta.width, meta.height) < 512) console.warn(`Aviso: el logo mide ${meta.width}x${meta.height}; con menos de 512 px los íconos grandes se ven borrosos.`);

const square = (size, pad = 0) => sharp(src)
  .resize(size - pad * 2, size - pad * 2, { fit: 'contain', background: '#ffffff' })
  .extend({ top: pad, bottom: pad, left: pad, right: pad, background: '#ffffff' })
  .flatten({ background: '#ffffff' });

await square(192).png().toFile(path.join(out, 'icon-192.png'));
await square(512).png().toFile(path.join(out, 'icon-512.png'));
await square(180).png().toFile(path.join(out, 'apple-touch-icon.png'));
// "maskable": Android puede recortarlo en círculo o gota, así que el logo va con margen (zona segura).
await square(512, 76).png().toFile(path.join(out, 'icon-maskable-512.png'));
await square(300).jpeg({ quality: 92 }).toFile(path.join(out, 'logo.jpg'));
// Insignia: silueta blanca sobre transparente.
const g = await square(96).greyscale().threshold(140).negate().raw().toBuffer({ resolveWithObject: true });
const rgba = Buffer.alloc(96 * 96 * 4);
for (let i = 0; i < 96 * 96; i++) {
  rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = g.data[i * g.info.channels];
}
await sharp(rgba, { raw: { width: 96, height: 96, channels: 4 } }).png().toFile(path.join(out, 'badge-96.png'));
console.log(`Listo: íconos generados en ${out} desde un logo de ${meta.width}x${meta.height}.`);
