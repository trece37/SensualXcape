import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedPushEndpoint, buildPushPayload, createWebPushProvider, handlePushRequest } from '../supabase/functions/fc-deliver-push/worker.mjs';

const time = Date.parse('2026-10-26T12:00:00Z');
const id = '00000000-0000-4000-8000-000000000001', topic = '00000000-0000-4000-8000-000000000002', lease = '00000000-0000-4000-8000-000000000003', device = '00000000-0000-4000-8000-000000000004';
const job = { id, topic_id: topic, subscription_id: device, lease_token: lease, attempts: 1, created_at: new Date(time - 120000).toISOString(), first_attempt_at: new Date(time - 60000).toISOString(), last_attempt_at: new Date(time).toISOString() };
const subscription = { id: device, endpoint: 'https://fcm.googleapis.com/fcm/send/test-device', keys: { p256dh: 'P'.repeat(87), auth: 'A'.repeat(22) } };
const target = { allowed: true, topic_id: topic, deep_url: `https://trece37.github.io/SensualXcape/foro/?topic=${topic}`, subscription, idempotency_key: id };
const config = { configured: true, vapid_public_key: 'V'.repeat(87), vapid_private_key: 'K'.repeat(43), vapid_subject: 'https://trece37.github.io/SensualXcape/foro/' };
const secret = 'local-test-push-worker-secret';
const env = { SUPABASE_URL: 'https://database.example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'local-test-service-key' };
const request = (value = secret, method = 'POST') => new Request('https://function.example.invalid/', { method, headers: { 'x-foro-worker-secret': value }, ...(method === 'POST' ? { body: '{"endpoint":"http://127.0.0.1/","body":"PRIVATE USER CONTENT"}' } : {}) });

function fixture({ jobs = [job], destination = target, settings = config, provider, ackError = false, rpcError = null } = {}) {
  const calls = [], generates = [], sends = [];
  const client = { async rpc(name, args) {
    calls.push({ name, args });
    if (rpcError === name) return { data: null, error: { message: 'PRIVATE ERROR SECRET endpoint token' } };
    if (name === 'fc_push_worker_config') return { data: args.p_secret === secret ? settings : null, error: null };
    if (name === 'fc_claim_push_delivery') return { data: structuredClone(jobs), error: null };
    if (name === 'fc_revalidate_push_delivery') return { data: destination, error: null };
    if (name === 'fc_ack_push_delivery') return ackError ? { data: null, error: {} } : { data: { ok: true, state: args.p_outcome }, error: null };
    throw new Error('Unexpected RPC');
  } };
  const generateRequestDetails = (subscription, payload, options) => {
    generates.push({ subscription, payload: JSON.parse(payload), options });
    return { endpoint: subscription.endpoint, method: 'POST', headers: { 'Content-Encoding': 'aes128gcm', Authorization: 'test-vapid-authorization', TTL: String(options.TTL), Topic: options.topic }, body: new Uint8Array([0, 128, 255, 17]) };
  };
  const fetchImpl = async (url, options) => { sends.push({ url, options }); return provider ? provider(url, options) : new Response(null, { status: 201 }); };
  return { calls, generates, sends, client, generateRequestDetails, fetchImpl,
    run: (options = {}) => handlePushRequest(request(), { env, client, generateRequestDetails, fetchImpl, now: () => time, ...options }),
    acks: () => calls.filter(call => call.name === 'fc_ack_push_delivery').map(call => call.args) };
}

test('push endpoint validation allows only HTTPS browser providers and rejects SSRF, credentials, ports, suffix tricks and fragments', () => {
  for (const value of ['https://fcm.googleapis.com/fcm/send/device', 'https://updates.push.services.mozilla.com/wpush/v2/device', 'https://web.push.apple.com/device', 'https://eu.web.push.apple.com/device', 'https://wns2-par02p.notify.windows.com/w/?token=device']) assert.equal(allowedPushEndpoint(value), true, value);
  for (const value of ['http://fcm.googleapis.com/send', 'https://127.0.0.1/push', 'https://[::1]/push', 'https://localhost/push', 'https://fcm.googleapis.com.evil.invalid/', 'https://evilfcm.googleapis.com/', 'https://fcm.googleapis.com@127.0.0.1/', 'https://user:pass@fcm.googleapis.com/', 'https://fcm.googleapis.com:443/push', 'https://fcm.googleapis.com:8443/push', 'https://web.push.apple.com#secret', 'https://notify.windows.com/', 'https://fcm.\ngoogleapis.com/']) assert.equal(allowedPushEndpoint(value), false, value);
});

test('missing authentication is rejected before database work and wrong secrets reveal no Vault data', async () => {
  const h = fixture(); let made = 0;
  const empty = await handlePushRequest(request(''), { env, createClient: () => { made++; return h.client; } });
  assert.equal(empty.status, 401); assert.equal(made, 0); assert.equal(h.calls.length, 0);
  const wrong = await handlePushRequest(request('wrong'), { env, client: h.client });
  assert.equal(wrong.status, 401); assert.deepEqual(await wrong.json(), { unauthorized: 1 });
  assert.deepEqual(h.calls, [{ name: 'fc_push_worker_config', args: { p_secret: 'wrong' } }]);
  const get = await handlePushRequest(request(secret, 'GET'), { env, client: h.client }); assert.equal(get.status, 405);
});

test('missing platform configuration or disabled or invalid VAPID setup cannot claim or send', async () => {
  for (const settings of [{ ...config, configured: false }, { ...config, vapid_private_key: '' }, { ...config, vapid_subject: 'https://localhost' }]) {
    const h = fixture({ settings }), result = await h.run();
    assert.equal(result.status, 503); assert.deepEqual(await result.json(), { disabled: 1 });
    assert.equal(h.calls.length, 1); assert.equal(h.sends.length, 0);
  }
  const h = fixture(), result = await h.run({ env: {} }); assert.equal(result.status, 503); assert.equal(h.calls.length, 0);
});

test('push payload uses only a generic notice, canonical topic link, stable tag and the authorized device binding', () => {
  const payload = buildPushPayload({ topicId: topic, jobId: id, deviceId: device, body: 'PRIVATE BODY', title: 'PRIVATE TITLE', alias: 'PRIVATE ALIAS' });
  assert.deepEqual(payload, { title: 'Nueva respuesta', body: 'Tienes una respuesta en una conversación que sigues.', url: target.deep_url, tag: `foro-${id}`, device_id: device });
  assert.doesNotMatch(JSON.stringify(payload), /PRIVATE|email|<img|token=|auth/);
  assert.throws(() => buildPushPayload({ topicId: 'javascript:alert(1)', jobId: id, deviceId: device }), /invalid_target/);
});

test('claim and revalidation precede encryption and fetch sends only the opaque encrypted request with redirects blocked', async () => {
  const h = fixture(), response = await h.run(), summary = await response.json();
  assert.equal(summary.accepted, 1); assert.equal('delivered' in summary, false);
  assert.deepEqual(h.calls.map(call => call.name), ['fc_push_worker_config', 'fc_claim_push_delivery', 'fc_revalidate_push_delivery', 'fc_ack_push_delivery']);
  assert.deepEqual(h.calls[1].args, { p_limit: 20, p_lease_seconds: 120 });
  assert.deepEqual(h.calls[2].args, { p_id: id, p_lease_token: lease });
  assert.equal(h.generates[0].options.contentEncoding, 'aes128gcm'); assert.equal(h.generates[0].options.topic, id.replaceAll('-', ''));
  assert.ok(h.generates[0].options.TTL <= 86400 && h.generates[0].options.TTL > 0);
  assert.deepEqual(h.generates[0].options.vapidDetails, { subject: config.vapid_subject, publicKey: config.vapid_public_key, privateKey: config.vapid_private_key });
  assert.equal(h.sends[0].url, subscription.endpoint); assert.equal(h.sends[0].options.redirect, 'error');
  assert.deepEqual([...h.sends[0].options.body], [0, 128, 255, 17]);
  assert.equal(h.acks()[0].p_outcome, 'accepted'); assert.equal(h.acks()[0].p_provider_id, null);
  assert.ok(Object.values(summary).every(Number.isInteger)); assert.doesNotMatch(JSON.stringify(summary), /endpoint|secret|V{10}|K{10}|device/);
});

test('revoked access, unsafe endpoints, changed device bindings and invalid deep links are discarded without encryption or fetch', async () => {
  for (const destination of [{ allowed: false }, { ...target, deep_url: 'https://attacker.example.invalid/' }, { ...target, subscription: { ...subscription, id: id } }, { ...target, subscription: { ...subscription, endpoint: 'https://127.0.0.1/' } }, { ...target, subscription: { ...subscription, keys: { p256dh: '', auth: '' } } }]) {
    const h = fixture({ destination }); assert.equal((await (await h.run()).json()).discarded, 1);
    assert.equal(h.generates.length, 0); assert.equal(h.sends.length, 0);
  }
});

test('404 and 410 expire only the authorized job device through the atomic ack RPC', async () => {
  for (const status of [404, 410]) {
    const h = fixture({ provider: () => new Response('PRIVATE PROVIDER DATA', { status }) });
    assert.equal((await (await h.run()).json()).expired, 1);
    assert.deepEqual(h.acks()[0], { p_id: id, p_lease_token: lease, p_outcome: 'expired', p_provider_id: null, p_error_code: 'subscription_expired', p_retry_at: null });
  }
});

test('429 and 5xx schedule bounded retries while other provider rejections are terminal', async () => {
  for (const status of [429, 500, 503]) {
    const h = fixture({ provider: () => new Response(null, { status, headers: { 'Retry-After': '180' } }) });
    assert.equal((await (await h.run()).json()).retried, 1); assert.equal(h.acks()[0].p_retry_at, new Date(time + 180000).toISOString());
  }
  for (const status of [302, 400, 401, 403, 413]) {
    const h = fixture({ provider: () => new Response('PRIVATE TOKEN', { status }) });
    assert.equal((await (await h.run()).json()).failed, 1); assert.equal(h.acks()[0].p_outcome, 'failed');
  }
});

test('uncertain network and revalidation failures retry without leaking exceptions or provider bodies', async () => {
  const h = fixture({ provider: () => { throw new Error('PRIVATE VAPID TOKEN AND ENDPOINT'); } });
  assert.equal((await (await h.run()).json()).retried, 1); assert.doesNotMatch(JSON.stringify(h.acks()), /PRIVATE|ENDPOINT|TOKEN/);
  const revoked = fixture({ rpcError: 'fc_revalidate_push_delivery' }); assert.equal((await (await revoked.run()).json()).retried, 1); assert.equal(revoked.sends.length, 0);
});

test('duplicate leases send once and lost acknowledgments report acceptance separately from the ack failure', async () => {
  const h = fixture({ jobs: [job, job], ackError: true }), summary = await (await h.run()).json();
  assert.equal(summary.accepted, 1); assert.equal(summary.ack_failed, 1); assert.equal(summary.duplicates, 1); assert.equal(h.sends.length, 1);
  await h.run();
  assert.equal(h.generates[0].payload.tag, h.generates[1].payload.tag);
  assert.equal(h.generates[0].options.topic, h.generates[1].options.topic);
});

test('retry time and attempt caps prevent stale sends and do not renew exhausted retries', async () => {
  for (const changed of [{ attempts: 9 }, { first_attempt_at: new Date(time - 86400000).toISOString() }, { first_attempt_at: 'invalid' }]) {
    const h = fixture({ jobs: [{ ...job, ...changed }] });
    assert.equal((await (await h.run()).json()).failed, 1); assert.equal(h.sends.length, 0);
  }
  const last = fixture({ jobs: [{ ...job, attempts: 8 }], provider: () => new Response(null, { status: 503 }) });
  assert.equal((await (await last.run()).json()).failed, 1); assert.equal(last.acks()[0].p_retry_at, null);
});

test('a generator cannot redirect the request or supply a plaintext body and timeout remains an uncertain retry', async () => {
  let sends = 0;
  for (const details of [{ endpoint: 'https://attacker.example.invalid/', method: 'POST', body: new Uint8Array([1]) }, { endpoint: subscription.endpoint, method: 'POST', body: 'plain payload' }]) {
    const provider = createWebPushProvider({ config, generateRequestDetails: () => details, fetchImpl: () => { sends++; } });
    assert.equal((await provider.send({ subscription, topicId: topic, jobId: id })).outcome, 'failed');
  }
  assert.equal(sends, 0);
  const provider = createWebPushProvider({ config, timeoutMs: 5, generateRequestDetails: () => ({ endpoint: subscription.endpoint, method: 'POST', headers: {}, body: new Uint8Array([1]) }), fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  assert.equal((await provider.send({ subscription, topicId: topic, jobId: id })).outcome, 'retry');
});

test('configuration and claim failures return counters without exposing server diagnostics', async () => {
  const configError = fixture({ rpcError: 'fc_push_worker_config' }); assert.equal((await configError.run()).status, 503);
  const claimError = fixture({ rpcError: 'fc_claim_push_delivery' }), result = await claimError.run();
  assert.equal(result.status, 500); assert.deepEqual(await result.json(), { failed: 1 }); assert.equal(claimError.sends.length, 0);
});
