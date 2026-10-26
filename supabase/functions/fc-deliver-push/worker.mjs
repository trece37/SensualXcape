// Server-only Web Push transport. No subscription, key, secret or provider response is logged.
const FORUM_URL = 'https://trece37.github.io/SensualXcape/foro/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETRY_WINDOW_MS = 86400000 - 60000, MAX_ATTEMPTS = 8;
const counts = () => ({ claimed: 0, accepted: 0, retried: 0, discarded: 0, expired: 0, failed: 0, ack_failed: 0, duplicates: 0 });

export function allowedPushEndpoint(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f]/.test(value)) return false;
  const authority = value.match(/^https:\/\/([^/?#]+)(?:[/?#]|$)/i)?.[1];
  if (!authority || !/^[a-z0-9.-]+$/i.test(authority)) return false;
  try {
    const url = new URL(value), host = url.hostname;
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
      && (['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'].includes(host)
        || /^(?:[a-z0-9-]+\.)+web\.push\.apple\.com$/.test(host)
        || /^(?:[a-z0-9-]+\.)+notify\.windows\.com$/.test(host));
  } catch { return false; }
}

function validSubscription(subscription) {
  return subscription && UUID.test(subscription.id) && allowedPushEndpoint(subscription.endpoint)
    && typeof subscription.keys?.p256dh === 'string' && /^[a-z0-9_-]{87}$/i.test(subscription.keys.p256dh)
    && typeof subscription.keys?.auth === 'string' && /^[a-z0-9_-]{22}$/i.test(subscription.keys.auth);
}

function validConfig(config) {
  if (config?.configured !== true || !/^[a-z0-9_-]{87}$/i.test(config.vapid_public_key || '')
    || !/^[a-z0-9_-]{43}$/i.test(config.vapid_private_key || '') || typeof config.vapid_subject !== 'string'
    || /[\r\n\0]/.test(config.vapid_subject)) return false;
  try {
    const subject = new URL(config.vapid_subject);
    return (subject.protocol === 'https:' && !!subject.hostname && subject.hostname !== 'localhost' && !subject.username && !subject.password)
      || (subject.protocol === 'mailto:' && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(subject.pathname));
  } catch { return false; }
}

export function buildPushPayload({ topicId, jobId, deviceId }) {
  if (![topicId, jobId, deviceId].every(value => typeof value === 'string' && UUID.test(value))) throw new Error('invalid_target');
  return {
    title: 'Nueva respuesta',
    body: 'Tienes una respuesta en una conversación que sigues.',
    url: `${FORUM_URL}?topic=${topicId.toLowerCase()}`,
    tag: `foro-${jobId.toLowerCase()}`,
    device_id: deviceId.toLowerCase(),
  };
}

export function createWebPushProvider({ config, generateRequestDetails, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  return {
    async send({ subscription, topicId, jobId, ttl = 86400 }) {
      if (!validConfig(config) || !validSubscription(subscription)) return { outcome: 'discarded', code: 'invalid_target' };
      let details;
      try {
        const payload = buildPushPayload({ topicId, jobId, deviceId: subscription.id });
        // generateRequestDetails encrypts/signs locally. sendNotification would use Node HTTPS;
        // the Edge transport uses fetch instead, with redirects explicitly prohibited.
        details = generateRequestDetails({ endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } }, JSON.stringify(payload), {
          vapidDetails: { subject: config.vapid_subject, publicKey: config.vapid_public_key, privateKey: config.vapid_private_key },
          contentEncoding: 'aes128gcm', urgency: 'normal', TTL: Math.min(86400, Math.max(1, Math.floor(ttl))),
          topic: jobId.replaceAll('-', '').toLowerCase(),
        });
      } catch { return { outcome: 'failed', code: 'invalid_subscription' }; }
      if (details?.endpoint !== subscription.endpoint || details.method !== 'POST' || !allowedPushEndpoint(details.endpoint)
        || !(details.body instanceof Uint8Array)) return { outcome: 'failed', code: 'invalid_request' };
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(details.endpoint, { method: 'POST', headers: details.headers, body: new Uint8Array(details.body), signal: controller.signal, redirect: 'error' });
        // Provider bodies and Location headers can contain subscription identifiers. Never retain them.
        await response.body?.cancel().catch(() => {});
        if (response.ok) return { outcome: 'accepted' };
        if (response.status === 404 || response.status === 410) return { outcome: 'expired', code: 'subscription_expired' };
        if (response.status === 429 || response.status >= 500) {
          const seconds = Number(response.headers.get('retry-after'));
          return { outcome: 'retry', code: 'provider_unavailable', retryAfterMs: Number.isFinite(seconds) ? Math.max(0, Math.min(3600000, seconds * 1000)) : 0 };
        }
        return { outcome: 'failed', code: 'provider_rejected' };
      } catch { return { outcome: 'retry', code: 'provider_response_unknown' }; }
      finally { clearTimeout(timer); }
    },
  };
}

function deadline(job) {
  const value = job.first_attempt_at || job.created_at;
  const start = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(start) ? start + RETRY_WINDOW_MS : NaN;
}

export async function processPushBatch({ client, provider, now = Date.now }) {
  const totals = counts(), seen = new Set();
  const claim = await client.rpc('fc_claim_push_delivery', { p_limit: 20, p_lease_seconds: 120 });
  if (claim.error || !Array.isArray(claim.data)) throw new Error('claim_unavailable');
  const jobs = claim.data.slice(0, 20); totals.claimed = jobs.length;
  async function ack(job, outcome, code = null, retryAt = null) {
    let result;
    try { result = await client.rpc('fc_ack_push_delivery', { p_id: job.id, p_lease_token: job.lease_token, p_outcome: outcome, p_provider_id: null, p_error_code: code, p_retry_at: retryAt }); }
    catch { result = null; }
    if (outcome === 'accepted') totals.accepted++;
    if (!result || result.error || result.data?.ok !== true) { totals.ack_failed++; return; }
    if (outcome === 'retry') totals.retried++;
    else if (outcome !== 'accepted') totals[outcome]++;
  }
  async function retry(job, code, delay = 0) {
    const next = Number(now()) + Math.max(Math.min(1800000, 60000 * 2 ** Math.max(0, job.attempts - 1)), delay);
    if (job.attempts >= MAX_ATTEMPTS || !Number.isFinite(deadline(job)) || next >= deadline(job)) await ack(job, 'failed', 'retry_window_exhausted');
    else await ack(job, 'retry', code, new Date(next).toISOString());
  }
  for (const job of jobs) {
    if (!job || ![job.id, job.topic_id, job.subscription_id, job.lease_token].every(value => typeof value === 'string' && UUID.test(value))) { totals.failed++; continue; }
    if (seen.has(job.id)) { totals.duplicates++; continue; } seen.add(job.id);
    if (!Number.isInteger(job.attempts) || job.attempts < 1 || job.attempts > MAX_ATTEMPTS || !Number.isFinite(deadline(job)) || Number(now()) >= deadline(job)) { await ack(job, 'failed', 'retry_window_exhausted'); continue; }
    let checked;
    try { checked = await client.rpc('fc_revalidate_push_delivery', { p_id: job.id, p_lease_token: job.lease_token }); }
    catch { checked = null; }
    if (!checked || checked.error) { await retry(job, 'revalidation_unavailable'); continue; }
    const target = checked.data;
    if (target?.allowed !== true) { await ack(job, 'discarded', 'target_ineligible'); continue; }
    if (!validSubscription(target.subscription) || target.subscription.id.toLowerCase() !== job.subscription_id.toLowerCase()
      || typeof target.topic_id !== 'string' || target.topic_id.toLowerCase() !== job.topic_id.toLowerCase()
      || target.deep_url !== `${FORUM_URL}?topic=${job.topic_id.toLowerCase()}`) { await ack(job, 'discarded', 'invalid_target'); continue; }
    const ttl = Math.floor((deadline(job) - Number(now())) / 1000);
    if (ttl < 1) { await ack(job, 'failed', 'retry_window_exhausted'); continue; }
    let result;
    try { result = await provider.send({ subscription: target.subscription, topicId: job.topic_id, jobId: job.id, ttl }); }
    catch { result = { outcome: 'retry', code: 'provider_response_unknown' }; }
    if (result?.outcome === 'accepted') await ack(job, 'accepted');
    else if (result?.outcome === 'expired') await ack(job, 'expired', 'subscription_expired');
    else if (result?.outcome === 'discarded') await ack(job, 'discarded', 'invalid_target');
    else if (result?.outcome === 'failed') await ack(job, 'failed', 'provider_rejected');
    else await retry(job, 'provider_unavailable', Number.isFinite(result?.retryAfterMs) ? Math.max(0, result.retryAfterMs) : 0);
  }
  return totals;
}

const response = (status, counters, extra = {}) => new Response(JSON.stringify(counters), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } });
export async function handlePushRequest(request, { env = {}, client, createClient, generateRequestDetails, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (request.method !== 'POST') return response(405, { rejected: 1 }, { Allow: 'POST' });
  const secret = request.headers.get('x-foro-worker-secret');
  if (!secret || !secret.trim() || secret.length > 4096) return response(401, { unauthorized: 1 });
  if (!env.SUPABASE_URL?.trim() || !env.SUPABASE_SERVICE_ROLE_KEY?.trim()) return response(503, { disabled: 1 });
  try {
    const database = client || createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    // Only service_role can execute this RPC. Vault checks the exact header secret;
    // an invalid secret returns null and never reveals VAPID material.
    const settings = await database.rpc('fc_push_worker_config', { p_secret: secret });
    if (settings.error) return response(503, { disabled: 1 });
    if (!settings.data) return response(401, { unauthorized: 1 });
    if (!validConfig(settings.data)) return response(503, { disabled: 1 });
    const provider = createWebPushProvider({ config: settings.data, generateRequestDetails, fetchImpl });
    return response(200, await processPushBatch({ client: database, provider, now }));
  } catch { return response(500, { failed: 1 }); }
}
