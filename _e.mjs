import fs from 'node:fs';
const p = 'tests/app.test.js';
let s = fs.readFileSync(p, 'utf8');
const a = "  assert.match(terms, /<strong>2 %<\/strong>/);";
if (!s.includes(a)) throw new Error('x');
s = s.replace(a, `  assert.match(terms, /la comisión que acordó con nosotros/);
  for (const page of [terms, await (await get('/')).text(), await (await get('/como-funciona')).text()]) {
    assert.doesNotMatch(page, /\d\s?% de comisión|comisión de <strong>/, 'el porcentaje no se publica');
  }`);
fs.writeFileSync(p, s);
