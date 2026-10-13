// Catálogo fijo: categorías, tipos, tallas, estados y provincias.
// Todo lo que el usuario elige en un <select> se valida contra estas listas.

export const SITE_NAME = process.env.SITE_NAME || 'CowFace';

const range = (from, to, step = 1, prefix = '') => {
  const out = [];
  for (let n = from; n <= to + 1e-9; n += step) out.push(`${prefix}${Number.isInteger(n) ? n : n.toFixed(1)}`);
  return out;
};

export const CATEGORIES = {
  ropa: {
    label: 'Ropa',
    types: [
      'Camisas', 'Camisas polo', 'Camisetas', 'Blusas', 'Suéteres y hoodies', 'Pantalones', 'Jeans',
      'Shorts', 'Faldas', 'Vestidos', 'Enterizos', 'Abrigos y chaquetas', 'Ropa deportiva',
      'Ropa de dormir', 'Ropa interior', 'Trajes de baño', 'Uniformes', 'Trajes formales', 'Otro',
    ],
    sizes: {
      'Letras': ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL'],
      'Niños': range(0, 16, 2, 'Niño '),
      'Cintura (pantalón)': range(26, 44, 2, 'Cintura '),
      'Otra': ['Única'],
    },
  },
  zapatos: {
    label: 'Zapatos',
    types: [
      'Tenis', 'Zapatos formales', 'Sandalias', 'Tacones', 'Botas', 'Zapatos de fútbol',
      'Mocasines', 'Chancletas', 'Otro',
    ],
    sizes: {
      'Talla US': range(5, 13, 0.5, 'US '),
      'Talla EU': range(35, 47, 1, 'EU '),
      'Niños': range(20, 34, 1, 'Niño '),
    },
  },
  bolsos: {
    label: 'Bolsos',
    types: ['Bolsos de mano', 'Carteras', 'Mochilas', 'Bandoleras', 'Billeteras', 'Maletas', 'Loncheras', 'Otro'],
    sizes: { 'Tamaño': ['Pequeño', 'Mediano', 'Grande', 'Única'] },
  },
  accesorios: {
    label: 'Accesorios',
    types: ['Gorras y sombreros', 'Cinturones', 'Bufandas', 'Lentes', 'Joyería', 'Relojes', 'Corbatas', 'Otro'],
    sizes: { 'Talla': ['Única', 'S', 'M', 'L'] },
  },
};

// Medidas reales en centímetros, según la categoría (todas opcionales, pero muy recomendadas:
// en ropa usada la talla de la etiqueta no alcanza para decidir).
export const MEASUREMENTS = {
  ropa: [
    { key: 'pecho', label: 'Pecho', hint: 'De axila a axila, con la prenda plana' },
    { key: 'largo', label: 'Largo', hint: 'Del hombro (o cintura) hasta el borde de abajo' },
    { key: 'hombros', label: 'Hombros', hint: 'De costura a costura' },
    { key: 'manga', label: 'Manga', hint: 'Del hombro al puño' },
    { key: 'cintura', label: 'Cintura', hint: 'De lado a lado, con la prenda plana' },
    { key: 'tiro', label: 'Tiro', hint: 'De la entrepierna a la cintura' },
    { key: 'entrepierna', label: 'Largo de pierna', hint: 'De la entrepierna al ruedo' },
  ],
  zapatos: [
    { key: 'plantilla', label: 'Largo de plantilla', hint: 'Por dentro, del talón a la punta' },
    { key: 'ancho', label: 'Ancho de suela', hint: 'En la parte más ancha' },
  ],
  bolsos: [
    { key: 'ancho', label: 'Ancho' },
    { key: 'alto', label: 'Alto' },
    { key: 'fondo', label: 'Fondo' },
    { key: 'asa', label: 'Caída del asa', hint: 'Del borde del bolso al punto más alto del asa' },
  ],
  accesorios: [
    { key: 'largo', label: 'Largo' },
    { key: 'ancho', label: 'Ancho' },
  ],
};

export const DEPARTMENTS = {
  mujer: 'Mujer',
  hombre: 'Hombre',
  ninos: 'Niños y niñas',
  unisex: 'Unisex',
};

export const CONDITIONS = {
  nuevo: 'Nuevo con etiqueta',
  nuevo_sin_etiqueta: 'Nuevo sin etiqueta',
  como_nuevo: 'Usado - como nuevo',
  usado: 'Usado - buen estado',
};

// "nuevo" / "usado" como filtro rápido en la búsqueda.
export const CONDITION_GROUPS = {
  nuevo: ['nuevo', 'nuevo_sin_etiqueta'],
  usado: ['como_nuevo', 'usado'],
};

export const PROVINCES = ['San José', 'Alajuela', 'Cartago', 'Heredia', 'Guanacaste', 'Puntarenas', 'Limón'];

export const PRODUCT_STATUS = { borrador: 'Borrador', disponible: 'Disponible', pausado: 'Pausado', reservado: 'Reservado', vendido: 'Vendido' };
export const ORDER_STATUS = {
  por_pagar: 'Esperando pago',
  pagado: 'Pagado · por enviar',
  enviado: 'Enviado',
  completado: 'Completado',
  en_disputa: 'En reclamo',
  reembolso_pendiente: 'Reembolso pendiente',
  reembolsado: 'Reembolsado',
  cancelado: 'Cancelado',
};
export const OFFER_STATUS = {
  pendiente: 'Pendiente', aceptada: 'Aceptada', rechazada: 'Rechazada', reemplazada: 'Reemplazada', retirada: 'Retirada', expirada: 'Vencida',
};

export const SORTS = {
  recientes: 'Más recientes',
  precio_asc: 'Precio: menor a mayor',
  precio_desc: 'Precio: mayor a menor',
};

export function allSizes(category) {
  return Object.values(CATEGORIES[category]?.sizes || {}).flat();
}

export function isValidSize(category, size) {
  return allSizes(category).includes(size);
}

export function formatColones(n) {
  return '₡' + Math.round(Number(n) || 0).toLocaleString('es-CR');
}
