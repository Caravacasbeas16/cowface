// Validación de formularios en el borde del sistema. Cada función devuelve
// { data, errors } — errors es un objeto { campo: mensaje } vacío si todo está bien.
import { CATEGORIES, CONDITIONS, DEPARTMENTS, PROVINCES, isValidSize } from './catalog.js';
import { blockedMessage, findBlocked } from './moderation.js';

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

// Teléfonos de Costa Rica: 8 dígitos, opcionalmente con +506 delante.
export function normalizePhone(v) {
  const digits = String(v ?? '').replace(/\D/g, '').replace(/^506(?=\d{8}$)/, '');
  return /^[2-8]\d{7}$/.test(digits) ? digits : null;
}

export function parsePrice(v) {
  const n = Number(String(v ?? '').replace(/[₡,.\s]/g, ''));
  return Number.isInteger(n) && n > 0 && n <= 10_000_000 ? n : null;
}

export function validateSignup(body) {
  const data = {
    name: str(body.name, 80),
    store_name: str(body.store_name, 80),
    email: str(body.email, 120).toLowerCase(),
    phone: normalizePhone(body.phone),
    province: str(body.province, 40),
    password: String(body.password ?? ''),
  };
  const errors = {};
  if (data.name.length < 2) errors.name = 'Escribe tu nombre.';
  if (data.store_name && data.store_name.length < 2) errors.store_name = 'Muy corto.';
  const blocked = findBlocked(`${data.name} ${data.store_name}`);
  if (blocked) errors.store_name = blockedMessage(blocked);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) errors.email = 'Correo no válido.';
  if (!data.phone) errors.phone = 'Teléfono de 8 dígitos (ej. 8888-8888).';
  if (!PROVINCES.includes(data.province)) errors.province = 'Elige una provincia.';
  if (data.password.length < 8) errors.password = 'Mínimo 8 caracteres.';
  else if (data.password.length > 200) errors.password = 'Máximo 200 caracteres.';
  return { data, errors };
}

export function validateProduct(body) {
  const data = {
    title: str(body.title, 100),
    brand: str(body.brand, 60),
    description: str(body.description, 2000),
    category: str(body.category, 20),
    department: str(body.department, 20),
    item_type: str(body.item_type, 60),
    size: str(body.size, 30),
    color: str(body.color, 40),
    condition: str(body.condition, 30),
    price: parsePrice(body.price),
    quantity: Number.parseInt(body.quantity, 10),
  };
  const errors = {};
  if (data.title.length < 3) errors.title = 'Escribe un título (ej. "Camisa polo Lacoste azul").';
  if (!CATEGORIES[data.category]) errors.category = 'Elige una categoría.';
  else {
    if (!CATEGORIES[data.category].types.includes(data.item_type)) errors.item_type = 'Elige el tipo de artículo.';
    if (!isValidSize(data.category, data.size)) errors.size = 'Elige una talla válida para esta categoría.';
  }
  if (!DEPARTMENTS[data.department]) errors.department = 'Elige para quién es.';
  if (!CONDITIONS[data.condition]) errors.condition = 'Elige el estado.';
  if (!data.price) errors.price = 'Precio en colones, sin decimales.';
  if (!Number.isInteger(data.quantity) || data.quantity < 1 || data.quantity > 999) errors.quantity = 'Cantidad entre 1 y 999.';
  // Nada de teléfonos, redes o enlaces en la publicación.
  const blocked = findBlocked([data.title, data.brand, data.color, data.description].join('\n'));
  if (blocked) { errors.description = blockedMessage(blocked); errors._blocked = blocked; }
  return { data, errors };
}

// Solo permite redirigir a rutas internas (evita redirecciones abiertas).
export function safeNext(v, fallback = '/') {
  const s = String(v ?? '');
  return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') ? s : fallback;
}
