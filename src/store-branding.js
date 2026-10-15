// Logo y portada de la tienda (como en DoorDash / Uber Eats): el logo se recorta cuadrado y la
// portada a 3:1. Se guardan sin metadatos en la carpeta de fotos públicas.
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { db } from './db.js';
import { HEIC_HELP, PHOTO_TYPES, headerMatches } from './uploads.js';
import { TMP_DIR, UPLOAD_DIR, removeFrom } from './storage.js';

export const BRAND_MAX_MB = 10;
const SHAPES = {
  logo: { width: 400, height: 400, column: 'store_logo' },
  banner: { width: 1800, height: 600, column: 'store_banner' },
};
export const BRAND_KINDS = Object.keys(SHAPES);

const upload = multer({
  storage: multer.diskStorage({ destination: TMP_DIR, filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex')) }),
  limits: { fileSize: BRAND_MAX_MB * 1024 * 1024, files: 2, fields: 10, fieldSize: 10 * 1024 },
  fileFilter: (req, file, cb) => {
    if (PHOTO_TYPES.includes(file.mimetype)) return cb(null, true);
    const err = new Error(file.mimetype);
    err.code = /hei[cf]/i.test(file.mimetype) || /\.hei[cf]$/i.test(file.originalname) ? 'HEIC' : 'TYPE';
    return cb(err);
  },
});

class BrandError extends Error {}

async function crop(tmpPath, { width, height }) {
  const meta = await sharp(tmpPath, { failOn: 'error' }).metadata().catch(() => null);
  if (!meta?.width) throw new BrandError('La imagen no se pudo leer. Prueba con JPG o PNG.');
  if (Math.min(meta.width, meta.height) < 200) throw new BrandError('La imagen es muy pequeña: usa una de al menos 200 píxeles.');
  const name = `${crypto.randomBytes(12).toString('hex')}_marca.jpg`;
  await sharp(tmpPath).rotate().flatten({ background: '#ffffff' })
    .resize({ width, height, fit: 'cover', position: 'attention', withoutEnlargement: false })
    .jpeg({ quality: 86, mozjpeg: true }).toFile(path.join(UPLOAD_DIR, name));
  return name;
}

// Campos "logo" y "banner" (uno o ambos). Deja req.brand = { logo?, banner? } o req.uploadError.
export function brandPhotos(req, res, next) {
  upload.fields([{ name: 'logo', maxCount: 1 }, { name: 'banner', maxCount: 1 }])(req, res, async (err) => {
    req.brand = {};
    req.uploadError = null;
    const tmp = [...(req.files?.logo || []), ...(req.files?.banner || [])];
    try {
      if (err) throw new BrandError(err.code === 'HEIC' ? HEIC_HELP : err.code === 'LIMIT_FILE_SIZE' ? `La imagen debe pesar menos de ${BRAND_MAX_MB} MB.` : 'Solo se aceptan fotos JPG, PNG, WebP o AVIF.');
      if (!tmp.every(headerMatches)) throw new BrandError('El archivo no es una imagen válida (JPG, PNG, WebP o AVIF).');
      for (const kind of BRAND_KINDS) {
        const file = req.files?.[kind]?.[0];
        if (file) req.brand[kind] = await crop(file.path, SHAPES[kind]);
      }
    } catch (e) {
      if (!(e instanceof BrandError)) console.error('Error procesando logo/portada:', e);
      req.uploadError = e instanceof BrandError ? e.message : 'No se pudo procesar la imagen. Intenta de nuevo.';
      removeFrom(UPLOAD_DIR, Object.values(req.brand));
      req.brand = {};
    } finally {
      for (const f of tmp) fs.rm(f.path, { force: true }, () => {});
    }
    next();
  });
}

export function brandOf(userId) {
  const row = db.prepare('SELECT store_logo, store_banner FROM users WHERE id = ?').get(userId) || {};
  return { logo: row.store_logo || null, banner: row.store_banner || null };
}

// Guarda las imágenes nuevas y borra las que reemplazan.
export function saveBrand(userId, brand) {
  const before = brandOf(userId);
  const old = [];
  for (const kind of BRAND_KINDS) {
    if (!brand[kind]) continue;
    db.prepare(`UPDATE users SET ${SHAPES[kind].column} = ? WHERE id = ?`).run(brand[kind], userId);
    if (before[kind]) old.push(before[kind]);
  }
  removeFrom(UPLOAD_DIR, old);
}

export function removeBrand(userId, kind) {
  if (!SHAPES[kind]) return;
  const current = brandOf(userId)[kind];
  db.prepare(`UPDATE users SET ${SHAPES[kind].column} = NULL WHERE id = ?`).run(userId);
  if (current) removeFrom(UPLOAD_DIR, [current]);
}
