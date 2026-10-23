import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { createLocalQaServer, LOCAL_QA_PUBLIC_KEY } from '../scripts/local-qa-server.mjs';

async function until(condition, message) {
  const deadline = Date.now() + 7000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}
test('integrated private community: real bundles create, answer, report and moderate through authenticated HTTP', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sx-forocromos-e2e-'));
  const app = await createLocalQaServer({ port: 0, vaultDir: path.join(directory, 'cofre'), communityDir: path.join(directory, 'community') });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const login = async name => {
    const response = await fetch(app.origin + '/auth/v1/token?grant_type=password', { method: 'POST',
      headers: { apikey: LOCAL_QA_PUBLIC_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `${name}@example.invalid`, password: '123456' }) });
    assert.equal(response.status, 200); return response.json();
  };
  const [a, b, c] = await Promise.all(['a', 'b', 'c'].map(login));
  const request = (route, session, options = {}) => fetch(app.origin + route, { ...options,
    headers: { apikey: LOCAL_QA_PUBLIC_KEY, ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}), ...options.headers } });
  const prefix = '/forocromos/v1';
  assert.equal((await request(prefix + '/topics')).status, 401);
  assert.equal((await request(prefix + '/topics?q=prueba', c)).status, 403);
  assert.equal((await request('/cofre/v1/files', c)).status, 200, 'external account retains its own separate space');
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../forocromos.js', import.meta.url))],
    bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022' });
  function screen(session) {
    const dom = new JSDOM('<!doctype html><html lang="es"><body><main></main></body></html>', {
      url: app.origin, runScripts: 'outside-only', pretendToBeVisual: true
    });
    const { window } = dom;
    const calls = [];
    window.fetch = async (route, { signal, ...options } = {}) => {
      const abort = new AbortController(); const cancel = () => abort.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) abort.abort();
      calls.push(String(route));
      try { return await fetch(new URL(route, app.origin), { ...options, signal: abort.signal }); }
      finally { signal?.removeEventListener('abort', cancel); }
    };
    window.__sxCofreSession = { ...session, apikey: LOCAL_QA_PUBLIC_KEY };
    window.eval(bundle.outputFiles[0].text);
    const $ = selector => window.document.querySelector(selector);
    const submit = selector => $(selector).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    const fill = (selector, value) => { $(selector).value = value; $(selector).dispatchEvent(new window.Event('input', { bubbles: true })); };
    t.after(() => {
      window.__sxCofreSession = null;
      window.dispatchEvent(new window.CustomEvent('sx:session', { detail: null }));
      dom.window.close();
    });
    return { window, $, submit, fill, calls };
  }
  const A = screen(a);
  await until(() => A.$('#fc-identity').textContent.includes('Compañera A'), 'A did not gain community admission');
  A.$('#fc-new-topic').click();
  A.fill('#fc-topic-title', 'Consulta ficticia entre compañeras');
  A.fill('#fc-topic-body', 'Hola **compañeras**.\n\n<img src="https://example.invalid/pixel" onerror="alert(1)">\n\n![imagen](https://example.invalid/track)\n\n[Enlace](https://example.invalid/info)');
  A.$('#fc-topic-category').value = 'entre-companeras';
  A.submit('#fc-topic-form');
  await until(() => A.$('#fc-thread').textContent.includes('Consulta ficticia'), 'real topic creation did not render');
  assert.equal(A.$('#fc-thread strong').textContent, 'compañeras');
  assert.equal(A.$('#fc-thread img, #fc-thread iframe, #fc-thread script'), null);
  const link = A.$('#fc-thread a[href="https://example.invalid/info"]');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(A.calls.every(route => route.startsWith(prefix)), true);
  const topics = await (await request(prefix + '/topics', b)).json();
  assert.equal(topics.total, 1);
  const topic = topics.topics[0];
  assert.equal(JSON.stringify(topic).includes('@example.invalid'), false);
  assert.equal((await request(prefix + '/topics/' + topic.id, c)).status, 403);
  const B = screen(b);
  await until(() => Boolean(B.$('#fc-topics .fc-topic-open')), 'B could not discover the admitted topic');
  B.$('#fc-topics .fc-topic-open').click();
  await until(() => B.$('#fc-thread').textContent.includes('Consulta ficticia'), 'B could not open the topic');
  B.fill('#fc-reply-body', 'Respuesta ficticia de una compañera.');
  B.submit('#fc-reply-form');
  await until(() => B.$('#fc-replies').textContent.includes('Respuesta ficticia'), 'reply was not saved and displayed');
  assert.equal(B.$('#fc-moderation-button').hidden, true);
  assert.equal((await request(prefix + '/reports', b)).status, 403);
  const reportButton = [...B.$('#fc-thread').querySelectorAll('button')].find(button => button.textContent === 'Avisar a moderación');
  reportButton.click();
  B.fill('.fc-report-form textarea', 'Motivo de ensayo, solo para moderación.');
  B.submit('.fc-report-form');
  [...B.$('.fc-report-form').querySelectorAll('button')].find(button => button.textContent === 'Sí, enviar aviso').click();
  await until(() => B.$('#fc-status').textContent.includes('Aviso enviado'), 'confidential report was not acknowledged');
  assert.equal((await (await request(prefix + '/topics/' + topic.id, b)).json()).topic.body.includes('Motivo de ensayo'), false);
  A.$('#fc-moderation-button').click();
  await until(() => A.$('#fc-reports li'), 'moderator did not receive the confidential report');
  assert.ok(A.$('#fc-reports').textContent.includes('Motivo de ensayo'));
  const hide = [...A.$('#fc-reports').querySelectorAll('button')].find(button => /Ocultar/.test(button.textContent));
  assert.ok(hide); hide.click();
  const decision = [...A.$('#fc-reports').querySelectorAll('.fc-confirm button')].find(button => /Sí/.test(button.textContent));
  assert.ok(decision); decision.click();
  await until(() => A.$('#fc-reports').children.length === 0, 'moderation did not resolve the report');
  assert.equal((await request(prefix + '/topics/' + topic.id, b)).status, 404);
  assert.equal((await (await request(prefix + '/topics?q=Consulta', b)).json()).total, 0);
  app.forocromosStore.setMembership('b@example.invalid', { status: 'revoked' });
  assert.equal((await request(prefix + '/topics', b)).status, 403, 'existing session loses access when admission is revoked');
  B.$('#fc-refresh').click();
  await until(() => B.$('#fc-status').textContent.includes('no tiene acceso'), 'revocation did not clear the community UI');
  assert.equal(B.$('#fc-thread').textContent, '');
});
