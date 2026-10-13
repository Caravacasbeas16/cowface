// Filtro anti-contacto: impide compartir redes sociales, teléfonos, correos o enlaces
// antes de que la venta quede registrada en CowFace (así la comisión no se pierde).
import { db, getSetting, setSetting } from './db.js';

export const DEFAULT_BLOCKED_WORDS = [
  'whatsapp', 'whats', 'wasap', 'guasap', 'wsp', 'wpp', 'wa.me',
  'facebook', 'face', 'fb', 'messenger',
  'instagram', 'insta', 'ig',
  'telegram', 'tiktok', 'snapchat', 'signal',
  'gmail', 'hotmail', 'outlook', 'yahoo',
];

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '€': 'e' };

// Minúsculas, sin tildes y con los trucos comunes deshechos ("f4ceb00k" → "facebook").
export function normalize(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[013457@$€]/g, (c) => LEET[c]);
}

export function blockedWords() {
  const saved = getSetting('blocked_words');
  return saved == null ? DEFAULT_BLOCKED_WORDS : saved.split('\n').map((w) => w.trim()).filter(Boolean);
}

export function saveBlockedWords(text) {
  const words = [...new Set(String(text).split(/[\n,]/).map((w) => normalize(w.trim())).filter((w) => w.length >= 2))];
  setSetting('blocked_words', words.slice(0, 300).join('\n'));
  return words;
}

const PATTERNS = [
  // Teléfonos de Costa Rica: 8888-8888, 8888 8888, +506 88888888 (no después de ₡, para no confundir precios).
  { label: 'número de teléfono', re: /(?<![\d₡])(?:\+?\s?506[\s.-]?)?[2-8]\d{3}[\s.-]?\d{4}(?!\d)/ },
  // Dígitos separados uno por uno: 8 8 8 8 8 8 8 8
  { label: 'número de teléfono', re: /(?<!\d)(?:\d[\s.-]){7}\d(?!\d)/ },
  { label: 'correo electrónico', re: /[\w.+-]+\s*(?:@|\(at\)|\[at\]|\barroba\b)\s*[\w-]+\s*(?:\.|\bpunto\b)\s*[a-z]{2,}/i },
  { label: 'enlace', re: /(?:https?:\/\/|www\.)\S+/i },
  { label: 'enlace', re: /\b[\w-]+\.(?:com|net|org|cr|me|io|ly|co|app|link)\b/i },
];

// Devuelve lo que encontró (para avisarle al usuario) o null si el texto está limpio.
export function findBlocked(text, words = blockedWords()) {
  const raw = String(text ?? '');
  for (const { label, re } of PATTERNS) if (re.test(raw)) return label;

  const norm = normalize(raw);
  const tokens = new Set(norm.split(/[^a-z]+/).filter(Boolean));
  const collapsed = norm.replace(/[^a-z]/g, '');
  for (const word of words) {
    const w = normalize(word);
    if (/[^a-z]/.test(w)) {
      if (norm.includes(w)) return word;           // "wa.me" y similares
    } else if (w.length >= 6) {
      if (collapsed.includes(w)) return word;      // atrapa "w h a t s a p p", "face-book"
    } else if (tokens.has(w)) {
      return word;                                 // palabras cortas, solo completas ("fb", "ig")
    }
  }
  return null;
}

export function logFlagged({ userId, conversationId = null, context, body, matched }) {
  db.prepare('INSERT INTO flagged_messages (user_id, conversation_id, context, body, matched) VALUES (?, ?, ?, ?, ?)')
    .run(userId, conversationId, context, String(body).slice(0, 1000), matched);
}

export function blockedMessage(matched) {
  return `No se permite compartir ${/^(número|correo|enlace)/.test(matched) ? `un ${matched}` : `"${matched}"`} en CowFace. ` +
    'Para protegerte, toda la conversación y el trato se hacen aquí; cuando la venta queda registrada te mostramos los datos para el pago.';
}
