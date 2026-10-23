import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { createLocalQaServer, LOCAL_QA_PUBLIC_KEY } from '../scripts/local-qa-server.mjs';

async function until(condition, message) {
  const deadline = Date.now() + 10000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
test('real Uppy browser bundle transfers through DOM/XHR/TUS to own local store, downloads original and deletes', async t => {
  const vaultDir = await mkdtemp(path.join(tmpdir(), 'sx-cofre-dom-'));
  const app = await createLocalQaServer({ port: 0, vaultDir });
  t.after(async () => { await app.close(); await rm(vaultDir, { recursive: true, force: true }); });
  const login = async name => {
    const response = await fetch(app.origin + '/auth/v1/token?grant_type=password', { method: 'POST',
      headers: { apikey: LOCAL_QA_PUBLIC_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `${name}@example.invalid`, password: '123456' }) });
    assert.equal(response.status, 200); return response.json();
  };
  const [a, b] = await Promise.all([login('a'), login('b')]);
  const api = (route, session = a, method = 'GET') => fetch(app.origin + route, {
    method, headers: { Authorization: `Bearer ${session.access_token}`, apikey: LOCAL_QA_PUBLIC_KEY }
  });
  // A DOM emulator executes the real browser-target Uppy/Tus code and actual XHR.
  // It is not a human browser/visual/accessibility check.
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../cofre.js', import.meta.url))],
    bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022' });
  const dom = new JSDOM('<!doctype html><html lang="es"><body><main></main></body></html>', {
    url: app.origin, runScripts: 'outside-only', pretendToBeVisual: true
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const requests = [], downloads = [];
  const originalOpen = window.XMLHttpRequest.prototype.open;
  window.XMLHttpRequest.prototype.open = function(method, url, ...args) {
    const record = { method, url }; requests.push(record);
    this.addEventListener('loadend', () => { record.status = this.status; record.response = this.responseText; });
    return originalOpen.call(this, method, url, ...args);
  };
  window.fetch = async (route, { signal, ...options } = {}) => {
    // jsdom's AbortSignal belongs to its DOM realm; bridge to Node fetch.
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) abort.abort();
    try { return await fetch(new URL(route, app.origin), { ...options, signal: abort.signal }); }
    finally { signal?.removeEventListener('abort', cancel); }
  };
  window.URL.createObjectURL = blob => { downloads.push(blob); return 'blob:synthetic-download'; };
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function() { assert.equal(this.download, 'nota_<img onerror=x>.txt'); };
  window.__sxCofreSession = { ...a, apikey: LOCAL_QA_PUBLIC_KEY };
  window.eval(bundle.outputFiles[0].text);
  const $ = id => window.document.getElementById(id);
  await until(() => !$('cofre-refresh').disabled, 'initial Cofre list did not settle');
  const original = 'Contenido ficticio de prueba. Café y autonomía.\n';
  const file = new window.File([original], 'nota_<img onerror=x>.txt', { type: 'text/plain', lastModified: 0 });
  Object.defineProperty($('cofre-file-input'), 'files', { configurable: true, value: [file] });
  $('cofre-file-input').dispatchEvent(new window.Event('change'));
  assert.equal($('cofre-queue').children.length, 1);
  assert.equal(requests.filter(row => row.method === 'POST').length, 0, 'selection alone must not send');
  assert.equal($('cofre-save').disabled, false);
  $('cofre-save').click();
  try { await until(() => $('cofre-files').children.length === 1, 'Uppy upload did not produce a stored file'); }
  catch (error) { throw new Error(`${error.message}: ${$('cofre-status').textContent}; ${JSON.stringify(requests)}`); }
  assert.ok(requests.some(row => row.method === 'POST'));
  assert.ok(requests.some(row => row.method === 'PATCH'));
  assert.equal(window.document.querySelectorAll('img').length, 0, 'filename must render as text');
  const listed = await (await api('/cofre/v1/files')).json();
  const [stored] = listed.files;
  assert.equal(stored.name, file.name);
  assert.equal(await (await api(stored.downloadUrl)).text(), original);
  assert.deepEqual((await (await api('/cofre/v1/files', b)).json()).files, []);
  assert.equal((await api(stored.downloadUrl, b)).status, 404);
  assert.equal((await fetch(app.origin + stored.downloadUrl)).status, 401);
  $('cofre-files').querySelector('button[aria-label^="Descargar"]').click();
  await until(() => downloads.length === 1, 'authenticated original download was not prepared');
  assert.equal(await downloads[0].text(), original);
  $('cofre-queue').querySelector('button[aria-label^="Quitar"]').click();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await api(stored.downloadUrl)).status, 200, 'removing selection after success must retain stored file');
  $('cofre-files').querySelector('button[aria-label^="Borrar"]').click();
  const confirmBox = $('cofre-files').querySelector('[role="group"]');
  assert.equal(confirmBox.hidden, false);
  [...confirmBox.querySelectorAll('button')].find(button => button.textContent === 'Conservar archivo').click();
  assert.equal(confirmBox.hidden, true);
  assert.equal((await api(stored.downloadUrl)).status, 200);
  $('cofre-files').querySelector('button[aria-label^="Borrar"]').click();
  [...confirmBox.querySelectorAll('button')].find(button => button.textContent === 'Sí, borrar archivo').click();
  await until(() => $('cofre-files').children.length === 0, 'confirmed deletion did not settle');
  assert.equal((await api(stored.downloadUrl)).status, 404);
  window.__sxCofreSession = null;
  window.dispatchEvent(new window.CustomEvent('sx:session', { detail: null }));
  assert.equal($('cofre-panel').hidden, true);
});
