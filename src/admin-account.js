import { db } from './db.js';
import { hashPassword } from './auth.js';

// Crea (o actualiza la contraseña de) la cuenta admin definida en ADMIN_EMAIL / ADMIN_PASSWORD.
// En producción se llama al arrancar, así la cuenta se configura solo con variables de entorno.
export function ensureAdmin({ email, password }) {
  db.prepare(`
    INSERT INTO users (role, name, email, password_hash) VALUES ('admin', 'Administración', ?, ?)
    ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, role = 'admin', active = 1
  `).run(email.trim().toLowerCase(), hashPassword(password));
}

export function adminFromEnv() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email && !password) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12) {
    throw new Error('ADMIN_EMAIL debe ser un correo válido y ADMIN_PASSWORD tener al menos 12 caracteres.');
  }
  return { email, password };
}
