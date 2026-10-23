import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountCare } from '../care.js';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalCheckinStore } from '../scripts/local-checkin-store.mjs';

const alice = { user: { id: 'alice' }, access_token: 'alice-token', apikey: 'public-fixture' };
const bob = { user: { id: 'bob' }, access_token: 'bob-token', apikey: 'public-fixture' };
const baseTime = Date.parse('2026-10-21T12:00:00.000Z');
const iso = seconds => new Date(baseTime + seconds * 1000).toISOString();
const contact = (id = 'contact-one', alias = 'Compañera Luna') => ({ id, alias, created_at: iso(0) });
const activePlan = (props = {}) => ({ id: 'plan-one', label: 'Vuelta a casa', status: 'active', created_at: iso(0), deadline_at: iso(30), reminder_at: iso(25), confirmed_at: null, cancelled_at: null, recipients: [contact()], ...props });
const snapshot = props => ({ mode: 'simulation', delivered: false, server_now: iso(0), contacts: [contact()], active_plan: null, plans: [], events: [], ...props });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { await new Promise(done => setImmediate(done)); await new Promise(done => setImmediate(done)); };

function harness(t, { handler = async () => undefined, initialSession = alice, initialState = snapshot(), initialNow = baseTime } = {}) {
  const dom = new JSDOM('<!doctype html><main></main>', { url: 'http://127.0.0.1:4341/', pretendToBeVisual: true });
  let session = initialSession, state = initialState, now = initialNow, sequence = 0, timerId = 0;
  const calls = [], intervals = new Map();
  dom.window.setInterval = (fn, ms) => { intervals.set(++timerId, { fn, ms }); return timerId; };
  dom.window.clearInterval = id => intervals.delete(id);
  const controller = mountCare({ getSession: () => session, documentRef: dom.window.document, windowRef: dom.window, now: () => now,
    uuid: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      const result = await handler(path, options);
      if (result !== undefined) return result;
      if (path === '/checkin/v1/state') return json(state);
      throw new Error(`Unexpected ${options.method || 'GET'} ${path}`);
    }
  });
  t.after(() => { controller.destroy(); dom.window.close(); });
  const $ = selector => dom.window.document.querySelector(selector);
  function setSession(next) { session = next; dom.window.dispatchEvent(new dom.window.CustomEvent('sx:session', { detail: next })); }
  function input(selector, value) { const node = $(selector); node.value = value; node.dispatchEvent(new dom.window.Event('input', { bubbles: true })); }
  function submit(selector) { $(selector).dispatchEvent(new dom.window.Event('submit', { cancelable: true, bubbles: true })); }
  function setHidden(hidden) { Object.defineProperty(dom.window.document, 'hidden', { configurable: true, value: hidden }); dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')); }
  function tick(ms) { for (const timer of [...intervals.values()]) if (timer.ms === ms) timer.fn(); }
  return { dom, controller, calls, intervals, $, setSession, input, submit, setHidden, tick, setState: next => { state = next; }, setNow: next => { now = next; } };
}

test('no session makes no requests, starts no timers, and cannot reveal a previous account', async t => {
  const h = harness(t, { initialSession: null });
  assert.equal(h.controller.panel.hidden, true); assert.equal(h.calls.length, 0); assert.equal(h.intervals.size, 0);
  h.setSession(alice); await flush();
  assert.equal(h.controller.panel.hidden, false); assert.equal(h.intervals.size, 2);
  h.setSession(null); await flush();
  assert.equal(h.controller.panel.hidden, true); assert.equal(h.intervals.size, 0);
  assert.doesNotMatch(h.controller.panel.textContent, /Compañera Luna/u);
});

test('simulation is visible before activation; requests use current credentials without cookies or cached state', async t => {
  const h = harness(t); await flush();
  assert.equal(h.$('#care-simulation').textContent, 'Ensayo · avisos simulados');
  assert.match(h.$('.care-local-note').textContent, /No se envía ningún mensaje/u);
  assert.equal(h.$('#care-start').disabled, true);
  const options = h.calls[0].options;
  assert.equal(options.headers.Authorization, 'Bearer alice-token'); assert.equal(options.credentials, 'omit');
  assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.apikey, 'public-fixture');
  assert.equal(h.$('input[type=email],input[type=tel]'), null);
});

test('aliases render as plain text and are never used as HTML', async t => {
  const h = harness(t, { initialState: snapshot({ contacts: [contact('unsafe', '<img src=x onerror=alert(1)>')] }) }); await flush();
  assert.match(h.$('#care-contacts').textContent, /<img src=x/u);
  assert.equal(h.$('#care-contacts img'), null);
  assert.equal(h.$('#care-contact-choices img'), null);
});

test('creating a fictitious contact posts only its alias; successful refresh makes it selectable', async t => {
  let h;
  h = harness(t, { initialState: snapshot({ contacts: [] }), handler: async (path, options) => {
    if (path === '/checkin/v1/contacts') {
      assert.deepEqual(JSON.parse(options.body), { alias: 'Amiga ensayo' });
      h.setState(snapshot({ contacts: [contact('new', 'Amiga ensayo')] }));
      return json({ mode: 'simulation', contact: contact('new', 'Amiga ensayo') }, 201);
    }
  } }); await flush();
  h.input('#care-contact-alias', ' Amiga ensayo '); h.submit('#care-contact-form'); await flush();
  assert.equal(h.$('#care-contact-alias').value, ''); assert.match(h.$('#care-contact-choices').textContent, /Amiga ensayo/u);
  assert.match(h.$('#care-status').textContent, /Alias ficticio añadido/u);
});

test('failed contact and plan submissions preserve drafts; unchanged retry keeps the plan operation ID and refreshed token', async t => {
  let fail = true;
  const h = harness(t, { handler: async (path, options) => {
    if (path === '/checkin/v1/contacts') throw new TypeError('offline');
    if (path === '/checkin/v1/plans') { if (fail) { fail = false; throw new TypeError('offline'); } return json({ plan: activePlan() }, 201); }
  } }); await flush();
  h.input('#care-contact-alias', 'Borrador privado'); h.submit('#care-contact-form'); await flush();
  assert.equal(h.$('#care-contact-alias').value, 'Borrador privado');
  h.$('#care-contact-choices input').click(); h.input('#care-label', 'Mi vuelta'); h.submit('#care-plan-form'); await flush();
  assert.equal(h.$('#care-label').value, 'Mi vuelta'); assert.match(h.$('#care-status').textContent, /selección se conserva/u);
  h.setSession({ ...alice, access_token: 'fresh-token' });
  assert.equal(h.$('#care-contact-choices input').checked, true); assert.equal(h.$('#care-label').value, 'Mi vuelta');
  h.submit('#care-plan-form'); await flush();
  const posts = h.calls.filter(call => call.path === '/checkin/v1/plans'); assert.equal(posts.length, 2);
  assert.deepEqual(JSON.parse(posts[0].options.body), JSON.parse(posts[1].options.body));
  assert.equal(posts[1].options.headers.Authorization, 'Bearer fresh-token');
  assert.deepEqual(Object.keys(JSON.parse(posts[1].options.body)).sort(), ['client_request_id', 'contact_ids', 'duration_seconds', 'label', 'reminder_seconds']);
});

test('changing a failed plan starts a new idempotent operation; selection is limited to three', async t => {
  const h = harness(t, { initialState: snapshot({ contacts: [contact('one'), contact('two'), contact('three'), contact('four')] }), handler: async (path) => path === '/checkin/v1/plans' ? json({}, 409) : undefined });
  await flush();
  const choices = [...h.dom.window.document.querySelectorAll('#care-contact-choices input')];
  for (const choice of choices) choice.click();
  assert.equal(choices[3].checked, false); assert.match(h.$('#care-status').textContent, /hasta tres/u);
  h.submit('#care-plan-form'); await flush();
  h.input('#care-label', 'Otro recorrido'); h.submit('#care-plan-form'); await flush();
  const posts = h.calls.filter(call => call.path === '/checkin/v1/plans').map(call => JSON.parse(call.options.body));
  assert.equal(posts.length, 2); assert.notEqual(posts[0].client_request_id, posts[1].client_request_id); assert.equal(posts[1].contact_ids.length, 3);
});

test('server time calibrates the visual countdown; reaching zero alone never creates an alert or an overdue state', async t => {
  const plan = activePlan();
  const h = harness(t, { initialNow: baseTime + 900000, initialState: snapshot({ active_plan: plan, plans: [plan] }) }); await flush();
  assert.equal(h.$('#care-countdown').textContent, '00:30');
  h.setNow(baseTime + 931000); h.tick(1000);
  assert.equal(h.$('#care-countdown').textContent, 'Actualizando estado…');
  assert.equal(h.$('#care-current').dataset.state, 'active'); assert.equal(h.$('#care-events').children.length, 0);
  assert.equal(h.calls.length, 1); assert.equal(h.$('#care-plan-form').hidden, true);
});

test('confirm and cancel use server plan IDs with empty bodies; simulation badge remains visible in terminal states', async t => {
  let h;
  const plan = activePlan();
  h = harness(t, { initialState: snapshot({ active_plan: plan, plans: [plan] }), handler: async (path, options) => {
    if (path === '/checkin/v1/plans/plan-one/confirm') {
      assert.deepEqual(JSON.parse(options.body), {});
      h.setState(snapshot({ plans: [activePlan({ status: 'confirmed', confirmed_at: iso(10) })] })); return json({ plan });
    }
    if (path === '/checkin/v1/plans/plan-one/cancel') {
      assert.deepEqual(JSON.parse(options.body), {});
      h.setState(snapshot({ plans: [activePlan({ status: 'cancelled', cancelled_at: iso(10) })] })); return json({ plan });
    }
  } }); await flush();
  h.$('#care-confirm').click(); assert.equal(h.$('#care-confirm').disabled, true); await flush();
  assert.equal(h.$('#care-current').dataset.state, 'confirmed'); assert.equal(h.$('.care-actions').hidden, true);
  assert.match(h.$('#care-state-message').textContent, /Llegada confirmada/u); assert.equal(h.$('#care-simulation').hidden, false);
  h.setState(snapshot({ active_plan: plan, plans: [plan] })); await h.controller.refresh();
  h.$('#care-cancel').click(); await flush(); assert.equal(h.$('#care-current').dataset.state, 'cancelled');
});

test('an overdue plan and its simulated activity are visible without claiming delivery or allowing late confirmation', async t => {
  const plan = activePlan({ status: 'overdue' });
  const h = harness(t, { initialState: snapshot({ plans: [plan], events: [{ id: 'event-one', kind: 'simulated_alert', created_at: iso(31), contact_alias: 'Compañera Luna', delivered: false }] }) }); await flush();
  assert.equal(h.$('#care-current').dataset.state, 'overdue'); assert.equal(h.$('.care-actions').hidden, true);
  assert.match(h.$('#care-state-message').textContent, /nadie los ha recibido/u);
  assert.match(h.$('#care-events').textContent, /no enviado/u); assert.match(h.$('#care-events').textContent, /Compañera Luna/u);
  const before = h.calls.length; h.$('#care-confirm').click(); await flush(); assert.equal(h.calls.length, before);
});

test('contact removal requires inline confirmation and retains already selected plan recipients from its snapshot', async t => {
  const plan = activePlan(); let h;
  h = harness(t, { initialState: snapshot({ active_plan: plan, plans: [plan] }), handler: async (path, options) => {
    if (path === '/checkin/v1/contacts/contact-one' && options.method === 'DELETE') { h.setState(snapshot({ contacts: [], active_plan: plan, plans: [plan] })); return new Response(null, { status: 204 }); }
  } }); await flush();
  h.$('#care-contacts button').click(); assert.equal(h.calls.length, 1);
  assert.match(h.$('.care-delete-confirm').textContent, /conserva los destinatarios/u);
  h.$('[data-care-delete]').click(); await flush();
  assert.equal(h.$('#care-contacts').children.length, 0); assert.match(h.$('#care-recipients').textContent, /Compañera Luna/u);
});

test('account changes abort pending reads and discard their late response, selections, alias drafts and old contact controls', async t => {
  const late = deferred(); let delay = false;
  const h = harness(t, { handler: async path => path === '/checkin/v1/state' && delay ? late.promise : undefined }); await flush();
  const oldRemove = h.$('#care-contacts button');
  h.$('#care-contact-choices input').click(); h.input('#care-contact-alias', 'ALICE PRIVATE DRAFT'); h.input('#care-label', 'ALICE PRIVATE LABEL');
  delay = true; const loading = h.controller.refresh(); const call = h.calls.at(-1);
  h.setState(snapshot({ contacts: [contact('bob-contact', 'Alias B')] })); delay = false; h.setSession(bob); await flush();
  assert.equal(call.options.signal.aborted, true); assert.equal(h.$('#care-contact-alias').value, ''); assert.equal(h.$('#care-label').value, '');
  const before = h.calls.length; oldRemove.click(); assert.equal(h.calls.length, before); assert.equal(h.$('.care-delete-confirm'), null);
  late.resolve(json(snapshot({ contacts: [contact('late', 'ALICE PRIVATE RESPONSE')] }))); await loading;
  assert.doesNotMatch(h.controller.panel.textContent, /ALICE PRIVATE/u); assert.match(h.$('#care-contacts').textContent, /Alias B/u);
  assert.equal(h.$('#care-contact-choices input').checked, false);
});

test('hidden documents stop polling and abort reads; becoming visible refreshes from server rather than issuing local alerts', async t => {
  const late = deferred(); let delaying = false;
  const h = harness(t, { handler: async path => path === '/checkin/v1/state' && delaying ? late.promise : undefined }); await flush();
  delaying = true; h.tick(2000); const call = h.calls.at(-1);
  h.setHidden(true); assert.equal(h.intervals.size, 0); assert.equal(call.options.signal.aborted, true);
  delaying = false; h.setHidden(false); await flush(); assert.equal(h.intervals.size, 2);
  const calls = h.calls.length; late.resolve(json(snapshot({ contacts: [contact('late', 'STALE HIDDEN RESULT')] }))); await flush();
  assert.doesNotMatch(h.controller.panel.textContent, /STALE HIDDEN RESULT/u); assert.equal(h.calls.length, calls);
  assert.equal(h.calls.some(item => item.options.method === 'POST'), false);
});

test('unknown service mode is not silently presented as simulated', async t => {
  const h = harness(t, { initialState: snapshot({ mode: 'real-delivery' }) }); await flush();
  assert.equal(h.$('.care-content').hidden, true); assert.match(h.$('#care-status').textContent, /No podemos actualizar/u);
  assert.equal(h.$('#care-contacts').children.length, 0);
});

test('polling does not duplicate a live reminder announcement on every refresh', async t => {
  const plan = activePlan(); const h = harness(t, { initialState: snapshot({ active_plan: plan, plans: [plan] }) }); await flush();
  h.setState(snapshot({ server_now: iso(25), active_plan: plan, plans: [plan], events: [{ id: 'reminder-one', kind: 'reminder', created_at: iso(25) }] }));
  h.tick(2000); await flush(); assert.match(h.$('#care-status').textContent, /se acerca la hora/u);
  const status = h.$('#care-status'); status.textContent = 'Mantener mi mensaje';
  h.tick(2000); await flush(); assert.equal(status.textContent, 'Mantener mi mensaje');
});

test('resuming after multiple missed events announces the latest alert rather than an older reminder', async t => {
  const plan = activePlan(); const h = harness(t, { initialState: snapshot({ active_plan: plan, plans: [plan] }) }); await flush();
  h.setState(snapshot({ server_now: iso(31), plans: [activePlan({ status: 'overdue' })], events: [
    { id: 'alert-one', kind: 'simulated_alert', created_at: iso(30), contact_alias: 'Compañera Luna', delivered: false },
    { id: 'reminder-one', kind: 'reminder', created_at: iso(25) }
  ] }));
  h.tick(2000); await flush(); assert.match(h.$('#care-status').textContent, /Plazo vencido/u); assert.doesNotMatch(h.$('#care-status').textContent, /se acerca/u);
});

test('a saved operation whose state refresh fails retains an explicit view-update error', async t => {
  let saved = false;
  const h = harness(t, { handler: async (path, options) => {
    if (path === '/checkin/v1/contacts' && options.method === 'POST') { saved = true; return json({ contact: contact('new') }, 201); }
    if (saved && path === '/checkin/v1/state') throw new TypeError('offline after save');
  } }); await flush();
  h.input('#care-contact-alias', 'Alias nuevo'); h.submit('#care-contact-form'); await flush();
  assert.match(h.$('#care-status').textContent, /Alias ficticio añadido/u);
  assert.match(h.$('#care-status').textContent, /No podemos actualizar la vista/u); assert.equal(h.$('#care-status').classList.contains('care-error'), true);
});

test('a scheduler failure blocks new test activation and explains its state without hiding active confirm/cancel controls', async t => {
  const h = harness(t, { initialState: snapshot({ scheduler_ok: false }) }); await flush();
  h.$('#care-contact-choices input').click(); assert.equal(h.$('#care-start').disabled, true);
  assert.match(h.$('#care-status').textContent, /planificador local necesita revisión/u);
  const before = h.calls.length; h.submit('#care-plan-form'); await flush(); assert.equal(h.calls.length, before);
  const plan = activePlan(); h.setState(snapshot({ scheduler_ok: false, active_plan: plan, plans: [plan] })); await h.controller.refresh();
  assert.equal(h.$('#care-confirm').disabled, false); assert.equal(h.$('#care-cancel').disabled, false);
});

test('the real local API accepts the default UI flow and keeps the resulting plan out of a second account', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sx-care-ui-'));
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
  const store = await createLocalCheckinStore({ directory, clock: () => baseTime, getOwner: request => ({ 'Bearer alice-token': 'alice@example.invalid', 'Bearer bob-token': 'bob@example.invalid' })[request.headers.authorization] });
  const server = createServer(async (request, response) => {
    try { await store.handle(request, response, new URL(request.url, 'http://127.0.0.1')); }
    catch (error) { response.statusCode = error.status || 500; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(done => { server.close(done); server.closeAllConnections(); }); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const h = harness(t, { handler: (endpoint, options) => fetch(origin + endpoint, options) });
  async function until(predicate) { for (let attempt = 0; attempt < 50; attempt++) { if (predicate()) return; await new Promise(done => setTimeout(done, 10)); } assert.fail('local API UI did not settle'); }
  await until(() => !h.$('.care-content').hidden);
  h.input('#care-contact-alias', 'Luna ficticia'); h.submit('#care-contact-form');
  await until(() => Boolean(h.$('#care-contact-choices input')));
  h.$('#care-contact-choices input').click(); h.input('#care-duration', '15');
  assert.equal(h.$('#care-label').value, '', 'advanced label really remains optional');
  h.submit('#care-plan-form');
  await until(() => h.$('#care-current').dataset.state === 'active');
  assert.match(h.$('#care-recipients').textContent, /Luna ficticia/u);
  assert.equal(h.$('#care-current-title').textContent, 'Mi check-in de prueba');
  await until(() => !h.$('#care-confirm').disabled); h.$('#care-confirm').click();
  await until(() => h.$('#care-current').dataset.state === 'confirmed');
  h.setSession(bob); await until(() => !h.$('.care-content').hidden);
  assert.equal(h.$('#care-current').hidden, true); assert.equal(h.$('#care-contacts').children.length, 0);
  assert.doesNotMatch(h.controller.panel.textContent, /Luna ficticia/u);
});

test('quiet polling preserves contact checkbox and action nodes together with keyboard focus', async t => {
  const h = harness(t); await flush();
  const checkbox = h.$('#care-contact-choices input'), remove = h.$('#care-contacts button');
  checkbox.focus(); checkbox.click(); h.tick(2000); await flush();
  assert.equal(h.$('#care-contact-choices input'), checkbox); assert.equal(checkbox.checked, true); assert.equal(h.dom.window.document.activeElement, checkbox);
  remove.focus(); h.tick(2000); await flush();
  assert.equal(h.$('#care-contacts button'), remove); assert.equal(h.dom.window.document.activeElement, remove);
});

test('polling coalesces slow reads without starving their results and schedules at most one follow-up read', async t => {
  const first = deferred(), second = deferred(); let reads = 0;
  const h = harness(t, { handler: async endpoint => {
    if (endpoint !== '/checkin/v1/state') return undefined;
    reads++; if (reads === 1) return first.promise; if (reads === 2) return second.promise;
  } });
  h.tick(2000); h.tick(2000); h.tick(2000); assert.equal(reads, 1, 'only one HTTP read may be in flight');
  first.resolve(json(snapshot({ contacts: [contact('slow-one', 'First slow response')] }))); await flush();
  assert.match(h.$('#care-contacts').textContent, /First slow response/u); assert.equal(reads, 2, 'overlapping polls collapse into one follow-up');
  second.resolve(json(snapshot({ contacts: [contact('slow-two', 'Second response')] }))); await flush();
  assert.equal(reads, 2); assert.match(h.$('#care-contacts').textContent, /Second response/u);
});
