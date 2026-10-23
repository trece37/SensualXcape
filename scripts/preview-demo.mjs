import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// Serve only the generated public demo, including the GitHub project subpath.
const files = new Map([
  ['', ['index.html', 'text/html; charset=utf-8']],
  ['index.html', ['index.html', 'text/html; charset=utf-8']],
  ['demo.js', ['demo.js', 'text/javascript; charset=utf-8']],
  ['demo.css', ['demo.css', 'text/css; charset=utf-8']],
  ['assets/v11/portal-unicorn.png', ['assets/v11/portal-unicorn.png', 'image/png']]
]);
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/') {
    response.writeHead(302, { Location: '/SensualXcape/' }); response.end(); return;
  }
  const entry = url.pathname.startsWith('/SensualXcape/') ? files.get(url.pathname.slice('/SensualXcape/'.length)) : undefined;
  if (!entry) { response.writeHead(404); response.end('Not found'); return; }
  try {
    const body = await readFile(new URL(`../dist/${entry[0]}`, import.meta.url));
    response.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-store' }); response.end(body);
  } catch { response.writeHead(404); response.end('Build the demo first: npm run build:demo'); }
});
server.listen(4345, '127.0.0.1', () => console.log('Demo: http://127.0.0.1:4345/SensualXcape/'));
