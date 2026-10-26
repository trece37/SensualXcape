import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { FORUM_MIME } from './build-forum.mjs';

// The normal preview remains the current V2 candidate for the phone-review tool.
// --pages previews the exact multi-version artifact which will be deployed.
const pages = process.argv.includes('--pages');
const files = new Map([
  ['', ['index.html', 'text/html; charset=utf-8']],
  ['index.html', ['index.html', 'text/html; charset=utf-8']],
  ['demo.js', ['demo.js', 'text/javascript; charset=utf-8']],
  ['demo.css', ['demo.css', 'text/css; charset=utf-8']],
  ['assets/v11/portal-unicorn.png', ['assets/v11/portal-unicorn.png', 'image/png']],
  ...['portal.webp', 'cofre.webp', 'auralink.webp', 'portraits.webp'].map(name => [`assets/v2/${name}`, [`assets/v2/${name}`, 'image/webp']]),
  ['assets/v2/cofre-closed.png', ['assets/v2/cofre-closed.png', 'image/png']]
]);
const v1Paths = new Set(['', 'index.html', 'demo.js', 'demo.css', 'assets/v11/portal-unicorn.png']);
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/') {
    response.writeHead(302, { Location: '/SensualXcape/' }); response.end(); return;
  }
  let relative = url.pathname.startsWith('/SensualXcape/') ? url.pathname.slice('/SensualXcape/'.length) : null;
  let entry, output = 'dist';
  if (relative !== null && pages) {
    output = 'dist-pages';
    if (relative === 'v2') { response.writeHead(302, { Location: '/SensualXcape/v2/' }); response.end(); return; }
    if (relative === 'foro') { response.writeHead(302, { Location: '/SensualXcape/foro/' }); response.end(); return; }
    if (relative.startsWith('foro/')) {
      const path = relative.slice(5) || 'index.html';
      if (FORUM_MIME[path]) entry = [`foro/${path}`, FORUM_MIME[path]];
    } else if (relative.startsWith('v2/')) {
      const v2 = files.get(relative.slice(3));
      if (v2) entry = [`v2/${v2[0]}`, v2[1]];
    } else if (relative.startsWith('demo/')) {
      const demo = files.get(relative.slice(5));
      if (demo) entry = [`demo/${demo[0]}`, demo[1]];
    } else if (v1Paths.has(relative)) entry = files.get(relative);
  } else if (relative !== null) entry = files.get(relative);
  if (!entry) { response.writeHead(404); response.end('Not found'); return; }
  try {
    const body = await readFile(new URL(`../${output}/${entry[0]}`, import.meta.url));
    response.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-store' }); response.end(body);
  } catch { response.writeHead(404); response.end(`Build the demo first: npm run ${pages ? 'build:pages' : 'build:demo'}`); }
});
const port = Number(process.env.PORT || (pages ? 4349 : 4345));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be between 1024 and 65535');
server.listen(port, '127.0.0.1', () => console.log(`Demo${pages ? ' V1 + V2' : ' V2'}: http://127.0.0.1:${port}/SensualXcape/${pages ? 'v2/' : ''}`));
