import test from 'node:test';
import assert from 'node:assert/strict';
import jsdom from 'jsdom';
import { DEFAULT_STYLE, normalizeStyle, renderBody, attachComposer, PROFILE_STAGES, PROFILE_RULES, describeProgress, normalizeAvatar } from '../forum/community.js';
const { JSDOM, requestInterceptor } = jsdom;

function environment(t) {
  const requests = [];
  const resources = { interceptors: [requestInterceptor(request => { requests.push(request.url); return new Response(''); })] };
  const dom = new JSDOM('<form><textarea maxlength="3000"></textarea></form>', { url: 'https://example.invalid/foro/', resources, pretendToBeVisual: true });
  const { window } = dom, doc = window.document, textarea = doc.querySelector('textarea');
  window.fetch = url => { requests.push(url); throw new Error('Unexpected request'); };
  t.after(() => window.close());
  return { window, doc, textarea, requests };
}

test('message rendering keeps hostile markup and links as plain text without external requests', async t => {
  const h = environment(t);
  const parts = ['<img src="https://tracker.invalid/pixel" onerror="alert(1)">', '<script>alert(2)</script><svg/onload=alert(3)>', '[abrir](javascript:alert(4)) https://tracker.invalid/image.png'];
  const element = renderBody(h.doc, parts.join('\n\n'));
  h.doc.body.append(element);
  assert.deepEqual([...element.querySelectorAll('p')].map(node => node.textContent), parts);
  assert.equal(element.querySelector('img,script,svg,a,iframe,video,audio,style,link'), null);
  assert.deepEqual([...element.classList], ['styled-body', 'font-sans', 'color-default']);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.requests, []);
  const legacy = renderBody(h.doc, 'Una línea\ny su continuación.\n \nOtro párrafo.');
  assert.deepEqual([...legacy.children].map(node => node.textContent), ['Una línea\ny su continuación.', 'Otro párrafo.']);
});

test('only the allowed structured fonts and colors can become classes', t => {
  const { doc } = environment(t);
  for (const value of [null, {}, 'serif', { font: '__proto__', color: 'constructor' }, { font: 'serif" onclick="alert(1)', color: 'url(https://tracker.invalid)' }]) {
    assert.deepEqual(normalizeStyle(value), DEFAULT_STYLE);
    const node = renderBody(doc, 'Texto', value);
    assert.equal(node.className, 'styled-body font-sans color-default');
    assert.equal(node.getAttribute('style'), null);
    assert.equal(node.attributes.length, 1);
  }
  for (const font of ['sans', 'serif', 'mono']) for (const color of ['default', 'rose', 'violet', 'teal']) {
    const element = renderBody(doc, 'Texto <literal>', { font, color, background: 'url(https://tracker.invalid)' });
    assert.equal(element.className, `styled-body font-${font} color-${color}`);
    assert.equal(element.textContent, 'Texto <literal>');
  }
});

test('composer styles apply to the whole message without altering text or cursor', t => {
  const { doc, textarea, window } = environment(t), changes = [];
  textarea.value = 'Una aportación\ncon dos líneas.'; textarea.setSelectionRange(4, 14);
  const composer = attachComposer({ doc, textarea, style: { font: 'serif', color: 'rose' }, onStyleChange: style => changes.push(style) });
  textarea.before(composer.element);
  const font = composer.element.querySelector('[aria-label="Fuente"]'), color = composer.element.querySelector('[aria-label="Color"]');
  assert.equal(font.value, 'serif'); assert.equal(color.value, 'rose');
  font.value = 'mono'; font.dispatchEvent(new window.Event('change', { bubbles: true }));
  color.value = 'teal'; color.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.deepEqual(changes, [{ font: 'mono', color: 'rose' }, { font: 'mono', color: 'teal' }]);
  assert.deepEqual(composer.getStyle(), { font: 'mono', color: 'teal' });
  assert.ok(textarea.classList.contains('font-mono')); assert.ok(textarea.classList.contains('color-teal'));
  assert.equal(textarea.value, 'Una aportación\ncon dos líneas.');
  assert.equal(textarea.selectionStart, 4); assert.equal(textarea.selectionEnd, 14);
  const copy = composer.getStyle(); copy.color = 'rose';
  assert.equal(composer.getStyle().color, 'teal');
  composer.setStyle({ font: 'invalid', color: 'invalid' });
  assert.deepEqual(composer.getStyle(), DEFAULT_STYLE);
  assert.equal(changes.length, 2);
});

test('emoji choices are accessible local text and Escape returns focus without closing an enclosing dialog', t => {
  const { doc, textarea, window, requests } = environment(t);
  const composer = attachComposer({ doc, textarea }); textarea.before(composer.element);
  const toggle = composer.element.querySelector('.emoji-toggle'), picker = composer.element.querySelector('.emoji-picker');
  assert.equal(picker.hidden, true); assert.equal(toggle.getAttribute('aria-controls'), picker.id);
  toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true'); assert.equal(picker.hidden, false);
  assert.equal(picker.querySelectorAll('button[type="button"][aria-label]').length, 12);
  assert.equal(doc.activeElement, picker.querySelector('button'));
  assert.equal(composer.element.querySelector('img,a,script,iframe,style,link'), null);
  let escaped = 0; doc.addEventListener('keydown', () => escaped++);
  doc.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(picker.hidden, true); assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(doc.activeElement, toggle); assert.equal(escaped, 0); assert.deepEqual(requests, []);
});

test('choosing an emoji replaces the selected text, moves the caret and emits one input without submitting', t => {
  const { doc, textarea } = environment(t), inputs = [];
  const composer = attachComposer({ doc, textarea }); textarea.before(composer.element);
  textarea.value = 'Hola mundo'; textarea.setSelectionRange(5, 10);
  textarea.addEventListener('input', event => inputs.push({ data: event.data, inputType: event.inputType, bubbles: event.bubbles }));
  let submits = 0; doc.querySelector('form').addEventListener('submit', () => submits++);
  composer.element.querySelector('.emoji-toggle').click(); composer.element.querySelector('.emoji-option').click();
  assert.equal(textarea.value, 'Hola 😊'); assert.equal(textarea.selectionStart, 7); assert.equal(textarea.selectionEnd, 7);
  assert.equal(doc.activeElement, textarea); assert.deepEqual(inputs, [{ data: '😊', inputType: 'insertText', bubbles: true }]);
  assert.equal(submits, 0);
});

test('emoji insertion respects maxlength in UTF-16 units and never cuts an emoji in half', t => {
  const { doc, textarea } = environment(t), composer = attachComposer({ doc, textarea }); textarea.before(composer.element);
  textarea.maxLength = 5; textarea.value = '1234'; textarea.setSelectionRange(4, 4);
  let inputs = 0; textarea.addEventListener('input', () => inputs++);
  const choose = () => { composer.element.querySelector('.emoji-toggle').click(); composer.element.querySelector('.emoji-option').click(); };
  choose(); assert.equal(textarea.value, '1234'); assert.equal(inputs, 0);
  assert.match(composer.element.querySelector('[role="status"]').textContent, /no cabe/);
  textarea.setSelectionRange(3, 4); choose();
  assert.equal(textarea.value, '123😊'); assert.equal(textarea.value.length, 5); assert.equal(inputs, 1);
  assert.equal(composer.element.querySelector('[role="status"]').textContent, '');
});

test('read-only and destroyed composers cannot edit or notify and multiple composers have unique picker IDs', t => {
  const { doc, textarea, window } = environment(t), changes = [];
  const composer = attachComposer({ doc, textarea, onStyleChange: style => changes.push(style) }); textarea.before(composer.element);
  const second = attachComposer({ doc, textarea: doc.createElement('textarea') });
  assert.notEqual(composer.element.querySelector('.emoji-picker').id, second.element.querySelector('.emoji-picker').id);
  const toggle = composer.element.querySelector('.emoji-toggle'), color = composer.element.querySelector('[aria-label="Color"]');
  textarea.readOnly = true; toggle.click(); color.value = 'rose'; color.dispatchEvent(new window.Event('change'));
  assert.equal(composer.element.querySelector('.emoji-picker').hidden, true); assert.deepEqual(changes, []);
  assert.equal(color.value, 'default');
  textarea.readOnly = false; composer.setStyle({ font: 'mono', color: 'teal' }); composer.reset();
  assert.deepEqual(composer.getStyle(), DEFAULT_STYLE);
  composer.destroy(); toggle.click(); color.value = 'rose'; color.dispatchEvent(new window.Event('change'));
  assert.equal(composer.element.isConnected, false); assert.deepEqual(changes, []);
  composer.setStyle({ font: 'mono', color: 'rose' }); assert.deepEqual(composer.getStyle(), DEFAULT_STYLE);
  second.destroy();
});

const now = new Date('2026-10-26T12:00:00Z');
const stats = (days, contributions, activeDays) => ({ created_at: new Date(now.getTime() - days * 86400000).toISOString(), topic_count: contributions, reply_count: 0, active_days: activeDays });
test('profile stages require time and contributions and later stages also require distinct active days', () => {
  for (const stage of PROFILE_STAGES) {
    const summary = describeProgress(stats(stage.minDays, stage.minContributions, stage.minActiveDays), now);
    assert.equal(summary.stage.id, stage.id);
    if (stage.minDays) assert.notEqual(describeProgress(stats(stage.minDays - 1, stage.minContributions, stage.minActiveDays), now).stage.id, stage.id);
    if (stage.minContributions) assert.notEqual(describeProgress(stats(stage.minDays, stage.minContributions - 1, stage.minActiveDays), now).stage.id, stage.id);
    if (stage.minActiveDays) assert.notEqual(describeProgress(stats(stage.minDays, stage.minContributions, stage.minActiveDays - 1), now).stage.id, stage.id);
  }
  assert.equal(describeProgress(stats(0, 9999, 999), now).stage.id, 'bienvenida');
  assert.equal(describeProgress(stats(300, 0, 0), now).stage.id, 'bienvenida');
  assert.equal(describeProgress(stats(180, 100, 30), now).nextStage, null);
  assert.equal(describeProgress({ ...stats(7, 1, 0), reply_count: 2 }, now).stage.id, 'vecina');
});

test('badges do not grant roles or withhold active-member features and a helper application needs human review', () => {
  for (const stage of PROFILE_STAGES) {
    assert.deepEqual(stage.privileges, PROFILE_RULES.activePrivileges);
    assert.ok(stage.privileges.every(text => /desde la admisión/.test(text)));
  }
  const before = describeProgress(stats(89, 1000, 40), now), eligible = describeProgress(stats(90, 0, 0), now);
  assert.equal(before.helperEligible, false); assert.equal(eligible.helperEligible, true);
  assert.equal(eligible.helperReviewRequired, true); assert.equal('role' in eligible, false);
  assert.match(PROFILE_RULES.moderatorNotice, /invitación y aceptación/);
  assert.equal(describeProgress({ ...stats(0, 0, 0), stage: 'habitual' }, now).stage.id, 'habitual');
  assert.equal(describeProgress({ created_at: 'invalid', topic_count: -2, reply_count: Infinity, active_days: -1 }, now).stage.id, 'bienvenida');
  assert.equal(describeProgress({ created_at: null }, now).helperEligible, false);
  assert.equal(describeProgress(null, now).days, 0);
});

const jpeg = () => new File([new Uint8Array([255, 216, 255, 224, 0, 0, 0, 0, 0, 0, 0, 0]), 'private original metadata'], 'original.jpg', { type: 'image/jpeg' });
function avatarEnvironment({ fallback = false, failure = false } = {}) {
  const calls = { urls: [], revoked: [], closed: 0, draws: [], encodings: [], removed: 0 };
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: (...args) => calls.draws.push(args) }), toBlob(callback, type, quality) { calls.encodings.push({ type, quality }); callback(failure ? null : new Blob(['encoded raster'], { type })); } };
  const bitmap = { width: 640, height: 480, close() { calls.closed++; } };
  class Image {
    naturalWidth = 200; naturalHeight = 400;
    set src(value) { calls.urls.push(value); queueMicrotask(() => this.onload?.()); }
    removeAttribute(name) { if (name === 'src') calls.removed++; }
  }
  const win = { File, Image, document: { createElement: tag => { assert.equal(tag, 'canvas'); return canvas; } }, URL: { createObjectURL: () => 'blob:local-avatar', revokeObjectURL: url => calls.revoked.push(url) } };
  if (!fallback) win.createImageBitmap = async () => bitmap;
  return { win, canvas, calls, bitmap };
}

test('avatar normalization crops to 256 square, reencodes WebP and releases its decoded source and canvas', async () => {
  const h = avatarEnvironment(), file = await normalizeAvatar(jpeg(), { win: h.win });
  assert.equal(file.name, 'avatar.webp'); assert.equal(file.type, 'image/webp');
  assert.equal(await file.text(), 'encoded raster');
  assert.deepEqual(h.calls.draws[0].slice(1), [80, 0, 480, 480, 0, 0, 256, 256]);
  assert.deepEqual(h.calls.encodings, [{ type: 'image/webp', quality: 0.8 }]);
  assert.equal(h.calls.closed, 1); assert.equal(h.canvas.width, 0); assert.equal(h.canvas.height, 0);
  assert.deepEqual(h.calls.urls, []);
});

test('avatar validation rejects oversized or disguised non-raster inputs before decoding', async () => {
  let decoded = 0; const win = { createImageBitmap: () => { decoded++; throw new Error('Should not decode'); } };
  for (const file of [new File(['<svg/>'], 'avatar.svg', { type: 'image/svg+xml' }), new File(['<svg/>'], 'fake.png', { type: 'image/png' }), new File([new Uint8Array(950001)], 'large.png', { type: 'image/png' })]) {
    await assert.rejects(normalizeAvatar(file, { win }), /Elige una imagen|No se ha podido leer/);
  }
  assert.equal(decoded, 0);
});

test('avatar normalization can explicitly accept an 8 MiB source while retaining the default and output limits', async () => {
  const bytes = new Uint8Array(2_447_776); bytes.set([137,80,78,71,13,10,26,10]);
  const source = new File([bytes], 'phone-photo.png', { type:'image/png' }), h = avatarEnvironment();
  await assert.rejects(normalizeAvatar(source,{win:h.win}),/950 KB/);
  const output = await normalizeAvatar(source,{win:h.win,maxInputBytes:8*1024*1024});
  assert.equal(output.type,'image/webp'); assert.ok(output.size <= 950000);
  await assert.rejects(normalizeAvatar({type:'image/png',size:8*1024*1024+1},{win:h.win,maxInputBytes:8*1024*1024}),/8 MB/);
  h.canvas.toBlob=(done,type)=>done(new Blob([new Uint8Array(950001)],{type}));
  await assert.rejects(normalizeAvatar(jpeg(),{win:h.win,maxInputBytes:8*1024*1024}),/límite de 950 KB/);
});

test('avatar fallback revokes only its local object URL and cleans up after a failed encoding', async () => {
  for (const failure of [false, true]) {
    const h = avatarEnvironment({ fallback: true, failure });
    if (failure) await assert.rejects(normalizeAvatar(jpeg(), { win: h.win }), /No se ha podido preparar/);
    else await normalizeAvatar(jpeg(), { win: h.win });
    assert.deepEqual(h.calls.urls, ['blob:local-avatar']); assert.deepEqual(h.calls.revoked, ['blob:local-avatar']);
    assert.equal(h.calls.removed, 1); assert.equal(h.canvas.width, 0); assert.equal(h.canvas.height, 0);
    assert.deepEqual(h.calls.draws[0].slice(1), [0, 100, 200, 200, 0, 0, 256, 256]);
  }
  await assert.rejects(normalizeAvatar(jpeg(), { win: { createImageBitmap: async () => { throw new Error('decoder failed'); } } }), /No se ha podido leer/);
});
