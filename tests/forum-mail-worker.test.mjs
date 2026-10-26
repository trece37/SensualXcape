import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReplyNotification, createResendProvider, handleNotificationRequest, FORUM_URL } from '../supabase/functions/fc-deliver-notifications/worker.mjs';

const clock = Date.parse('2026-10-26T12:00:00Z');
const id = '00000000-0000-4000-8000-000000000001', topic = '00000000-0000-4000-8000-000000000002', lease = '00000000-0000-4000-8000-000000000003';
const job = { id, topic_id: topic, lease_token: lease, attempts: 1, created_at: new Date(clock - 120000).toISOString(), first_attempt_at: new Date(clock - 60000).toISOString(), last_attempt_at: new Date(clock).toISOString() };
const destination = { allowed: true, email: 'member@example.invalid', topic_id: topic, deep_url: `${FORUM_URL}?topic=${topic}`, idempotency_key: id };
const env = { SUPABASE_URL: 'https://database.example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'local-test-server-key', RESEND_API_KEY: 'local-test-provider-key', FORUM_MAIL_FROM: 'Comunidad <notice@example.invalid>', FORUM_MAIL_WORKER_SECRET: 'local-test-worker-secret' };
const request = (secret = env.FORUM_MAIL_WORKER_SECRET, method = 'POST') => new Request('https://function.example.invalid/', { method, headers: { 'x-foro-worker-secret': secret }, ...(method === 'POST' ? { body: '{"email":"attacker@example.invalid","body":"PRIVATE USER TEXT"}' } : {}) });

function fixture({ jobs = [job], target = destination, provider, ackError = false, rpcError = null } = {}) {
  const calls = [], sends = [];
  const client = { async rpc(name, args) {
    calls.push({ name, args });
    if (rpcError === name) return { data: null, error: { message: 'PRIVATE DATABASE ERROR member@example.invalid' } };
    if (name === 'fc_claim_delivery') return { data: structuredClone(jobs), error: null };
    if (name === 'fc_revalidate_delivery') return { data: typeof target === 'function' ? target(args) : target, error: null };
    if (name === 'fc_ack_delivery') return ackError ? { data: null, error: { message: 'PRIVATE ACK ERROR' } } : { data: { ok: true, state: args.p_outcome }, error: null };
    throw new Error('Unexpected RPC');
  } };
  const fetchImpl = async (url, options) => {
    sends.push({ url, options, message: JSON.parse(options.body) });
    return provider ? provider(url, options) : Response.json({ id: 'provider-test-id' });
  };
  return { calls, sends, client, fetchImpl, run: (options = {}) => handleNotificationRequest(request(), { env, client, fetchImpl, now: () => clock, ...options }), acks: () => calls.filter(call => call.name === 'fc_ack_delivery').map(call => call.args) };
}

test('mail worker stays disabled without every server setting and never claims or sends', async () => {
  for (const setting of Object.keys(env)) {
    const h = fixture(), config = { ...env }; delete config[setting];
    const result = await h.run({ env: config });
    assert.equal(result.status, 503); assert.deepEqual(await result.json(), { disabled: 1 });
    assert.deepEqual(h.calls, []); assert.deepEqual(h.sends, []);
  }
});

test('only POST with the exact independent worker secret can reach the server client', async () => {
  for (const secret of ['', 'local-test-worker-secret-extra', 'LOCAL-TEST-WORKER-SECRET', 'different']) {
    const h = fixture(); const result = await handleNotificationRequest(request(secret), { env, client: h.client, fetchImpl: h.fetchImpl });
    assert.equal(result.status, 401); assert.deepEqual(await result.json(), { unauthorized: 1 }); assert.deepEqual(h.calls, []);
  }
  const h = fixture(); const result = await handleNotificationRequest(request(env.FORUM_MAIL_WORKER_SECRET, 'GET'), { env, client: h.client });
  assert.equal(result.status, 405); assert.equal(result.headers.get('allow'), 'POST'); assert.deepEqual(h.calls, []);
});

test('a claimed job is revalidated with its lease immediately before the provider and acknowledged only as accepted', async () => {
  const h = fixture(), result = await h.run(), summary = await result.json();
  assert.equal(result.status, 200); assert.equal(summary.accepted, 1); assert.equal('delivered' in summary, false);
  assert.deepEqual(h.calls[0], { name: 'fc_claim_delivery', args: { p_limit: 20, p_lease_seconds: 120 } });
  assert.deepEqual(h.calls[1], { name: 'fc_revalidate_delivery', args: { p_id: id, p_lease_token: lease } });
  assert.deepEqual(h.acks(), [{ p_id: id, p_lease_token: lease, p_outcome: 'accepted', p_provider_id: 'provider-test-id', p_error_code: null, p_retry_at: null }]);
  assert.equal(h.sends[0].url, 'https://api.resend.com/emails'); assert.equal(h.sends[0].options.redirect, 'error');
  assert.equal(h.sends[0].options.headers['Idempotency-Key'], id);
  assert.deepEqual(h.sends[0].message.to, ['member@example.invalid']);
  assert.ok(Object.values(summary).every(value => Number.isInteger(value)));
  assert.doesNotMatch(JSON.stringify(summary), /email|PRIVATE|secret|provider-test-id/);
});

test('mail templates contain a fixed neutral notice and canonical conversation link, without private content or remote images', () => {
  const message = buildReplyNotification({ from: env.FORUM_MAIL_FROM, email: destination.email, topicId: topic, title: 'PRIVATE TITLE', body: 'PRIVATE BODY', author: 'PRIVATE AUTHOR' });
  assert.equal(message.subject, 'Tienes una nueva respuesta'); assert.match(message.text, /Mi perfil/);
  assert.match(message.html, new RegExp(`${FORUM_URL.replaceAll('.', '\\.')}\\?topic=${topic}`));
  assert.match(message.html, />Abrir conversación<\/a>/);
  assert.doesNotMatch(JSON.stringify(message), /PRIVATE|<img|<script|<iframe|token=|supabase\.co/);
  assert.throws(() => buildReplyNotification({ from: env.FORUM_MAIL_FROM, email: 'bad\r\nbcc: another@example.invalid', topicId: topic }), /invalid_target/);
});

test('invalid, no longer visible or no longer followed targets are discarded without contacting the provider', async () => {
  for (const target of [{ allowed: false }, { ...destination, email: '' }, { ...destination, topic_id: null }, { ...destination, deep_url: 'https://attacker.example.invalid/' }, { ...destination, idempotency_key: 'bad\nheader' }]) {
    const h = fixture({ target }), result = await h.run();
    assert.equal((await result.json()).discarded, 1); assert.equal(h.sends.length, 0); assert.equal(h.acks()[0].p_outcome, 'discarded');
  }
});

test('transient provider failures schedule bounded retries without persisting the provider body', async () => {
  for (const status of [429, 500, 503]) {
    const h = fixture({ provider: () => Response.json({ message: 'PRIVATE PROVIDER PAYLOAD member@example.invalid' }, { status, headers: { 'Retry-After': '180' } }) });
    const result = await h.run(), summary = await result.json();
    assert.equal(summary.retried, 1); assert.equal(summary.accepted, 0);
    assert.equal(h.acks()[0].p_retry_at, new Date(clock + 180000).toISOString());
    assert.doesNotMatch(JSON.stringify(h.acks()), /PRIVATE|member@/);
  }
});

test('network uncertainty and transient revalidation failures never claim delivery and can retry', async () => {
  const h = fixture({ provider: () => { throw new Error('PRIVATE NETWORK ERROR'); } });
  assert.equal((await (await h.run()).json()).retried, 1); assert.equal(h.acks()[0].p_outcome, 'retry');
  const missing = fixture({ rpcError: 'fc_revalidate_delivery' });
  assert.equal((await (await missing.run()).json()).retried, 1); assert.equal(missing.sends.length, 0);
});

test('permanent provider rejection and a different payload under an existing key terminate the job', async () => {
  for (const [status, name] of [[400, 'validation_error'], [403, 'restricted_api_key'], [409, 'invalid_idempotent_request']]) {
    const h = fixture({ provider: () => Response.json({ name, message: 'PRIVATE PROVIDER ERROR' }, { status }) });
    assert.equal((await (await h.run()).json()).failed, 1); assert.equal(h.acks()[0].p_outcome, 'failed');
  }
  const concurrent = fixture({ provider: () => Response.json({ name: 'concurrent_idempotent_requests' }, { status: 409 }) });
  assert.equal((await (await concurrent.run()).json()).retried, 1);
});

test('an expired retry window or ninth attempt cannot send, and the eighth failed attempt cannot retry', async () => {
  for (const changed of [{ first_attempt_at: new Date(clock - 86400000).toISOString() }, { attempts: 9 }, { first_attempt_at: 'invalid' }]) {
    const h = fixture({ jobs: [{ ...job, ...changed }] });
    assert.equal((await (await h.run()).json()).failed, 1); assert.equal(h.sends.length, 0);
  }
  const last = fixture({ jobs: [{ ...job, attempts: 8 }], provider: () => Response.json({}, { status: 503 }) });
  assert.equal((await (await last.run()).json()).failed, 1); assert.equal(last.acks()[0].p_retry_at, null);
});

test('duplicate rows in a claim batch send once and a failed acknowledgment remains observable only as a counter', async () => {
  const h = fixture({ jobs: [job, job], ackError: true }), summary = await (await h.run()).json();
  assert.equal(summary.accepted, 1); assert.equal(summary.ack_failed, 1); assert.equal(summary.duplicates, 1);
  assert.equal(h.sends.length, 1); assert.equal(h.acks().length, 1);
});

test('retrying an uncertain acknowledgment reuses the same provider idempotency key and exact payload', async () => {
  const h = fixture({ ackError: true }), seen = new Map(); let acceptedByProvider = 0;
  const fetchImpl = async (_url, options) => {
    const key = options.headers['Idempotency-Key'];
    if (seen.has(key)) assert.equal(options.body, seen.get(key));
    else { seen.set(key, options.body); acceptedByProvider++; }
    return Response.json({ id: 'same-provider-id' });
  };
  await h.run({ fetchImpl }); await h.run({ fetchImpl });
  assert.equal(acceptedByProvider, 1); assert.equal(h.acks().length, 2);
  assert.ok(h.acks().every(ack => ack.p_provider_id === 'same-provider-id'));
});

test('claim errors stay generic and client creation never inherits caller authorization or session storage', async () => {
  const h = fixture({ rpcError: 'fc_claim_delivery' }); let options;
  const result = await h.run({ client: undefined, createClient: (url, key, config) => { options = { url, key, config }; return h.client; } });
  assert.equal(result.status, 500); assert.deepEqual(await result.json(), { failed: 1 });
  assert.deepEqual(options, { url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY, config: { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } } });
  assert.equal(h.sends.length, 0);
});

test('provider timeout aborts the request and treats its outcome as uncertain', async () => {
  const provider = createResendProvider({ apiKey: 'test', from: env.FORUM_MAIL_FROM, timeoutMs: 5, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  assert.equal((await provider.send({ email: destination.email, topicId: topic, idempotencyKey: id })).outcome, 'retry');
});
