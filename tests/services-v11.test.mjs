import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountServicePreviews } from '../services-v11.js';

function fixture(t) {
  const dom = new JSDOM('<!doctype html><main></main>', { url: 'http://127.0.0.1:4341/' });
  const created = [], revoked = [], destinations = [];
  dom.window.URL.createObjectURL = file => { created.push(file); return `blob:fixture-${created.length}`; };
  dom.window.URL.revokeObjectURL = url => revoked.push(url);
  dom.window.fetch = () => assert.fail('interactive previews must not make network requests');
  const service = mountServicePreviews({ documentRef: dom.window.document, windowRef: dom.window, onNavigate: destination => destinations.push(destination) });
  t.after(() => { service.destroy(); dom.window.close(); });
  const $ = selector => dom.window.document.querySelector(selector);
  const mount = () => dom.window.document.querySelector('main').append(...service.pages);
  const submit = selector => $(selector).dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  function chooseFile(type = 'image/png', size = 6) { const file = new dom.window.File([new Uint8Array(size)], 'fixture.png', { type }); Object.defineProperty($('#v11-visual-file'), 'files', { configurable: true, value: [file] }); $('#v11-visual-file').dispatchEvent(new dom.window.Event('change')); return file; }
  return { dom, service, $, mount, submit, created, revoked, destinations, chooseFile };
}

test('five distinct preview pages are returned without insertion and disclose their local scope', t => {
  const h = fixture(t); assert.equal(h.$('main').children.length, 0);
  assert.deepEqual(h.service.pages.map(page => page.dataset.v11Page), ['profile', 'trust', 'auralink', 'feedback', 'plans']);
  for (const page of h.service.pages) { assert.equal(page.hidden, true); assert.ok(page.querySelector('h2')); assert.match(page.textContent, /MAQUETA INTERACTIVA/u); assert.match(page.textContent, /no se envían ni se guardan en el servidor/u); }
});

test('profile preview saves plain text and chosen visibility without publishing or adding markup', t => {
  const h = fixture(t); h.mount(); h.$('#v11-profile-alias').value = '<b>Mi alias</b>'; h.$('#v11-profile-city').value = 'Mi ciudad'; h.$('#v11-profile-bio').value = 'Mi texto'; h.$('#v11-profile-visibility').value = 'companions'; h.submit('#v11-profile-form');
  assert.equal(h.$('.v11-preview-card h3').textContent, '<b>Mi alias</b>'); assert.equal(h.$('.v11-preview-card b'), null);
  assert.match(h.$('.v11-preview-card').textContent, /Compañeras admitidas/u); assert.match(h.$('#v11-profile-status').textContent, /no se ha publicado ni compartido/u);
});

test('trust blocks remain explicitly fictitious and reports do not claim delivery or real account effects', t => {
  const h = fixture(t); h.mount(); h.$('#v11-trust-demo-one').click();
  assert.match(h.$('#v11-trust-list').textContent, /Bloqueado en esta maqueta/u); assert.equal(h.$('#v11-trust-demo-one').textContent, 'Desbloquear ejemplo');
  h.$('#v11-trust-messages').click(); assert.deepEqual(h.destinations, ['messages']);
  h.$('#v11-report-body').value = 'Ejemplo ficticio'; h.submit('#v11-report-form');
  assert.match(h.$('#v11-report-status').textContent, /Recibo ficticio/u); assert.match(h.$('#v11-report-status').textContent, /No se ha enviado a moderación/u);
});

test('visual preview requires an authorized supported local file and never creates a URL before consent', t => {
  const h = fixture(t); h.mount(); h.chooseFile(); h.submit('#v11-visual-form');
  assert.equal(h.created.length, 0); assert.equal(h.$('#v11-visual-image').hidden, true);
  h.$('#v11-visual-consent').checked = true; h.$('#v11-visual-style').value = 'noir'; h.submit('#v11-visual-form');
  assert.equal(h.created.length, 1); assert.equal(h.$('#v11-visual-image').hidden, false); assert.equal(h.$('#v11-visual-image').style.filter, 'grayscale(1)');
  assert.match(h.$('#v11-visual-status').textContent, /no se ha generado una imagen nueva/u);
  h.$('#v11-visual-consent').checked = false; h.$('#v11-visual-consent').dispatchEvent(new h.dom.window.Event('change'));
  assert.deepEqual(h.revoked, ['blob:fixture-1']); assert.equal(h.$('#v11-visual-image').hasAttribute('src'), false);
});

test('replacing and clearing visual inputs revoke object URLs; unsupported or oversized files do not preview', t => {
  const h = fixture(t); h.mount(); h.chooseFile(); h.$('#v11-visual-consent').checked = true; h.submit('#v11-visual-form');
  h.chooseFile('text/html'); assert.deepEqual(h.revoked, ['blob:fixture-1']); assert.equal(h.$('#v11-visual-image').hidden, true); assert.match(h.$('#v11-visual-status').textContent, /Elige un JPG/u);
  h.chooseFile('image/png', 10 * 1024 * 1024 + 1); h.$('#v11-visual-consent').checked = true; h.submit('#v11-visual-form'); assert.equal(h.created.length, 1);
});

test('feedback and plan controls produce local receipts without invented prices, purchases or chat extraction', t => {
  const h = fixture(t); h.mount(); h.$('#v11-feedback-body').value = 'Mi sugerencia'; h.submit('#v11-feedback-form');
  assert.match(h.$('#v11-feedback-status').textContent, /No se ha enviado ni se han leído tus chats/u);
  h.$('#v11-plan-visual').click(); assert.match(h.$('#v11-plans-status').textContent, /No has contratado ni pagado nada/u);
  assert.doesNotMatch(h.$('#v11-plans').textContent, /\d+\s*[€$]/u);
});

test('reset clears all account drafts, previews, receipts, selected files and object URLs', t => {
  const h = fixture(t); h.mount(); h.$('#v11-profile-alias').value = 'PRIVATE ALIAS'; h.submit('#v11-profile-form'); h.$('#v11-report-body').value = 'PRIVATE REPORT'; h.submit('#v11-report-form'); h.$('#v11-trust-demo-one').click(); h.$('#v11-feedback-body').value = 'PRIVATE FEEDBACK'; h.submit('#v11-feedback-form'); h.$('#v11-plan-daily').click(); h.chooseFile(); h.$('#v11-visual-consent').checked = true; h.submit('#v11-visual-form');
  h.service.reset(); assert.equal(h.$('#v11-profile-alias').value, ''); assert.equal(h.$('#v11-report-body').value, ''); assert.equal(h.$('#v11-feedback-body').value, ''); assert.equal(h.$('#v11-visual-image').hasAttribute('src'), false); assert.equal(h.$('#v11-visual-consent').checked, false);
  assert.equal(h.$('#v11-trust-demo-one').textContent, 'Bloquear ejemplo'); assert.deepEqual(h.revoked, ['blob:fixture-1']); assert.doesNotMatch(h.$('main').textContent, /PRIVATE|Interés de prueba|Recibo ficticio/u);
});
