// Dirección de la tienda (privada: solo el admin) y sus puntos de pick up o entrega en persona
// (públicos: se muestran en el artículo y el comprador elige uno al pedir pick up).
import { db } from './db.js';
import { findBlocked } from './moderation.js';

export const MAX_POINTS = 5;
const MAX_POINT_LEN = 120;

// Un punto por línea. Nada de teléfonos, redes ni enlaces (se muestran a todos).
export function parsePickupPoints(text) {
  const points = String(text ?? '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (points.length > MAX_POINTS) return { points, error: `Máximo ${MAX_POINTS} puntos de entrega.` };
  if (points.some((p) => p.length < 5 || p.length > MAX_POINT_LEN)) return { points, error: `Cada punto entre 5 y ${MAX_POINT_LEN} caracteres (ej. "Mall Oxígeno, Heredia — sábados 2 a 5 p. m.").` };
  if (points.some((p) => findBlocked(p))) return { points, error: 'Los puntos de entrega no pueden tener teléfonos, redes ni enlaces: se muestran a los compradores.' };
  return { points: [...new Set(points)], error: null };
}

export function validateStoreLocation(body) {
  const address = String(body.store_address ?? '').trim().slice(0, 300);
  const { points, error } = parsePickupPoints(body.pickup_points);
  const errors = {};
  if (address.length < 10) errors.store_address = 'Escribe la dirección de tu tienda o desde dónde despachas (provincia, cantón y señas).';
  if (error) errors.pickup_points = error;
  else if (!points.length) errors.pickup_points = 'Agrega al menos un punto donde puedas entregar en persona (pick up).';
  return { address, points, errors };
}

export function saveStoreLocation(userId, address, points) {
  db.prepare('UPDATE users SET store_address = ?, pickup_points = ? WHERE id = ?').run(address, JSON.stringify(points), userId);
}

export function pickupPointsOf(userId) {
  try {
    const raw = db.prepare('SELECT pickup_points FROM users WHERE id = ?').get(userId)?.pickup_points;
    const list = JSON.parse(raw || '[]');
    return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

export const storeAddressOf = (userId) => db.prepare('SELECT store_address FROM users WHERE id = ?').get(userId)?.store_address || '';
