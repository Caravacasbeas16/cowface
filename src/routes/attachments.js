// Entrega de adjuntos privados (fotos/PDF del chat, comprobantes de pago y envío, evidencia de
// reclamos). Solo los ve quien participa en esa conversación o pedido, y el admin.
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { ATTACH_DIR } from '../storage.js';
import { readPrivateFile } from '../crypto-box.js';

const router = Router();

// ¿Quién puede ver este archivo? Devuelve los ids de los dueños o null si no existe.
function ownersOf(name) {
  const msg = db.prepare(`
    SELECT c.buyer_id, c.seller_id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.attachment = ?
  `).get(name);
  if (msg) return [msg.buyer_id, msg.seller_id];
  const order = db.prepare(`
    SELECT buyer_id, seller_id FROM orders WHERE payment_proof = ? OR shipping_proof = ? OR dispute_evidence = ?
  `).get(name, name, name);
  return order ? [order.buyer_id, order.seller_id] : null;
}

router.get('/:name', (req, res, next) => {
  const { name } = req.params;
  if (!/^[a-f0-9]{24}\.(jpg|png|pdf)$/.test(name) || !req.user) return next();
  const owners = ownersOf(name);
  if (!owners || (req.user.role !== 'admin' && !owners.includes(req.user.id))) return next();
  const file = path.join(ATTACH_DIR, name);
  if (!fs.existsSync(file)) return next();
  res.set({ 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
  const content = readPrivateFile(file);
  if (!content) return res.status(500).type('text').send('No se pudo abrir el archivo (clave de cifrado).');
  // Los PDF se descargan en vez de abrirse dentro del sitio.
  if (name.endsWith('.pdf')) res.attachment(`comprobante-${name.slice(0, 8)}.pdf`);
  res.type(name.endsWith('.pdf') ? 'application/pdf' : name.endsWith('.png') ? 'image/png' : 'image/jpeg').send(content);
});

export default router;
