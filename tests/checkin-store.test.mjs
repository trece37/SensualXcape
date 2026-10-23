import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLocalCheckinStore, CHECKIN_LIMITS } from '../scripts/local-checkin-store.mjs';

const PREFIX = '/checkin/v1';
async function fixture(t, { directory: existingDirectory, clock: existingClock } = {}) {
  const directory = existingDirectory || await mkdtemp(path.join(tmpdir(), 'sx-checkin-'));
  let time = Date.UTC(2026, 9, 21, 12), closed = false;
  const clock = existingClock || (() => time);
  const sessions = new Map([['a', 'a@example.invalid'], ['b', 'b@example.invalid'], ['c', 'c@example.invalid']]);
  const store = await createLocalCheckinStore({ directory, clock, getOwner: req => sessions.get(req.headers['x-fixture-session']) });
  const server = createServer(async (req, res) => {
    try { await store.handle(req, res, new URL(req.url, 'http://127.0.0.1')); }
    catch (error) { res.statusCode = error.status || 500; res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ code: error.code, message: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const close = async () => { if (closed) return; closed = true;
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await store.close(); };
  t.after(async () => { await close(); if (!existingDirectory) await rm(directory, { recursive: true, force: true }); });
  async function api(actor, route, method = 'GET', body) {
    const res = await fetch(origin + PREFIX + route, { method, headers: {
      ...(actor ? { 'x-fixture-session': actor } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json(), headers: res.headers };
  }
  async function contact(actor = 'a', alias = 'Amiga de prueba') {
    const result = await api(actor, '/contacts', 'POST', { alias });
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.contact;
  }
  async function plan(actor = 'a', overrides = {}) {
    const recipient = overrides.contact_ids ? null : await contact(actor);
    const result = await api(actor, '/plans', 'POST', { label: 'Volver a confirmar', duration_seconds: 30,
      reminder_seconds: 10, contact_ids: [recipient?.id], client_request_id: randomUUID(), ...overrides });
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.plan;
  }
  return { directory, store, sessions, origin, api, contact, plan, close, clock, advance: ms => { time += ms; } };
}

test('check-in requires validated sessions and keeps A, B and external C independently private', async t => {
  const app = await fixture(t), a = await app.contact('a', 'Amiga A'), b = await app.contact('b', 'Amiga B'), c = await app.contact('c', 'Amiga C');
  assert.equal((await app.api(null, '/state')).status, 401);
  assert.equal((await app.api(null, '/unknown')).status, 401);
  for (const [actor, expected] of [['a', a], ['b', b], ['c', c]]) {
    const state = await app.api(actor, '/state');
    assert.equal(state.status, 200); assert.equal(state.headers.get('cache-control'), 'no-store');
    assert.deepEqual(state.body.contacts.map(item => item.id), [expected.id]);
    assert.equal(state.body.mode, 'simulation'); assert.equal(state.body.delivered, false);
    assert.doesNotMatch(JSON.stringify(state.body), /@example|owner|email/);
  }
  assert.equal((await app.api('b', `/contacts/${a.id}`, 'DELETE')).status, 404);
  assert.equal((await app.api('c', '/plans', 'POST', { label: 'Cruzar cuentas', duration_seconds: 30,
    reminder_seconds: 10, contact_ids: [a.id], client_request_id: randomUUID() })).status, 404);
  assert.equal((await app.api('a', '/contacts', 'POST', { alias: 'Prueba', owner: 'b@example.invalid' })).status, 400);
});

test('reminder precedes deadline; per-recipient alerts are simulated once and never claim delivery', async t => {
  const app = await fixture(t), one = await app.contact(), two = await app.contact('a', 'Otra amiga');
  const plan = await app.plan('a', { contact_ids: [one.id, two.id] });
  app.advance(19999); app.store.processDue();
  let state = (await app.api('a', '/state')).body;
  assert.deepEqual(state.events.map(item => item.kind), ['created']);
  app.advance(1); app.store.processDue(); app.store.processDue();
  state = (await app.api('a', '/state')).body;
  assert.equal(state.events.filter(item => item.kind === 'reminder').length, 1);
  assert.equal(state.active_plan.id, plan.id);
  app.advance(10000); app.store.processDue(); app.store.processDue();
  state = (await app.api('a', '/state')).body;
  assert.equal(state.active_plan, null); assert.equal(state.plans[0].status, 'overdue');
  const alerts = state.events.filter(item => item.kind === 'simulated_alert');
  assert.equal(alerts.length, 2);
  assert.deepEqual(alerts.map(item => item.contact_alias).sort(), ['Amiga de prueba', 'Otra amiga']);
  assert.ok(alerts.every(item => item.mode === 'simulation' && item.delivered === false));
  assert.ok(alerts.every(item => item.scheduled_at === plan.deadline_at));
  assert.ok(alerts.every(item => /No se ha enviado a nadie/.test(item.message)));
  assert.equal((await app.api('b', '/state')).body.events.length, 0);
});

test('confirmation and cancellation stop all future events; repeated actions are idempotent', async t => {
  const app = await fixture(t), recipient = await app.contact();
  const confirmed = await app.plan('a', { contact_ids: [recipient.id] });
  const confirmations = await Promise.all([app.api('a', `/plans/${confirmed.id}/confirm`, 'POST', {}), app.api('a', `/plans/${confirmed.id}/confirm`, 'POST', {})]);
  assert.deepEqual(confirmations.map(item => item.status), [200, 200]);
  assert.equal((await app.api('a', `/plans/${confirmed.id}/cancel`, 'POST', {})).status, 409);
  const cancelled = await app.plan('a', { contact_ids: [recipient.id] });
  assert.equal((await app.api('a', `/plans/${cancelled.id}/cancel`, 'POST', {})).status, 200);
  assert.equal((await app.api('a', `/plans/${cancelled.id}/cancel`, 'POST', {})).status, 200);
  app.advance(100000); app.store.processDue();
  const state = (await app.api('a', '/state')).body;
  assert.equal(state.events.filter(item => ['reminder', 'simulated_alert'].includes(item.kind)).length, 0);
  assert.equal(state.events.filter(item => item.kind === 'confirmed').length, 1);
  assert.equal(state.events.filter(item => item.kind === 'cancelled').length, 1);
  assert.ok(state.plans.find(item => item.id === confirmed.id).confirmed_at);
  assert.ok(state.plans.find(item => item.id === cancelled.id).cancelled_at);
});

test('confirm/cancel at or after deadline cannot erase an already generated simulated alert', async t => {
  const app = await fixture(t), plan = await app.plan();
  app.advance(30000);
  const attempts = await Promise.all([app.api('a', `/plans/${plan.id}/confirm`, 'POST', {}), app.api('a', `/plans/${plan.id}/cancel`, 'POST', {})]);
  assert.deepEqual(attempts.map(item => item.status), [409, 409]);
  const state = (await app.api('a', '/state')).body;
  assert.equal(state.plans[0].status, 'overdue');
  assert.equal(state.events.filter(item => item.kind === 'simulated_alert').length, 1);
  assert.equal((await app.api('b', `/plans/${plan.id}/confirm`, 'POST', {})).status, 404);
  assert.equal((await app.api('c', `/plans/${plan.id}/cancel`, 'POST', {})).status, 404);
});

test('a deadline crossed between the sweep and confirmation commits expiry instead of confirming late', async t => {
  const start = Date.UTC(2026, 9, 21, 12); let armed = false, reads = 0;
  const app = await fixture(t, { clock: () => !armed ? start : start + 30000 - (++reads === 1 ? 1 : 0) });
  const plan = await app.plan(); armed = true;
  const result = await app.api('a', `/plans/${plan.id}/confirm`, 'POST', {});
  assert.equal(result.status, 409);
  const state = (await app.api('a', '/state')).body;
  assert.equal(state.plans[0].status, 'overdue');
  assert.equal(state.events.filter(item => item.kind === 'simulated_alert').length, 1);
  assert.equal(state.events.filter(item => item.kind === 'confirmed').length, 0);
});

test('concurrent retries produce one durable plan and reject altered payloads or a second active plan', async t => {
  const app = await fixture(t), recipient = await app.contact();
  const body = { label: 'Único plan', duration_seconds: 30, reminder_seconds: 10,
    contact_ids: [recipient.id], client_request_id: randomUUID() };
  const responses = await Promise.all([app.api('a', '/plans', 'POST', body), app.api('a', '/plans', 'POST', body)]);
  assert.deepEqual(responses.map(item => item.status).sort(), [200, 201]);
  assert.equal(responses[0].body.plan.id, responses[1].body.plan.id);
  assert.equal((await app.api('a', '/plans', 'POST', { ...body, label: 'Cambio' })).status, 409);
  assert.equal((await app.api('a', '/plans', 'POST', { ...body, client_request_id: randomUUID() })).status, 409);
  const id = responses[0].body.plan.id;
  const race = await Promise.all([app.api('a', `/plans/${id}/confirm`, 'POST', {}), app.api('a', `/plans/${id}/cancel`, 'POST', {})]);
  assert.deepEqual(race.map(item => item.status).sort(), [200, 409]);
  assert.equal((await app.api('a', '/state')).body.plans.length, 1);
});

test('recipient snapshots survive contact deletion, while later plans cannot use deleted contacts', async t => {
  const app = await fixture(t), recipient = await app.contact('a', 'Alias original');
  const plan = await app.plan('a', { contact_ids: [recipient.id] });
  assert.equal((await app.api('a', `/contacts/${recipient.id}`, 'DELETE')).status, 200);
  app.advance(30001); app.store.processDue();
  const state = (await app.api('a', '/state')).body;
  assert.equal(state.contacts.length, 0); assert.equal(state.plans[0].recipients[0].alias, 'Alias original');
  assert.equal(state.events.find(item => item.kind === 'simulated_alert').contact_alias, 'Alias original');
  assert.equal((await app.api('a', '/plans', 'POST', { label: 'Otro plan', duration_seconds: 30, reminder_seconds: 10,
    contact_ids: [recipient.id], client_request_id: randomUUID() })).status, 404);
  assert.equal(state.plans[0].id, plan.id);
});

test('SQLite restart reconciles missed deadlines once and preserves idempotency and account isolation', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sx-checkin-restart-'));
  let time = Date.UTC(2026, 9, 21, 12);
  const app = await fixture(t, { directory, clock: () => time });
  const recipient = await app.contact();
  const body = { label: 'Sobrevive cierre', duration_seconds: 30, reminder_seconds: 10,
    contact_ids: [recipient.id], client_request_id: randomUUID() };
  const first = await app.api('a', '/plans', 'POST', body);
  await app.close(); time += 90000;
  const reopened = await fixture(t, { directory, clock: () => time });
  const state = (await reopened.api('a', '/state')).body;
  assert.equal(state.plans[0].id, first.body.plan.id); assert.equal(state.plans[0].status, 'overdue');
  assert.equal(state.events.filter(item => item.kind === 'simulated_alert').length, 1);
  const alert = state.events.find(item => item.kind === 'simulated_alert');
  assert.notEqual(alert.created_at, alert.scheduled_at); assert.equal(alert.delivered, false);
  assert.equal(state.events.filter(item => item.kind === 'reminder').length, 0);
  const retry = await reopened.api('a', '/plans', 'POST', body);
  assert.equal(retry.status, 200); assert.equal(retry.body.plan.id, first.body.plan.id);
  assert.equal((await reopened.api('b', '/state')).body.plans.length, 0);
  assert.equal((await reopened.api('c', '/state')).body.contacts.length, 0);
  reopened.store.processDue(); assert.equal((await reopened.api('a', '/state')).body.events.length, 2);
  const file = await readFile(path.join(directory, 'checkin.sqlite'));
  assert.ok(file.length > 0);
  await reopened.close();
  await rm(directory, { recursive: true, force: true });
});

test('strict parameters bound duration, recipients, queries, JSON and fictitious contact metadata', async t => {
  const app = await fixture(t), recipient = await app.contact();
  const body = { label: 'Plan', duration_seconds: 30, reminder_seconds: 10, contact_ids: [recipient.id], client_request_id: randomUUID() };
  for (const change of [{ duration_seconds: 14 }, { duration_seconds: 86401 }, { duration_seconds: 20.5 }, { reminder_seconds: 0 },
    { reminder_seconds: 30 }, { reminder_seconds: '10' }, { label: '' }, { label: 'x'.repeat(121) }, { label: 'control\0' },
    { contact_ids: [] }, { contact_ids: [recipient.id, recipient.id] }, { contact_ids: ['not-id'] }, { contact_ids: new Array(4).fill(recipient.id) },
    { client_request_id: 'bad' }, { delivered: true }]) {
    assert.equal((await app.api('a', '/plans', 'POST', { ...body, ...change })).status, 400, JSON.stringify(change));
  }
  for (const alias of ['real@example.com', '+34 600 000 000', 'https://example.com', '', 'x'.repeat(61), 'a\ncontrol']) {
    assert.equal((await app.api('a', '/contacts', 'POST', { alias })).status, 400, alias);
  }
  assert.equal((await app.api('a', '/state?owner=b')).status, 400);
  assert.equal((await app.api('a', '/contacts/not-id', 'DELETE')).status, 400);
  assert.equal((await app.api('a', '/unknown')).status, 404);
  assert.equal((await app.api('a', '/contacts', 'POST', { alias: 'x'.repeat(9000) })).status, 413);
  const wrongType = await fetch(app.origin + PREFIX + '/contacts', { method: 'POST', headers: { 'x-fixture-session': 'a', 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(wrongType.status, 415);
  const malformed = await fetch(app.origin + PREFIX + '/contacts', { method: 'POST', headers: { 'x-fixture-session': 'a', 'content-type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
});

test('contact and per-minute limits prevent unbounded local writes', async t => {
  const app = await fixture(t);
  for (let i = 0; i < CHECKIN_LIMITS.contacts; i++) await app.contact('a', `Amiga ${i}`);
  assert.equal((await app.api('a', '/contacts', 'POST', { alias: 'Una más' })).status, 409);
  const recipient = (await app.api('a', '/state')).body.contacts[0];
  for (let i = 0; i < 5; i++) {
    const plan = await app.plan('a', { contact_ids: [recipient.id] });
    assert.equal((await app.api('a', `/plans/${plan.id}/cancel`, 'POST', {})).status, 200);
  }
  assert.equal((await app.api('a', `/contacts/${recipient.id}`, 'DELETE')).status, 429);
  app.advance(60001);
  assert.equal((await app.api('a', `/contacts/${recipient.id}`, 'DELETE')).status, 200);
});

test('revocation or changed identity during a slow request body prevents writes', async t => {
  const app = await fixture(t);
  const slow = (body, replacement) => new Promise((resolve, reject) => {
    const json = JSON.stringify(body), req = httpRequest(app.origin + PREFIX + '/contacts', { method: 'POST', headers: {
      'x-fixture-session': 'a', 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) } }, res => {
      let content = ''; res.on('data', value => content += value); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(content) }));
    });
    req.on('error', reject); req.write(json.slice(0, 5));
    setTimeout(() => { if (replacement) app.sessions.set('a', replacement); else app.sessions.delete('a'); req.end(json.slice(5)); }, 30);
  });
  assert.equal((await slow({ alias: 'No debe quedar' })).status, 401);
  app.sessions.set('a', 'a@example.invalid');
  assert.equal((await app.api('a', '/state')).body.contacts.length, 0);
  assert.equal((await slow({ alias: 'Tampoco debe quedar' }, 'b@example.invalid')).status, 401);
  app.sessions.set('a', 'a@example.invalid');
  assert.equal((await app.api('a', '/state')).body.contacts.length, 0);
  assert.equal((await app.api('b', '/state')).body.contacts.length, 0);
});

test('oversize chunked JSON returns 413 without buffering the rest or resetting the response', async t => {
  const app = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(app.origin + PREFIX + '/contacts', { method: 'POST', headers: {
      'x-fixture-session': 'a', 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.write('{"alias":"'); req.end('x'.repeat(20000) + '"}');
  });
  assert.equal(status, 413);
  assert.equal((await app.api('a', '/state')).body.contacts.length, 0);
});

test('scheduler reconciles while no browser requests exist and close stops access', async t => {
  const app = await fixture(t); await app.plan(); app.advance(30001);
  // Poll the internal reconciliation result without issuing an HTTP request; the
  // real Croner tick must have consumed the deadline first (under 1.5 seconds).
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.deepEqual(app.store.processDue(), { overdue: 0, reminders: 0 });
  assert.equal((await app.api('a', '/state')).body.plans[0].status, 'overdue');
  await app.close(); assert.throws(() => app.store.processDue(), error => error.status === 503);
});

test('private data directory cannot be served from public', async () => {
  const directory = path.resolve('public');
  await assert.rejects(() => createLocalCheckinStore({ directory, getOwner: () => 'a@example.invalid' }), /public/);
});
