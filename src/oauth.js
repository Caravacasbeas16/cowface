// Entrar con Google o Facebook (OAuth 2.0, flujo de código). Cada proveedor se activa solo si
// sus credenciales están en las variables de entorno; si no, el botón no aparece.
//   Google:   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
//   Facebook: FACEBOOK_APP_ID, FACEBOOK_APP_SECRET
// La dirección de regreso es <PUBLIC_URL>/auth/<proveedor>/callback (PUBLIC_URL es opcional).
import { db } from './db.js';
import { UserError } from './messages.js';
import { publicBaseUrl } from './urls.js';

const env = (k) => (process.env[k] || '').trim();

export const PROVIDERS = {
  google: {
    label: 'Google',
    id: () => env('GOOGLE_CLIENT_ID'),
    secret: () => env('GOOGLE_CLIENT_SECRET'),
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
  },
  facebook: {
    label: 'Facebook',
    id: () => env('FACEBOOK_APP_ID'),
    secret: () => env('FACEBOOK_APP_SECRET'),
    authorize: 'https://www.facebook.com/dialog/oauth',
    token: 'https://graph.facebook.com/oauth/access_token',
    scope: 'email,public_profile',
  },
};

export function enabledProviders() {
  return Object.keys(PROVIDERS).filter((p) => PROVIDERS[p].id() && PROVIDERS[p].secret());
}

export function redirectUri(req, provider) {
  return `${publicBaseUrl(req)}/auth/${provider}/callback`;
}

export function authorizeUrl(provider, state, redirect) {
  const p = PROVIDERS[provider];
  const params = new URLSearchParams({ client_id: p.id(), redirect_uri: redirect, response_type: 'code', scope: p.scope, state });
  if (provider === 'google') params.set('prompt', 'select_account');
  return `${p.authorize}?${params}`;
}

async function getJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OAuth ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

// Cambia el código por los datos básicos del usuario: { subject, email, emailVerified, name }.
export async function fetchProfile(provider, code, redirect) {
  const p = PROVIDERS[provider];
  const body = new URLSearchParams({ client_id: p.id(), client_secret: p.secret(), redirect_uri: redirect, code });
  if (provider === 'google') {
    body.set('grant_type', 'authorization_code');
    const token = await getJson(p.token, { method: 'POST', body });
    const info = await getJson('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    return { subject: String(info.sub), email: info.email || '', emailVerified: info.email_verified === true, name: info.name || '' };
  }
  const token = await getJson(`${p.token}?${body}`);
  const info = await getJson(`https://graph.facebook.com/me?${new URLSearchParams({ fields: 'id,name,email', access_token: token.access_token })}`);
  // Facebook solo entrega correos que la persona ya confirmó.
  return { subject: String(info.id), email: info.email || '', emailVerified: Boolean(info.email), name: info.name || '' };
}

// Encuentra o crea la cuenta para ese perfil. Devuelve { userId, isNew }.
export function loginWithProvider(provider, profile) {
  const linked = db.prepare(`
    SELECT u.id, u.active FROM oauth_accounts o JOIN users u ON u.id = o.user_id WHERE o.provider = ? AND o.subject = ?
  `).get(provider, profile.subject);
  if (linked) {
    if (!linked.active) throw new UserError('Tu cuenta está suspendida. Escríbenos si crees que es un error.');
    return { userId: linked.id, isNew: false };
  }

  const email = String(profile.email || '').trim().toLowerCase();
  if (!email || !profile.emailVerified) {
    throw new UserError(`${PROVIDERS[provider].label} no compartió un correo confirmado. Crea tu cuenta con correo y contraseña.`);
  }
  const existing = db.prepare('SELECT id, role, active FROM users WHERE email = ?').get(email);
  if (existing) {
    if (existing.role !== 'usuario' || !existing.active) throw new UserError('No puedes entrar con esta cuenta por este medio.');
    // Solo Google garantiza que el correo está verificado; con otros, se entra con la contraseña.
    if (provider !== 'google') throw new UserError('Ya tienes una cuenta con ese correo. Entra con tu correo y contraseña.');
    // Google confirmó que la persona es dueña de ese correo: se vincula a la cuenta que ya existe.
    // Como el registro con contraseña no verifica el correo, esa cuenta pudo crearla otra persona:
    // se anula la contraseña y se cierran sus sesiones, así solo entra quien controla el correo.
    db.prepare('INSERT INTO oauth_accounts (provider, subject, user_id, email) VALUES (?, ?, ?, ?)').run(provider, profile.subject, existing.id, email);
    db.prepare("UPDATE users SET password_hash = '!' WHERE id = ?").run(existing.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
    return { userId: existing.id, isNew: false };
  }

  const name = String(profile.name || email.split('@')[0]).trim().slice(0, 80);
  // Sin contraseña ('!' nunca coincide): entra siempre por su proveedor.
  const { lastInsertRowid } = db.prepare(
    "INSERT INTO users (role, name, email, password_hash) VALUES ('usuario', ?, ?, '!')",
  ).run(name, email);
  const userId = Number(lastInsertRowid);
  db.prepare('INSERT INTO oauth_accounts (provider, subject, user_id, email) VALUES (?, ?, ?, ?)').run(provider, profile.subject, userId, email);
  return { userId, isNew: true };
}
