import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { request as rawRequest } from 'node:http';
import { createLocalQaServer, LOCAL_QA_PUBLIC_KEY } from '../scripts/local-qa-server.mjs';
import { COFRE_MAX_FILE_SIZE, COFRE_MAX_TOTAL_SIZE, COFRE_PENDING_TTL_MS } from '../scripts/local-cofre-store.mjs';

const filesPath = '/cofre/v1/files', uploadsPath = '/cofre/v1/uploads';
const metadata = (name, type, extra = '') => `filename ${Buffer.from(name).toString('base64')},filetype ${Buffer.from(type).toString('base64')}${extra}`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const vaultDir = await mkdtemp(path.join(tmpdir(), 'sx-cofre-test-'));
  let app = await createLocalQaServer({ port: 0, vaultDir });
  t.after(async () => { await app.close(); await rm(vaultDir, { recursive: true, force: true }); });
  async function call(url, { method = 'GET', session, headers = {}, body } = {}) {
    return fetch(app.origin + url, { method, headers: { apikey: LOCAL_QA_PUBLIC_KEY,
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}), ...headers }, body });
  }
  async function login(name = 'a') {
    const response = await call('/auth/v1/token?grant_type=password', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `${name}@example.invalid`, password: '123456' }) });
    assert.equal(response.status, 200); return response.json();
  }
  async function create(session, bytes = Buffer.from('Texto ficticio'), name = 'Notas de prueba.txt', type = 'text/plain') {
    const response = await call(uploadsPath, { method: 'POST', session, headers: {
      'Tus-Resumable': '1.0.0', 'Upload-Length': String(bytes.length), 'Upload-Metadata': metadata(name, type) } });
    assert.equal(response.status, 201, await response.text());
    const location = response.headers.get('location'); assert.match(location, /^\/cofre\/v1\/uploads\/[0-9a-f]{32}$/);
    return { location, id: location.split('/').at(-1), bytes };
  }
  async function patch(session, upload, start = 0, end = upload.bytes.length) {
    return call(upload.location, { method: 'PATCH', session, headers: { 'Tus-Resumable': '1.0.0',
      'Upload-Offset': String(start), 'Content-Type': 'application/offset+octet-stream' }, body: upload.bytes.subarray(start, end) });
  }
  const list = async session => { const response = await call(filesPath, { session }); assert.equal(response.status, 200); return (await response.json()).files; };
  return { get app() { return app; }, vaultDir, call, login, create, patch, list,
    async restart() { await app.close(); app = await createLocalQaServer({ port: 0, vaultDir }); } };
}

test('Cofre uses actual tus HTTP upload and authenticated attachment recovery with integrity', async t => {
  const f = await fixture(t), a = await f.login();
  const upload = await f.create(a, Buffer.from('Mi documento ficticio ñ\n'), '../Notas\\personales\u202e.txt');
  assert.deepEqual(await f.list(a), [], 'creation is not a recoverable file');
  const result = await f.patch(a, upload); assert.equal(result.status, 204, await result.text());
  assert.equal(Number(result.headers.get('upload-offset')), upload.bytes.length);
  const [file] = await f.list(a); assert.equal(file.id, upload.id); assert.equal(file.size, upload.bytes.length);
  assert.equal(file.name, '..Notaspersonales.txt'); assert.equal(file.sha256, sha(upload.bytes));
  const download = await f.call(file.downloadUrl, { session: a }); assert.equal(download.status, 200);
  assert.equal(download.headers.get('cache-control'), 'no-store'); assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.equal(sha(Buffer.from(await download.arrayBuffer())), sha(upload.bytes));
  assert.equal((await f.call(upload.location, { session: a })).status, 404, 'tus does not expose a GET blob route');
});

test('Cofre prevents anonymous and cross-account list, download, HEAD, PATCH and DELETE access', async t => {
  const f = await fixture(t), a = await f.login(), b = await f.login('b'), c = await f.login('c');
  const upload = await f.create(a); assert.equal((await f.patch(a, upload)).status, 204);
  const downloadUrl = `${filesPath}/${upload.id}`;
  assert.equal((await f.call(filesPath)).status, 401); assert.equal((await f.call(downloadUrl)).status, 401);
  for (const session of [b, c]) {
    assert.deepEqual(await f.list(session), []);
    assert.equal((await f.call(downloadUrl, { session })).status, 404);
    assert.equal((await f.call(upload.location, { method: 'HEAD', session, headers: { 'Tus-Resumable': '1.0.0' } })).status, 404);
    assert.equal((await f.patch(session, upload)).status, 404);
    assert.equal((await f.call(upload.location, { method: 'DELETE', session, headers: { 'Tus-Resumable': '1.0.0' } })).status, 404);
    assert.equal((await f.call(downloadUrl, { method: 'DELETE', session })).status, 204, 'idempotent namespace deletion does not reveal other owners');
  }
  assert.equal((await f.call(downloadUrl, { session: a })).status, 200);
  assert.equal((await f.call(downloadUrl, { method: 'DELETE', session: a })).status, 204);
  assert.equal((await f.call(downloadUrl, { method: 'DELETE', session: a })).status, 204);
  assert.equal((await f.call(downloadUrl, { session: a })).status, 404); assert.deepEqual(await f.list(a), []);
});

test('Cofre resumes partial uploads and preserves stable ownership and bytes across server restart', async t => {
  const f = await fixture(t), oldA = await f.login(), oldB = await f.login('b');
  const partial = await f.create(oldA, Buffer.from('Documento interrumpido, y después recuperado.'));
  const complete = await f.create(oldA, Buffer.from('%PDF-1.7\nDocumento ficticio\n'), 'Prueba.pdf', 'application/pdf');
  assert.equal((await f.patch(oldA, complete)).status, 204);
  assert.equal((await f.patch(oldA, partial, 0, 5)).status, 204);
  assert.equal((await f.list(oldA)).length, 1);
  assert.equal((await f.patch(oldA, partial, 0)).status, 409, 'wrong offset never replaces previous bytes');
  await f.restart();
  assert.equal((await f.call(filesPath, { session: oldA })).status, 401);
  const a = await f.login(), b = await f.login('b'); assert.notEqual(a.user.id, oldA.user.id);
  assert.notEqual(b.user.id, oldB.user.id); assert.equal((await f.list(a)).length, 1); assert.deepEqual(await f.list(b), []);
  const head = await f.call(partial.location, { method: 'HEAD', session: a, headers: { 'Tus-Resumable': '1.0.0' } });
  assert.equal(head.status, 200); assert.equal(Number(head.headers.get('upload-offset')), 5);
  assert.equal((await f.patch(a, partial, 5)).status, 204);
  for (const upload of [partial, complete]) {
    const response = await f.call(`${filesPath}/${upload.id}`, { session: a }); assert.equal(response.status, 200);
    assert.equal(sha(Buffer.from(await response.arrayBuffer())), sha(upload.bytes));
  }
});

test('Cofre termination removes partial bytes and logout rejects all later storage requests', async t => {
  const f = await fixture(t), a = await f.login();
  const upload = await f.create(a, Buffer.from('Parcial que será cancelado.'));
  assert.equal((await f.patch(a, upload, 0, 3)).status, 204);
  assert.equal((await f.call(upload.location, { method: 'DELETE', session: a, headers: { 'Tus-Resumable': '1.0.0' } })).status, 204);
  assert.equal((await f.call(upload.location, { method: 'HEAD', session: a, headers: { 'Tus-Resumable': '1.0.0' } })).status, 404);
  const next = await f.create(a); assert.equal((await f.patch(a, next)).status, 204);
  assert.equal((await f.call('/auth/v1/logout', { method: 'POST', session: a })).status, 204);
  assert.equal((await f.call(filesPath, { session: a })).status, 401);
  assert.equal((await f.call(`${filesPath}/${next.id}`, { method: 'DELETE', session: a })).status, 401);
  assert.equal((await f.call(next.location, { method: 'HEAD', session: a, headers: { 'Tus-Resumable': '1.0.0' } })).status, 401);
  assert.equal((await f.patch(a, next)).status, 401);
  const fresh = await f.login(); assert.equal((await f.list(fresh)).length, 1);
});

test('Cofre enforces file types, metadata, known sizes, payload bounds and per-owner reserved quota', async t => {
  const f = await fixture(t), a = await f.login();
  async function post(headers) { return f.call(uploadsPath, { method: 'POST', session: a,
    headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': '10', 'Upload-Metadata': metadata('Prueba.txt', 'text/plain'), ...headers } }); }
  assert.equal((await post({ 'Upload-Length': String(COFRE_MAX_FILE_SIZE + 1) })).status, 413);
  assert.equal((await post({ 'Upload-Length': '0' })).status, 413);
  assert.equal((await post({ 'Upload-Metadata': metadata('Web.html', 'text/html') })).status, 400);
  assert.equal((await post({ 'Upload-Metadata': metadata('Prueba.txt', 'text/plain', ',owner Yg==') })).status, 400);
  assert.equal((await post({ 'Upload-Metadata': metadata('x'.repeat(513), 'text/plain') })).status, 400);
  assert.equal((await post({ 'Upload-Defer-Length': '1' })).status, 400);
  const wrong = await f.create(a, Buffer.from('No es un PNG'), 'Foto.png', 'image/png');
  assert.equal((await f.patch(a, wrong)).status, 422); assert.deepEqual(await f.list(a), []);
  const tooLong = await f.create(a, Buffer.from('123'));
  const over = await f.call(tooLong.location, { method: 'PATCH', session: a, headers: { 'Tus-Resumable': '1.0.0',
    'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' }, body: '1234' });
  assert.equal(over.status, 413); assert.deepEqual(await f.list(a), []);
  await f.call(tooLong.location, { method: 'DELETE', session: a, headers: { 'Tus-Resumable': '1.0.0' } });
  const reservations = [];
  for (let index = 0; index < COFRE_MAX_TOTAL_SIZE / COFRE_MAX_FILE_SIZE - 1; index++) {
    const response = await post({ 'Upload-Length': String(COFRE_MAX_FILE_SIZE) }); assert.equal(response.status, 201);
    reservations.push(response.headers.get('location'));
  }
  const contested = await Promise.all([post({ 'Upload-Length': String(COFRE_MAX_FILE_SIZE) }), post({ 'Upload-Length': String(COFRE_MAX_FILE_SIZE) })]);
  assert.deepEqual(contested.map(response => response.status).sort(), [201, 413], 'simultaneous creations cannot overbook the remaining quota');
  reservations.push(contested.find(response => response.status === 201).headers.get('location'));
  assert.equal((await post({ 'Upload-Length': '1' })).status, 413, 'pending files reserve their declared space');
  await f.call(reservations[0], { method: 'DELETE', session: a, headers: { 'Tus-Resumable': '1.0.0' } });
  assert.equal((await post({ 'Upload-Length': '1' })).status, 201);
  const b = await f.login('b'); assert.equal((await f.create(b)).bytes.length, 14, 'other owner has separate quota');
});

test('Cofre boundary rejects foreign origins, encoded traversal, arbitrary resources and server disk paths', async t => {
  const f = await fixture(t), a = await f.login(), upload = await f.create(a); await f.patch(a, upload);
  assert.equal((await f.call(filesPath, { session: a, headers: { Origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await f.call(filesPath, { session: a, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await f.call(`${filesPath}?owner=b`, { session: a })).status, 400);
  assert.equal((await f.call(`${uploadsPath}/not-an-id`, { method: 'HEAD', session: a })).status, 404);
  assert.equal((await f.call(`/local-data/cofre/${upload.id}`, { session: a })).status, 404);
  assert.equal((await f.call(`${filesPath}/${upload.id}.json`, { session: a })).status, 404);
  const response = await new Promise((resolve, reject) => {
    const req = rawRequest(f.app.origin, { path: '/cofre/v1/files/%2e%2e%2fsecret', headers: { apikey: LOCAL_QA_PUBLIC_KEY,
      Authorization: `Bearer ${a.access_token}` } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(response, 400);
});

test('Cofre expires abandoned uploads on owner activity while preserving completed files', async t => {
  const f = await fixture(t), a = await f.login();
  const pending = await f.create(a), completed = await f.create(a); await f.patch(a, completed);
  const [ownerDirectory] = await readdir(f.vaultDir);
  const pendingInfo = path.join(f.vaultDir, ownerDirectory, pending.id + '.json');
  const info = JSON.parse(await readFile(pendingInfo, 'utf8'));
  info.creation_date = new Date(Date.now() - COFRE_PENDING_TTL_MS - 1000).toISOString();
  await writeFile(pendingInfo, JSON.stringify(info));
  assert.equal((await f.list(a)).length, 1);
  assert.equal((await f.call(pending.location, { method: 'HEAD', session: a, headers: { 'Tus-Resumable': '1.0.0' } })).status, 404);
  assert.equal((await f.call(`${filesPath}/${completed.id}`, { session: a })).status, 200);
});

test('Cofre survives a real connection abort and bounds chunked PATCH bodies without exposing uncommitted bytes', async t => {
  const f = await fixture(t), a = await f.login();
  const upload = await f.create(a, Buffer.from('Archivo ficticio con interrupción de red.'));
  const [ownerDirectory] = await readdir(f.vaultDir);
  const diskPath = path.join(f.vaultDir, ownerDirectory, upload.id);
  const req = rawRequest(f.app.origin + upload.location, { method: 'PATCH', headers: {
    apikey: LOCAL_QA_PUBLIC_KEY, Authorization: `Bearer ${a.access_token}`, 'Tus-Resumable': '1.0.0',
    'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream', 'Content-Length': upload.bytes.length
  } });
  const closed = new Promise(resolve => { req.on('error', () => {}); req.once('close', resolve); });
  req.write(upload.bytes.subarray(0, 7));
  const deadline = Date.now() + 2000;
  while ((await stat(diskPath)).size < 7 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await stat(diskPath)).size, 7, 'prefix reached actual FileStore before connection loss');
  req.destroy(); await closed;
  const head = await f.call(upload.location, { method: 'HEAD', session: a, headers: { 'Tus-Resumable': '1.0.0' } });
  assert.equal(head.status, 200); assert.equal(Number(head.headers.get('upload-offset')), 7);
  assert.deepEqual(await f.list(a), []);
  assert.equal((await f.patch(a, upload, 7)).status, 204);
  const recovered = await f.call(`${filesPath}/${upload.id}`, { session: a });
  assert.equal(sha(Buffer.from(await recovered.arrayBuffer())), sha(upload.bytes));

  const small = await f.create(a, Buffer.from('123'));
  const oversized = await new Promise((resolve, reject) => {
    const raw = rawRequest(f.app.origin + small.location, { method: 'PATCH', headers: {
      apikey: LOCAL_QA_PUBLIC_KEY, Authorization: `Bearer ${a.access_token}`, 'Tus-Resumable': '1.0.0',
      'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream', 'Transfer-Encoding': 'chunked'
    } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    raw.on('error', reject); raw.write('12'); raw.end('34');
  });
  assert.equal(oversized, 413); assert.equal((await stat(path.join(f.vaultDir, ownerDirectory, small.id))).size <= 3, true);
  assert.equal((await f.list(a)).some(file => file.id === small.id), false);
});
