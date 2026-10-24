import test from 'node:test';
import assert from 'node:assert/strict';
import { Blob as NativeBlob, File as NativeFile } from 'node:buffer';
import { JSDOM } from 'jsdom';
import { createCofreView, COFRE_STUDIO_LIMITS } from '../demo/cofre-studio.js';

const flush = () => new Promise(done => setImmediate(done));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function fixture(t, { confirm = async () => false, nativeBlobs = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.invalid/SensualXcape/', pretendToBeVisual: true });
  const w = dom.window, d = w.document, created = [], revoked = [], downloads = [], confirmations = [], notices = [], infos = [];
  let storageCalls = 0, networkCalls = 0;
  for (const property of ['localStorage', 'sessionStorage']) Object.defineProperty(w, property, { get() { storageCalls++; throw new Error('Durable browser storage is outside the Cofre.'); } });
  const noNetwork = () => { networkCalls++; throw new Error('No upload or external service belongs to this view.'); };
  w.fetch = noNetwork; w.XMLHttpRequest = noNetwork; w.WebSocket = noNetwork;
  if (nativeBlobs) { w.Blob = NativeBlob; w.File = NativeFile; }
  w.URL.createObjectURL = blob => { const url = `blob:https://example.invalid/cofre-${created.length + 1}`; created.push({ url, blob }); return url; };
  w.URL.revokeObjectURL = url => { revoked.push({ url, activeImageSources: [...d.querySelectorAll('.sx-cofre-preview img')].map(image => image.getAttribute('src')) }); };
  w.HTMLAnchorElement.prototype.click = function () { downloads.push({ href: this.href, name: this.download, rel: this.rel }); };
  const view = createCofreView({ documentRef: d, windowRef: w, onInfo: key => infos.push(key), notify: message => notices.push(message), confirmAction: async request => { confirmations.push(request); return confirm(request); } });
  d.body.append(view.element);
  t.after(() => { view.destroy(); w.close(); });
  const $ = selector => view.element.querySelector(selector);
  const click = (text, parent = view.element) => { const node = [...parent.querySelectorAll('button')].find(button => button.textContent === text); assert.ok(node, `Missing button: ${text}`); node.click(); return node; };
  const inputFiles = files => { const input = $('input[type="file"]'); Object.defineProperty(input, 'files', { configurable: true, value: files }); input.dispatchEvent(new w.Event('change', { bubbles: true })); };
  const file = (name, content = 'Texto de prueba', type = 'text/plain') => new w.File([content], name, { type });
  const rows = () => [...view.element.querySelectorAll('.sx-cofre-item')];
  const saveNote = (name, text) => { $('.sx-cofre-note-form input').value = name; $('.sx-cofre-note-form textarea').value = text; $('.sx-cofre-note-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); };
  const calls = () => ({ storage: storageCalls, network: networkCalls });
  return { w, d, view, $, click, file, inputFiles, rows, saveNote, created, revoked, downloads, confirmations, notices, infos, calls };
}

test('Cofre starts empty, explains its temporary scope and supports file selection from keyboard or drag/drop', t => {
  const h = fixture(t);
  assert.equal(h.view.element.tagName, 'SECTION'); assert.equal(h.view.element.dataset.v11Page, 'cofre');
  assert.equal(h.d.getElementById('cofre-panel'), null); assert.equal(h.rows().length, 0);
  assert.equal(h.$('.sx-cofre-empty').hidden, false); assert.match(h.$('.sx-cofre-session-note').textContent, /Solo en esta pestaña.*recargar o cerrar.*descarga/u);
  const input = h.$('input[type="file"]'); let chooses = 0; input.click = () => { chooses++; };
  const zone = h.$('.sx-cofre-dropzone');
  for (const key of ['Enter', ' ']) { const event = new h.w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }); zone.dispatchEvent(event); assert.equal(event.defaultPrevented, true); }
  assert.equal(chooses, 2); assert.equal(input.multiple, true);
  const drop = new h.w.Event('drop', { bubbles: true, cancelable: true }); Object.defineProperty(drop, 'dataTransfer', { value: { files: [h.file('Lista.txt')] } }); zone.dispatchEvent(drop);
  assert.equal(drop.defaultPrevented, true); assert.equal(h.rows().length, 1); assert.match(h.rows()[0].textContent, /Lista.txt/u);
  h.click('Dónde se guardan tus cosas'); h.click('Qué ocurre al borrar'); assert.deepEqual(h.infos, ['cofre', 'deletion']);
  assert.deepEqual(h.calls(), { storage: 0, network: 0 });
});

test('unsafe extensions, disguised active formats and active MIME types are rejected without executing filename or file contents', async t => {
  const h = fixture(t);
  h.inputFiles([
    h.file('pagina.html', '<script>window.compromised=true</script>', 'text/html'),
    h.file('foto.svg.png', '<svg onload="alert(1)"></svg>', 'image/png'),
    h.file('oculto.txt', '<svg></svg>', 'image/svg+xml'),
    h.file('codigo.js', 'alert(1)', 'text/plain'),
    h.file('script.ps1', 'Get-ChildItem', 'application/octet-stream'),
    h.file('../../<img src=x onerror=alert(1)>.txt', '<img src=x onerror=alert(1)>\n<script>unsafe()</script>')
  ]);
  assert.equal(h.rows().length, 1); assert.match(h.$('.sx-cofre-status').textContent, /este tipo de archivo no se admite/u);
  assert.doesNotMatch(h.rows()[0].querySelector('h4').textContent, /[<>\\/]/u);
  h.click('Abrir', h.rows()[0]);
  for (let count = 0; count < 15 && h.$('.sx-cofre-preview-text').textContent === 'Leyendo el texto…'; count++) await flush();
  assert.match(h.$('.sx-cofre-preview-text').textContent, /<img src=x/u);
  assert.equal(h.$('.sx-cofre-preview-content').querySelector('img, script, svg:not(.sx-cofre-icon)'), null); assert.equal(h.$('.sx-cofre-preview-text').children.length, 0); assert.equal(h.w.compromised, undefined);
  assert.deepEqual(h.calls(), { storage: 0, network: 0 });
});

test('file count, per-file size and total memory limits are enforced while valid selections remain available', t => {
  const h = fixture(t, { nativeBlobs: true }), limit = COFRE_STUDIO_LIMITS;
  h.inputFiles([new NativeFile([new Uint8Array(limit.fileBytes + 1)], 'Demasiado grande.bin')]);
  assert.equal(h.rows().length, 0); assert.match(h.$('.sx-cofre-status').textContent, /8 MB por archivo/u);
  h.inputFiles(Array.from({ length: 13 }, (_, index) => h.file(`${index}.txt`, 'x')));
  assert.equal(h.rows().length, 12); assert.match(h.$('.sx-cofre-status').textContent, /hasta 12 elementos/u);
  h.view.reset();
  h.inputFiles(Array.from({ length: 4 }, (_, index) => new NativeFile([new Uint8Array(limit.fileBytes)], `${index}.bin`)));
  assert.equal(h.rows().length, 3); assert.match(h.$('.sx-cofre-status').textContent, /30 MB disponibles/u);
  assert.match(h.$('.sx-cofre-counter').textContent, /24 MB de 30 MB/u);
});

test('notes preserve plain text and spacing, edit in place, participate in filters and download as safe bytes', t => {
  const h = fixture(t);
  h.click('Escribir una nota'); h.saveNote('Ideas <propias>', '  <img src=x onerror=alert(1)>\n  Segunda línea\n');
  assert.equal(h.rows().length, 1); assert.equal(h.$('.sx-cofre-editor').hidden, true);
  h.click('Abrir', h.rows()[0]); assert.equal(h.$('.sx-cofre-preview-text').textContent, '  <img src=x onerror=alert(1)>\n  Segunda línea\n');
  assert.equal(h.$('.sx-cofre-preview-content img'), null);
  h.click('Editar', h.rows()[0]); assert.equal(h.$('.sx-cofre-note-form textarea').value.startsWith('  <img'), true);
  h.saveNote('Mi lista', 'Contenido actualizado'); assert.equal(h.rows().length, 1); assert.equal(h.$('.sx-cofre-preview-text').textContent, 'Contenido actualizado');
  const filter = h.$('select'); filter.value = 'image'; filter.dispatchEvent(new h.w.Event('change')); assert.equal(h.rows().length, 0); assert.equal(h.$('.sx-cofre-empty').hidden, false);
  h.click('Ver todo'); const search = h.$('input[type="search"]'); search.value = 'LISTA'; search.dispatchEvent(new h.w.Event('input')); assert.equal(h.rows().length, 1);
  h.click('Descargar', h.rows()[0]); assert.equal(h.downloads.length, 1); assert.equal(h.downloads[0].name, 'Mi lista.txt');
  assert.equal(h.created.at(-1).blob.type, 'application/octet-stream'); assert.match(h.downloads[0].href, /^blob:/u); assert.equal(h.downloads[0].rel, 'noopener');
});

test('an unsuccessful note save keeps its draft when the count or byte quota is full', t => {
  const h = fixture(t, { nativeBlobs: true });
  h.inputFiles(Array.from({ length: 12 }, (_, index) => h.file(`${index}.txt`, 'x')));
  h.click('Escribir una nota'); h.saveNote('Pendiente', 'Mi borrador');
  assert.equal(h.$('.sx-cofre-editor').hidden, false); assert.equal(h.$('.sx-cofre-note-form textarea').value, 'Mi borrador'); assert.equal(h.rows().length, 12);
  h.view.reset();
  h.inputFiles([8, 8, 8, 6].map((size, index) => new NativeFile([new Uint8Array(size * 1024 * 1024)], `${index}.bin`)));
  h.click('Escribir una nota'); h.saveNote('Pendiente', 'No se pierde');
  assert.equal(h.rows().length, 4); assert.equal(h.$('.sx-cofre-note-form textarea').value, 'No se pierde'); assert.match(h.$('.sx-cofre-status').textContent, /espacio disponible/u);
});

test('deleting requires explicit confirmation, leaves device originals alone and clears image consumers before revoking the URL', async t => {
  let accepted = false; const h = fixture(t, { confirm: async () => accepted });
  h.inputFiles([h.file('Retrato.png', 'image bytes', 'image/png')]); h.click('Abrir', h.rows()[0]);
  const image = h.$('.sx-cofre-preview img'), url = image.src; assert.equal(h.created.length, 1);
  h.click('Quitar', h.rows()[0]); await flush(); assert.equal(h.rows().length, 1); assert.equal(h.revoked.length, 0);
  assert.match(h.confirmations[0].description, /original de tu dispositivo.*no se borran/u); assert.equal(h.confirmations[0].danger, true);
  accepted = true; h.click('Quitar', h.rows()[0]); await flush();
  assert.equal(h.rows().length, 0); assert.equal(h.$('.sx-cofre-preview').hidden, true); assert.equal(image.hasAttribute('src'), false);
  assert.deepEqual(h.revoked.map(item => item.url), [url]); assert.deepEqual(h.revoked[0].activeImageSources, []);
  assert.match(h.$('.sx-cofre-status').textContent, /original.*no se ha borrado/u);
});

test('a stale delete confirmation cannot remove a new visit and clear-all refuses to remove newly added content', async t => {
  let pending = deferred(); const h = fixture(t, { confirm: () => pending.promise });
  h.inputFiles([h.file('Anterior.txt')]); h.click('Quitar', h.rows()[0]);
  h.view.reset(); h.inputFiles([h.file('Nuevo.txt')]); pending.resolve(true); await flush();
  assert.equal(h.rows().length, 1); assert.match(h.rows()[0].textContent, /Nuevo.txt/u);
  pending = deferred(); h.click('Vaciar el Cofre'); h.inputFiles([h.file('Añadido después.txt')]); pending.resolve(true); await flush();
  assert.equal(h.rows().length, 2); assert.match(h.$('.sx-cofre-status').textContent, /contenido del Cofre ha cambiado/u);
});

test('deleting a new note warns that its undownloaded text will be lost rather than implying a device original exists', async t => {
  const h = fixture(t); h.click('Escribir una nota'); h.saveNote('Mi nota', 'Sólo está en memoria');
  h.click('Quitar', h.rows()[0]); await flush();
  assert.match(h.confirmations[0].description, /Si no has descargado la nota, su texto se perderá/u);
  assert.doesNotMatch(h.confirmations[0].description, /archivo original/u); assert.equal(h.rows().length, 1);
});

test('clear-all, reset and destroy revoke every preview/download URL and discard all note or file state', async t => {
  const h = fixture(t, { confirm: async () => true });
  h.inputFiles([h.file('Foto.webp', 'pixels', 'image/webp'), h.file('Lista.txt')]); h.click('Abrir', h.rows()[0]); h.click('Descargar', h.rows()[0]);
  assert.equal(h.created.length, 2); h.click('Vaciar el Cofre'); await flush();
  assert.equal(h.rows().length, 0); assert.equal(h.revoked.length, 2); assert.equal(new Set(h.revoked.map(item => item.url)).size, 2);
  assert.match(h.confirmations[0].description, /No se borrarán originales/u);
  h.click('Escribir una nota'); h.saveNote('Temporal', 'No se conserva'); h.view.reset();
  assert.equal(h.rows().length, 0); assert.equal(h.$('.sx-cofre-note-form input').value, ''); assert.equal(h.$('.sx-cofre-note-form textarea').value, '');
  h.inputFiles([h.file('Otra.png', 'bytes', 'image/png')]); h.click('Abrir', h.rows()[0]); h.click('Descargar', h.rows()[0]);
  const statusNode = h.$('.sx-cofre-status'); h.view.destroy(); h.view.destroy();
  assert.equal(h.d.body.contains(h.view.element), false); assert.equal(h.revoked.length, 4); assert.equal(statusNode.textContent, '');
  assert.deepEqual(h.calls(), { storage: 0, network: 0 });
});

test('Node Blob/File compatibility keeps original download bytes and does not let a late text read refill a reset preview', async t => {
  const h = fixture(t, { nativeBlobs: true }); h.inputFiles([new NativeFile(['Original bytes'], 'Documento.pdf', { type: 'application/pdf' })]);
  h.click('Descargar', h.rows()[0]); assert.equal(await h.created.at(-1).blob.text(), 'Original bytes'); assert.equal(h.created.at(-1).blob.type, 'application/octet-stream');
  const delayed = deferred(), textFile = new NativeFile(['late'], 'Tarde.txt', { type: 'text/plain' });
  textFile.slice = () => ({ text: () => delayed.promise }); h.inputFiles([textFile]); h.click('Abrir', h.rows()[1]);
  h.view.reset(); delayed.resolve('No debe volver'); await flush();
  assert.equal(h.$('.sx-cofre-preview').hidden, true); assert.equal(h.$('.sx-cofre-preview-content').textContent, ''); assert.equal(h.rows().length, 0);
});
