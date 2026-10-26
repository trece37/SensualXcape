import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createForum } from '../forum/forum.js';

const html = await readFile(new URL('../forum/index.html', import.meta.url), 'utf8');
const session = id => ({ user: { id } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const first = { id: 'one', category: 'cuidado', title: 'PRIVATE TITLE ONE', body: 'PRIVATE BODY ONE', author_id: 'a', editorial: false, pinned: false, closed: false, hidden: false, withdrawn_at: null, created_at: '2026-10-26T12:00:00Z' };
const second = { ...first, id: 'two', title: 'Second conversation', body: 'Second body', author_id: 'b' };

function harness(t, { rpc, query, auth = {}, role = 'member' } = {}) {
  const dom = new JSDOM(html, { url: 'https://example.invalid/foro/', pretendToBeVisual: true });
  const { window } = dom, document = window.document;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.confirm = () => true;
  const people = new Map([
    ['a', { user_id: 'a', alias: 'Alias A', status: 'active', role }],
    ['b', { user_id: 'b', alias: 'Alias B', status: 'active', role: 'member' }],
    ['pending', { user_id: 'pending', alias: 'Pending', status: 'pending', role: 'member' }],
  ]);
  const records = { fc_members: [...people.values()], fc_topics: [first, second], fc_replies: [], fc_reports: [], fc_saved: [] };
  const calls = [];
  let actor = null;
  const client = {
    auth: {
      getSession: async () => ({ data: { session: null } }),
      getUser: async () => ({ data: { user: { id: actor } } }),
      signOut: async () => ({ error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      ...auth,
    },
    async rpc(name, args) {
      calls.push({ name, args, actor });
      if (rpc) return rpc(name, args, actor);
      return { data: { ok: true }, error: null };
    },
    from(table) {
      const spec = { table, fields: '*', eq: {}, in: {}, is: {}, range: null, limit: null, single: false };
      const q = {
        select(fields) { spec.fields = fields; return q; },
        eq(key, value) { spec.eq[key] = value; return q; },
        in(key, values) { spec.in[key] = values; return q; },
        is(key, value) { spec.is[key] = value; return q; },
        ilike() { return q; }, order() { return q; },
        range(start, end) { spec.range = [start, end]; return q; },
        limit(value) { spec.limit = value; return q; },
        maybeSingle() { spec.single = true; return q; },
        async then(resolve, reject) {
          try {
            const override = query ? await query(spec, actor) : undefined;
            if (override !== undefined) return resolve(override);
            let rows = (records[table] || []).filter(row => Object.entries(spec.eq).every(([key, value]) => row[key] === value)
              && Object.entries(spec.in).every(([key, values]) => values.includes(row[key]))
              && Object.entries(spec.is).every(([key, value]) => row[key] === value));
            const count = rows.length;
            if (spec.range) rows = rows.slice(spec.range[0], spec.range[1] + 1);
            if (spec.limit !== null) rows = rows.slice(0, spec.limit);
            return resolve({ data: structuredClone(spec.single ? rows[0] ?? null : rows), count, error: null });
          } catch (error) { return reject(error); }
        },
      };
      return q;
    },
  };
  const forum = createForum({ client, doc: document, win: window });
  const $ = selector => document.querySelector(selector);
  const button = (label, scope = document) => [...scope.querySelectorAll('button')].find(node => node.textContent === label);
  const submit = selector => $(selector).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const login = async id => { actor = id; await forum.syncSession(id ? session(id) : null); };
  t.after(() => { forum.destroy(); window.close(); });
  return { forum, document, window, records, people, calls, $, button, submit, login };
}

test('team trial buttons select the account and clear and focus the password without authenticating until form submission', async t => {
  const authCalls = [];
  const h = harness(t, { auth: {
    signInWithPassword: async credentials => { authCalls.push({ method: 'login', credentials }); return { data: { session: null }, error: null }; },
    signUp: async credentials => { authCalls.push({ method: 'signup', credentials }); return { data: {}, error: null }; },
    resetPasswordForEmail: async email => { authCalls.push({ method: 'recover', email }); return { error: null }; },
  } });
  for (const [index, [name, email]] of [['Manel', 'manel@yo.com'], ['Walker', 'walker@yo.com']].entries()) {
    h.$('#login-open').click();
    const shortcut = h.button(name, h.$('#auth-dialog'));
    assert.equal(shortcut.type, 'button');
    h.$('#auth-password').value = 'previous-account-password';
    h.$('#auth-password').setCustomValidity('Previous signup validation');
    shortcut.click(); await flush();
    assert.equal(h.$('#auth-email').value, email);
    assert.equal(h.$('#auth-password').value, '');
    assert.equal(h.$('#auth-password').validity.customError, false);
    assert.equal(h.document.activeElement, h.$('#auth-password'));
    assert.equal(authCalls.length, index);
    h.$('#auth-password').value = `manually-entered-${name}`;
    h.submit('#auth-form'); await flush();
    assert.deepEqual(authCalls[index], { method: 'login', credentials: { email, password: `manually-entered-${name}` } });
    assert.equal(authCalls.length, index + 1);
  }
});

test('logout removes an open editor and all former topic text from DOM and form values', async t => {
  const h = harness(t); await h.login('a'); await h.forum.openTopic(first);
  h.button('Editar mi texto', h.$('#topic-controls')).click();
  assert.equal(h.$('#edit-dialog textarea').value, first.body);
  await h.login(null);
  assert.equal(h.$('#edit-dialog'), null);
  assert.equal(h.$('#topic-title').textContent, '');
  assert.equal(h.$('#topic-author').textContent, '');
  assert.doesNotMatch(h.document.body.textContent, /PRIVATE (?:BODY|TITLE) ONE/);
  assert.ok([...h.document.querySelectorAll('input,textarea')].every(node => !node.value.includes('PRIVATE')));
});

test('switching accounts removes an open editor and its private draft', async t => {
  const h = harness(t); await h.login('a'); await h.forum.openTopic(first);
  h.button('Editar mi texto', h.$('#topic-controls')).click();
  h.$('#edit-dialog textarea').value = 'UNSENT EDIT FOR A';
  await h.login('pending');
  assert.equal(h.$('#edit-dialog'), null);
  assert.doesNotMatch(h.document.body.textContent, /PRIVATE BODY ONE|UNSENT EDIT FOR A/);
});

test('late successful publication cannot repopulate private content after logout', async t => {
  const late = deferred(); const h = harness(t, { rpc: () => late.promise });
  await h.login('a');
  h.$('#topic-title-input').value = first.title; h.$('#topic-body-input').value = first.body;
  h.submit('#topic-form'); await flush();
  assert.equal(h.calls[0].name, 'fc_create_topic');
  await h.login(null); late.resolve({ data: first, error: null }); await flush();
  assert.equal(h.forum.getState().member, null);
  assert.equal(h.$('#topic-view').hidden, true);
  assert.doesNotMatch(h.document.body.textContent, /PRIVATE BODY ONE|PRIVATE TITLE ONE/);
});

test('late successful reply cannot reopen its former topic for a pending account', async t => {
  const late = deferred(); const h = harness(t, { rpc: () => late.promise });
  await h.login('a'); await h.forum.openTopic(first);
  h.$('#reply-body').value = 'PRIVATE UNSENT RESPONSE'; h.submit('#reply-form'); await flush();
  await h.login('pending'); late.resolve({ data: { id: 'reply' }, error: null }); await flush();
  assert.equal(h.forum.getState().member.status, 'pending');
  assert.equal(h.$('#topic-view').hidden, true);
  assert.doesNotMatch(h.document.body.textContent, /PRIVATE BODY ONE|PRIVATE UNSENT RESPONSE/);
});

test('the public preview rejects a remote topic object even if it is labelled editorial', async t => {
  const h = harness(t);
  await h.forum.openTopic({ ...first, editorial: true });
  assert.equal(h.$('#topic-view').hidden, true);
  assert.doesNotMatch(h.document.body.textContent, /PRIVATE BODY ONE/);
  await h.forum.openTopic({ ...first, id: 'opening-lista-negra', editorial: true });
  assert.equal(h.$('#topic-view').hidden, false);
  assert.doesNotMatch(h.$('#topic-body').textContent, /PRIVATE BODY ONE/);
});

test('revoking moderator role with active membership clears confidential reports on the next poll', async t => {
  const h = harness(t, { role: 'moderator' });
  h.records.fc_reports.push({ id: 'notice', reporter_id: 'b', body: 'CONFIDENTIAL MODERATION ONLY', status: 'open', created_at: first.created_at });
  await h.login('a'); h.$('#moderation-button').click(); await flush();
  assert.match(h.$('#moderation-list').textContent, /CONFIDENTIAL MODERATION ONLY/);
  h.people.get('a').role = 'member'; h.window.dispatchEvent(new h.window.Event('online')); await flush();
  assert.equal(h.forum.getState().member.role, 'member');
  assert.equal(h.$('#moderation-panel').hidden, true);
  assert.equal(h.$('#moderation-button').hidden, true);
  assert.doesNotMatch(h.document.body.textContent, /CONFIDENTIAL MODERATION ONLY/);
});

test('an authorization failure during polling clears formerly readable private content', async t => {
  let expired = false;
  const h = harness(t, { query: spec => expired && spec.table === 'fc_members' && spec.single
    ? { data: null, error: { message: 'JWT expired', code: 'PGRST301', status: 401 } } : undefined });
  await h.login('a'); await h.forum.openTopic(first); expired = true;
  h.window.dispatchEvent(new h.window.Event('online')); await flush();
  assert.equal(h.$('#topic-view').hidden, true);
  assert.doesNotMatch(h.document.body.textContent, /PRIVATE BODY ONE|PRIVATE TITLE ONE/);
  assert.equal(h.$('#new-topic-button').hidden, true);
});

test('reply drafts belong to their own conversation across navigation', async t => {
  const h = harness(t); await h.login('a'); await h.forum.openTopic(first);
  h.$('#reply-body').value = 'DRAFT FOR FIRST TOPIC';
  h.$('#reply-body').dispatchEvent(new h.window.Event('input', { bubbles: true }));
  h.$('#back-topics').click(); await flush(); await h.forum.openTopic(second);
  assert.equal(h.$('#reply-body').value, '');
  h.$('#reply-body').value = 'DRAFT FOR SECOND TOPIC';
  h.$('#reply-body').dispatchEvent(new h.window.Event('input', { bubbles: true }));
  await h.forum.openTopic(first);
  assert.equal(h.$('#reply-body').value, 'DRAFT FOR FIRST TOPIC');
});

test('failed publication keeps its input and exposes a useful visible status', async t => {
  const h = harness(t, { rpc: async () => ({ data: null, error: new TypeError('Failed to fetch') }) });
  await h.login('a');
  h.$('#topic-title-input').value = first.title; h.$('#topic-body-input').value = first.body;
  h.submit('#topic-form'); await flush();
  assert.equal(h.$('#topic-body-input').value, first.body);
  assert.match(h.$('#topic-form-status').textContent, /Tu texto sigue aquí/);
  assert.ok([...h.$('#topic-form').querySelectorAll('button')].every(node => !node.disabled));
});

test('hostile body, alias and reply strings render as text without HTML or remote previews', async t => {
  const h = harness(t);
  const hostile = '<img src="https://tracker.example.invalid/pixel" onerror="alert(1)"><script>alert(2)</script>[open](javascript:alert(3))';
  h.records.fc_topics[0] = { ...first, body: hostile };
  h.people.get('a').alias = '<svg/onload=alert(4)>';
  h.records.fc_replies.push({ id: 'r', topic_id: first.id, author_id: 'a', body: hostile, hidden: false, withdrawn_at: null, created_at: first.created_at });
  await h.login('a'); await h.forum.openTopic(first);
  assert.equal(h.$('#topic-body').textContent, hostile);
  assert.match(h.$('#topic-author').textContent, /<svg\/onload=alert\(4\)>/);
  assert.equal(h.$('#topic-view').querySelector('img,svg,script,iframe,a,video,audio'), null);
});

test('reply pagination reaches the final response and keeps the unsent reply', async t => {
  const h = harness(t);
  h.records.fc_replies.push(...Array.from({ length: 121 }, (_, index) => ({ id: `reply-${index}`, topic_id: first.id, author_id: 'b', body: `REPLY NUMBER ${index}`, hidden: false, withdrawn_at: null, created_at: first.created_at })));
  await h.login('a'); await h.forum.openTopic(first);
  h.$('#reply-body').value = 'DRAFT WHILE READING';
  h.$('#reply-body').dispatchEvent(new h.window.Event('input', { bubbles: true }));
  for (let index = 0; index < 2; index++) { h.button('Respuestas siguientes →', h.$('#topic-posts')).click(); await flush(); }
  assert.match(h.$('#topic-posts').textContent, /REPLY NUMBER 120/);
  assert.equal(h.$('#reply-body').value, 'DRAFT WHILE READING');
});

test('a confidential reply report exposes its actual target and hides only that reply', async t => {
  let h;
  h = harness(t, { role: 'moderator', rpc: async (name, args) => {
    if (name === 'fc_moderate' && args.p_action === 'reply_hide') h.records.fc_replies.find(row => row.id === args.p_target_id).hidden = true;
    return { data: { ok: true }, error: null };
  } });
  h.records.fc_replies.push({ id: 'reported-reply', topic_id: first.id, author_id: 'b', body: 'REPORTED REPLY TEXT', hidden: false, withdrawn_at: null, created_at: first.created_at });
  h.records.fc_reports.push({ id: 'notice', reporter_id: 'a', topic_id: null, reply_id: 'reported-reply', body: 'PRIVATE REASON', status: 'open', created_at: first.created_at });
  await h.login('a'); h.$('#moderation-button').click(); await flush();
  const list = h.$('#moderation-list');
  assert.match(list.textContent, /PRIVATE REASON/);
  assert.match(list.textContent, /PRIVATE TITLE ONE/);
  assert.match(list.textContent, /Alias B: REPORTED REPLY TEXT/);
  h.button('Ocultar respuesta señalada', list).click(); await flush();
  assert.deepEqual(h.calls.find(call => call.name === 'fc_moderate').args, { p_action: 'reply_hide', p_target_id: 'reported-reply' });
  assert.equal(h.records.fc_topics[0].hidden, false);
});

test('admission pagination reaches requests beyond the previous 250 member limit', async t => {
  const h = harness(t, { role: 'moderator' });
  h.records.fc_members.push(...Array.from({ length: 300 }, (_, index) => ({ user_id: `candidate-${index}`, alias: `Candidate ${index}`, status: 'pending', role: 'member', created_at: first.created_at })));
  await h.login('a'); h.$('#moderation-button').click(); await flush();
  for (let index = 0; index < 6; index++) { h.button('Siguientes →', h.$('#moderation-list')).click(); await flush(); }
  assert.match(h.$('#moderation-list').textContent, /Candidate 299/);
});
