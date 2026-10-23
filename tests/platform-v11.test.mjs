import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountPlatform, SERVICES } from '../platform-v11.js';

const alice = { user: { id: 'alice-id', email: 'a@example.invalid' }, access_token: 'alice-token' };
const bob = { user: { id: 'bob-id', email: 'b@example.invalid' }, access_token: 'bob-token' };
const flush = async () => { await new Promise(done => setImmediate(done)); await new Promise(done => setImmediate(done)); };

function fixture(t, { session = null, hash = '', omitCare = false } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body><aside>Historical banner</aside><div id="app-layout"><header class="topbar">Old header</header><main><div class="intro">Old intro</div><p id="notice" hidden></p><section id="auth-panel"><p class="access-intro"></p><form id="auth-form"><label for="email">Correo</label><input id="email"><label for="password">Contraseña</label><input id="password" type="password"><button id="login-btn" type="button">Entrar</button><button id="recover-btn" type="button">Recuperar</button><details class="access-help">Other auth paths</details></form></section><section id="recovery-panel" hidden></section><section id="chat-panel" hidden>Chat local<button id="logout-btn" type="button">Salir</button></section><section id="cofre-panel" hidden>Cofre local</section><section id="forocromos-panel" hidden>Comunidad local</section><section id="care-panel" hidden>Check-in local</section></main><footer>Old footer</footer></div></body></html>`, { url: `http://127.0.0.1:4341/${hash}`, pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  const scrolls = [], created = [], revoked = [];
  w.scrollTo = value => scrolls.push(value);
  w.URL.createObjectURL = value => { created.push(value); return `blob:platform-${created.length}`; };
  w.URL.revokeObjectURL = value => revoked.push(value);
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  w.__sxCofreSession = session;
  if (omitCare) d.getElementById('care-panel').remove();
  const controller = mountPlatform({ documentRef: d, windowRef: w });
  t.after(() => { controller.destroy(); dom.window.close(); });
  const $ = selector => d.querySelector(selector);
  function setSession(next, { updateGlobal = true } = {}) { if (updateGlobal) w.__sxCofreSession = next; w.dispatchEvent(new w.CustomEvent('sx:session', { detail: next })); }
  function setHash(next) { w.history.replaceState(null, '', next); w.dispatchEvent(new w.HashChangeEvent('hashchange')); }
  const submit = selector => $(selector).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  return { dom, w, d, controller, $, setSession, setHash, submit, scrolls, created, revoked };
}

test('the shell keeps functional module nodes and preserves their independent hidden permission state', t => {
  const h = fixture(t, { session: alice });
  const chat = h.$('#chat-panel'); h.controller.navigate('messages');
  assert.equal(h.$('#chat-panel'), chat); assert.equal(chat.hidden, true, 'presentation cannot override module authorization');
  assert.equal(chat.hasAttribute('v11-hidden'), false); assert.equal(h.$('#cofre-panel').hasAttribute('v11-hidden'), true);
  chat.hidden = false; h.controller.navigate('cofre'); assert.equal(chat.hidden, false); assert.equal(chat.hasAttribute('v11-hidden'), true);
});

test('a protected deep link asks for access and returns to the originally requested service after login', t => {
  const h = fixture(t, { hash: '#cofre-panel' });
  assert.equal(h.controller.route, 'access'); assert.equal(h.w.location.hash, '#cofre-panel');
  h.setSession(alice); assert.equal(h.controller.route, 'cofre'); assert.equal(h.w.location.hash, '#cofre');
  assert.equal(h.$('#cofre-panel').hasAttribute('v11-hidden'), false);
});

test('access helpers only prepare fictitious form values and do not submit or replace original login handlers', t => {
  const h = fixture(t); let loginClicks = 0;
  h.$('#login-btn').addEventListener('click', () => { loginClicks++; }); h.controller.navigate('access');
  [...h.d.querySelectorAll('button')].find(node => node.textContent === 'Preparar cuenta B').click();
  assert.equal(h.$('#email').value, 'b@example.invalid'); assert.equal(h.$('#password').value, '123456'); assert.equal(h.d.activeElement, h.$('#login-btn')); assert.equal(loginClicks, 0);
  h.$('#login-btn').click(); assert.equal(loginClicks, 1); assert.equal(h.$('#recover-btn').hasAttribute('v11-hidden'), true);
});

test('all service destinations are reachable from the full menu and the mobile menu closes after selection', t => {
  const h = fixture(t, { session: alice });
  const drawer = h.$('#v11-more'); const more = h.$('#v11-mobile-nav button[aria-controls="v11-more"]');
  for (const service of SERVICES) {
    const destination = drawer.querySelector(`button[data-route="${service.route}"]`); assert.ok(destination, service.route);
    more.click(); assert.equal(drawer.open, true); destination.click(); assert.equal(drawer.open, false); assert.equal(h.controller.route, service.route);
    assert.equal(h.d.activeElement, h.$('#v11-workspace')); assert.equal(destination.getAttribute('aria-current'), 'page');
  }
  more.click(); drawer.querySelector('button[aria-label="Cerrar menú"]').click(); assert.equal(drawer.open, false);
});

test('preview routes are visible when selected; the HTML hidden flag does not fight shell routing', t => {
  const h = fixture(t, { session: alice });
  for (const route of ['profile', 'trust', 'auralink', 'feedback', 'plans']) {
    h.controller.navigate(route); const page = h.$(`[data-v11-page="${route}"]`);
    assert.equal(page.hidden, false, `${route} must be displayable`); assert.equal(page.hasAttribute('v11-hidden'), false);
  }
});

test('account switch resets every memory-only preview and revokes its image URL', t => {
  const h = fixture(t, { session: alice });
  h.$('#v11-profile-alias').value = 'ALICE PRIVATE'; h.submit('#v11-profile-form');
  h.$('#v11-feedback-body').value = 'ALICE FEEDBACK'; h.submit('#v11-feedback-form');
  h.$('#v11-report-body').value = 'ALICE REPORT'; h.submit('#v11-report-form');
  const file = new h.w.File([new Uint8Array(5)], 'alice.png', { type: 'image/png' }); Object.defineProperty(h.$('#v11-visual-file'), 'files', { configurable: true, value: [file] });
  h.$('#v11-visual-file').dispatchEvent(new h.w.Event('change')); h.$('#v11-visual-consent').checked = true; h.submit('#v11-visual-form');
  h.setSession(bob);
  assert.equal(h.$('#v11-profile-alias').value, ''); assert.equal(h.$('#v11-feedback-body').value, ''); assert.equal(h.$('#v11-report-body').value, '');
  assert.doesNotMatch(h.$('main').textContent, /ALICE PRIVATE|ALICE FEEDBACK|ALICE REPORT/u); assert.deepEqual(h.revoked, ['blob:platform-1']); assert.match(h.$('#v11-account').textContent, /Cuenta B/u);
});

test('token refresh keeps same-account drafts intact and logout clears them', t => {
  const h = fixture(t, { session: alice }); h.controller.navigate('profile'); h.$('#v11-profile-alias').value = 'Draft same account';
  h.setSession({ ...alice, access_token: 'new-token' }); assert.equal(h.$('#v11-profile-alias').value, 'Draft same account');
  h.setSession(null); assert.equal(h.$('#v11-profile-alias').value, ''); assert.equal(h.controller.route, 'home'); assert.equal(h.w.location.hash, '#home'); assert.match(h.$('#v11-account').textContent, /Entrar al ensayo/u);
  h.controller.navigate('messages'); assert.equal(h.controller.route, 'access');
});

test('an explicit null session event cannot fall back to a stale global snapshot', t => {
  const h = fixture(t, { session: alice }); h.controller.navigate('profile'); h.$('#v11-profile-alias').value = 'PRIVATE LOGOUT DRAFT';
  h.setSession(null, { updateGlobal: false });
  assert.equal(h.$('#v11-profile-alias').value, ''); assert.equal(h.controller.route, 'home'); assert.match(h.$('#v11-account').textContent, /Entrar al ensayo/u);
});

test('skip-to-content hash preserves the current service rather than replacing it with home', t => {
  const h = fixture(t, { session: alice }); h.controller.navigate('care'); h.setHash('#v11-workspace');
  assert.equal(h.controller.route, 'care'); assert.equal(h.$('#care-panel').hasAttribute('v11-hidden'), false);
});

test('theme changes are the only persisted preview preference and do not reset drafts or affect routing', t => {
  const h = fixture(t, { session: alice }); h.controller.navigate('profile'); h.$('#v11-profile-alias').value = 'Draft';
  for (const theme of ['neon', 'rose', 'noir']) { h.controller.setTheme(theme); assert.equal(h.d.body.dataset.theme, theme); assert.equal(h.$('#v11-theme').value, theme); assert.equal(h.controller.route, 'profile'); assert.equal(h.$('#v11-profile-alias').value, 'Draft'); }
  assert.equal(h.w.localStorage.length, 1); assert.equal(h.w.localStorage.getItem('sx-v11-theme'), 'noir');
});

test('late module insertion is discovered without displaying inactive services or overriding its authorization', async t => {
  const h = fixture(t, { session: alice, omitCare: true });
  const cofre = h.d.createElement('section'); cofre.id = 'care-panel'; cofre.hidden = true; h.$('main').append(cofre); await flush();
  assert.equal(cofre.dataset.v11Page, 'care'); assert.equal(cofre.hidden, true); assert.equal(cofre.hasAttribute('v11-hidden'), true);
  h.controller.navigate('care'); assert.equal(cofre.hidden, true); assert.equal(cofre.hasAttribute('v11-hidden'), false);
});
