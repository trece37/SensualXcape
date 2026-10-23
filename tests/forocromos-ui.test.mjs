import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMarkdownRenderer, mountForocromos } from '../forocromos.js';

const alice = { user: { id: 'alice', email: 'not-for-publication@example.invalid' }, access_token: 'alice-token', apikey: 'local-public-test' };
const bob = { user: { id: 'bob' }, access_token: 'bob-token', apikey: 'local-public-test' };
const outsider = { user: { id: 'outsider' }, access_token: 'outsider-token', apikey: 'local-public-test' };
const categories = [{ id: 'entre-companeras', name: 'Entre compañeras' }, { id: 'vida-practica', name: 'Vida práctica' }, { id: 'ideas', name: 'Ideas para mejorar' }];
const topic = (id = 'one', properties = {}) => ({ id, title: `Tema ${id}`, body: 'Texto **importante**', snippet: 'Texto importante', category_id: 'entre-companeras', author: { id: 'bob', alias: 'Compañera B' }, created_at: '2026-10-21T12:00:00.000Z', reply_count: 0, locked: false, withdrawn: false, ...properties });
const reply = (id = 'reply-one', properties = {}) => ({ id, topic_id: 'one', body: 'Una respuesta', author: { id: 'alice', alias: 'Compañera A' }, created_at: '2026-10-21T12:30:00.000Z', withdrawn: false, ...properties });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };

function harness(t, handler = async () => undefined, initialSession = alice) {
  const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'http://127.0.0.1:4341/' });
  let session = initialSession;
  const calls = [];
  let sequence = 0;
  const controller = mountForocromos({ documentRef: dom.window.document, windowRef: dom.window, getSession: () => session, uuid: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`, fetchImpl: async (path, options) => {
    calls.push({ path, options });
    const handled = await handler(path, options);
    if (handled !== undefined) return handled;
    if (path.endsWith('/me')) return json({ member: { id: session.user.id, alias: session.user.id === 'alice' ? 'Compañera A' : 'Compañera B', role: session.user.id === 'alice' ? 'moderator' : 'member' } });
    if (path.endsWith('/categories')) return json({ categories });
    if (path.includes('/topics?')) return json({ topics: [topic()], total: 1, has_more: false });
    if (path.includes('/reports?')) return json({ reports: [], total: 0, has_more: false });
    if (/\/topics\/[^/?]+\?/u.test(path)) return json({ topic: topic(path.split('/topics/')[1].split('?')[0]), replies: [], total: 0, has_more: false });
    throw new Error(`Unexpected request ${path}`);
  } });
  t.after(() => { controller.destroy(); dom.window.close(); });
  const $ = selector => dom.window.document.querySelector(selector);
  const $$ = selector => [...dom.window.document.querySelectorAll(selector)];
  function setSession(next) { session = next; dom.window.dispatchEvent(new dom.window.CustomEvent('sx:session', { detail: next })); }
  function input(selector, value) { const node = $(selector); node.value = value; node.dispatchEvent(new dom.window.Event('input', { bubbles: true })); }
  function submit(selector) { $(selector).dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); }
  function namedButton(text, scope = controller.panel) { return [...scope.querySelectorAll('button')].find(node => node.textContent === text); }
  return { dom, controller, $, $$, calls, setSession, input, submit, namedButton };
}

test('no session makes no community requests; an external account sees no community content', async t => {
  const h = harness(t, async path => path.endsWith('/me') ? json({ error: 'denied' }, 403) : undefined, null);
  assert.equal(h.controller.panel.hidden, true);
  assert.equal(h.calls.length, 0);
  h.setSession(outsider);
  await flush();
  assert.equal(h.controller.panel.hidden, false);
  assert.equal(h.$('.fc-space').hidden, true);
  assert.equal(h.$('#fc-topics').children.length, 0);
  assert.match(h.$('#fc-status').textContent, /no tiene acceso/u);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].path, '/forocromos/v1/me');
});

test('membership gates categories and topics; API credentials do not expose emails to the community', async t => {
  const h = harness(t);
  await flush();
  assert.equal(h.$('.fc-space').hidden, false);
  assert.match(h.$('#fc-identity').textContent, /Compañera A.*moderadora/u);
  assert.equal(h.$('#fc-moderation-button').hidden, false);
  assert.equal(h.$('#fc-category').options.length, 4);
  assert.equal(h.$('#fc-topics').children.length, 1);
  assert.doesNotMatch(h.controller.panel.textContent, /not-for-publication|@example/u);
  for (const call of h.calls) {
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.cache, 'no-store');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.headers.Authorization, 'Bearer alice-token');
    assert.equal(call.options.headers.apikey, 'local-public-test');
  }
});

test('maintained Markdown and sanitizer render formatting but no HTML, images, previews or unsafe links', () => {
  const dom = new JSDOM('<!doctype html><main></main>', { url: 'http://127.0.0.1:4341/' });
  try {
    const render = createMarkdownRenderer(dom.window);
    const host = dom.window.document.querySelector('main');
    host.append(render('**Claro**\n\n<script>alert(1)</script><img src="https://tracker.example.invalid/pixel">\n\n![imagen](https://tracker.example.invalid/second)\n\n[Salir](https://example.invalid/a) [relativo](/secret) [correo](mailto:test@example.invalid) [credenciales](https://user:pass@example.invalid) [peligro](javascript:alert(1))\n\nhttps://plain.example.invalid'));
    assert.equal(host.querySelector('strong').textContent, 'Claro');
    assert.equal(host.querySelector('img,script,iframe,svg,style,video,audio'), null);
    const links = [...host.querySelectorAll('a')];
    assert.ok(links.length >= 1);
    for (const link of links) {
      assert.match(link.href, /^https?:\/\//u);
      assert.equal(new URL(link.href).username, '');
      assert.equal(link.target, '_blank');
      assert.equal(link.rel, 'noopener noreferrer');
      assert.equal(link.getAttribute('referrerpolicy'), 'no-referrer');
    }
    assert.equal(links.some(link => link.textContent === 'correo' || link.textContent === 'relativo' || link.textContent === 'credenciales'), false);
    assert.equal(links.some(link => link.href.includes('plain.example.invalid')), false, 'bare URLs do not become automatic links');
  } finally { dom.window.close(); }
});

test('topic form retains drafts across navigation and failed requests; unchanged retry keeps its operation id and current token', async t => {
  let failed = true;
  let saved;
  const h = harness(t, async (path, options) => {
    if (path === '/forocromos/v1/topics' && options.method === 'POST') {
      if (failed) { failed = false; throw new TypeError('network down'); }
      saved = JSON.parse(options.body);
      return json({ topic: topic('created', { ...saved, author: { id: 'alice', alias: 'Compañera A' } }) }, 201);
    }
    if (path.startsWith('/forocromos/v1/topics/created?')) return json({ topic: topic('created', saved), replies: [], total: 0, has_more: false });
  });
  await flush();
  h.$('#fc-new-topic').click();
  h.input('#fc-topic-title', 'Una pregunta cotidiana');
  h.input('#fc-topic-body', 'Un texto que quiero conservar');
  h.$('#fc-topics-button').click();
  await flush();
  h.$('#fc-new-topic').click();
  assert.equal(h.$('#fc-topic-body').value, 'Un texto que quiero conservar');
  h.submit('#fc-topic-form');
  assert.equal(h.$('#fc-publish-topic').disabled, true);
  await flush();
  assert.equal(h.$('#fc-topic-title').value, 'Una pregunta cotidiana');
  assert.equal(h.$('#fc-publish-topic').disabled, false);
  assert.match(h.$('#fc-status').textContent, /borrador se conserva/u);
  const first = JSON.parse(h.calls.find(call => call.options.method === 'POST').options.body);
  h.setSession({ ...alice, access_token: 'fresh-token' });
  h.submit('#fc-topic-form');
  await flush();
  const posts = h.calls.filter(call => call.options.method === 'POST');
  assert.equal(posts.length, 2);
  assert.deepEqual(JSON.parse(posts[1].options.body), first);
  assert.equal(posts[1].options.headers.Authorization, 'Bearer fresh-token');
  assert.equal(Object.hasOwn(first, 'author'), false);
  assert.equal(Object.hasOwn(first, 'user_id'), false);
  assert.equal(h.$('#fc-topic-body').value, '');
  assert.match(h.$('#fc-thread').textContent, /Una pregunta cotidiana/u);
  assert.match(h.$('#fc-status').textContent, /Tema publicado/u);
});

test('editing a failed topic draft starts a new idempotent operation', async t => {
  const h = harness(t, async (_path, options) => { if (options.method === 'POST') return json({}, 409); });
  await flush();
  h.$('#fc-new-topic').click();
  h.input('#fc-topic-title', 'Título'); h.input('#fc-topic-body', 'Antes'); h.submit('#fc-topic-form');
  await flush();
  h.input('#fc-topic-body', 'Después'); h.submit('#fc-topic-form');
  await flush();
  const posts = h.calls.filter(call => call.options.method === 'POST').map(call => JSON.parse(call.options.body));
  assert.notEqual(posts[0].client_request_id, posts[1].client_request_id);
  assert.equal(h.$('#fc-topic-body').value, 'Después');
});

test('reply drafts are scoped to each topic and retained on failure; locked topics disable replying', async t => {
  const h = harness(t, async (path, options) => {
    if (options.method === 'POST') return json({}, 409);
    if (path.startsWith('/forocromos/v1/topics/locked?')) return json({ topic: topic('locked', { locked: true }), replies: [], has_more: false, total: 0 });
  });
  await flush();
  await h.controller.openTopic('one');
  h.input('#fc-reply-body', 'Borrador del primer tema');
  await h.controller.openTopic('two');
  assert.equal(h.$('#fc-reply-body').value, '');
  h.input('#fc-reply-body', 'Borrador del segundo');
  await h.controller.openTopic('one');
  assert.equal(h.$('#fc-reply-body').value, 'Borrador del primer tema');
  h.submit('#fc-reply-form');
  await flush();
  assert.equal(h.$('#fc-reply-body').value, 'Borrador del primer tema');
  assert.match(h.$('#fc-status').textContent, /borrador se conserva/u);
  await h.controller.openTopic('locked');
  assert.equal(h.$('#fc-reply-form').hidden, true);
  assert.match(h.$('#fc-thread-notice').textContent, /cerrado/u);
  const before = h.calls.length;
  h.submit('#fc-reply-form');
  await flush();
  assert.equal(h.calls.length, before);
});

test('successful reply clears only its own draft and uses a server-owned author', async t => {
  let posted = false;
  const h = harness(t, async (path, options) => {
    if (path.endsWith('/one/replies')) { posted = true; return json({ reply: reply() }, 201); }
    if (path.startsWith('/forocromos/v1/topics/one?')) return json({ topic: topic(), replies: posted ? [reply()] : [], total: posted ? 1 : 0, has_more: false });
  });
  await flush(); await h.controller.openTopic('one');
  h.input('#fc-reply-body', 'Una respuesta'); h.submit('#fc-reply-form');
  await flush();
  assert.equal(h.$('#fc-reply-body').value, '');
  assert.match(h.$('#fc-replies').textContent, /Una respuesta/u);
  const post = JSON.parse(h.calls.find(call => call.path.endsWith('/one/replies')).options.body);
  assert.deepEqual(Object.keys(post).sort(), ['body', 'client_request_id']);
  assert.match(h.$('#fc-status').textContent, /Respuesta publicada/u);
});

test('switching accounts aborts and discards a late response; former controls cannot issue requests with a new account', async t => {
  const late = deferred();
  let first = true;
  const h = harness(t, async path => {
    if (path.startsWith('/forocromos/v1/topics/one?') && first) { first = false; return late.promise; }
  });
  await flush();
  const oldButton = h.$('#fc-topics .fc-topic-open');
  const opening = h.controller.openTopic('one');
  const oldCall = h.calls.at(-1);
  h.setSession(bob);
  await flush();
  assert.equal(oldCall.options.signal.aborted, true);
  const before = h.calls.length;
  oldButton.click();
  await flush();
  assert.equal(h.calls.length, before);
  late.resolve(json({ topic: topic('one', { body: 'PRIVATE ALICE CONTENT' }), replies: [], total: 0, has_more: false }));
  await opening;
  assert.doesNotMatch(h.controller.panel.textContent, /PRIVATE ALICE CONTENT/u);
  assert.match(h.$('#fc-identity').textContent, /Compañera B/u);
  assert.equal(h.$('#fc-moderation-button').hidden, true);
});

test('logout and account switching erase drafts and previous content without storing private browser data', async t => {
  const h = harness(t);
  await flush();
  h.$('#fc-new-topic').click(); h.input('#fc-topic-title', 'Sólo de A'); h.input('#fc-topic-body', 'Borrador íntimo');
  await h.controller.openTopic('one'); h.input('#fc-reply-body', 'Respuesta íntima');
  h.setSession(null);
  assert.equal(h.controller.panel.hidden, true);
  assert.equal(h.$('#fc-thread').textContent, '');
  assert.equal(h.$('#fc-topics').textContent, '');
  assert.equal(h.$('#fc-topic-body').value, '');
  assert.equal(h.$('#fc-reply-body').value, '');
  h.setSession(bob); await flush();
  h.$('#fc-new-topic').click();
  assert.equal(h.$('#fc-topic-title').value, '');
  await h.controller.openTopic('one');
  assert.equal(h.$('#fc-reply-body').value, '');
  assert.equal(h.dom.window.localStorage.length, 0);
  assert.equal(h.dom.window.sessionStorage.length, 0);
});

test('category, search and pagination use encoded same-origin queries and append without duplicate cards', async t => {
  const h = harness(t, async path => {
    if (!path.includes('/topics?')) return;
    const parsed = new URL(path, 'http://127.0.0.1:4341');
    if (parsed.searchParams.get('offset') === '20') return json({ topics: [topic('19'), topic('next')], total: 21, has_more: false });
    return json({ topics: Array.from({ length: 20 }, (_, i) => topic(String(i))), total: 21, has_more: true });
  });
  await flush();
  assert.equal(h.$('#fc-more-topics').hidden, false);
  h.$('#fc-more-topics').click(); await flush();
  assert.equal(h.$('#fc-topics').children.length, 21);
  assert.equal(h.$('#fc-more-topics').hidden, true);
  h.$('#fc-category').value = 'vida-practica';
  h.input('#fc-search', 'dudas & categoría / ?');
  h.submit('#fc-search-form'); await flush();
  const query = new URL(h.calls.at(-1).path, 'http://127.0.0.1:4341').searchParams;
  assert.equal(query.get('category'), 'vida-practica');
  assert.equal(query.get('q'), 'dudas & categoría / ?');
  assert.equal(query.get('offset'), '0');
});

test('reply pagination preserves the topic, deduplicates responses and retains an unsent reply draft', async t => {
  const h = harness(t, async path => {
    if (!path.startsWith('/forocromos/v1/topics/one?')) return;
    const offset = new URL(path, 'http://127.0.0.1:4341').searchParams.get('offset');
    return json({ topic: topic(), replies: offset === '0' ? [reply('r1')] : [reply('r1'), reply('r2')], total: 2, has_more: offset === '0' });
  });
  await flush(); await h.controller.openTopic('one');
  h.input('#fc-reply-body', 'Sin enviar');
  h.$('#fc-more-replies').click(); await flush();
  assert.equal(h.$('#fc-replies').children.length, 2);
  assert.equal(h.$('#fc-thread .fc-post').dataset.postId, 'one');
  assert.equal(h.$('#fc-reply-body').value, 'Sin enviar');
  assert.equal(h.$('#fc-more-replies').hidden, true);
});

test('withdrawing an own post requires confirmation and preserves other authors responses as tombstones appear', async t => {
  let withdrawn = false;
  const h = harness(t, async (path, options) => {
    if (path === '/forocromos/v1/topics/own' && options.method === 'DELETE') { withdrawn = true; return json({ topic: topic('own', { withdrawn: true }) }); }
    if (path.startsWith('/forocromos/v1/topics/own?')) return json({ topic: topic('own', withdrawn ? { title: 'Retirado por su autora', body: '', author: null, withdrawn: true, locked: true } : { author: { id: 'alice', alias: 'Compañera A' } }), replies: [reply('someone-else', { author: { id: 'bob', alias: 'Compañera B' }, body: 'Mi respuesta se conserva' })], total: 1, has_more: false });
  });
  await flush(); await h.controller.openTopic('own');
  h.$('#fc-thread .fc-withdraw').click();
  assert.equal(h.calls.some(call => call.options.method === 'DELETE'), false);
  h.$('#fc-thread .fc-confirm .text-button').click();
  assert.equal(h.$('#fc-thread .fc-confirm'), null);
  h.$('#fc-thread .fc-withdraw').click();
  h.$('#fc-thread .fc-confirm .secondary').click(); await flush();
  assert.equal(h.calls.filter(call => call.options.method === 'DELETE').length, 1);
  assert.match(h.$('#fc-thread').textContent, /Retirado por su autora/u);
  assert.match(h.$('#fc-replies').textContent, /Mi respuesta se conserva/u);
  assert.equal(h.$('#fc-reply-form').hidden, true);
});

test('confidential report needs review and explicit confirmation, retains reason on error and never appends a public response', async t => {
  let fail = true;
  const h = harness(t, async (path, options) => {
    if (path.endsWith('/reports') && options.method === 'POST') {
      if (fail) { fail = false; return json({}, 500); }
      return json({ report: { id: 'report-one' } }, 201);
    }
  });
  await flush(); await h.controller.openTopic('one');
  h.namedButton('Avisar a moderación', h.$('#fc-thread')).click();
  h.input('.fc-report-form textarea', 'Motivo que no debe hacerse público');
  h.submit('.fc-report-form');
  assert.equal(h.calls.some(call => call.options.method === 'POST'), false);
  h.$('.fc-report-form .fc-confirm .secondary').click(); await flush();
  assert.equal(h.$('.fc-report-form textarea').value, 'Motivo que no debe hacerse público');
  assert.equal(h.$('.fc-report-form .fc-confirm .secondary').disabled, false);
  h.$('.fc-report-form .fc-confirm .secondary').click(); await flush();
  assert.equal(h.$('.fc-report-form'), null);
  assert.equal(h.$('#fc-replies').children.length, 0);
  assert.doesNotMatch(h.$('#fc-thread').textContent, /Motivo que no debe/u);
  const reportCall = h.calls.find(call => call.options.method === 'POST');
  assert.deepEqual(JSON.parse(reportCall.options.body), { topic_id: 'one', reply_id: null, reason: 'Motivo que no debe hacerse público' });
  assert.match(h.$('#fc-status').textContent, /No se ha publicado en el tema/u);
});

test('moderation is role-gated and report resolution requires an explicit decision', async t => {
  const report = { id: 'report-one', topic_id: 'one', reply_id: null, reporter: { id: 'bob', alias: 'Compañera B' }, reason: '<img src=x> Texto del motivo', created_at: '2026-10-21T13:00:00.000Z', target: { type: 'topic', id: 'one', title: 'Título comunicado', body: '**Revisar** <script>mal</script>', author: { id: 'bob', alias: 'Compañera B' } } };
  let resolved = false;
  const h = harness(t, async (path, options) => {
    if (path.includes('/forocromos/v1/reports?')) return json({ reports: resolved ? [] : [report], total: resolved ? 0 : 1, has_more: false });
    if (path === '/forocromos/v1/reports/report-one/resolve') { resolved = true; return json({ report: { ...report, status: 'resolved' } }); }
  });
  await flush();
  h.$('#fc-moderation-button').click(); await flush();
  assert.match(h.$('#fc-reports').textContent, /Título comunicado/u);
  assert.equal(h.$('#fc-reports img, #fc-reports script'), null);
  h.namedButton('Ocultar publicación', h.$('#fc-reports')).click();
  assert.equal(h.calls.some(call => call.path.endsWith('/resolve')), false);
  h.$('#fc-reports .fc-confirm .secondary').click(); await flush();
  const decision = h.calls.find(call => call.path.endsWith('/resolve'));
  assert.deepEqual(JSON.parse(decision.options.body), { action: 'hide' });
  assert.equal(h.$('#fc-reports').children.length, 0);
  assert.equal(h.$('.fc-moderation-view .fc-empty').hidden, false);
  h.setSession(bob); await flush();
  const before = h.calls.length;
  h.$('#fc-moderation-button').click(); await flush();
  assert.equal(h.calls.length, before);
  assert.equal(h.$('#fc-moderation-button').hidden, true);
});

test('moderator can close a thread after confirmation and the reply form reflects the result', async t => {
  let locked = false;
  const h = harness(t, async (path, options) => {
    if (path.endsWith('/topics/one/moderation')) { locked = JSON.parse(options.body).action === 'lock'; return json({ topic: topic('one', { locked }) }); }
    if (path.startsWith('/forocromos/v1/topics/one?')) return json({ topic: topic('one', { locked }), replies: [], total: 0, has_more: false });
  });
  await flush(); await h.controller.openTopic('one');
  h.namedButton('Cerrar respuestas', h.$('#fc-thread')).click();
  assert.equal(locked, false);
  h.$('#fc-thread .fc-moderation-confirm .secondary').click(); await flush();
  assert.equal(locked, true);
  assert.equal(h.$('#fc-reply-form').hidden, true);
  assert.ok(h.namedButton('Reabrir respuestas', h.$('#fc-thread')));
});

test('a denied refresh clears previously visible private content', async t => {
  let revoked = false;
  const h = harness(t, async path => { if (revoked && path.includes('/topics?')) return json({}, 403); });
  await flush();
  assert.equal(h.$('#fc-topics').children.length, 1);
  revoked = true;
  await h.controller.refresh();
  assert.equal(h.$('.fc-space').hidden, true);
  assert.equal(h.$('#fc-topics').children.length, 0);
  assert.equal(h.$('#fc-thread').children.length, 0);
  assert.match(h.$('#fc-status').textContent, /no tiene acceso/u);
});

test('a late accepted topic list cannot repopulate the same account after membership is denied', async t => {
  const late = deferred();
  let reads = 0;
  const h = harness(t, async path => {
    if (!path.includes('/topics?')) return;
    reads++;
    if (reads === 1) return late.promise;
    if (reads === 2) return json({}, 403);
  });
  await flush();
  const pendingList = h.calls.find(call => call.path.includes('/topics?'));
  await h.controller.refresh();
  assert.equal(pendingList.options.signal.aborted, true);
  assert.equal(h.$('.fc-space').hidden, true);
  late.resolve(json({ topics: [topic('late', { title: 'PRIVATE LATE LIST' })], total: 1, has_more: false }));
  await flush();
  assert.equal(h.$('.fc-space').hidden, true);
  assert.equal(h.$('#fc-topics').children.length, 0);
  assert.doesNotMatch(h.controller.panel.textContent, /PRIVATE LATE LIST/u);
  const before = h.calls.length;
  await h.controller.refresh();
  assert.equal(h.calls[before].path, '/forocromos/v1/me', 'reopening requires a fresh membership check');
  assert.equal(h.$('.fc-space').hidden, false);
});

test('a late accepted membership response cannot reopen after a newer rejection', async t => {
  const late = deferred();
  let membershipChecks = 0;
  const h = harness(t, async path => {
    if (!path.endsWith('/me')) return;
    membershipChecks++;
    if (membershipChecks === 1) return late.promise;
    return json({}, 403);
  });
  await h.controller.refresh();
  assert.equal(h.calls[0].options.signal.aborted, true);
  late.resolve(json({ member: { id: 'alice', alias: 'PRIVATE OLD MEMBER', role: 'moderator' } }));
  await flush();
  assert.equal(h.$('.fc-space').hidden, true);
  assert.equal(h.calls.filter(call => call.path.endsWith('/categories')).length, 0);
  assert.doesNotMatch(h.controller.panel.textContent, /PRIVATE OLD MEMBER/u);
});

test('a topic published after navigating elsewhere does not replace the chosen thread', async t => {
  const pending = deferred();
  const h = harness(t, async (_path, options) => { if (options.method === 'POST') return pending.promise; });
  await flush();
  h.$('#fc-new-topic').click(); h.input('#fc-topic-title', 'Nuevo título'); h.input('#fc-topic-body', 'Nuevo contenido'); h.submit('#fc-topic-form');
  await h.controller.openTopic('another');
  assert.match(h.$('#fc-thread').textContent, /Tema another/u);
  pending.resolve(json({ topic: topic('created') }, 201)); await flush();
  assert.match(h.$('#fc-thread').textContent, /Tema another/u);
  assert.equal(h.calls.some(call => call.path.includes('/topics/created?')), false);
  assert.match(h.$('#fc-status').textContent, /Lo encontrarás en Temas/u);
});

test('more than one page of confidential reports remains reachable after resolving visible reports', async t => {
  let pending = Array.from({ length: 21 }, (_, index) => ({ id: `report-${index}`, topic_id: 'one', reply_id: null, reporter: { id: 'bob', alias: 'Compañera B' }, reason: `Motivo ${index}`, target: { type: 'topic', id: 'one', title: `Publicación ${index}`, body: 'Texto', author: { id: 'bob', alias: 'Compañera B' } } }));
  const h = harness(t, async (path, options) => {
    if (path.includes('/reports?')) {
      const params = new URL(path, 'http://127.0.0.1:4341/').searchParams;
      const offset = Number(params.get('offset'));
      const limit = Number(params.get('limit'));
      return json({ reports: pending.slice(offset, offset + limit), total: pending.length, has_more: offset + limit < pending.length });
    }
    if (path.endsWith('/resolve')) {
      const id = path.split('/reports/')[1].split('/')[0];
      pending = pending.filter(report => report.id !== id);
      return json({ report: { id, status: 'resolved' } });
    }
  });
  await flush(); h.$('#fc-moderation-button').click(); await flush();
  assert.equal(h.$('#fc-reports').children.length, 20);
  assert.equal(h.$('#fc-more-reports').hidden, false);
  h.$('#fc-more-reports').click(); await flush();
  assert.equal(h.$('#fc-reports').children.length, 21);
  assert.equal(h.$('#fc-more-reports').hidden, true);
  for (let index = 0; index < 20; index++) {
    h.namedButton('Cerrar aviso sin ocultar', h.$('#fc-reports li')).click();
    h.$('#fc-reports .fc-confirm .secondary').click(); await flush();
    assert.equal(h.$('.fc-moderation-view .fc-empty').hidden, true);
  }
  assert.equal(pending.length, 1);
  assert.equal(h.$('#fc-reports').children.length, 1);
  assert.equal(h.$('#fc-reports li').dataset.reportId, 'report-20');
  h.namedButton('Cerrar aviso sin ocultar', h.$('#fc-reports li')).click();
  h.$('#fc-reports .fc-confirm .secondary').click(); await flush();
  assert.equal(h.$('.fc-moderation-view .fc-empty').hidden, false);
  assert.equal(h.$('#fc-reports').children.length, 0);
});
