import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountCofre, createMemoryUrlStorage, COFRE_MAX_FILE_SIZE } from '../cofre.js';

const alice = { user: { id: 'alice' }, access_token: 'alice-token', apikey: 'local-public-test' };
const bob = { user: { id: 'bob' }, access_token: 'bob-token', apikey: 'local-public-test' };
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const stored = (id = 'one', name = 'mi-nota.txt') => ({ id, name, size: 8, type: 'text/plain', createdAt: '2026-10-21T10:00:00.000Z', downloadUrl: 'https://outside.example.invalid/do-not-send-credentials' });
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

function harness(t, fetchImpl = async () => json({ files: [] }), initialSession = alice) {
  const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'http://127.0.0.1:4341/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  // Uppy schedules its initial online check with the host timer rather than
  // window.setTimeout. Dispose those host timers with this jsdom document.
  const previousSetTimeout = globalThis.setTimeout;
  const hostTimers = new Set();
  globalThis.setTimeout = (fn, delay, ...args) => {
    const handle = previousSetTimeout(fn, delay, ...args);
    hostTimers.add(handle);
    return handle;
  };
  let session = initialSession;
  const calls = [];
  const blobs = [];
  const revoked = [];
  const downloads = [];
  dom.window.URL.createObjectURL = blob => { blobs.push(blob); return `blob:fixture-${blobs.length}`; };
  dom.window.URL.revokeObjectURL = url => revoked.push(url);
  dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push({ href: this.href, name: this.download }); };
  const controller = mountCofre({ documentRef: dom.window.document, windowRef: dom.window, getSession: () => session, fetchImpl: async (path, options) => {
    calls.push({ path, options });
    return fetchImpl(path, options);
  } });
  t.after(() => {
    controller.destroy();
    dom.window.close();
    for (const handle of hostTimers) clearTimeout(handle);
    globalThis.setTimeout = previousSetTimeout;
    if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window;
  });
  const $ = selector => dom.window.document.querySelector(selector);
  function setSession(next) {
    session = next;
    dom.window.dispatchEvent(new dom.window.CustomEvent('sx:session', { detail: next }));
  }
  function select(files) {
    Object.defineProperty($('#cofre-file-input'), 'files', { configurable: true, value: files });
    $('#cofre-file-input').dispatchEvent(new dom.window.Event('change'));
  }
  return { controller, dom, $, calls, blobs, revoked, downloads, setSession, select };
}

test('real Uppy selection enforces format and size without uploading automatically', async t => {
  const h = harness(t);
  await flush();
  h.select([new h.dom.window.File(['hola'], 'nota.txt', { type: 'text/plain' })]);
  assert.equal(h.controller.getUploader().getFiles().length, 1);
  assert.equal(h.$('#cofre-queue').children.length, 1);
  assert.equal(h.$('#cofre-save').disabled, false);
  assert.equal(h.calls.length, 1, 'selection only fetched the initial list');
  assert.equal(h.controller.getUploader().getFiles()[0].progress.uploadStarted, null);
  h.select([new h.dom.window.File(['<script>'], 'activo.html', { type: 'text/html' })]);
  assert.equal(h.controller.getUploader().getFiles().length, 1);
  const oversized = new h.dom.window.File([new Uint8Array(COFRE_MAX_FILE_SIZE + 1)], 'grande.txt', { type: 'text/plain' });
  h.select([oversized]);
  assert.equal(h.controller.getUploader().getFiles().length, 1);
  assert.match(h.$('#cofre-status').textContent, /supera/);
});

test('TXT with missing browser MIME is inferred and queued metadata sends no owner', async t => {
  const h = harness(t);
  await flush();
  h.select([new h.dom.window.File(['contenido'], 'sin-mime.txt')]);
  const file = h.controller.getUploader().getFiles()[0];
  assert.equal(file.type, 'text/plain');
  const plugin = h.controller.getUploader().getPlugin('Tus');
  assert.deepEqual(plugin.opts.allowedMetaFields, ['filename', 'filetype']);
  assert.equal(file.meta.owner, undefined);
  assert.equal(file.meta.user_id, undefined);
});

test('same user token refresh keeps selection but Tus uses current token and rejects external URLs', async t => {
  const h = harness(t);
  await flush();
  h.select([new h.dom.window.File(['x'], 'prueba.txt', { type: 'text/plain' })]);
  const uploader = h.controller.getUploader();
  const beforeRequest = uploader.getPlugin('Tus').opts.onBeforeRequest;
  h.setSession({ ...alice, access_token: 'fresh-alice-token' });
  assert.equal(h.controller.getUploader(), uploader);
  assert.equal(uploader.getFiles().length, 1);
  const headers = {};
  beforeRequest({ getURL: () => '/cofre/v1/uploads/new', setHeader: (key, value) => { headers[key] = value; } });
  assert.equal(headers.Authorization, 'Bearer fresh-alice-token');
  assert.throws(() => beforeRequest({ getURL: () => 'https://outside.example.invalid/upload', setHeader() {} }), /INVALID_UPLOAD_URL/);
  h.setSession(bob);
  assert.throws(() => beforeRequest({ getURL: () => '/cofre/v1/uploads/new', setHeader() {} }), /SESSION_CHANGED/);
  assert.equal(h.controller.getUploader().getFiles().length, 0);
});

test('late list from previous user is discarded after account switch', async t => {
  const first = deferred();
  let number = 0;
  const h = harness(t, async () => ++number === 1 ? first.promise : json({ files: [stored('bob-file', 'bob.txt')] }));
  h.setSession(bob);
  await flush();
  assert.match(h.$('#cofre-files').textContent, /bob.txt/);
  first.resolve(json({ files: [stored('alice-file', 'alice-secret.txt')] }));
  await flush();
  assert.doesNotMatch(h.$('#cofre-files').textContent, /alice-secret/);
  assert.match(h.$('#cofre-files').textContent, /bob.txt/);
  assert.equal(h.calls[0].options.signal.aborted, true);
});

test('file names render as plain text and download uses own authenticated route', async t => {
  const h = harness(t, async path => path === '/cofre/v1/files' ? json({ files: [stored('one', '<img src=x>.txt')] }) : new Response('original'));
  await flush();
  assert.equal(h.$('#cofre-files img'), null);
  assert.match(h.$('#cofre-files').textContent, /<img src=x>/);
  h.$('#cofre-files button').click();
  await flush();
  assert.equal(h.calls.at(-1).path, '/cofre/v1/files/one');
  assert.equal(h.calls.at(-1).options.headers.Authorization, 'Bearer alice-token');
  assert.equal(await h.blobs[0].text(), 'original');
  assert.equal(h.downloads.length, 1);
  assert.ok(h.downloads[0].href.startsWith('blob:fixture-'));
});

test('delete requires explicit inline confirmation and cancellation keeps stored file', async t => {
  let deleted = false;
  const h = harness(t, async (path, options) => {
    if (options.method === 'DELETE') { deleted = true; return new Response(null, { status: 204 }); }
    return json({ files: deleted ? [] : [stored()] });
  });
  await flush();
  h.$('#cofre-files .cofre-delete-button').click();
  assert.equal(h.calls.length, 1);
  assert.equal(h.$('.cofre-confirm').hidden, false);
  h.$('.cofre-confirm .text-button').click();
  assert.equal(h.calls.length, 1);
  assert.equal(h.$('.cofre-confirm').hidden, true);
  h.$('#cofre-files .cofre-delete-button').click();
  h.$('.cofre-confirm .secondary').click();
  await flush();
  assert.equal(h.calls.filter(call => call.options.method === 'DELETE').length, 1);
  assert.equal(h.$('#cofre-files').children.length, 0);
  assert.equal(h.$('.cofre-empty').hidden, false);
});

test('denied deletion retains the row and allows retry', async t => {
  const h = harness(t, async (path, options) => options.method === 'DELETE' ? new Response(null, { status: 403 }) : json({ files: [stored()] }));
  await flush();
  h.$('#cofre-files .cofre-delete-button').click();
  h.$('.cofre-confirm .secondary').click();
  await flush();
  assert.equal(h.$('#cofre-files').children.length, 1);
  assert.equal(h.$('.cofre-confirm .secondary').disabled, false);
  assert.match(h.$('#cofre-status').textContent, /desde tu cuenta/);
});

test('logout clears UI immediately and pending download never creates an object URL', async t => {
  const pending = deferred();
  const h = harness(t, async path => path === '/cofre/v1/files' ? json({ files: [stored()] }) : pending.promise);
  await flush();
  h.$('#cofre-files button').click();
  h.setSession(null);
  assert.equal(h.$('#cofre-panel').hidden, true);
  assert.equal(h.$('#cofre-files').children.length, 0);
  assert.equal(h.controller.getUploader(), null);
  pending.resolve(new Response('private original'));
  await flush();
  assert.equal(h.blobs.length, 0);
  assert.equal(h.downloads.length, 0);
});

test('logout detaches Tus cancellation managers after pausing before destroy', async t => {
  const h = harness(t);
  await flush();
  const instance = h.controller.getUploader();
  const actions = [];
  const originalPause = instance.pauseAll.bind(instance);
  instance.pauseAll = () => { actions.push('pause'); originalPause(); };
  instance.getPlugin('Tus').uploaderEvents.fixture = { remove: () => actions.push('detach') };
  const originalDestroy = instance.destroy.bind(instance);
  instance.destroy = () => { actions.push('destroy'); originalDestroy(); };
  h.setSession(null);
  assert.deepEqual(actions, ['pause', 'detach', 'destroy']);
});

test('resumption storage is scoped to one instance and explicitly clearable', async () => {
  const first = createMemoryUrlStorage();
  const second = createMemoryUrlStorage();
  const key = await first.addUpload('same-file', { uploadUrl: '/cofre/v1/uploads/a' });
  assert.equal((await first.findUploadsByFingerprint('same-file')).length, 1);
  assert.equal((await second.findUploadsByFingerprint('same-file')).length, 0);
  await first.removeUpload(key);
  assert.equal((await first.findAllUploads()).length, 0);
  await first.addUpload('another', { uploadUrl: '/cofre/v1/uploads/b' });
  first.clear();
  assert.equal((await first.findAllUploads()).length, 0);
});

test('local section navigation appears only for an authenticated account', async t => {
  const h = harness(t, undefined, null);
  assert.equal(h.$('#cofre-navigation').hidden, true);
  h.setSession(alice);
  await flush();
  assert.equal(h.$('#cofre-navigation').hidden, false);
  assert.equal(h.$('#cofre-navigation a[href="#cofre-panel"]').textContent, 'Mi Cofre');
  assert.equal(h.$('#cofre-navigation a[href="#forocromos-panel"]').textContent, 'Forocromos');
  h.setSession(null);
  assert.equal(h.$('#cofre-navigation').hidden, true);
});

test('late pre-delete refresh cannot restore a successfully deleted file', async t => {
  const late = deferred();
  let lists = 0;
  let deleted = false;
  const h = harness(t, async (path, options) => {
    if (options.method === 'DELETE') { deleted = true; return new Response(null, { status: 204 }); }
    if (++lists === 2) return late.promise;
    return json({ files: deleted ? [] : [stored()] });
  });
  await flush();
  void h.controller.refresh();
  h.$('#cofre-files .cofre-delete-button').click();
  h.$('.cofre-confirm .secondary').click();
  await flush();
  assert.equal(h.$('#cofre-files').children.length, 0);
  late.resolve(json({ files: [stored()] }));
  await flush();
  assert.equal(h.$('#cofre-files').children.length, 0);
  assert.equal(h.$('#cofre-files').hasAttribute('aria-busy'), false);
  assert.equal(h.$('#cofre-refresh').disabled, false);
});

test('failed partial cancellation is awaited and retains the file for explicit retry', async t => {
  let fail = true;
  const stops = [];
  const h = harness(t, async (path, options) => {
    if (options.method === 'DELETE') return new Response(null, { status: fail ? 503 : 204 });
    return json({ files: [] });
  });
  await flush();
  h.select([new h.dom.window.File(['contenido'], 'cancelar.txt', { type: 'text/plain' })]);
  const instance = h.controller.getUploader();
  const file = instance.getFiles()[0];
  const uploadUrl = 'http://127.0.0.1:4341/cofre/v1/uploads/partial-one';
  instance.setFileState(file.id, { progress: { ...file.progress, uploadStarted: Date.now() }, tus: { uploadUrl } });
  instance.getPlugin('Tus').uploaders[file.id] = { url: uploadUrl, abort: async terminate => { stops.push(terminate); } };
  instance.emit('file-added', instance.getFile(file.id));
  h.$('#cofre-queue .text-button').click();
  await flush();
  assert.deepEqual(stops, [false]);
  assert.equal(h.calls.at(-1).path, '/cofre/v1/uploads/partial-one');
  assert.equal(h.calls.at(-1).options.headers['Tus-Resumable'], '1.0.0');
  assert.equal(instance.getFiles().length, 1);
  assert.equal(instance.getFiles()[0].tus.uploadUrl, uploadUrl);
  assert.match(h.$('#cofre-status').textContent, /no hemos podido borrar/);
  fail = false;
  h.$('#cofre-queue .text-button').click();
  await flush();
  assert.equal(instance.getFiles().length, 0);
  assert.equal(h.calls.filter(call => call.options.method === 'DELETE').length, 2);
  assert.match(h.$('#cofre-status').textContent, /Subida cancelada/);
});

test('removing a completed selection never requests deletion of its stored original', async t => {
  const h = harness(t);
  await flush();
  h.select([new h.dom.window.File(['contenido'], 'guardado.txt', { type: 'text/plain' })]);
  const instance = h.controller.getUploader();
  const file = instance.getFiles()[0];
  instance.setFileState(file.id, { progress: { ...file.progress, uploadStarted: Date.now(), uploadComplete: true }, tus: { uploadUrl: '/cofre/v1/uploads/saved' } });
  instance.emit('file-added', instance.getFile(file.id));
  h.$('#cofre-queue .text-button').click();
  await flush();
  assert.equal(instance.getFiles().length, 0);
  assert.equal(h.calls.filter(call => call.options.method === 'DELETE').length, 0);
});
