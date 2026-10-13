// Datos de demostración para probar en tu computadora. No se usa en producción.
//   npm run seed            → crea admin + demo (solo si no hay artículos)
//   npm run seed -- --reset → borra todo y vuelve a crear
//
// Admin: ADMIN_EMAIL / ADMIN_PASSWORD en .env, o si no están, DEV_ADMIN de abajo.
// Usuarios demo (vendedores y una compradora): los correos de DEMO_SELLERS y DEMO_BUYER, contraseña DEMO_PASSWORD.
import { db, setSetting, transaction } from './db.js';
import { hashPassword } from './auth.js';
import { adminFromEnv, ensureAdmin } from './admin-account.js';
import { getConversationForUser, getOrCreateConversation, makeOffer, sendText } from './chat.js';
import { getProduct } from './products.js';

if (process.env.NODE_ENV === 'production') {
  console.error('El seed de demostración no corre en producción. La cuenta admin se crea sola al arrancar.');
  process.exit(1);
}

const DEMO_PASSWORD = 'demo-cowface-2026';
const DEV_ADMIN = { email: 'admin@cowface.local', password: 'admin-cowface-2026' };
const DEMO_BUYER = { name: 'Sofía Jiménez', email: 'sofia@demo.cr', phone: '87775555', province: 'San José' };

const DEMO_SELLERS = [
  { name: 'Ana Solís', store_name: 'Closet de Ana', email: 'ana@demo.cr', phone: '88881111', province: 'San José' },
  { name: 'Luis Mora', store_name: 'Tenis CR', email: 'luis@demo.cr', phone: '88882222', province: 'Heredia' },
  { name: 'Karla Vargas', store_name: 'Bolsos Karla', email: 'karla@demo.cr', phone: '88883333', province: 'Cartago' },
  { name: 'Diego Rojas', store_name: 'Ropa Americana La Paca', email: 'diego@demo.cr', phone: '88884444', province: 'Alajuela' },
];

// [vendedor, título, marca, categoría, para, tipo, talla, color, estado, precio, cantidad]
const DEMO_PRODUCTS = [
  [0, 'Camisa polo Lacoste azul marino', 'Lacoste', 'ropa', 'hombre', 'Camisas polo', 'M', 'Azul marino', 'nuevo', 28000, 2],
  [0, 'Camisa polo Ralph Lauren blanca', 'Ralph Lauren', 'ropa', 'hombre', 'Camisas polo', 'L', 'Blanco', 'como_nuevo', 15000, 1],
  [3, 'Polo Tommy Hilfiger roja', 'Tommy Hilfiger', 'ropa', 'hombre', 'Camisas polo', 'M', 'Rojo', 'usado', 6500, 1],
  [3, 'Polo deportiva Nike Dri-FIT', 'Nike', 'ropa', 'hombre', 'Camisas polo', 'S', 'Negro', 'como_nuevo', 7000, 1],
  [0, 'Vestido floral de verano', 'Zara', 'ropa', 'mujer', 'Vestidos', 'S', 'Floreado', 'nuevo_sin_etiqueta', 18000, 1],
  [0, 'Blusa de lino beige', 'Mango', 'ropa', 'mujer', 'Blusas', 'M', 'Beige', 'nuevo', 14500, 3],
  [3, 'Jeans Levi\'s 501', 'Levi\'s', 'ropa', 'hombre', 'Jeans', 'Cintura 32', 'Azul', 'usado', 9000, 1],
  [3, 'Jeans skinny tiro alto', 'American Eagle', 'ropa', 'mujer', 'Jeans', 'Cintura 28', 'Azul claro', 'como_nuevo', 8500, 1],
  [3, 'Hoodie Champion gris', 'Champion', 'ropa', 'unisex', 'Suéteres y hoodies', 'L', 'Gris', 'usado', 7500, 1],
  [0, 'Uniforme escolar camisa blanca', '', 'ropa', 'ninos', 'Uniformes', 'Niño 10', 'Blanco', 'nuevo', 6000, 10],
  [3, 'Camiseta Saprissa 2025', 'Kappa', 'ropa', 'hombre', 'Camisetas', 'M', 'Morado', 'nuevo', 32000, 2],
  [3, 'Camiseta Liga Deportiva Alajuelense', 'Umbro', 'ropa', 'hombre', 'Camisetas', 'XL', 'Rojo y negro', 'como_nuevo', 16000, 1],
  [0, 'Traje de baño entero negro', 'Speedo', 'ropa', 'mujer', 'Trajes de baño', 'M', 'Negro', 'nuevo', 19000, 2],
  [3, 'Short de baño estampado', 'Quiksilver', 'ropa', 'hombre', 'Trajes de baño', 'L', 'Azul', 'usado', 5000, 1],
  [1, 'Nike Air Force 1 blancas', 'Nike', 'zapatos', 'unisex', 'Tenis', 'US 9', 'Blanco', 'nuevo', 62000, 3],
  [1, 'Adidas Samba OG', 'Adidas', 'zapatos', 'unisex', 'Tenis', 'US 8', 'Negro', 'nuevo', 68000, 2],
  [1, 'New Balance 550', 'New Balance', 'zapatos', 'hombre', 'Tenis', 'US 10', 'Blanco y verde', 'como_nuevo', 38000, 1],
  [1, 'Tacos de fútbol Puma Future', 'Puma', 'zapatos', 'hombre', 'Zapatos de fútbol', 'US 9.5', 'Naranja', 'usado', 22000, 1],
  [1, 'Sandalias Birkenstock Arizona', 'Birkenstock', 'zapatos', 'mujer', 'Sandalias', 'EU 38', 'Café', 'como_nuevo', 35000, 1],
  [1, 'Tacones nude punta fina', 'Steve Madden', 'zapatos', 'mujer', 'Tacones', 'US 7', 'Nude', 'nuevo_sin_etiqueta', 29000, 1],
  [1, 'Botas Dr. Martens 1460', 'Dr. Martens', 'zapatos', 'unisex', 'Botas', 'EU 42', 'Negro', 'usado', 45000, 1],
  [1, 'Tenis Skechers para niño con luces', 'Skechers', 'zapatos', 'ninos', 'Tenis', 'Niño 28', 'Azul', 'nuevo', 24000, 2],
  [2, 'Bolso tote de cuero café', 'Michael Kors', 'bolsos', 'mujer', 'Bolsos de mano', 'Grande', 'Café', 'como_nuevo', 55000, 1],
  [2, 'Cartera pequeña Guess negra', 'Guess', 'bolsos', 'mujer', 'Carteras', 'Pequeño', 'Negro', 'nuevo', 32000, 2],
  [2, 'Mochila JanSport clásica', 'JanSport', 'bolsos', 'unisex', 'Mochilas', 'Mediano', 'Azul', 'nuevo', 26000, 4],
  [2, 'Bandolera Coach', 'Coach', 'bolsos', 'mujer', 'Bandoleras', 'Pequeño', 'Beige', 'usado', 38000, 1],
  [2, 'Billetera de cuero para hombre', 'Fossil', 'bolsos', 'hombre', 'Billeteras', 'Única', 'Negro', 'nuevo', 18000, 3],
  [2, 'Maleta de mano rígida 20"', 'Samsonite', 'bolsos', 'unisex', 'Maletas', 'Mediano', 'Gris', 'como_nuevo', 42000, 1],
  [0, 'Gorra New Era Yankees', 'New Era', 'accesorios', 'unisex', 'Gorras y sombreros', 'Única', 'Negro', 'nuevo', 17000, 5],
  [2, 'Lentes de sol Ray-Ban Wayfarer', 'Ray-Ban', 'accesorios', 'unisex', 'Lentes', 'Única', 'Negro', 'como_nuevo', 48000, 1],
  [0, 'Faja de cuero reversible', 'Calvin Klein', 'accesorios', 'hombre', 'Cinturones', 'M', 'Negro/café', 'nuevo', 16000, 2],
];

const reset = process.argv.includes('--reset');

const admin = adminFromEnv() || DEV_ADMIN;

transaction(() => {
  if (reset) db.exec('DELETE FROM orders; DELETE FROM product_images; DELETE FROM products; DELETE FROM sessions; DELETE FROM users;');

  ensureAdmin(admin);

  if (db.prepare('SELECT COUNT(*) AS n FROM products').get().n > 0) {
    console.log('Ya hay artículos; no se crean datos de demostración (usa --reset para empezar de cero).');
    return;
  }

  const sellerIds = DEMO_SELLERS.map((s) => Number(db.prepare(`
    INSERT INTO users (role, name, store_name, email, phone, province, payout_phone, payout_name, password_hash)
    VALUES ('usuario', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET name = excluded.name RETURNING id
  `).get(s.name, s.store_name, s.email, s.phone, s.province, s.phone, s.name, hashPassword(DEMO_PASSWORD)).id));

  // Cobro de demostración (en el sitio real lo configuras en /admin con tu SINPE).
  setSetting('payment_phone', '80000000');
  setSetting('payment_holder', 'CowFace (demostración)');

  const insert = db.prepare(`
    INSERT INTO products (seller_id, title, brand, description, category, department, item_type, size, color, condition, price, quantity, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))
  `);
  DEMO_PRODUCTS.forEach(([seller, title, brand, category, dept, type, size, color, condition, price, qty], i) => {
    insert.run(sellerIds[seller], title, brand, 'Artículo de demostración. Pregunta por medidas y fotos adicionales.',
      category, dept, type, size, color, condition, price, qty, `-${DEMO_PRODUCTS.length - i} hours`);
  });
  // Una compradora con una conversación y una oferta pendiente, para ver el chat funcionando.
  const buyerId = Number(db.prepare(`
    INSERT INTO users (role, name, email, phone, province, password_hash) VALUES ('usuario', ?, ?, ?, ?, ?) RETURNING id
  `).get(DEMO_BUYER.name, DEMO_BUYER.email, DEMO_BUYER.phone, DEMO_BUYER.province, hashPassword(DEMO_PASSWORD)).id);
  const polo = getProduct(db.prepare('SELECT id FROM products WHERE title LIKE ? LIMIT 1').get('Camisa polo Lacoste%').id);
  const conv = getConversationForUser(getOrCreateConversation(polo, buyerId), buyerId);
  sendText(conv, buyerId, 'Hola, ¿la polo talla M es entallada o regular? Mido 1.75 m.');
  sendText(conv, polo.seller_id, '¡Hola! Es corte regular, te queda bien con esa altura. Está nueva con etiqueta.');
  makeOffer(conv, buyerId, 22000);

  console.log(`Creados ${DEMO_SELLERS.length} vendedores, 1 compradora y ${DEMO_PRODUCTS.length} artículos de demostración.`);
});

console.log(`Cuenta de administración: ${admin.email}${admin === DEV_ADMIN ? ' (contraseña de demostración en src/seed.js)' : ''}`);
