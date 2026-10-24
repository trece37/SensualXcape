import test from 'node:test';
import assert from 'node:assert/strict';
import { Blob as NativeBlob, File as NativeFile } from 'node:buffer';
import { JSDOM } from 'jsdom';
import { createCofreView } from '../demo/cofre-studio.js';
import { SXVaultObjects } from '../demo/effects/vault-objects.js';

const flush = () => new Promise(done => setImmediate(done));
function setup(t, { confirm = async () => false } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://example.invalid/SensualXcape/v2/', pretendToBeVisual: true });
  const w = dom.window, d = w.document, downloads = [], blobs = [];
  w.Blob = NativeBlob; w.File = NativeFile;
  w.URL.createObjectURL = blob => { blobs.push(blob); return `blob:https://example.invalid/${blobs.length}`; }; w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
  const view = createCofreView({ documentRef: d, windowRef: w, confirmAction: confirm }); d.body.append(view.element);
  t.after(() => { view.destroy(); w.close(); });
  const $ = s => view.element.querySelector(s), $$ = s => [...view.element.querySelectorAll(s)];
  const button = text => $$('button').find(n => n.textContent === text);
  const note = (title, text) => { button('Escribir una nota').click(); $('.sx-cofre-note-form input').value = title; $('.sx-cofre-note-form textarea').value = text; $('.sx-cofre-note-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); };
  const file = (name, text) => { const input = $('input[type=file]'); Object.defineProperty(input, 'files', { configurable: true, value: [new NativeFile([text], name, { type: 'text/plain' })] }); input.dispatchEvent(new w.Event('change', { bubbles: true })); };
  const key = (node, key) => node.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  return { w, d, view, $, $$, button, note, file, key, downloads, blobs };
}

test('V2 objects represent the actual entries, stay in sync with edits and filters, and do not introduce samples', async t => {
  const h = setup(t);
  assert.equal(h.$$('.vo-card').length, 0); assert.equal(h.$$('.sx-cofre-item').length, 0);
  h.note('Una idea', 'Texto original'); h.file('Mi archivo.txt', 'Archivo real de prueba');
  h.button('Abrir mi Cofre').click();
  assert.equal(h.$$('.vo-card:not([hidden])').length, 2);
  const ids = h.$$('.sx-cofre-item').map(n => n.dataset.entryId); assert.deepEqual(h.$$('.vo-card').map(n => n.dataset.entryId), ids);
  h.$('.vo-card .vo-open').click(); assert.equal(h.$('.sx-cofre-preview-text').textContent, 'Texto original');
  h.$('.sx-cofre-item-actions button[aria-label="Editar Una idea"]').click();
  h.$('.sx-cofre-note-form input').value = 'Mi idea renombrada'; h.$('.sx-cofre-note-form textarea').value = 'Texto actualizado'; h.$('.sx-cofre-note-form').dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(h.$('.vo-title').textContent, 'Mi idea renombrada'); assert.equal(h.$('.vo-card').dataset.entryId, ids[0]);
  assert.equal(h.$('.sx-cofre-preview-text').textContent, 'Texto actualizado');
  const search = h.$('input[type=search]'); search.value = 'archivo'; search.dispatchEvent(new h.w.Event('input'));
  assert.equal(h.$$('.vo-card').length, 1); assert.equal(h.$('.vo-title').textContent, 'Mi archivo.txt');
  search.value = ''; search.dispatchEvent(new h.w.Event('input')); assert.equal(h.$$('.vo-card').length, 2);
  assert.equal(h.$$('.sx-cofre-item').length, 2); await flush();
});

test('collecting and recovering an object never removes its entry or changes its download bytes', async t => {
  const h = setup(t); h.file('Conservar.txt', 'Los mismos bytes\n'); h.button('Abrir mi Cofre').click();
  const card = h.$('.vo-card'), id = card.dataset.entryId;
  h.key(card.querySelector('.vo-handle'), 'End');
  assert.equal(card.hidden, true); assert.equal(h.$$('.sx-cofre-item').length, 1); assert.match(h.$('.sx-cofre-status').textContent, /sigue disponible en la lista/u);
  h.$('.sx-cofre-item [aria-label="Descargar Conservar.txt"]').click();
  assert.equal(await h.blobs.at(-1).text(), 'Los mismos bytes\n'); assert.deepEqual(h.downloads, ['Conservar.txt']);
  h.$('.vo-recover').click(); assert.equal(h.$('.vo-card').hidden, false); assert.equal(h.$('.vo-card').dataset.entryId, id);
  assert.equal(h.$$('.sx-cofre-item').length, 1);
});

test('opening an object brings its preview into view without changing the list opening flow', async t => {
  const h = setup(t), scrolls = [];
  h.$('.sx-cofre-preview').scrollIntoView = options => scrolls.push(options);
  h.note('Visible en móvil', 'Contenido real'); h.button('Abrir mi Cofre').click();
  h.$('.vo-card .vo-open').click(); await flush();
  assert.equal(h.$('.sx-cofre-preview-text').textContent, 'Contenido real');
  assert.deepEqual(scrolls, [{ block: 'start', behavior: 'auto' }]);
  h.$('.sx-cofre-preview-heading button').click();
  h.$('.sx-cofre-item [data-preview-entry]').click(); await flush();
  assert.equal(scrolls.length, 1, 'opening from the list keeps its existing scroll flow');
});

test('confirmed removal updates objects too, while cancelling removal preserves them', async t => {
  let accept = false; const h = setup(t, { confirm: async () => accept }); h.note('Una nota', 'Conservar'); h.button('Abrir mi Cofre').click();
  h.$('.sx-cofre-delete').click(); await flush(); assert.equal(h.$$('.vo-card').length, 1);
  accept = true; h.$('.sx-cofre-delete').click(); await flush();
  assert.equal(h.$$('.vo-card').length, 0); assert.equal(h.$$('.sx-cofre-item').length, 0);
});

test('a pointer drag into the chest only collects the object and cancelling a drag preserves its entry', async t => {
  const h = setup(t); h.file('Arrastrar.txt', 'No borrar al mover'); h.button('Abrir mi Cofre').click();
  const scene = h.$('.sx-cofre-scene'), card = h.$('.vo-card'), handle = card.querySelector('.vo-handle');
  Object.defineProperty(scene, 'clientWidth', { value: 390 }); Object.defineProperty(scene, 'clientHeight', { value: 430 });
  scene.getBoundingClientRect = () => ({ left: 0, top: 0, width: 390, height: 430 });
  h.$('input[type=search]').dispatchEvent(new h.w.Event('input'));
  h.$('.vo-drop-zone').getBoundingClientRect = () => ({ left: 12, right: 378, top: 370, bottom: 424 });
  card.setPointerCapture = () => {}; card.hasPointerCapture = () => true; card.releasePointerCapture = () => {};
  const pointer = (type, x, y) => { const event = new h.w.Event(type, { bubbles: true, cancelable: true }); Object.assign(event, { pointerId: 1, pointerType: 'touch', button: 0, isPrimary: true, clientX: x, clientY: y }); handle.dispatchEvent(event); };
  const initialLeft = card.style.left;
  pointer('pointerdown', 40, 40); pointer('pointermove', 140, 200); pointer('pointercancel', 140, 200);
  assert.equal(card.style.left, initialLeft); assert.equal(card.hidden, false); assert.equal(h.$$('.sx-cofre-item').length, 1);
  pointer('pointerdown', 40, 40); pointer('pointermove', 140, 400); pointer('pointerup', 140, 400);
  assert.equal(card.hidden, true); assert.equal(h.$$('.sx-cofre-item').length, 1);
  h.$('.sx-cofre-item [aria-label="Descargar Arrastrar.txt"]').click();
  assert.equal(await h.blobs.at(-1).text(), 'No borrar al mover');
});

test('only four objects are staged while every entry stays in the list, and simple mode preserves all actions', async t => {
  const h = setup(t); for (let i = 0; i < 7; i++) h.note(`Nota ${i}`, `Contenido ${i}`);
  h.button('Abrir mi Cofre').click(); assert.equal(h.$$('.vo-card').length, 4); assert.equal(h.$$('.sx-cofre-item').length, 7);
  h.d.body.classList.add('sx-easy'); h.d.dispatchEvent(new h.w.CustomEvent('sx:effects-change', { detail: { enabled: false, easy: true } }));
  assert.equal(h.$('.sx-cofre-scene').hidden, true); assert.equal(h.$$('.sx-cofre-item').length, 7);
  assert.equal(h.button('Añadir archivos').disabled, false); assert.equal(h.button('Escribir una nota').disabled, false);
  h.d.body.classList.remove('sx-easy'); h.d.dispatchEvent(new h.w.CustomEvent('sx:effects-change', { detail: { enabled: true, easy: false } }));
  assert.equal(h.$('.sx-cofre-scene').hidden, false); assert.equal(h.$$('.vo-card:not([hidden])').length, 4); await flush();
});

test('a pending hold is cancelled by a route/effect change and by a scroll gesture', t => {
  const h = setup(t), timers = new Map(); let sequence = 0;
  h.w.setTimeout = fn => { timers.set(++sequence, fn); return sequence; }; h.w.clearTimeout = id => timers.delete(id);
  const target = h.$('.sx-cofre-chest-touch');
  const pointer = (type, props) => { const e = new h.w.Event(type, { bubbles: true }); Object.assign(e, { button: 0, isPrimary: true, clientX: 20, clientY: 20 }, props); target.dispatchEvent(e); };
  pointer('pointerdown'); assert.equal(timers.size, 1);
  h.d.dispatchEvent(new h.w.CustomEvent('sx:effects-change', { detail: { enabled: true, route: 'messages' } })); assert.equal(timers.size, 0); assert.equal(target.getAttribute('aria-expanded'), 'false');
  pointer('pointerdown'); pointer('pointermove', { clientY: 50 }); assert.equal(timers.size, 0);
  pointer('pointerdown'); [...timers.values()][0](); assert.equal(target.getAttribute('aria-expanded'), 'true');
  target.click(); assert.equal(target.getAttribute('aria-expanded'), 'true', 'the click following a long press must not close the chest');
});

test('object layout survives a collapsed resize and filtered items retain their collected state', t => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { pretendToBeVisual: true }); const w = dom.window, host = w.document.getElementById('host');
  let width = 390; Object.defineProperty(host, 'clientWidth', { get: () => width }); Object.defineProperty(host, 'clientHeight', { get: () => 430 });
  const objects = new SXVaultObjects({ host, items: [{ id: 1, title: 'Uno', kind: 'note', detail: 'Nota' }, { id: 2, title: 'Dos', kind: 'text', detail: 'Texto' }] });
  t.after(() => { objects.destroy(); w.close(); }); objects.setOpen(true);
  const second = () => host.querySelector('[data-entry-id="2"]'); const rightBefore = Number.parseFloat(second().style.left); assert.ok(rightBefore > 180);
  width = 60; objects.resize(); width = 847; objects.resize(); assert.ok(Number.parseFloat(second().style.left) > 600);
  second().querySelector('.vo-handle').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
  objects.setItems([{ id: 1, title: 'Uno', kind: 'note', detail: 'Nota' }], [1, 2]);
  objects.setItems([{ id: 1, title: 'Uno', kind: 'note', detail: 'Nota' }, { id: 2, title: 'Dos renombrado', kind: 'text', detail: 'Texto' }], [1, 2]);
  assert.equal(second().hidden, true); assert.equal(second().querySelector('.vo-title').textContent, 'Dos renombrado');
  objects.reset(); assert.equal(second().hidden, false);
  objects.setItems([]); assert.equal(host.querySelectorAll('.vo-card').length, 0); assert.equal(objects.layouts.size, 0);
});
