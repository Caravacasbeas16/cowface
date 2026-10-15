// Recepción de archivos (multer) compartida por publicaciones, chat y pedidos.
// Todo llega primero a TMP_DIR; se revisa que sea lo que dice ser (primeros bytes) y se procesa
// con images.js. El resultado queda en req.photos / req.attachment, o el problema en req.uploadError.
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { ImageError, processAttachment, processPhoto } from './images.js';
import { ATTACH_DIR, TMP_DIR, UPLOAD_DIR, removeFrom, removeFromNow } from './storage.js';
import { sealFile } from './crypto-box.js';
import path from 'node:path';

export const MAX_IMAGES = 8;
export const MAX_PHOTO_MB = 20;
export const MAX_ATTACH_MB = 10;

// El tipo que manda el navegador se puede falsificar: se revisan los primeros bytes del archivo.
const SIGNATURES = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'image/avif': (b) => ['ftypavif', 'ftypavis'].includes(b.subarray(4, 12).toString('latin1')),
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
};
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
const ATTACH_TYPES = [...PHOTO_TYPES, 'application/pdf'];

export function headerMatches(file) {
  const head = Buffer.alloc(12);
  const fd = fs.openSync(file.path, 'r');
  try { fs.readSync(fd, head, 0, 12, 0); } finally { fs.closeSync(fd); }
  return SIGNATURES[file.mimetype]?.(head) === true;
}

function makeUpload({ types, maxMb, maxFiles }) {
  return multer({
    storage: multer.diskStorage({
      destination: TMP_DIR,
      filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex')),
    }),
    limits: { fileSize: maxMb * 1024 * 1024, files: maxFiles, fields: 60, fieldSize: 100 * 1024 },
    fileFilter: (req, file, cb) => {
      if (types.includes(file.mimetype)) return cb(null, true);
      const err = new Error(file.mimetype);
      err.code = /hei[cf]/i.test(file.mimetype) || /\.hei[cf]$/i.test(file.originalname) ? 'HEIC' : 'TYPE';
      return cb(err);
    },
  });
}

const photoUpload = makeUpload({ types: PHOTO_TYPES, maxMb: MAX_PHOTO_MB, maxFiles: MAX_IMAGES });
const attachUpload = makeUpload({ types: ATTACH_TYPES, maxMb: MAX_ATTACH_MB, maxFiles: 1 });

export const HEIC_HELP = 'Las fotos HEIC no se pueden subir. En iPhone: Ajustes → Cámara → Formatos → "Más compatible", o comparte la foto como JPG.';
const photoErrors = {
  LIMIT_FILE_SIZE: `Cada foto debe pesar menos de ${MAX_PHOTO_MB} MB.`,
  LIMIT_FILE_COUNT: `Máximo ${MAX_IMAGES} fotos por artículo.`,
  LIMIT_UNEXPECTED_FILE: `Máximo ${MAX_IMAGES} fotos por artículo.`,
  HEIC: HEIC_HELP,
  TYPE: 'Solo se aceptan fotos JPG, PNG, WebP o AVIF.',
};
const attachErrors = {
  LIMIT_FILE_SIZE: `El archivo debe pesar menos de ${MAX_ATTACH_MB} MB.`,
  LIMIT_FILE_COUNT: 'Envía un archivo a la vez.',
  LIMIT_UNEXPECTED_FILE: 'Envía un archivo a la vez.',
  HEIC: HEIC_HELP,
  TYPE: 'Solo se pueden enviar fotos (JPG, PNG, WebP) o PDF.',
};

const cleanupTmp = (files) => { for (const f of files || []) fs.rm(f.path, { force: true }, () => {}); };

// Fotos de artículos: campo "photos". Deja req.photos = [{ filename, thumb, original }].
export function photos(req, res, next) {
  photoUpload.array('photos', MAX_IMAGES)(req, res, async (err) => {
    req.photos = [];
    req.uploadError = null;
    const tmp = req.files || [];
    try {
      if (err) throw new ImageError(photoErrors[err.code] || 'No se pudieron subir las fotos.');
      if (!tmp.every(headerMatches)) throw new ImageError('Una de las fotos no es una imagen válida (JPG, PNG, WebP o AVIF).');
      for (const file of tmp) req.photos.push(await processPhoto(file.path, UPLOAD_DIR));
    } catch (e) {
      if (!(e instanceof ImageError)) console.error('Error procesando fotos:', e);
      req.uploadError = e instanceof ImageError ? e.message : 'No se pudieron procesar las fotos. Intenta de nuevo.';
      removeFrom(UPLOAD_DIR, photoFiles(req));
      req.photos = [];
      cleanupTmp(tmp);
    }
    next();
  });
}

export const photoFiles = (req) => (req.photos || []).flatMap((p) => [p.filename, p.thumb, p.original]);

// Un adjunto privado (foto o PDF) en el campo indicado. Deja req.attachment = { name, type } o null.
export function attachment(field) {
  return (req, res, next) => {
    attachUpload.single(field)(req, res, async (err) => {
      req.attachment = null;
      req.uploadError = null;
      try {
        if (err) throw new ImageError(attachErrors[err.code] || 'No se pudo subir el archivo.');
        if (req.file) {
          if (!headerMatches(req.file)) throw new ImageError('El archivo no es una foto o PDF válido.');
          req.attachment = await processAttachment(req.file.path, req.file.mimetype, ATTACH_DIR);
          sealFile(path.join(ATTACH_DIR, req.attachment.name));
        }
      } catch (e) {
        if (!(e instanceof ImageError)) console.error('Error procesando adjunto:', e);
        req.uploadError = e instanceof ImageError ? e.message : 'No se pudo procesar el archivo. Intenta de nuevo.';
        req.attachment = null;
        cleanupTmp(req.file ? [req.file] : []);
      }
      next();
    });
  };
}

export const discardAttachment = (req) => { if (req.attachment) removeFrom(ATTACH_DIR, [req.attachment.name]); };

// ---------- Carga rápida (admin): un CSV con los artículos + muchas fotos ----------
export const BULK_MAX_PHOTOS = 60;
const BULK_MAX_CSV = 2 * 1024 * 1024;
const bulkUpload = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex')),
  }),
  // Nombres de archivo con tildes o ñ ("camisa-niño.jpg") llegan bien.
  defParamCharset: 'utf8',
  limits: { fileSize: MAX_PHOTO_MB * 1024 * 1024, files: BULK_MAX_PHOTOS + 1, fields: 20, fieldSize: 10 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'archivo') return cb(null, true);
    if (file.fieldname === 'fotos' && PHOTO_TYPES.includes(file.mimetype)) return cb(null, true);
    const err = new Error(file.mimetype);
    err.code = /hei[cf]/i.test(file.mimetype) || /\.hei[cf]$/i.test(file.originalname) ? 'HEIC' : 'TYPE';
    err.file = file.originalname;
    return cb(err);
  },
});

// Deja req.bulk = { csv: texto, photos: Map(nombre en minúsculas → ruta temporal), error }.
export function bulkFiles(req, res, next) {
  bulkUpload.fields([{ name: 'archivo', maxCount: 1 }, { name: 'fotos', maxCount: BULK_MAX_PHOTOS }])(req, res, (err) => {
    const csvFile = req.files?.archivo?.[0];
    const photoFilesIn = req.files?.fotos || [];
    req.bulk = { csv: null, photos: new Map(), error: null, tmp: [...(csvFile ? [csvFile] : []), ...photoFilesIn] };
    try {
      if (err) {
        throw new ImageError({
          LIMIT_FILE_SIZE: `Cada foto debe pesar menos de ${MAX_PHOTO_MB} MB.`,
          LIMIT_FILE_COUNT: `Máximo ${BULK_MAX_PHOTOS} fotos por carga. Divide el inventario en varias cargas.`,
          LIMIT_UNEXPECTED_FILE: `Máximo ${BULK_MAX_PHOTOS} fotos por carga.`,
          HEIC: `${err.file ? `"${err.file}": ` : ''}${HEIC_HELP}`,
          TYPE: `${err.file ? `"${err.file}": ` : ''}solo se aceptan fotos JPG, PNG, WebP o AVIF.`,
        }[err.code] || 'No se pudieron subir los archivos.');
      }
      if (!csvFile) throw new ImageError('Elige el archivo CSV con los artículos.');
      const raw = fs.readFileSync(csvFile.path);
      if (raw.length > BULK_MAX_CSV) throw new ImageError('El CSV es muy grande (máximo 2 MB).');
      if (raw.subarray(0, 2).toString('latin1') === 'PK') throw new ImageError('Ese archivo es de Excel (.xlsx). En Excel: Archivo → Guardar como → "CSV UTF-8 (delimitado por comas)".');
      req.bulk.csv = raw.toString('utf8');
      for (const f of photoFilesIn) {
        if (!headerMatches(f)) throw new ImageError(`"${f.originalname}" no es una imagen válida.`);
        req.bulk.photos.set(f.originalname.toLowerCase(), f.path);
      }
    } catch (e) {
      if (!(e instanceof ImageError)) console.error('Error recibiendo carga rápida:', e);
      req.bulk.error = e instanceof ImageError ? e.message : 'No se pudieron recibir los archivos.';
    }
    next();
  });
}

export const discardBulk = (req) => cleanupTmp(req.bulk?.tmp);

// ---------- Solicitud de tienda: fotos de referencia (privadas, solo las ven la tienda y el admin) ----------
export const REQUEST_MAX_PHOTOS = 6;
const requestUpload = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex')),
  }),
  limits: { fileSize: MAX_PHOTO_MB * 1024 * 1024, files: REQUEST_MAX_PHOTOS * 2, fields: 20, fieldSize: 10 * 1024 },
  fileFilter: (req, file, cb) => {
    if (PHOTO_TYPES.includes(file.mimetype)) return cb(null, true);
    const err = new Error(file.mimetype);
    err.code = /hei[cf]/i.test(file.mimetype) || /\.hei[cf]$/i.test(file.originalname) ? 'HEIC' : 'TYPE';
    return cb(err);
  },
});

// Deja req.requestPhotos = { productos: [nombres], envios: [nombres] } (ya procesadas y cifradas) o req.uploadError.
export function requestPhotos(req, res, next) {
  requestUpload.fields([{ name: 'productos', maxCount: REQUEST_MAX_PHOTOS }, { name: 'envios', maxCount: REQUEST_MAX_PHOTOS }])(req, res, async (err) => {
    req.requestPhotos = { productos: [], envios: [] };
    req.uploadError = null;
    const tmp = [...(req.files?.productos || []), ...(req.files?.envios || [])];
    try {
      if (err) {
        throw new ImageError({
          LIMIT_FILE_SIZE: `Cada foto debe pesar menos de ${MAX_PHOTO_MB} MB.`,
          LIMIT_FILE_COUNT: `Máximo ${REQUEST_MAX_PHOTOS} fotos en cada grupo.`,
          LIMIT_UNEXPECTED_FILE: `Máximo ${REQUEST_MAX_PHOTOS} fotos en cada grupo.`,
          HEIC: HEIC_HELP,
          TYPE: 'Solo se aceptan fotos JPG, PNG, WebP o AVIF.',
        }[err.code] || 'No se pudieron subir las fotos.');
      }
      if (!tmp.every(headerMatches)) throw new ImageError('Una de las fotos no es una imagen válida (JPG, PNG, WebP o AVIF).');
      for (const field of ['productos', 'envios']) {
        for (const file of req.files?.[field] || []) {
          const { name } = await processAttachment(file.path, file.mimetype, ATTACH_DIR);
          sealFile(path.join(ATTACH_DIR, name));
          req.requestPhotos[field].push(name);
        }
      }
    } catch (e) {
      if (!(e instanceof ImageError)) console.error('Error procesando fotos de la solicitud:', e);
      req.uploadError = e instanceof ImageError ? e.message : 'No se pudieron procesar las fotos. Intenta de nuevo.';
      discardRequestPhotos(req);
      cleanupTmp(tmp);
    }
    next();
  });
}

export function discardRequestPhotos(req) {
  const p = req.requestPhotos || {};
  removeFromNow(ATTACH_DIR, [...(p.productos || []), ...(p.envios || [])]);
  req.requestPhotos = { productos: [], envios: [] };
}
