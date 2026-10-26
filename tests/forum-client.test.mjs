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

function harness(t, { rpc, activityRpc, query, auth = {}, role = 'member', storage = {}, policy = { attachment_limit: 950000, founder: false }, profileQuery, pushSupport = false } = {}) {
  const dom = new JSDOM(html, { url: 'https://example.invalid/foro/', pretendToBeVisual: true });
  const { window } = dom, document = window.document;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.confirm = () => true;
  const revoked = []; let urlId = 0;
  window.URL.createObjectURL = () => `blob:private-${++urlId}`;
  window.URL.revokeObjectURL = url => revoked.push(url);
  if(pushSupport){
    window.PushManager=class{};window.Notification={permission:'granted'};
    window.MessageChannel=class{constructor(){this.port1={onmessage:null,close(){}};this.port2={postMessage:data=>queueMicrotask(()=>this.port1.onmessage?.({data}))};}};
    const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/private-test',unsubscribe:async()=>true};
    const registration={active:{postMessage:(_,ports)=>ports[0].postMessage({ok:true})},pushManager:{getSubscription:async()=>subscription}};
    Object.defineProperty(window.navigator,'serviceWorker',{value:{getRegistration:async()=>registration,addEventListener(){},removeEventListener(){}}});
  }
  const people = new Map([
    ['a', { user_id: 'a', alias: 'Alias A', status: 'active', role }],
    ['b', { user_id: 'b', alias: 'Alias B', status: 'active', role: 'member' }],
    ['pending', { user_id: 'pending', alias: 'Pending', status: 'pending', role: 'member' }],
  ]);
  const records = { fc_members: [...people.values()], fc_topics: structuredClone([first, second]), fc_replies: [], fc_reports: [], fc_saved: [], fc_files: [] };
  const calls = [];
  let actor = null;
  const client = {
    storage: { from: bucket => ({
      download: path => storage.download ? storage.download(bucket, path) : Promise.resolve({ data: new window.Blob(['test']), error: null }),
      upload: (path, bytes, options) => storage.upload ? storage.upload(bucket, path, bytes, options) : Promise.resolve({ data: {}, error: null }),
      remove: paths => storage.remove ? storage.remove(bucket, paths) : Promise.resolve({ data: [], error: null }),
    }) },
    auth: {
      getSession: async () => ({ data: { session: null } }),
      getUser: async () => ({ data: { user: { id: actor } } }),
      signOut: async () => ({ error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      ...auth,
    },
    async rpc(name, args) {
      calls.push({ name, args, actor });
      if(activityRpc&&/^fc_(topics_page|activity_feed|recent_contributors|mark_topic_read|locate_reply)$/.test(name)){const override=await activityRpc(name,args,actor);if(override!==undefined)return override;}
      if(name==='fc_topics_page'){
        let q=client.from('fc_topics').select('*').eq('hidden',false);if(args.p_category)q=q.eq('category',args.p_category);if(args.p_search)q=q.ilike('title',`%${args.p_search}%`);if(args.p_saved_only)q=q.in('id',records.fc_saved.filter(s=>!s.user_id||s.user_id===actor).map(s=>s.topic_id));
        const result=await q.range(args.p_offset,args.p_offset+args.p_limit-1);return{data:{items:result.data||[],total:result.count||0},error:result.error};
      }
      if(name==='fc_activity_feed'||name==='fc_recent_contributors')return{data:{items:[],has_more:false},error:null};
      if(name==='fc_mark_topic_read')return{data:{unread_count:0,topic_unread:false},error:null};
      if(name==='fc_locate_reply'){const rows=records.fc_replies.filter(p=>p.topic_id===args.p_topic_id&&!p.hidden);return{data:{reply_page:Math.floor(Math.max(0,rows.findIndex(p=>p.id===args.p_reply_id))/50)},error:null};}
      if (name === 'fc_upload_policy') return { data: policy, error: null };
      if (name === 'fc_profile_cards') {
        const override = profileQuery ? await profileQuery(args, actor) : undefined; if (override !== undefined) return override;
        return { data: args.p_ids.map(id => people.get(id)).filter(p => p?.status === 'active').map(p => ({ created_at: first.created_at, topic_count: records.fc_topics.filter(row => row.author_id === p.user_id).length, reply_count: records.fc_replies.filter(row => row.author_id === p.user_id).length, active_days: 1, ...structuredClone(p) })), error: null };
      }
      if (name === 'fc_my_files') return { data: records.fc_files.filter(f => f.owner_id === actor && f.status !== 'linked'), error: null };
      if (name === 'fc_notifications') return {data:{items:[],unread_count:0,has_more:false,next_before:null,next_before_id:null},error:null};
      if (name === 'fc_notification_settings') return {data:{email_enabled:false,email:null,email_verified:false,deliveryConfigured:false},error:null};
      if (name === 'fc_push_settings') return {data:{configured:false,public_key:null},error:null};
      if (name === 'fc_push_status') return {data:{registered:true,id:'11111111-1111-4111-8111-111111111111'},error:null};
      if (name === 'fc_is_following') return {data:false,error:null};
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
  return { forum, document, window, records, people, calls, $, button, submit, login, revoked };
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
  assert.equal(h.calls.find(call => call.name === 'fc_publish')?.args.p_kind, 'topic');
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

test('Mi perfil opens a forum-specific editor and saves alias, tagline and preferred style without promoting the member', async t => {
  let h;
  h = harness(t, { rpc: async (name, args) => {
    if (name === 'fc_profile_details') {
      const card = { ...h.people.get('a'), alias: args.p_alias, tagline: args.p_tagline, font: args.p_font, color: args.p_color, avatar: null, topic_count: 1, reply_count: 0, created_at: first.created_at, active_days: 1 };
      Object.assign(h.people.get('a'), card); return { data: card, error: null };
    }
    return { data: { ok: true }, error: null };
  } });
  await h.login('a');
  assert.equal(h.$('#profile-button').hidden, false);
  assert.equal(h.$('#profile-button').textContent, 'Mi perfil'); h.$('#profile-button').click(); await flush();
  assert.match(h.$('#profile-heading').textContent, /Foro Cromos/);
  assert.ok(h.$('#profile-avatar[type=file]'));
  assert.match(h.$('#profile-dialog').textContent, /temas.*respuestas/);
  h.$('#profile-alias').value = 'Luna'; h.$('#profile-tagline').value = 'Mi frase personal ✨';
  const font = h.$('#profile-dialog select[aria-label=Fuente]'); font.value = 'serif'; font.dispatchEvent(new h.window.Event('change'));
  const color = h.$('#profile-dialog select[aria-label=Color]'); color.value = 'teal'; color.dispatchEvent(new h.window.Event('change'));
  h.submit('#profile-dialog form'); await flush();
  assert.deepEqual(h.calls.find(call => call.name === 'fc_profile_details').args, { p_alias: 'Luna', p_tagline: 'Mi frase personal ✨', p_avatar: null, p_font: 'serif', p_color: 'teal' });
  assert.equal(h.forum.getState().member.role, 'member');
  assert.equal(h.$('#account-label').textContent, 'Luna');
  assert.match(h.$('#my-community-card').textContent, /Mi frase personal/);
});

test('a late profile save cannot repopulate identity after an account switch', async t => {
  const late = deferred(), h = harness(t, { rpc: async name => name === 'fc_profile_details' ? late.promise : { data: {}, error: null } });
  await h.login('a'); h.$('#profile-button').click(); h.$('#profile-tagline').value = 'PRIVATE PROFILE PHRASE'; h.submit('#profile-dialog form'); await flush();
  await h.login('b'); late.resolve({ data: { user_id: 'a', alias: 'PRIVATE ALIAS', tagline: 'PRIVATE PROFILE PHRASE' }, error: null }); await flush();
  assert.equal(h.$('#profile-dialog'), null); assert.equal(h.$('#account-label').textContent, 'Alias B');
  assert.doesNotMatch(h.document.body.textContent, /PRIVATE PROFILE|PRIVATE ALIAS/);
});

test('attachments download only on demand and late downloads cannot show media after logout', async t => {
  const late = deferred(), downloads = [], h = harness(t, { storage: { download: (bucket, path) => { downloads.push({ bucket, path }); return late.promise; } } });
  h.records.fc_files.push({ id: 'file', owner_id: 'a', topic_id: first.id, reply_id: null, status: 'linked', bucket_id: 'fc-attachments', object_path: 'a/file', file_name: 'photo.png', mime_type: 'image/png', byte_size: 500 });
  await h.login('a'); await h.forum.openTopic(first);
  assert.equal(downloads.length, 0); assert.match(h.$('#topic-body').textContent, /photo.png.*1 KB/);
  h.button('Ver imagen', h.$('#topic-body')).click(); await flush(); assert.equal(downloads.length, 1);
  await h.login(null); late.resolve({ data: new h.window.Blob(['image']), error: null }); await flush();
  assert.equal(h.$('#media-dialog'), null); assert.equal(h.$('#topic-body').textContent, '');
});

test('displayed media object URLs are revoked when its topic becomes unavailable', async t => {
  const h = harness(t);
  h.records.fc_files.push({ id: 'file', owner_id: 'a', topic_id: first.id, reply_id: null, status: 'linked', bucket_id: 'fc-attachments', object_path: 'a/file', file_name: 'photo.png', mime_type: 'image/png', byte_size: 500 });
  await h.login('a'); await h.forum.openTopic(first); h.button('Ver imagen', h.$('#topic-body')).click(); await flush();
  assert.equal(h.$('#media-dialog').open, true);
  h.records.fc_topics[0].hidden = true; await h.forum.openTopic(first, { quiet: true });
  assert.equal(h.$('#media-dialog').open, false); assert.equal(h.$('#media-dialog img'), null); assert.ok(h.revoked.length > 0);
});

test('reply styles remain scoped to the conversation alongside its draft', async t => {
  const h = harness(t); await h.login('a'); await h.forum.openTopic(first);
  h.$('#reply-body').value = 'FIRST DRAFT';
  const color = h.$('#reply-form select[aria-label=Color]'); color.value = 'violet'; color.dispatchEvent(new h.window.Event('change'));
  await h.forum.openTopic(second); assert.equal(color.value, 'default'); await h.forum.openTopic(first);
  assert.equal(color.value, 'violet'); assert.equal(h.$('#reply-body').value, 'FIRST DRAFT');
});

test('profile cards and their avatar URLs disappear when the server stops returning a suspended author', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const h = harness(t); h.people.get('b').avatar = {id:'avatar-b',bucket_id:'fc-avatars',object_path:'b/avatar'};
  await h.login('a'); await h.forum.openTopic(second); await flush();
  assert.ok(h.$('#topic-author img')); h.button('Alias B',h.$('#topic-author')).click();
  h.people.get('b').status = 'suspended'; now += 61000; await h.forum.openTopic(second,{quiet:true}); await flush();
  assert.equal(h.$('#topic-author img'),null); assert.equal(h.$('#member-dialog'),null); assert.ok(h.revoked.length);
});

test('readmission through polling restores founder upload capability without requiring a new login', async t => {
  const h = harness(t,{policy:{attachment_limit:50000000,founder:true}}); await h.login('a');
  h.people.get('a').status = 'suspended'; h.window.dispatchEvent(new h.window.Event('online')); await flush();
  assert.equal(h.$('#profile-button').hidden,true);
  h.people.get('a').status = 'active'; h.window.dispatchEvent(new h.window.Event('online')); await flush();
  h.$('#new-topic-button').click();
  assert.match(h.$('#topic-form .upload-panel').textContent,/50 MB.*fundador/);
  assert.equal(h.calls.filter(call=>call.name==='fc_upload_policy').length,2);
});

test('a confirmed reply remains successful when the following counter refresh fails', async t => {
  let committed = false, posts = 0;
  const h = harness(t,{
    rpc:async name=>{if(name==='fc_publish'){committed=true;posts++;} return{data:{id:'r'},error:null};},
    profileQuery:()=>committed?{data:null,error:new TypeError('Failed to fetch')}:undefined,
  });
  await h.login('a'); await h.forum.openTopic(first); h.$('#reply-body').value='POST THAT SUCCEEDED'; h.submit('#reply-form'); await flush();
  assert.equal(posts,1); assert.equal(h.$('#reply-body').value,'');
  assert.match(h.$('#reply-status').textContent,/publicada/); assert.match(h.$('#app-status').textContent,/publicada/);
});

test('a late reply in another topic keeps the current topic staged attachments visible', async t => {
  const late=deferred(); let h;
  h=harness(t,{rpc:async(name,args)=>{
    if(name==='fc_reserve_file'){const f={id:'file-b',owner_id:'a',purpose:'attachment',bucket_id:'fc-attachments',object_path:'a/file-b',file_name:args.p_name,mime_type:args.p_mime,byte_size:args.p_size,status:'reserved'};h.records.fc_files.push(f);return{data:f,error:null};}
    if(name==='fc_finish_file')return{data:{...h.records.fc_files[0],status:'ready'},error:null};
    if(name==='fc_publish'&&args.p_topic_id===first.id)return late.promise;
    return{data:{id:'reply'},error:null};
  }});
  await h.login('a'); await h.forum.openTopic(second);
  const input=h.$('#reply-form input[type=file]');Object.defineProperty(input,'files',{value:[new File(['secret'],'DRAFT-FOR-B.txt',{type:'text/plain'})],configurable:true});input.dispatchEvent(new h.window.Event('change'));await flush();
  await h.forum.openTopic(first);h.$('#reply-body').value='ANSWER FOR A';h.submit('#reply-form');await flush();
  await h.forum.openTopic(second);assert.match(h.$('#reply-form .staged-files').textContent,/DRAFT-FOR-B/);
  late.resolve({data:{id:'answer-a'},error:null});await flush();
  assert.match(h.$('#reply-form .staged-files').textContent,/DRAFT-FOR-B/);
  h.$('#reply-body').value='ANSWER FOR B';h.submit('#reply-form');await flush();
  assert.deepEqual(h.calls.filter(c=>c.name==='fc_publish').at(-1).args.p_files,['file-b']);
});

test('logout clears private content immediately even when device unregistration never finishes',async t=>{
 const late=deferred(),h=harness(t,{pushSupport:true,rpc:name=>name==='fc_unregister_push'?late.promise:Promise.resolve({data:{},error:null})});
 await h.login('a');await flush();await h.forum.openTopic(first);h.$('#logout-button').click();await flush();
 assert.equal(h.forum.getState().member,null);assert.equal(h.$('#topic-view').hidden,true);assert.doesNotMatch(h.document.body.textContent,/PRIVATE BODY/);
 assert.ok(h.calls.some(call=>call.name==='fc_unregister_push'));late.resolve({data:{ok:true},error:null});await flush();
});

test('topic summaries show real activity metadata, separate unread states and send the chosen filters',async t=>{
 const h=harness(t,{activityRpc:(name,args)=>name==='fc_topics_page'?{data:{items:[{...first,reply_count:7,last_activity_at:first.created_at,last_author_id:'b',last_reply_id:'r7',unread_count:3,topic_unread:true}],total:1},error:null}:undefined});await h.login('a');
 const row=h.$('#topics-list .topic-row');assert.match(row.textContent,/7 respuestas/);assert.match(row.textContent,/3 respuestas nuevas/);assert.match(row.textContent,/Nuevo hilo/);assert.match(row.textContent,/Alias B/);assert.equal(row.classList.contains('topic-has-unread'),true);
 h.$('#unread-topics-filter').click();await flush();assert.equal(h.calls.filter(c=>c.name==='fc_topics_page').at(-1).args.p_unread_only,true);h.$('#sort-select').value='newest';h.$('#sort-select').dispatchEvent(new h.window.Event('change'));await flush();assert.equal(h.calls.filter(c=>c.name==='fc_topics_page').at(-1).args.p_order,'newest');
});
test('opening a pending reply locates its actual page and acknowledges only the rendered reply IDs',async t=>{
 const h=harness(t);h.records.fc_replies.push(...Array.from({length:121},(_,index)=>({id:`r-${index}`,topic_id:first.id,author_id:'b',body:`PAGE RESPONSE ${index}`,hidden:false,withdrawn_at:null,created_at:first.created_at})));await h.login('a');await h.forum.openTopic({...first,first_unread_reply_id:'r-100'},{resume:true});
 assert.ok(h.calls.some(c=>c.name==='fc_locate_reply'&&c.args.p_reply_id==='r-100'));assert.match(h.$('#topic-posts').textContent,/PAGE RESPONSE 120/);assert.doesNotMatch(h.$('#topic-posts').textContent,/PAGE RESPONSE 49\b/);
 const ack=h.calls.filter(c=>c.name==='fc_mark_topic_read').at(-1);assert.deepEqual(ack.args.p_reply_ids,Array.from({length:21},(_,i)=>`r-${100+i}`));assert.equal(h.document.activeElement.dataset.replyId,'r-100');assert.equal(new URL(h.window.location.href).searchParams.get('reply'),'r-100');
});
test('background refresh never consumes newly arriving replies as read',async t=>{
 const h=harness(t);await h.login('a');await h.forum.openTopic(first);const before=h.calls.filter(c=>c.name==='fc_mark_topic_read').length;h.records.fc_replies.push({id:'unseen',topic_id:first.id,author_id:'b',body:'NEW DURING REFRESH',hidden:false,withdrawn_at:null,created_at:first.created_at});await h.forum.openTopic(first,{quiet:true});assert.equal(h.calls.filter(c=>c.name==='fc_mark_topic_read').length,before);
});
test('a late read acknowledgment cannot restore the previous account or its activity',async t=>{
 const pending=deferred();const h=harness(t,{activityRpc:name=>name==='fc_mark_topic_read'?pending.promise:undefined});await h.login('a');const opening=h.forum.openTopic(first);await flush();await h.login(null);pending.resolve({data:{unread_count:0,topic_unread:false},error:null});await opening;assert.equal(h.forum.getState().member,null);assert.equal(h.$('#community-activity').hidden,true);assert.doesNotMatch(h.document.body.textContent,/PRIVATE BODY ONE|PRIVATE TITLE ONE/);
});
test('quiet refresh cannot supersede an explicit reply navigation and preserves keyboard focus afterwards',async t=>{
 const pending=deferred();let awaiting=true;const h=harness(t,{activityRpc:name=>name==='fc_mark_topic_read'&&awaiting?pending.promise:undefined});h.records.fc_replies.push({id:'target',topic_id:first.id,author_id:'b',body:'TARGET RESPONSE',hidden:false,withdrawn_at:null,created_at:first.created_at});await h.login('a');const opening=h.forum.openTopic(first,{replyId:'target'});await flush();const count=h.calls.filter(c=>c.name==='fc_topics_page').length;await h.forum.openTopic(first,{quiet:true});assert.equal(h.document.activeElement.dataset.replyId,'target');pending.resolve({data:{unread_count:0},error:null});awaiting=false;await opening;assert.ok(h.calls.filter(c=>c.name==='fc_topics_page').length>count);await h.forum.openTopic(first,{quiet:true});assert.equal(h.document.activeElement.dataset.replyId,'target');
});
