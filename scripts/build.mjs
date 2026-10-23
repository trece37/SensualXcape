import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Read only two plain literal exports. Never import or evaluate config.js.
function parseConfig(source) {
  const values = Object.create(null);
  let remaining = source;
  while (remaining.length) {
    remaining = remaining.replace(/^(?:\s+|\/\/[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)+/, '');
    if (!remaining) break;
    const match = /^export\s+const\s+(SUPABASE_URL|SUPABASE_PUBLISHABLE_KEY)\s*=\s*(['"])([^\\\r\n]*?)\2\s*;/.exec(remaining);
    if (!match || Object.hasOwn(values, match[1])) {
      throw new Error('config.js solo admite dos exports const con literales simples, sin escapes, expresiones ni otros datos.');
    }
    values[match[1]] = match[3];
    remaining = remaining.slice(match[0].length);
  }
  if (Object.keys(values).length !== 2) throw new Error('Faltan las dos constantes públicas en config.js.');
  return values;
}
function validatePublicKey(key) {
  if (/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(key)) return;
  const parts = key.split('.');
  if (parts.length === 3 && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) {
    try {
      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      // Decode only to classify legacy public keys; this does not verify a JWT signature.
      if (header?.alg === 'HS256' && payload?.role === 'anon') return;
    } catch { /* Invalid JSON/base64 is rejected below. */ }
  }
  throw new Error('Clave no pública o inválida: usa sb_publishable_ o un JWT legacy con role=anon.');
}

// Explicit allowlist: documentation, SQL, tests and source notes never enter the web root.
const root = new URL('../', import.meta.url);
const target = new URL('../public/', import.meta.url);
const source = await readFile(new URL('config.js', root), 'utf8').catch(() => {
  throw new Error('Falta config.js: copia config.example.js y usa SOLO URL/clave pública del laboratorio.');
});
const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = parseConfig(source);
if (SUPABASE_URL.includes('TU-PROYECTO') || SUPABASE_PUBLISHABLE_KEY.includes('REEMPLAZAR')) {
  throw new Error('Configura los placeholders antes de preparar public/.');
}
if (!/^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?\/?$/i.test(SUPABASE_URL)) {
  throw new Error('URL pública inválida: usa un origen HTTPS sin escapes, espacios, usuario, consulta ni fragmento.');
}
let projectUrl;
try { projectUrl = new URL(SUPABASE_URL); }
catch { throw new Error('URL pública HTTPS inválida.'); }
if (projectUrl.protocol !== 'https:' || !projectUrl.hostname || projectUrl.username || projectUrl.password) {
  throw new Error('URL pública HTTPS inválida.');
}
validatePublicKey(SUPABASE_PUBLISHABLE_KEY);
// Reconstruct from validated values: comments or extra source cannot leak into deploy.
const publicConfig = `export const SUPABASE_URL = ${JSON.stringify(projectUrl.origin)};\nexport const SUPABASE_PUBLISHABLE_KEY = ${JSON.stringify(SUPABASE_PUBLISHABLE_KEY)};\n`;
const publicFiles = ['index.html', 'styles.css', 'app.js', 'config.js'];
const existing = await readdir(target).catch(error => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
if (existing.some(name => !publicFiles.includes(name))) {
  throw new Error('public/ contiene archivos ajenos a la lista permitida; revisa la carpeta antes de publicar.');
}
await mkdir(target, { recursive: true });
for (const name of ['index.html', 'styles.css', 'app.js']) {
  await writeFile(new URL(name, target), await readFile(new URL(name, root)));
}
await writeFile(new URL('config.js', target), publicConfig);
console.log(`Raíz estática preparada: ${fileURLToPath(target)}`);
