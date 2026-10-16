// Fotos subidas por vendedores y adjuntos del chat.
//
// Fotos de artículos: se guardan TRES versiones.
//  - original: la foto tal como se subió, sin perder calidad. Si es un JPEG derecho, solo se le
//    quitan los metadatos (GPS, cámara…) cortando esos bloques del archivo: los píxeles no se tocan
//    ni se vuelven a comprimir. Si hay que enderezarla (o es otro formato), se guarda en calidad 95
//    sin submuestreo de color, o sin pérdida (PNG). Se conserva el perfil de color.
//  - display: 2048 px, JPEG calidad 90, para mostrar en la página del artículo sin que sea lenta.
//  - thumb: 800 px para las tarjetas del catálogo.
// La pantalla completa muestra la original.
import sharp from 'sharp';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const DISPLAY_PX = 2048;
export const THUMB_PX = 800;
export const MAX_INPUT_PIXELS = 120_000_000; // ~120 MP: más que cualquier celular; frena "bombas" de imagen

sharp.cache(false);

export class ImageError extends Error {}

const newId = () => crypto.randomBytes(12).toString('hex');

// Quita de un JPEG los bloques de metadatos (EXIF/GPS/XMP en APP1, IPTC en APP13, comentarios),
// conservando la imagen comprimida tal cual y el perfil de color (APP2). Devuelve null si el
// archivo no tiene la estructura esperada (entonces se procesa por la vía normal).
export function stripJpegMetadata(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const parts = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xda) {
      // Datos de la imagen: van tal cual hasta el fin de la foto principal (FFD9). Lo que algunos
      // celulares pegan después (mapas de profundidad/HDR con sus propios metadatos) se descarta.
      let end = i + 2;
      while (end + 1 < buf.length && !(buf[end] === 0xff && buf[end + 1] === 0xd9)) end += 1;
      if (end + 1 >= buf.length) return null;
      parts.push(buf.subarray(i, end + 2));
      return Buffer.concat(parts);
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { parts.push(buf.subarray(i, i + 2)); i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return null;
    const isIcc = marker === 0xe2 && buf.subarray(i + 4, i + 15).toString('latin1') === 'ICC_PROFILE';
    // Se conservan: JFIF (APP0), perfil de color (APP2 ICC), Adobe (APP14) y todo lo que no sea APPn/comentario.
    const drop = (marker >= 0xe1 && marker <= 0xef && marker !== 0xee && !isIcc) || marker === 0xfe;
    if (!drop) parts.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return null;
}

async function saveOriginal(input, meta, outDir) {
  const upright = !meta.orientation || meta.orientation === 1;
  if (meta.format === 'jpeg' && upright) {
    const stripped = stripJpegMetadata(await fs.readFile(input));
    // Se decodifica la foto completa para confirmar que quedó intacta y sin metadatos.
    const check = stripped && await sharp(stripped, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS })
      .stats().then(() => sharp(stripped).metadata()).catch(() => null);
    if (check && check.width === meta.width && check.height === meta.height && !check.exif && !check.xmp) {
      const name = `${newId()}_o.jpg`;
      await fs.writeFile(path.join(outDir, name), stripped);
      return name;
    }
  }
  const img = sharp(input, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS }).rotate().keepIccProfile();
  if (meta.format === 'png') {
    const name = `${newId()}_o.png`;
    await img.png({ compressionLevel: 9 }).toFile(path.join(outDir, name)); // sin pérdida
    return name;
  }
  const name = `${newId()}_o.jpg`;
  await img.flatten({ background: '#ffffff' }).jpeg({ quality: 95, chromaSubsampling: '4:4:4', mozjpeg: true }).toFile(path.join(outDir, name));
  return name;
}

export async function processPhoto(tmpPath, outDir) {
  const created = [];
  try {
    let meta;
    try {
      meta = await sharp(tmpPath, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    } catch {
      throw new ImageError('Una de las fotos no se pudo leer. Prueba con JPG o PNG (en iPhone: Ajustes → Cámara → Formatos → Más compatible).');
    }
    if (!meta.width || !meta.height) throw new ImageError('Una de las fotos no es una imagen válida (JPG, PNG, WebP o AVIF).');
    if (Math.min(meta.width, meta.height) < 300) throw new ImageError('Una de las fotos es muy pequeña: usa fotos de al menos 300 píxeles de lado.');

    const original = await saveOriginal(tmpPath, meta, outDir);
    created.push(original);
    const base = sharp(tmpPath, { limitInputPixels: MAX_INPUT_PIXELS }).rotate().flatten({ background: '#ffffff' });
    const display = `${newId()}.jpg`;
    await base.clone().resize({ width: DISPLAY_PX, height: DISPLAY_PX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90, chromaSubsampling: '4:4:4', mozjpeg: true }).toFile(path.join(outDir, display));
    created.push(display);
    const thumb = `${display.replace('.jpg', '')}_t.jpg`;
    await base.clone().resize({ width: THUMB_PX, height: THUMB_PX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true }).toFile(path.join(outDir, thumb));
    created.push(thumb);
    return { filename: display, thumb, original };
  } catch (err) {
    await Promise.all(created.map((f) => fs.rm(path.join(outDir, f), { force: true })));
    if (err instanceof ImageError) throw err;
    console.error('Error procesando foto:', err.message);
    throw new ImageError('Una de las fotos no se pudo procesar. Intenta de nuevo o prueba con otra foto.');
  } finally {
    await fs.rm(tmpPath, { force: true });
  }
}

// Adjuntos privados (chat, comprobantes, evidencia de reclamos): fotos o PDF.
// Las fotos se guardan sin metadatos, hasta 2560 px y en calidad 92 (se lee bien cualquier
// comprobante); las capturas PNG quedan sin pérdida. Los PDF se guardan tal cual.
export async function processAttachment(tmpPath, mimetype, outDir) {
  try {
    if (mimetype === 'application/pdf') {
      const head = Buffer.alloc(5);
      const fh = await fs.open(tmpPath, 'r');
      try { await fh.read(head, 0, 5, 0); } finally { await fh.close(); }
      if (head.toString('latin1') !== '%PDF-') throw new ImageError('El archivo no es un PDF válido.');
      const name = `${newId()}.pdf`;
      await fs.copyFile(tmpPath, path.join(outDir, name));
      return { name, type: 'pdf' };
    }
    let meta;
    try {
      meta = await sharp(tmpPath, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    } catch {
      throw new ImageError('El archivo no se pudo leer. Envía una foto (JPG, PNG, WebP) o un PDF.');
    }
    const img = sharp(tmpPath, { limitInputPixels: MAX_INPUT_PIXELS }).rotate()
      .resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true });
    const name = `${newId()}${meta.format === 'png' ? '.png' : '.jpg'}`;
    await (meta.format === 'png'
      ? img.png({ compressionLevel: 9 })
      : img.flatten({ background: '#ffffff' }).jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true }))
      .toFile(path.join(outDir, name));
    return { name, type: 'imagen' };
  } finally {
    await fs.rm(tmpPath, { force: true });
  }
}
