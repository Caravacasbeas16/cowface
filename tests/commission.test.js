// La comisión que cobra CowFace es 5 %: una base nueva arranca así y la migración la deja en 5 %.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('una base nueva cobra 5 % y la migración cambia la comisión anterior a 5 %', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowface-comision-'));
  process.env.DATA_DIR = dir;
  process.env.UPLOAD_DIR = path.join(dir, 'uploads');
  const { commissionRate, db } = await import('../src/db.js');
  assert.equal(commissionRate(), 0.05);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'migration_commission_5pct'").get().value, '1');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
