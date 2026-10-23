import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountPlatform } from '../platform-v11.js';

const alice = { user: { id: 'alice-id', email: 'a@example.invalid' }, access_token: 'alice-token' };
function fixture(t, { viewport = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="app-layout"><main><section id="auth-panel"><input id="email"><input id="password"><button id="login-btn"></button></section><section id="chat-panel" hidden><input id="draft"><button id="logout-btn"></button></section><section id="cofre-panel" hidden></section><section id="forocromos-panel" hidden></section><section id="care-panel" hidden></section></main></div></body></html>', { url: 'http://127.0.0.1:4341/#home', pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  let scrollY = 0;
  Object.defineProperty(w, 'scrollY', { get: () => scrollY });
  w.scrollTo = ({ top }) => { scrollY = top; };
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  w.__sxCofreSession = alice;
  w.history.scrollRestoration = 'auto';
  let visualViewport;
  if (viewport) {
    visualViewport = new w.EventTarget(); visualViewport.height = 768; visualViewport.offsetTop = 0;
    Object.defineProperty(w, 'visualViewport', { value: visualViewport });
  }
  const controller = mountPlatform({ documentRef: d, windowRef: w });
  t.after(() => { controller.destroy(); w.close(); });
  const $ = selector => d.querySelector(selector);
  const travel = direction => new Promise(resolve => { w.addEventListener('hashchange', () => setTimeout(resolve, 0), { once: true }); w.history[direction](); });
  return { w, d, $, controller, visualViewport, travel };
}

test('Back and Forward restore service, scroll and the existing draft without overriding permissions', async t => {
  const h = fixture(t), initialLength = h.w.history.length;
  h.controller.navigate('messages'); h.$('#draft').value = 'Mi borrador';
  const messages = h.d.createElement('ol'); messages.className = 'messages'; h.$('#chat-panel').append(messages); messages.scrollTop = 170;
  h.w.scrollTo({ top: 940 }); h.controller.navigate('cofre');
  messages.scrollTop = 0; // A background module refresh while its page is hidden.
  assert.equal(h.w.scrollY, 0); assert.equal(h.w.history.length, initialLength + 2);
  h.w.scrollTo({ top: 310 });
  await h.travel('back');
  assert.equal(h.controller.route, 'messages'); assert.equal(h.w.scrollY, 940);
  assert.equal(h.$('#draft').value, 'Mi borrador'); assert.equal(h.$('#chat-panel').hidden, true);
  assert.equal(messages.scrollTop, 170, 'restore the nested conversation viewport too');
  assert.equal(h.$('#chat-panel').hasAttribute('v11-hidden'), false);
  assert.equal(h.d.activeElement, h.$('main'));
  await h.travel('forward');
  assert.equal(h.controller.route, 'cofre'); assert.equal(h.w.scrollY, 310);
  const length = h.w.history.length; h.controller.navigate('cofre');
  assert.equal(h.w.history.length, length); assert.equal(h.w.scrollY, 310);
});

test('closing More returns focus to its trigger and keeps the route and scroll', t => {
  const h = fixture(t); h.controller.navigate('cofre'); h.w.scrollTo({ top: 250 });
  const trigger = h.$('[aria-controls="v11-more"]'); trigger.focus(); trigger.click();
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  h.$('[aria-label="Cerrar menú"]').click();
  assert.equal(h.d.activeElement, trigger); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(h.controller.route, 'cofre'); assert.equal(h.w.scrollY, 250);
  trigger.click(); h.$('#v11-more button[data-route="profile"]').click();
  assert.equal(h.controller.route, 'profile'); assert.equal(h.d.activeElement, h.$('main'));
});

test('browser history remains gated after signing out and clears the old account draft', async t => {
  const h = fixture(t); h.controller.navigate('messages'); h.controller.navigate('profile');
  h.$('#v11-profile-alias').value = 'Privado';
  h.w.dispatchEvent(new h.w.CustomEvent('sx:session', { detail: null }));
  assert.equal(h.controller.route, 'home'); assert.equal(h.$('#v11-profile-alias').value, '');
  await h.travel('back');
  assert.equal(h.controller.route, 'access'); assert.equal(h.$('#chat-panel').hasAttribute('v11-hidden'), true);
});

test('visual viewport tracks visible height and flags the keyboard only for an editable field', async t => {
  const h = fixture(t, { viewport: true });
  h.$('#email').focus(); h.visualViewport.height = 440;
  h.visualViewport.dispatchEvent(new h.w.Event('resize'));
  assert.equal(h.d.body.style.getPropertyValue('--v11-visible-height'), '440px');
  assert.equal(h.d.body.style.getPropertyValue('--v11-keyboard-offset'), '328px');
  assert.equal(h.d.body.getAttribute('data-keyboard-open'), 'true');
  h.visualViewport.scale = 2; h.visualViewport.dispatchEvent(new h.w.Event('resize'));
  assert.equal(h.d.body.hasAttribute('data-keyboard-open'), false, 'pinch zoom is not a keyboard');
  assert.equal(h.d.body.style.getPropertyValue('--v11-keyboard-offset'), '0px');
  h.$('#login-btn').focus(); await Promise.resolve();
  assert.equal(h.d.body.hasAttribute('data-keyboard-open'), false);
  h.controller.destroy();
  assert.equal(h.d.body.style.getPropertyValue('--v11-visible-height'), '');
  assert.equal(h.w.history.scrollRestoration, 'auto');
});
