// Procesa cada foto que sube un vendedor:
//  - La endereza según la orientación del celular (EXIF).
//  - Borra los metadatos, incluida la ubicación GPS de donde se tomó (privacidad del vendedor).
//  - Guarda una versión grande en alta calidad (hasta 2560 px, JPEG calidad 92 sin submuestreo
//    de color: la diferencia con el original no se nota a simple vista) para la página del artículo.
//  - Guarda una miniatura liviana (800 px) para las tarjetas, así el catálogo carga rápido.
// El color se convierte a sRGB, que es como lo muestran todos los navegadores.
import sharp from 'sharp';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const LARGE_PX = 2560;
export const THUMB_PX = 800;
const MAX_INPUT_PIXELS = 120_000_000; // ~120 MP: más que cualquier celular, frena "bombas" de imagen

sharp.cache(false);

export class ImageError extends Error {}

export async function processPhoto(tmpPath, outDir) {
  const id = crypto.randomBytes(12).toString('hex');
  const large = `${id}.jpg`;
  const thumb = `${id}_t.jpg`;
  try {
    const input = sharp(tmpPath, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS });
    const meta = await input.metadata();
    if (!meta.width || !meta.height) throw new ImageError('Una de las fotos no es una imagen válida (JPG, PNG, WebP o AVIF).');
    if (Math.min(meta.width, meta.height) < 300) throw new ImageError('Una de las fotos es muy pequeña: usa fotos de al menos 300 píxeles de lado.');

    // rotate() sin argumentos aplica la orientación EXIF; al no pedir metadatos, sharp los quita todos.
    const base = input.rotate().flatten({ background: '#ffffff' });
    await base.clone()
      .resize({ width: LARGE_PX, height: LARGE_PX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true })
      .toFile(path.join(outDir, large));
    await base.clone()
      .resize({ width: THUMB_PX, height: THUMB_PX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toFile(path.join(outDir, thumb));
    return { filename: large, thumb };
  } catch (err) {
    await Promise.all([large, thumb].map((f) => fs.rm(path.join(outDir, f), { force: true })));
    if (err instanceof ImageError) throw err;
    throw new ImageError('Una de las fotos no se pudo leer. Prueba con JPG o PNG (en iPhone: Ajustes → Cámara → Formatos → Más compatible).');
  } finally {
    await fs.rm(tmpPath, { force: true });
  }
}
