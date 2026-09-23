// Verifica las traducciones: mismas claves en es y en, y que todas las claves usadas en el código existan.
// Uso: npm run i18n:check -w web
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function loadLang(lang) {
  const dir = join(root, 'i18n', lang);
  const out = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const data = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    for (const k of Object.keys(data)) {
      if (k in out) console.error(`! clave de primer nivel repetida entre archivos (${lang}): ${k}`);
      out[k] = data[k];
    }
  }
  return out;
}
function flatten(o, prefix = '', acc = new Set()) {
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flatten(v, key, acc); else acc.add(key);
  }
  return acc;
}
function walk(dir, acc = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (f !== 'i18n') walk(p, acc); } else if (/\.(tsx?|jsx?)$/.test(f)) acc.push(p);
  }
  return acc;
}

const es = flatten(loadLang('es'));
const en = flatten(loadLang('en'));
let problems = 0;
for (const k of es) if (!en.has(k)) { console.log(`falta en EN: ${k}`); problems++; }
for (const k of en) if (!es.has(k)) { console.log(`falta en ES: ${k}`); problems++; }

// plurales de i18next: "x_one"/"x_other" cuentan como la clave "x"
const base = (k) => k.replace(/_(zero|one|two|few|many|other)$/, '');
const esBase = new Set([...es].map(base));

const used = new Map();
const dynamic = [];
const re = /\bt\(\s*(['"`])((?:(?!\1).)*)\1/g;
const reNav = /['"`]((?:nav|shell)\.[a-z0-9_.]+)['"`]/g;
for (const f of walk(root)) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(re)) {
    if (m[2].includes('${')) dynamic.push(`${f.replace(root, 'src')}: ${m[2]}`);
    else (used.get(m[2]) ?? used.set(m[2], []).get(m[2])).push(f.replace(root, 'src'));
  }
  for (const m of src.matchAll(reNav)) (used.get(m[1]) ?? used.set(m[1], []).get(m[1])).push(f.replace(root, 'src'));
}
for (const [k, files] of used) {
  if (!esBase.has(k) && !es.has(k)) { console.log(`clave usada sin traducir: ${k}   (${files[0]})`); problems++; }
}
if (dynamic.length) { console.log('\nClaves dinámicas (revisar a mano):'); for (const d of dynamic) console.log('  ' + d); }
console.log(problems ? `\n${problems} problema(s)` : `\nOK — ${es.size} claves en ES y EN`);
process.exit(problems ? 1 : 0);
