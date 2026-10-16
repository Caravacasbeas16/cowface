// Aviso de pago del comprador: el nombre de la persona que hizo el SINPE (así sale en el banco) y la
// captura del comprobante, que es obligatoria. Una misma captura no sirve para dos pedidos: se guarda
// la huella (sha256) del archivo y se compara con los otros pedidos.
import crypto from 'node:crypto';
import path from 'node:path';
import { db } from './db.js';
import { UserError } from './messages.js';
import { readPrivateFile } from './crypto-box.js';
import { ATTACH_DIR } from './storage.js';

export const PAYER_MAX = 80;

export function checkPaymentProof(order, body, proof) {
  const payer = String(body.payer_name ?? '').replace(/\s+/g, ' ').trim().slice(0, PAYER_MAX);
  if (payer.length < 3) throw new UserError('Escribe el nombre de la persona que hizo el SINPE (como sale en el comprobante).');
  if (!proof) throw new UserError('Sube la captura del comprobante del SINPE: es obligatoria para verificar tu pago.');
  let hash = null;
  try {
    const content = readPrivateFile(path.join(ATTACH_DIR, proof));
    if (content) hash = crypto.createHash('sha256').update(content).digest('hex');
  } catch { /* si no se puede leer, se sigue sin huella: el admin igual revisa la captura */ }
  if (hash) {
    const reused = db.prepare("SELECT 1 FROM orders WHERE payment_proof_hash = ? AND id != ? AND status != 'cancelado'").get(hash, order.id);
    if (reused) throw new UserError('Esa captura ya se usó en otro pedido. Sube la captura del SINPE de este pedido; si crees que es un error, escríbenos.');
  }
  return { payer, hash };
}
