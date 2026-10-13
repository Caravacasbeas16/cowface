// Texto de búsqueda: sin tildes ni mayúsculas, con la categoría, para quién, talla y estado,
// para que "sueter", "zapatos nike", "vestido mujer" o "nino" encuentren lo que corresponde.
// Se busca por inicio de palabra: "camisa" encuentra "camisas", pero "nino" no encuentra "femenino".
import { CATEGORIES, DEPARTMENTS } from './catalog.js';

export const normalize = (s) => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9.\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Unisex aparece al buscar "mujer" u "hombre"; niños también como "niña" o "infantil".
const DEPARTMENT_WORDS = {
  mujer: 'mujer dama',
  hombre: 'hombre caballero',
  ninos: 'ninos ninas infantil kids',
  unisex: 'unisex mujer hombre',
};

// "nuevo" no debe encontrar "usado - como nuevo".
const CONDITION_WORDS = {
  nuevo: 'nuevo etiqueta',
  nuevo_sin_etiqueta: 'nuevo',
  como_nuevo: 'usado seminuevo',
  usado: 'usado',
};

const LETTER_SIZES = new Set(['xxs', 'xs', 's', 'm', 'l', 'xl', 'xxl', 'xxxl', '2xl', '3xl', '4xl']);

export function buildSearchText(p) {
  const text = normalize([
    p.title, p.brand, p.brand && p.brand.replace(/[^\p{L}\p{N}]/gu, ''), p.item_type, p.color,
    p.size && `talla ${p.size}`, CATEGORIES[p.category]?.label, DEPARTMENT_WORDS[p.department] || DEPARTMENTS[p.department],
    CONDITION_WORDS[p.condition], p.description,
  ].filter(Boolean).join(' '));
  // Espacios al inicio y al final para poder buscar por palabra completa o por inicio de palabra.
  return text ? ` ${text} ` : ' ';
}

// Singular aproximado: "camisas" → "camisa", "pantalones" → "pantalon", "tenis" → "teni".
export function stem(word) {
  if (word.length > 4 && /[^aeiou]es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

// Palabras que significan lo mismo en Costa Rica (ya en singular y sin tildes).
const SYNONYMS = [
  ['teni', 'zapatilla', 'sneaker', 'tennis'],
  ['sueter', 'sweater', 'hoodie', 'sudadera', 'buzo'],
  ['chaqueta', 'jacket', 'chamarra', 'campera'],
  ['jean', 'mezclilla', 'denim'],
  ['pantalon', 'pants'],
  ['camiseta', 'playera', 'tshirt', 'tee'],
  ['short', 'pantaloneta'],
  ['bolso', 'bolsa', 'cartera'],
  ['gorra', 'cap'],
  ['lente', 'gafa', 'anteojo'],
  ['zapato', 'calzado'],
  ['reloj', 'watch'],
  ['nino', 'nina', 'infantil', 'kid'],
];

// Solo en un sentido: quien busca "pantalones" también quiere ver jeans, pero no al revés.
const BROADER = { pantalon: ['jean'] };

const STOPWORDS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'con', 'para', 'en', 'un', 'una', 'por', 'a', 'talla']);

// Cada palabra de la búsqueda es un grupo de patrones LIKE alternativos (la palabra, su singular y
// sinónimos, al inicio de una palabra); el artículo tiene que coincidir con uno de cada grupo.
// Una talla de letras ("m", "xl") busca exactamente esa talla.
export function queryPatterns(q) {
  const words = normalize(q).split(' ').filter((w) => w && !STOPWORDS.has(w)).slice(0, 6);
  return words.flatMap((w) => {
    if (LETTER_SIZES.has(w)) return [[`% talla ${w} %`]];
    if (w.length < 2) return [];
    const s = stem(w);
    const alts = new Set([s]);
    for (const group of SYNONYMS) if (group.includes(s)) group.forEach((g) => alts.add(g));
    for (const g of BROADER[s] || []) alts.add(g);
    return [[...alts].map((a) => `% ${a.replace(/[%_]/g, '')}%`)];
  });
}
