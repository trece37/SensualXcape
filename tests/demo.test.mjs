import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildDemo } from '../scripts/build-demo.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(process.env.SX_DEMO_DEPS_ROOT || root, 'package.json'));
const { JSDOM } = require('jsdom');
let output, html, bundle, mountDemo;
before(async () => {
  output = await mkdtemp(join(tmpdir(), 'sx-static-demo-'));
  await buildDemo({ root, output }); html = await readFile(join(output, 'index.html'), 'utf8');
  bundle = await readFile(join(output, 'demo.js'), 'utf8');
  ({ mountDemo } = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString('base64')}`));
});
after(async () => { if (output) await rm(output, { recursive: true, force: true }); });

function fixture(t) {
  const dom = new JSDOM(html, { url: 'https://trece37.github.io/SensualXcape/', pretendToBeVisual: true });
  const w = dom.window, d = w.document, calls = { storage: 0, network: 0, session: 0 };
  for (const property of ['localStorage', 'sessionStorage']) Object.defineProperty(w, property, { get() { calls.storage++; throw new Error('Browser storage is outside this static demo.'); } });
  Object.defineProperty(w, '__sxCofreSession', { get() { calls.session++; throw new Error('Existing account identity must not be read.'); } });
  const noNetwork = () => { calls.network++; throw new Error('No network services belong to this demonstration.'); };
  w.fetch = noNetwork; w.XMLHttpRequest = noNetwork; w.WebSocket = noNetwork;
  w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  const demo = mountDemo({ documentRef: d, windowRef: w });
  t.after(() => { demo.destroy(); w.close(); });
  const $ = id => d.getElementById(id);
  const submit = id => $(id).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  const clickText = (parent, text) => [...parent.querySelectorAll('button')].find(node => node.textContent === text).click();
  return { w, d, $, demo, calls, submit, clickText };
}

test('static build uses relative project paths, a network-blocking CSP and no production runtime', async () => {
  assert.match(html, /connect-src 'none'/u); assert.match(html, /src="\.\/demo\.js"/u); assert.match(html, /href="\.\/demo\.css"/u);
  assert.doesNotMatch(html, /app\.js|config\.js|supabase|https?:\/\//u);
  assert.doesNotMatch(bundle, /https:\/\/esm\.sh|createClient|SUPABASE_PUBLISHABLE_KEY/u);
  assert.ok((await readFile(join(output, 'assets', 'v11', 'portal-unicorn.png'))).length > 0);
});

test('building refuses contaminated output before changing any existing file', async t => {
  const contaminated = await mkdtemp(join(tmpdir(), 'sx-demo-contaminated-'));
  t.after(() => rm(contaminated, { recursive: true, force: true }));
  await writeFile(join(contaminated, 'index.html'), 'existing reviewed page');
  await writeFile(join(contaminated, 'config.js'), 'private fixture must never ship');
  await assert.rejects(buildDemo({ root, output: contaminated }), /unexpected or linked file config\.js/u);
  assert.equal(await readFile(join(contaminated, 'index.html'), 'utf8'), 'existing reviewed page');
  assert.equal(await readFile(join(contaminated, 'config.js'), 'utf8'), 'private fixture must never ship');
});

test('output allowlist is recursive and also rejects links at otherwise allowed paths', async t => {
  const nested = await mkdtemp(join(tmpdir(), 'sx-demo-nested-'));
  t.after(() => rm(nested, { recursive: true, force: true }));
  await mkdir(join(nested, 'assets', 'v11'), { recursive: true });
  await writeFile(join(nested, 'assets', 'v11', 'unreviewed.txt'), 'nested fixture');
  await assert.rejects(buildDemo({ root, output: nested }), /unexpected or linked file assets\/v11\/unreviewed\.txt/u);
  assert.equal(await readFile(join(nested, 'assets', 'v11', 'unreviewed.txt'), 'utf8'), 'nested fixture');
  const linked = await mkdtemp(join(tmpdir(), 'sx-demo-link-'));
  t.after(() => rm(linked, { recursive: true, force: true }));
  try { await symlink(join(nested, 'assets'), join(linked, 'assets'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.diagnostic('This system does not permit symlink fixtures; nested contamination was still verified.'); return; } throw error; }
  await assert.rejects(buildDemo({ root, output: linked }), /symbolic link assets/u);
});

test('every service and all three atmospheres work without storage, session identity or API access', t => {
  const h = fixture(t);
  for (const route of ['home', 'messages', 'community', 'cofre', 'care', 'profile', 'trust', 'auralink', 'feedback', 'plans', 'settings', 'access']) {
    h.demo.platform.navigate(route); assert.equal(h.demo.platform.route, route);
    assert.equal(h.d.querySelector(`[data-v11-page="${route}"]`).hasAttribute('v11-hidden'), false);
  }
  assert.match(h.d.querySelector('[data-v11-page="access"]').textContent, /sin cuenta/u);
  assert.equal(h.d.querySelectorAll('input[type="password"]').length, 0);
  for (const theme of ['neon', 'rose', 'noir']) { h.demo.platform.setTheme(theme); assert.equal(h.d.body.dataset.theme, theme); }
  assert.equal(new URL(h.d.querySelector('.v11-hero-art img').src).pathname, '/SensualXcape/assets/v11/portal-unicorn.png');
  assert.deepEqual(h.calls, { storage: 0, network: 0, session: 0 });
});

test('contact decisions, draft restoration and blocking remain inside the fictitious conversation', t => {
  const h = fixture(t); h.demo.platform.navigate('messages');
  h.clickText(h.$('contacts-list'), 'Abrir conversación');
  h.$('body').value = 'Mi borrador ficticio'; h.$('body').dispatchEvent(new h.w.Event('input'));
  h.$('leave-room').click(); h.clickText(h.$('contacts-list'), 'Abrir conversación');
  assert.equal(h.$('body').value, 'Mi borrador ficticio');
  h.$('active-block').click(); assert.equal(h.$('body').disabled, true);
  const count = h.$('messages').children.length; h.submit('send-form'); assert.equal(h.$('messages').children.length, count);
  h.$('active-block').click(); h.submit('send-form'); assert.equal(h.$('messages').children.length, count + 1);
  assert.match(h.$('send-status').textContent, /No se ha enviado/u);
  h.$('leave-room').click(); h.clickText(h.$('contacts-list'), 'Rechazar ejemplo');
  assert.equal(h.$('active-chat').hidden, true); assert.match(h.$('demo-contacts-status').textContent, /No se ha abierto/u);
  h.$('demo-reset-contacts').click(); h.clickText(h.$('contacts-list'), 'Aceptar ejemplo'); assert.equal(h.$('active-chat').hidden, false);
  assert.deepEqual(h.calls, { storage: 0, network: 0, session: 0 });
});

test('Cofre examples are fabricated and forum replies are text, with no uploads or publication', t => {
  const h = fixture(t); h.demo.platform.navigate('cofre'); const count = h.$('demo-files').children.length;
  h.$('demo-add-file').click(); assert.equal(h.$('demo-files').children.length, count + 1);
  h.clickText(h.$('demo-files'), 'Ver muestra'); assert.equal(h.$('demo-file-preview').hidden, false);
  h.clickText(h.$('demo-files'), 'Retirar ejemplo'); assert.equal(h.$('demo-files').children.length, count);
  assert.equal(h.$('cofre-panel').querySelectorAll('input[type="file"]').length, 0);
  h.demo.platform.navigate('community'); h.$('demo-topic-search').value = 'no-existe'; h.$('demo-topic-search').dispatchEvent(new h.w.Event('input'));
  assert.match(h.$('demo-topics').textContent, /No hay temas/u);
  h.$('demo-topic-search').value = ''; h.$('demo-topic-search').dispatchEvent(new h.w.Event('input')); h.$('demo-topics').querySelector('button').click();
  h.$('demo-reply').value = '<img src=x onerror=alert(1)>'; h.submit('demo-reply-form');
  assert.match(h.$('demo-topic-posts').textContent, /<img src=x/u); assert.equal(h.$('demo-topic-posts').querySelector('img'), null);
  assert.match(h.$('demo-community-status').textContent, /No se ha publicado/u); assert.equal(h.calls.network, 0);
});

test('check-in advances only by explicit simulation and never claims that an alert was delivered', t => {
  const h = fixture(t); h.demo.platform.navigate('care');
  h.submit('demo-checkin-form'); assert.equal(h.$('demo-checkin-confirm').hidden, false);
  assert.match(h.$('demo-checkin-state').textContent, /El tiempo no avanza/u);
  h.$('demo-checkin-expire').click(); assert.match(h.$('demo-checkin-state').textContent, /no envía nada/u);
  h.$('demo-checkin-confirm').click(); assert.equal(h.$('demo-checkin-cancel').hidden, true);
  h.submit('demo-checkin-form'); h.$('demo-checkin-cancel').click(); assert.match(h.$('demo-checkin-state').textContent, /cancelado/u);
  assert.equal(h.calls.network, 0);
});

test('reloading the demo resets messages, preview drafts, files and theme', t => {
  const first = fixture(t); first.demo.platform.setTheme('noir');
  first.$('v11-profile-alias').value = 'Alias inventado'; first.$('demo-add-file').click();
  first.clickText(first.$('contacts-list'), 'Abrir conversación'); first.$('body').value = 'Solo en memoria'; first.submit('send-form');
  const second = fixture(t); assert.equal(second.d.body.dataset.theme, 'neon'); assert.equal(second.$('v11-profile-alias').value, '');
  assert.equal(second.$('demo-files').children.length, 2); second.clickText(second.$('contacts-list'), 'Abrir conversación');
  assert.doesNotMatch(second.$('messages').textContent, /Solo en memoria/u);
});
