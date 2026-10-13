import { db } from './db.js';
import { hashPassword, verifyPassword } from './auth.js';

// Crea (o actualiza la contraseña de) la cuenta admin definida en ADMIN_EMAIL / ADMIN_PASSWORD.
// En producción se llama al arrancar, así la cuenta se configura solo con variables de entorno.
//
// Seguridad: nunca convierte en admin una cuenta normal que ya exista con ese correo (alguien
// podría registrarse antes con el correo del admin). Si la contraseña cambia, cierra todas las
// sesiones de admin abiertas.
export function ensureAdmin({ email, password }) {
  const address = email.trim().toLowerCase();
  const existing = db.prepare('SELECT id, role, password_hash FROM users WHERE email = ?').get(address);
  if (existing && existing.role !== 'admin') {
    console.error(`ALERTA: ya existe una cuenta normal con ADMIN_EMAIL (${address}); no se convierte en admin. `
      + 'Usa otro correo para el admin o suspende esa cuenta.');
    return false;
  }
  if (!existing) {
    db.prepare("INSERT INTO users (role, name, email, password_hash) VALUES ('admin', 'Administración', ?, ?)")
      .run(address, hashPassword(password));
    return true;
  }
  if (!verifyPassword(password, existing.password_hash)) {
    db.prepare('UPDATE users SET password_hash = ?, active = 1 WHERE id = ?').run(hashPassword(password), existing.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
  }
  return true;
}

// Correo reservado para el admin: nadie puede registrarse con él.
export function adminEmail() {
  return (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
}

export function adminFromEnv() {
  const email = adminEmail();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email && !password) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12) {
    throw new Error('ADMIN_EMAIL debe ser un correo válido y ADMIN_PASSWORD tener al menos 12 caracteres.');
  }
  return { email, password };
}
