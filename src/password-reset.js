// "¿Olvidaste tu contraseña?": enlaces de un solo uso que vencen solos.
// Solo se guarda el hash SHA-256 del token; el token en sí viaja únicamente en el enlace.
import crypto from 'node:crypto';
import { db, transaction } from './db.js';
import { hashPassword } from './auth.js';
import { UserError } from './messages.js';

export const EMAIL_LINK_MINUTES = 60;
export const ADMIN_LINK_HOURS = 24;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Crea un enlace nuevo (anula los anteriores sin usar) y devuelve el token en claro.
export function createResetToken(userId, minutes = EMAIL_LINK_MINUTES) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + minutes * 60e3).toISOString();
  transaction(() => {
    db.prepare('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL').run(userId);
    db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, expires);
  });
  return token;
}

// Devuelve el usuario dueño del enlace si sigue válido; si no, null.
export function findValidReset(token) {
  if (typeof token !== 'string' || !/^[\w-]{40,60}$/.test(token)) return null;
  return db.prepare(`
    SELECT r.token_hash, u.id AS user_id, u.email, u.name
    FROM password_resets r JOIN users u ON u.id = r.user_id
    WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > ? AND u.active = 1 AND u.role = 'usuario'
  `).get(sha256(token), new Date().toISOString()) || null;
}

export function validateNewPassword(password, confirm) {
  const p = String(password ?? '');
  if (p.length < PASSWORD_MIN) return `La contraseña debe tener al menos ${PASSWORD_MIN} caracteres.`;
  if (p.length > PASSWORD_MAX) return `La contraseña no puede pasar de ${PASSWORD_MAX} caracteres.`;
  if (confirm !== undefined && p !== String(confirm ?? '')) return 'Las contraseñas no coinciden.';
  return null;
}

// Cambia la contraseña, marca el enlace como usado y cierra todas las sesiones abiertas
// (si alguien más tenía acceso a la cuenta, lo pierde).
export function resetPassword(token, password, confirm) {
  return transaction(() => {
    const reset = findValidReset(token);
    if (!reset) throw new UserError('El enlace venció o ya se usó. Pide uno nuevo.');
    const problem = validateNewPassword(password, confirm);
    if (problem) throw new UserError(problem);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(password)), reset.user_id);
    db.prepare("UPDATE password_resets SET used_at = datetime('now') WHERE token_hash = ?").run(reset.token_hash);
    db.prepare('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL').run(reset.user_id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(reset.user_id);
    return reset.user_id;
  });
}
