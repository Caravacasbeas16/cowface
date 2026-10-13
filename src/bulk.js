// Carga rápida: el admin sube un CSV (de Excel o Google Sheets) con el inventario de una tienda y
// las fotos, y se crean todos los artículos de una vez. Acepta los valores como los escribe una
// persona ("Zapatos", "niños", "nuevo con etiqueta", "9") y los convierte a los del catálogo.
import fs from 'node:fs';
import path from 'node:path';
import { CATEGORIES, allSizes } from './catalog.js';
import { normalize } from './search-text.js';
import { validateProduct } from './validate.js';
import { createProduct } from './products.js';
import { ImageError, processPhoto } from './images.js';
import { TMP_DIR, UPLOAD_DIR, removeFrom } from './storage.js';
import { MAX_IMAGES } from './uploads.js';
import crypto from 'node:crypto';

export const MAX_ROWS = 200;

export const COLUMNS = [
  ['titulo', 'Camisa polo Lacoste azul', 'Obligatorio.'],
  ['marca', 'Lacoste', ''],
  ['categoria', 'Ropa', 'Ropa, Zapatos, Bolsos o Accesorios.'],
  ['tipo', 'Camisas polo', 'Uno de los tipos de esa categoría (lista abajo).'],
  ['para', 'Hombre', 'Mujer, Hombre, Niños o Unisex.'],
  ['talla', 'M', 'Una talla de esa categoría (lista abajo). En zapatos, "9" = US 9 y "40" = EU 40.'],
  ['color', 'Azul', ''],
  ['estado', 'Usado', 'Nuevo con etiqueta, Nuevo sin etiqueta, Como nuevo o Usado.'],
  ['precio', '25000', 'En colones, sin decimales.'],
  ['cantidad', '1', 'Si se deja vacío, 1.'],
  ['envio', '2500', 'Costo de envío que paga el comprador; 0 o vacío = gratis.'],
  ['en_persona', 'Sí', 'Sí o No: si acepta entregar en persona. Vacío = Sí.'],
  ['descripcion', 'Algodón, poco uso, sin manchas.', ''],
  ['fotos', 'polo1.jpg; polo2.jpg', 'Nombres exactos de las fotos que subes, separados por ";" o ",". La primera es la portada.'],
];

const ALIASES = {
  título: 'titulo', title: 'titulo', nombre: 'titulo', articulo: 'titulo',
  brand: 'marca', category: 'categoria', 'tipo de articulo': 'tipo', departamento: 'para', genero: 'para',
  size: 'talla', condicion: 'estado', price: 'precio', stock: 'cantidad', unidades: 'cantidad',
  'costo de envio': 'envio', 'costo envio': 'envio', shipping: 'envio',
  'entrega en persona': 'en_persona', 'en persona': 'en_persona', meetup: 'en_persona',
  descripción: 'descripcion', description: 'descripcion', foto: 'fotos', imagenes: 'fotos', photos: 'fotos',
};
const headerKey = (h) => {
  const n = normalize(h).replace(/_/g, ' ');
  return ALIASES[n] || n.replace(/ /g, '_');
};

// CSV de Excel en español usa ";"; Google Sheets usa ",". Respeta comillas y saltos de línea dentro de celdas.
export function parseCsv(text) {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!nonEmpty.length) return { headers: [], rows: [] };
  const headers = nonEmpty[0].map(headerKey);
  return {
    headers,
    rows: nonEmpty.slice(1).map((r, i) => {
      // "foto1.jpg; foto2.jpg" sin comillas en un CSV con ";" parte la celda: lo que sobra va a la última columna.
      const cells = r.length > headers.length
        ? [...r.slice(0, headers.length - 1), r.slice(headers.length - 1).join(';')]
        : r;
      return { line: i + 2, values: Object.fromEntries(headers.map((h, j) => [h, String(cells[j] ?? '').trim()])) };
    }),
  };
}

const byNormalized = (options, value) => {
  const v = normalize(value);
  return options.find((o) => normalize(o) === v) || options.find((o) => normalize(o).replace(/s$/, '') === v.replace(/s$/, ''));
};

function mapCategory(v) {
  const n = normalize(v);
  return Object.keys(CATEGORIES).find((k) => k === n || normalize(CATEGORIES[k].label) === n || normalize(CATEGORIES[k].label).replace(/s$/, '') === n.replace(/s$/, '')) || '';
}

const DEPARTMENT_WORDS = {
  mujer: ['mujer', 'mujeres', 'dama', 'damas', 'femenino'],
  hombre: ['hombre', 'hombres', 'caballero', 'caballeros', 'masculino'],
  ninos: ['ninos', 'nino', 'nina', 'ninas', 'ninos y ninas', 'infantil', 'kids'],
  unisex: ['unisex', 'ambos'],
};
const mapDepartment = (v) => Object.keys(DEPARTMENT_WORDS).find((k) => DEPARTMENT_WORDS[k].includes(normalize(v))) || '';

function mapCondition(v) {
  const n = normalize(v);
  if (/^nuevo sin/.test(n)) return 'nuevo_sin_etiqueta';
  if (/como nuevo|seminuevo/.test(n)) return 'como_nuevo';
  if (/^nuevo/.test(n)) return 'nuevo';
  if (/usado|buen estado|segunda/.test(n)) return 'usado';
  return n.replace(/ /g, '_');
}

function mapSize(category, itemType, v) {
  const sizes = allSizes(category);
  const exact = byNormalized(sizes, v);
  if (exact) return exact;
  const n = normalize(v).replace(/^talla /, '');
  const direct = byNormalized(sizes, n);
  if (direct) return direct;
  const num = Number(n.replace(',', '.'));
  if (Number.isFinite(num)) {
    if (category === 'zapatos') {
      const guess = num >= 30 ? `EU ${num}` : `US ${num}`;
      if (sizes.includes(guess)) return guess;
    }
    if (category === 'ropa' && sizes.includes(`Cintura ${num}`)) return `Cintura ${num}`;
  }
  return v;
}

const yes = (v) => (v === '' ? '1' : /^(si|s|1|x|yes|true|verdadero)$/.test(normalize(v)) ? '1' : '');

// Una fila del CSV → los mismos campos que el formulario de publicar.
export function rowToBody(values) {
  const category = mapCategory(values.categoria || '');
  const types = CATEGORIES[category]?.types || [];
  const itemType = byNormalized(types, values.tipo || '') || (values.tipo ? values.tipo : (types.includes('Otro') ? 'Otro' : ''));
  return {
    title: values.titulo || '',
    brand: values.marca || '',
    category,
    item_type: itemType,
    department: mapDepartment(values.para || ''),
    size: category ? mapSize(category, itemType, values.talla || '') : values.talla || '',
    color: values.color || '',
    condition: mapCondition(values.estado || ''),
    price: values.precio || '',
    quantity: values.cantidad || '1',
    shipping_cost: values.envio || '',
    meetup: yes(values.en_persona ?? ''),
    description: values.descripcion || '',
  };
}

const photoNames = (cell) => String(cell || '').split(/[;,|\n]+/).map((s) => s.trim()).filter(Boolean);

// Busca la foto por nombre exacto (sin importar mayúsculas) o sin la extensión ("polo1" → "polo1.jpg").
function findPhoto(photos, name) {
  const n = name.toLowerCase();
  if (photos.has(n)) return photos.get(n);
  for (const [k, v] of photos) if (k.replace(/\.[a-z0-9]+$/, '') === n.replace(/\.[a-z0-9]+$/, '')) return v;
  return null;
}

// Crea los artículos. photos: Map(nombre → ruta temporal). publish: false = todo como borrador.
// Devuelve una fila de resultado por cada fila del CSV.
export async function importRows({ sellerId, csv, photos, publish = true }) {
  const { headers, rows } = parseCsv(csv);
  if (!headers.includes('titulo')) throw new ImageError('El CSV no tiene la columna "titulo". Usa la plantilla.');
  if (!rows.length) throw new ImageError('El CSV no tiene artículos (solo el encabezado).');
  if (rows.length > MAX_ROWS) throw new ImageError(`Máximo ${MAX_ROWS} artículos por carga. Divide el archivo.`);
  const results = [];
  for (const { line, values } of rows) {
    const body = rowToBody(values);
    const { data, errors } = validateProduct(body);
    const names = photoNames(values.fotos);
    const missing = names.filter((n) => !findPhoto(photos, n));
    if (names.length > MAX_IMAGES) errors.photos = `Máximo ${MAX_IMAGES} fotos por artículo.`;
    if (missing.length) errors.photos = `No subiste ${missing.length === 1 ? 'la foto' : 'las fotos'}: ${missing.join(', ')}.`;
    // Mensajes que dicen qué valor del CSV está mal (no los del formulario).
    const label = CATEGORIES[body.category]?.label || 'esa categoría';
    const csvMessages = {
      category: `Categoría "${values.categoria || ''}" no existe: usa Ropa, Zapatos, Bolsos o Accesorios.`,
      item_type: `Tipo "${values.tipo || ''}" no existe en ${label}.`,
      size: `Talla "${values.talla || ''}" no es válida para ${label}.`,
      department: `"Para" debe ser Mujer, Hombre, Niños o Unisex (dice "${values.para || ''}").`,
      condition: `Estado "${values.estado || ''}" no existe: usa Nuevo con etiqueta, Nuevo sin etiqueta, Como nuevo o Usado.`,
      price: `Precio "${values.precio || ''}" no es válido: en colones, sin decimales.`,
    };
    const messages = Object.entries(errors)
      .filter(([k]) => !k.startsWith('_') && !(errors.category && ['item_type', 'size'].includes(k)))
      .map(([k, m]) => csvMessages[k] || m);
    if (messages.length) { results.push({ line, title: body.title, ok: false, messages }); continue; }

    const processed = [];
    try {
      for (const name of names) {
        // Se copia: la misma foto puede usarse en varias filas y processPhoto borra el temporal.
        const copy = path.join(TMP_DIR, crypto.randomBytes(12).toString('hex'));
        fs.copyFileSync(findPhoto(photos, name), copy);
        processed.push(await processPhoto(copy, UPLOAD_DIR));
      }
    } catch (e) {
      removeFrom(UPLOAD_DIR, processed.flatMap((p) => [p.filename, p.thumb, p.original]));
      results.push({ line, title: body.title, ok: false, messages: [e instanceof ImageError ? e.message : 'No se pudo procesar una foto.'] });
      continue;
    }
    const status = publish && processed.length ? 'disponible' : 'borrador';
    const id = createProduct(sellerId, data, processed, status);
    results.push({
      line, title: data.title, ok: true, id, status,
      messages: status === 'borrador' ? [processed.length ? 'Guardado como borrador.' : 'Sin fotos: quedó como borrador (agrégalas desde "Editar").'] : [],
    });
  }
  return results;
}

// Plantilla para Excel (con ";" y BOM, así Excel en español la abre en columnas).
export function templateCsv() {
  const head = COLUMNS.map(([k]) => k);
  const ex1 = COLUMNS.map(([, v]) => v);
  const ex2 = ['Air Force 1 blancas', 'Nike', 'Zapatos', 'Tenis', 'Unisex', '9', 'Blanco', 'Como nuevo', '45000', '1', '0', 'Sí', 'Usadas dos veces.', 'af1.jpg'];
  const cell = (v) => (/[";\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return `﻿${[head, ex1, ex2].map((r) => r.map(cell).join(';')).join('\r\n')}\r\n`;
}
