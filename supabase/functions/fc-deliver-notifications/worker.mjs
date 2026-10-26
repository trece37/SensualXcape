// Server-only worker. The browser never receives addresses, provider credentials or queue rows.
export const FORUM_URL = 'https://trece37.github.io/SensualXcape/foro/';
const PROVIDER_URL = 'https://api.resend.com/emails';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s<>(),;:"\\]+@[^\s<>(),;:"\\]+\.[^\s<>(),;:"\\]+$/u;
const BATCH_SIZE = 20, LEASE_SECONDS = 120, MAX_ATTEMPTS = 8;
// Resend retains an idempotency key for 24 h. Stop earlier, including after an uncertain response.
const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000 - 60 * 1000;
const counts = () => ({ claimed: 0, accepted: 0, retried: 0, discarded: 0, failed: 0, ack_failed: 0, duplicates: 0 });
const validEmail = value => typeof value === 'string' && value.length <= 254 && !/[\x00-\x20\x7f]/.test(value) && EMAIL.test(value);

function validFrom(value) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) return false;
  const match = value.match(/^[^<>]+<([^<>]+)>$/);
  return validEmail(match ? match[1] : value);
}

function exactSecret(actual, expected) {
  if (typeof actual !== 'string' || actual.length > 4096) return false;
  let difference = actual.length ^ expected.length;
  for (let i = 0; i < Math.max(actual.length, expected.length); i++) difference |= (actual.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  return difference === 0;
}

export function buildReplyNotification({ email, topicId, from }) {
  if (!validEmail(email) || !UUID.test(topicId) || !validFrom(from)) throw new Error('invalid_target');
  const url = `${FORUM_URL}?topic=${topicId.toLowerCase()}`;
  return {
    from,
    to: [email],
    subject: 'Tienes una nueva respuesta',
    text: `Hay una nueva respuesta en una conversación que sigues.\n\nAbrir conversación: ${url}\n\nPuedes desactivar estos avisos en Mi perfil.`,
    html: `<!doctype html><html lang="es"><head><meta charset="utf-8"></head><body><p>Hay una nueva respuesta en una conversación que sigues.</p><p><a href="${url}" rel="noreferrer">Abrir conversación</a></p><p>Puedes desactivar estos avisos en <strong>Mi perfil</strong>.</p></body></html>`,
  };
}

function retryAfter(response, now) {
  const value = response.headers.get('retry-after');
  if (!value) return 0;
  const seconds = Number(value), date = Date.parse(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - now : 0;
  return Math.max(0, Math.min(60 * 60 * 1000, delay));
}

export function createResendProvider({ apiKey, from, fetchImpl = globalThis.fetch, timeoutMs = 8000, now = Date.now }) {
  return {
    async send({ email, topicId, idempotencyKey }) {
      if (typeof idempotencyKey !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(idempotencyKey)) return { outcome: 'failed', code: 'invalid_idempotency_key' };
      let message;
      try { message = buildReplyNotification({ email, topicId, from }); }
      catch { return { outcome: 'discarded', code: 'invalid_target' }; }
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(PROVIDER_URL, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify(message),
        });
        let data;
        try { data = await response.json(); } catch { data = null; }
        if (response.ok) {
          if (typeof data?.id !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(data.id)) return { outcome: 'retry', code: 'provider_response_unknown' };
          return { outcome: 'accepted', providerId: data.id };
        }
        if (response.status === 409) return data?.name === 'concurrent_idempotent_requests'
          ? { outcome: 'retry', code: 'provider_in_progress' }
          : { outcome: 'failed', code: 'provider_idempotency_conflict' };
        if (response.status === 429 || response.status >= 500) return { outcome: 'retry', code: 'provider_unavailable', retryAfterMs: retryAfter(response, Number(now())) };
        return { outcome: 'failed', code: 'provider_rejected' };
      } catch { return { outcome: 'retry', code: 'provider_response_unknown' }; }
      finally { clearTimeout(timer); }
    },
  };
}

function retryDeadline(job) {
  const value = job.first_attempt_at || job.created_at;
  const started = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(started) ? started + RETRY_WINDOW_MS : NaN;
}

export async function processNotificationBatch({ client, provider, now = Date.now }) {
  const totals = counts(), seenIds = new Set(), seenKeys = new Set();
  const claim = await client.rpc('fc_claim_delivery', { p_limit: BATCH_SIZE, p_lease_seconds: LEASE_SECONDS });
  if (claim.error || !Array.isArray(claim.data)) throw new Error('claim_unavailable');
  const jobs = claim.data.slice(0, BATCH_SIZE); totals.claimed = jobs.length;
  async function acknowledge(job, outcome, code = null, providerId = null, nextAttempt = null) {
    let result;
    try {
      result = await client.rpc('fc_ack_delivery', {
        p_id: job.id, p_lease_token: job.lease_token, p_outcome: outcome,
        p_provider_id: providerId, p_error_code: code, p_retry_at: nextAttempt,
      });
    } catch { result = null; }
    if (outcome === 'accepted') totals.accepted++;
    if (!result || result.error || result.data?.ok !== true) { totals.ack_failed++; return; }
    if (outcome === 'retry') totals.retried++;
    else if (outcome === 'discarded') totals.discarded++;
    else if (outcome === 'failed') totals.failed++;
  }
  async function retry(job, code, delay = 0) {
    const clock = Number(now()), deadline = retryDeadline(job);
    const backoff = Math.min(30 * 60 * 1000, 60 * 1000 * 2 ** Math.max(0, job.attempts - 1));
    const next = clock + Math.max(backoff, delay);
    if (!Number.isFinite(deadline) || next >= deadline || job.attempts >= MAX_ATTEMPTS) await acknowledge(job, 'failed', 'retry_window_exhausted');
    else await acknowledge(job, 'retry', code, null, new Date(next).toISOString());
  }
  for (const job of jobs) {
    if (!job || !UUID.test(job.id) || !UUID.test(job.topic_id) || !UUID.test(job.lease_token)) { totals.failed++; continue; }
    if (seenIds.has(job.id)) { totals.duplicates++; continue; }
    seenIds.add(job.id);
    const deadline = retryDeadline(job), clock = Number(now());
    if (!Number.isInteger(job.attempts) || job.attempts < 1 || job.attempts > MAX_ATTEMPTS || !Number.isFinite(deadline) || clock >= deadline) {
      await acknowledge(job, 'failed', 'retry_window_exhausted'); continue;
    }
    let validated;
    try { validated = await client.rpc('fc_revalidate_delivery', { p_id: job.id, p_lease_token: job.lease_token }); }
    catch { validated = null; }
    if (!validated || validated.error) { await retry(job, 'revalidation_unavailable'); continue; }
    const target = validated.data;
    if (target?.allowed !== true) { await acknowledge(job, 'discarded', 'target_ineligible'); continue; }
    const expectedUrl = `${FORUM_URL}?topic=${job.topic_id.toLowerCase()}`;
    if (!validEmail(target.email) || typeof target.topic_id !== 'string' || target.topic_id.toLowerCase() !== job.topic_id.toLowerCase() || target.deep_url !== expectedUrl
      || typeof target.idempotency_key !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(target.idempotency_key)) {
      await acknowledge(job, 'discarded', 'invalid_target'); continue;
    }
    if (seenKeys.has(target.idempotency_key)) { totals.duplicates++; await acknowledge(job, 'discarded', 'duplicate_event'); continue; }
    seenKeys.add(target.idempotency_key);
    if (Number(now()) >= deadline) { await acknowledge(job, 'failed', 'retry_window_exhausted'); continue; }
    // No other data is fetched between authorization and the provider call. Revalidation owns
    // membership, follow/preference, visibility and the frozen, still-current verified destination.
    let result;
    try { result = await provider.send({ email: target.email, topicId: job.topic_id, idempotencyKey: target.idempotency_key }); }
    catch { result = { outcome: 'retry', code: 'provider_response_unknown' }; }
    if (result?.outcome === 'accepted') await acknowledge(job, 'accepted', null, result.providerId);
    else if (result?.outcome === 'discarded') await acknowledge(job, 'discarded', 'invalid_target');
    else if (result?.outcome === 'failed') await acknowledge(job, 'failed', result.code === 'provider_idempotency_conflict' ? result.code : 'provider_rejected');
    else await retry(job, result?.code === 'provider_in_progress' ? 'provider_in_progress' : 'provider_unavailable', Number.isFinite(result?.retryAfterMs) ? result.retryAfterMs : 0);
  }
  return totals;
}

function response(status, counters, headers = {}) {
  return new Response(JSON.stringify(counters), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
}

export async function handleNotificationRequest(request, { env = {}, client, createClient, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (request.method !== 'POST') return response(405, { rejected: 1 }, { Allow: 'POST' });
  const secret = env.FORUM_MAIL_WORKER_SECRET;
  if (typeof secret !== 'string' || !secret.trim()) return response(503, { disabled: 1 });
  if (!exactSecret(request.headers.get('x-foro-worker-secret'), secret)) return response(401, { unauthorized: 1 });
  if (!env.RESEND_API_KEY?.trim() || !validFrom(env.FORUM_MAIL_FROM) || !env.SUPABASE_URL?.trim() || !env.SUPABASE_SERVICE_ROLE_KEY?.trim()) return response(503, { disabled: 1 });
  try {
    const database = client || createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const provider = createResendProvider({ apiKey: env.RESEND_API_KEY, from: env.FORUM_MAIL_FROM, fetchImpl, now });
    return response(200, await processNotificationBatch({ client: database, provider, now }));
  } catch { return response(500, { failed: 1 }); }
}
