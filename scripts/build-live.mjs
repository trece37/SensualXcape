import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildDemo } from './build-demo.mjs';

export function transformPlatformForLive(source) {
  const replacements = [["if (typeof document !== 'undefined') {", 'if (false) {'], ["image.src = '/assets/v11/portal-unicorn.png'", "image.src = './assets/v11/portal-unicorn.png'"]];
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw new Error(`Review live shell adapter: ${before}`);
    source = source.replace(before, after);
  }
  return source;
}

export async function buildLive(options) {
  const result = await buildDemo({ ...options, entry: 'demo/live.js', transform: transformPlatformForLive });
  const { output, root } = options;
  let html = await readFile(join(output, 'index.html'), 'utf8');
  html = html.replace("connect-src 'none'", "connect-src 'self' https://oorheeyyahpyiarwktbq.supabase.co wss://oorheeyyahpyiarwktbq.supabase.co; worker-src 'self'")
    .replace('data-static-demo="true"', 'data-live-site="true"')
    .replace('<title>SensualXcape · Demo interactiva</title>', '<title>SensualXcape · Tu espacio privado</title>')
    .replace('SensualXcape: un universo propio. Maqueta navegable con tres atmósferas, perfil, Cofre y servicios. Tus aportaciones permanecen solo en memoria de la pestaña.', 'SensualXcape: tu perfil, tus conversaciones privadas y Foro Cromos. Tu espacio, tus decisiones.')
    ;
  await writeFile(join(output, 'demo.css'), `${await readFile(join(output, 'demo.css'), 'utf8')}\n${await readFile(join(root, 'demo', 'live.css'), 'utf8')}`);
  const fingerprint=async name=>createHash('sha256').update(await readFile(join(output,name))).digest('hex').slice(0,12);
  html=html.replace('./demo.js"',`./demo.js?v=live-${await fingerprint('demo.js')}"`).replace('./demo.css"',`./demo.css?v=live-${await fingerprint('demo.css')}"`);
  await writeFile(join(output,'index.html'),html);
  return result;
}
