import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createProfileView } from '../demo/profile-studio.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, options = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.invalid/demo/' });
  const w = dom.window, d = w.document, urls = [], revoked = [], publishes = [], notifications = [], info = [], events = [], calls = { network: 0, storage: 0 };
  const noNetwork = () => { calls.network++; throw new Error('Network is outside the profile studio.'); };
  w.fetch = noNetwork; w.XMLHttpRequest = noNetwork; w.WebSocket = noNetwork;
  for (const key of ['localStorage', 'sessionStorage']) Object.defineProperty(w, key, { get() { calls.storage++; throw new Error('The studio must stay in memory.'); } });
  w.URL.createObjectURL = file => { const url = `blob:profile-${urls.length + 1}`; urls.push({ url, file }); return url; };
  w.URL.revokeObjectURL = url => { revoked.push(url); events.push(`revoke:${url}`); };
  const view = createProfileView({ documentRef: d, windowRef: w, onPublish: profile => { publishes.push(profile); events.push(profile ? 'publish' : 'withdraw'); }, notify: text => notifications.push(text), onInfo: key => info.push(key), ...options });
  d.body.append(view.element);
  t.after(() => { view.destroy(); assert.deepEqual(calls, { network: 0, storage: 0 }); w.close(); });
  const $ = selector => view.element.querySelector(selector);
  const input = (key, value) => { const node = $(`[data-field="${key}"]`); node.value = value; node.dispatchEvent(new w.Event('input', { bubbles: true })); return node; };
  const include = (key, checked = true) => { const node = $(`[data-include="${key}"]`); node.checked = checked; node.dispatchEvent(new w.Event('change', { bubbles: true })); };
  const file = (name = 'ejemplo.jpg', type = 'image/jpeg', size = 10) => { const result = new w.File(['fictitious'], name, { type }); Object.defineProperty(result, 'size', { value: size }); return result; };
  const choose = files => { const node = $('[data-field="photos"]'); Object.defineProperty(node, 'files', { configurable: true, value: files }); node.dispatchEvent(new w.Event('change', { bubbles: true })); };
  const action = (id, name) => $(`li[data-photo-id="${id}"] button[data-action="${name}"]`).click();
  const share = () => $('[data-action="share"]').click();
  return { w, d, $, view, urls, revoked, publishes, notifications, info, events, input, include, file, choose, action, share };
}

test('only deliberately included public text enters the snapshot and it remains plain text', t => {
  const h = fixture(t); assert.equal(h.view.element.dataset.v11Page, 'profile'); assert.equal(h.view.element.id, '');
  h.input('private-alias', 'PRIVATE ALIAS'); h.input('private-bio', 'PRIVATE NOTES');
  h.input('public-alias', '<b>Alias inventado</b>'); h.input('public-bio', '<img src=x onerror=alert(1)>');
  assert.equal(h.view.getPublicProfile(), null); assert.equal(h.publishes.length, 0);
  h.include('information'); h.share(); const profile = h.view.getPublicProfile();
  assert.deepEqual(profile, { alias: '<b>Alias inventado</b>', bio: '<img src=x onerror=alert(1)>', photos: [], coverIndex: -1 });
  assert.doesNotMatch(JSON.stringify(h.publishes), /PRIVATE ALIAS|PRIVATE NOTES/u);
  assert.equal(h.$('[data-role="public-preview"]').querySelector('b,img'), null);
  assert.match(h.$('[data-role="public-preview"]').textContent, /<img src=x/u);
});

test('nothing is shared implicitly and information and photos have separate inclusion choices', t => {
  const h = fixture(t); h.share(); assert.equal(h.publishes.length, 0);
  h.include('information'); h.share(); assert.equal(h.publishes.length, 0);
  h.input('public-alias', 'Alias de muestra'); h.choose([h.file()]); h.share();
  assert.equal(h.view.getPublicProfile().photos.length, 0, 'loading a photo is not permission to include it');
  h.include('information', false); assert.equal(h.view.getPublicProfile(), null);
  h.include('photos'); h.share(); assert.equal(h.view.getPublicProfile().alias, ''); assert.equal(h.view.getPublicProfile().photos.length, 1);
  h.include('photos', false); assert.equal(h.publishes.at(-1), null);
});

test('photo preparation enforces six photos, the 8 MiB limit and safe supported formats without uploads', t => {
  const h = fixture(t);
  h.choose([h.file('grande.jpg', 'image/jpeg', 8 * 1024 * 1024 + 1), h.file('vector.svg', 'image/svg+xml'), ...Array.from({ length: 7 }, (_, index) => h.file(`foto-${index}.png`, 'image/png'))]);
  assert.equal(h.urls.length, 6); assert.equal(h.$('[data-role="photo-list"]').children.length, 6);
  assert.match(h.$('[data-role="photo-status"]').textContent, /Cada foto.*máximo/u); assert.match(h.$('[data-role="photo-status"]').textContent, /máximo de 6/u);
  assert.equal(h.view.getPublicProfile(), null); assert.equal(h.publishes.length, 0);
});

test('cover, photo order and CSS framing are represented precisely in the decided snapshot', t => {
  const h = fixture(t); h.choose([h.file('uno.jpg'), h.file('dos.jpg'), h.file('tres.jpg')]);
  for (const [key, value] of [['zoom', 1.6], ['x', 23], ['y', 77]]) { const slider = h.$(`[data-adjustment="${key}"]`); slider.value = value; slider.dispatchEvent(new h.w.Event('input')); }
  h.action('photo-3', 'cover'); h.action('photo-3', 'earlier'); h.include('photos'); h.share();
  const profile = h.view.getPublicProfile();
  assert.deepEqual(profile.photos.map(photo => photo.url), ['blob:profile-1', 'blob:profile-3', 'blob:profile-2']); assert.equal(profile.coverIndex, 1);
  assert.deepEqual(profile.photos[1], { url: 'blob:profile-3', zoom: 1.6, x: 23, y: 77 });
  assert.equal(h.$('li[data-photo-id="photo-3"] img').style.objectPosition, '23% 77%');
  assert.deepEqual(Object.keys(profile).sort(), ['alias', 'bio', 'coverIndex', 'photos']);
});

test('editing a draft does not silently replace the previous shared version and returned snapshots are isolated', t => {
  const h = fixture(t); h.input('public-alias', 'Primera versión'); h.include('information'); h.share();
  h.input('public-alias', 'Segunda versión'); assert.equal(h.view.getPublicProfile().alias, 'Primera versión'); assert.equal(h.publishes.length, 1);
  h.view.getPublicProfile().alias = 'Outside mutation'; h.publishes[0].alias = 'Callback mutation';
  assert.equal(h.view.getPublicProfile().alias, 'Primera versión'); h.share(); assert.equal(h.view.getPublicProfile().alias, 'Segunda versión');
  h.$('[data-action="withdraw"]').click(); assert.equal(h.view.getPublicProfile(), null); assert.equal(h.publishes.at(-1), null);
});

test('removing a shared photo withdraws its snapshot before revoking the local URL', t => {
  const h = fixture(t); h.choose([h.file(), h.file('otra.jpg')]); h.include('photos'); h.share(); h.events.length = 0;
  h.action('photo-1', 'remove');
  assert.equal(h.view.getPublicProfile(), null); assert.deepEqual(h.events.slice(0, 2), ['withdraw', 'revoke:blob:profile-1']);
  assert.equal(h.$('[data-role="photo-list"]').children.length, 1); assert.match(h.$('[data-role="photo-status"]').textContent, /archivo de tu dispositivo sigue intacto/u);
});

test('an unreadable selected image is removed, withdrawn if shared and honestly reported', t => {
  const h = fixture(t); h.choose([h.file()]); h.include('photos'); h.share();
  h.$('li[data-photo-id="photo-1"] img').dispatchEvent(new h.w.Event('error'));
  assert.equal(h.view.getPublicProfile(), null); assert.deepEqual(h.revoked, ['blob:profile-1']); assert.equal(h.$('[data-role="photo-list"]').children.length, 0);
  assert.match(h.notifications.at(-1), /sin subir ningún archivo/u);
});

test('deleting needs confirmation and reset clears private drafts, publication and every URL', async t => {
  let accept = false, request;
  const h = fixture(t, { confirmAction: async details => { request = details; return accept; } });
  h.input('private-alias', 'Privado'); h.input('public-alias', 'Público'); h.choose([h.file()]); h.include('information'); h.share();
  h.$('[data-action="delete"]').click(); await flush(); assert.equal(h.revoked.length, 0); assert.notEqual(h.view.getPublicProfile(), null);
  assert.equal(request.danger, true); assert.match(request.description, /archivos originales de tu dispositivo no se borrarán/u);
  accept = true; h.$('[data-action="delete"]').click(); await flush();
  assert.equal(h.$('[data-field="private-alias"]').value, ''); assert.equal(h.$('[data-field="public-alias"]').value, ''); assert.equal(h.$('[data-include="information"]').checked, false);
  assert.equal(h.view.getPublicProfile(), null); assert.deepEqual(h.revoked, ['blob:profile-1']); assert.equal(h.publishes.at(-1), null);
});

test('a late deletion confirmation cannot erase a profile started after reset; destruction is idempotent', async t => {
  let finish;
  const h = fixture(t, { confirmAction: () => new Promise(resolve => { finish = resolve; }) });
  h.choose([h.file()]); h.$('[data-action="delete"]').click(); h.view.reset(); h.input('private-alias', 'Nuevo borrador'); finish(true); await flush();
  assert.equal(h.$('[data-field="private-alias"]').value, 'Nuevo borrador');
  h.choose([h.file('nueva.jpg')]); h.view.destroy(); h.view.destroy(); assert.deepEqual(h.revoked, ['blob:profile-1', 'blob:profile-2']);
});

test('privacy and image explanations delegate to the supplied information routes', t => {
  const h = fixture(t); for (const node of h.view.element.querySelectorAll('button')) { if (['Sobre la privacidad de tu perfil', 'Sobre tus imágenes'].includes(node.textContent)) node.click(); }
  assert.deepEqual(h.info, ['profile-sharing', 'images']);
});

test('saving and recovering restores all four texts without sharing or replacing photos and the public snapshot', t => {
  const h = fixture(t);
  h.input('private-alias', 'Alias privado guardado'); h.input('private-bio', 'Notas guardadas'); h.input('public-alias', 'Presentación guardada'); h.input('public-bio', 'Texto guardado');
  h.$('[data-action="save-texts"]').click(); assert.equal(h.publishes.length, 0);
  h.input('private-alias', 'Cambio privado'); h.input('private-bio', 'Cambio de notas'); h.input('public-alias', 'Versión compartida después'); h.input('public-bio', 'Otro texto compartido');
  h.choose([h.file()]); h.include('information'); h.include('photos'); h.share();
  const shared = h.view.getPublicProfile(), numberOfPublications = h.publishes.length;
  h.$('[data-action="recover-texts"]').click();
  assert.equal(h.$('[data-field="private-alias"]').value, 'Alias privado guardado'); assert.equal(h.$('[data-field="private-bio"]').value, 'Notas guardadas');
  assert.equal(h.$('[data-field="public-alias"]').value, 'Presentación guardada'); assert.equal(h.$('[data-field="public-bio"]').value, 'Texto guardado');
  assert.deepEqual(h.view.getPublicProfile(), shared); assert.equal(h.publishes.length, numberOfPublications);
  assert.equal(h.$('[data-role="photo-list"]').children.length, 1); assert.deepEqual(h.revoked, []);
  assert.match(h.$('[data-role="public-preview"]').textContent, /Presentación guardada/u);
});

test('reset and confirmed deletion also discard the saved copy of the texts', async t => {
  const h = fixture(t, { confirmAction: async () => true });
  h.input('private-alias', 'Antes de reset'); h.$('[data-action="save-texts"]').click(); h.view.reset();
  assert.equal(h.$('[data-action="recover-texts"]').disabled, true);
  h.input('private-alias', 'Nuevo texto'); h.$('[data-action="recover-texts"]').dispatchEvent(new h.w.Event('click'));
  assert.equal(h.$('[data-field="private-alias"]').value, 'Nuevo texto', 'reset must remove the saved copy, not merely disable its button');
  h.$('[data-action="save-texts"]').click(); h.$('[data-action="delete"]').click(); await flush();
  assert.equal(h.$('[data-action="recover-texts"]').disabled, true);
  h.input('private-alias', 'Después de borrar'); h.$('[data-action="recover-texts"]').dispatchEvent(new h.w.Event('click'));
  assert.equal(h.$('[data-field="private-alias"]').value, 'Después de borrar');
});
