import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const source = (await readFile(new URL('../app.js', import.meta.url), 'utf8'))
  .replace(/^import \{ createClient \}[^\n]+\n/, '')
  .replace("await import('./config.js')", 'testConfig');
const alice = { id: 'alice', email: 'alice@example.invalid' };
const bob = { id: 'bob', email: 'bob@example.invalid' };
const roomA = '11111111-1111-1111-1111-111111111111';
const roomB = '22222222-2222-2222-2222-222222222222';
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.listeners = {}; this.value = ''; this.hidden = false; this.textContent = ''; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  async fire(type) { return this.listeners[type]?.({ preventDefault() {} }); }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); }
  setAttribute(key, value) { this[key] = value; }
  querySelector() { return this.button ||= new Element('button'); }
  focus() { this.focused = true; }
  scrollIntoView(options) { this.scrollOptions = options; }
  reportValidity() { return Boolean(this.value); }
}
async function harness(options = {}) {
  const elements = new Map();
  const $ = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const storage = new Map();
  const drafts = options.drafts || new Map();
  const state = { messages: [], memberships: [], contacts: [], contactQueue: [], rpcCalls: [], rpcHandlers: {}, queries: [], memberListQueries: [], messageQueue: [], memberQueue: [], memberListQueue: [], insertQueue: [], channels: [], timers: new Set(), errors: [] };
  const sb = {
    auth: {
      getUser: async () => {
        state.authReads = (state.authReads || 0) + 1;
        return options.verifyUser ? options.verifyUser(state) : options.authResult || ({ data: { user: null }, error: null });
      },
      getSession: async () => state.sessionPending?.promise || ({ data: { session: state.localSession || null }, error: null }),
      onAuthStateChange: fn => { state.authEvent = fn; options.onAuthSubscribed?.(fn, { $, state, sb }); },
      signOut: async () => ({ error: null })
    },
    from(table) {
      const query = { table, filters: {}, ascending: true };
      const chain = {
        select() { return chain; },
        eq(key, value) { query.filters[key] = value; return chain; },
        order(key, options) { query.order = key; query.ascending = options.ascending; return chain; },
        async limit(count) {
          if (table === 'sx_room_members') {
            query.limit = count; state.memberListQueries.push(query);
            if (state.memberListQueue.length) return state.memberListQueue.shift();
            return { data: state.memberships.filter(row => row.user_id === query.filters.user_id)
              .sort((a, b) => (query.ascending ? 1 : -1) * a[query.order].localeCompare(b[query.order])).slice(0, count), error: null };
          }
          query.limit = count; state.queries.push(query);
          if (state.messageQueue.length) return state.messageQueue.shift();
          return { data: state.messages.filter(row => row.room_id === query.filters.room_id)
            .sort((a, b) => (query.ascending ? 1 : -1) * (a[query.order] - b[query.order])).slice(0, count), error: null };
        },
        async maybeSingle() {
          if (table === 'sx_messages') return { data: state.messages.find(row => Object.entries(query.filters).every(([key, value]) => row[key] === value)) || null, error: null };
          return state.memberQueue.length ? state.memberQueue.shift() : { data: { room_id: query.filters.room_id }, error: null };
        },
        async insert(row) { state.lastInsert = row; return state.insertQueue.length ? state.insertQueue.shift() : { error: null }; }
      };
      return chain;
    },
    channel() {
      const channel = { on(_type, filter, fn) { channel.filter = filter; channel.onInsert = fn; return channel; }, subscribe(fn) { channel.onStatus = fn; return channel; } };
      state.channels.push(channel); return channel;
    },
    removeChannel: () => state.removePending?.promise || Promise.resolve(),
    rpc: async (name, args) => {
      state.rpcCalls.push({ name, args });
      if (state.rpcHandlers[name]) return state.rpcHandlers[name](args);
      if (name === 'sx_list_contacts') return state.contactQueue.length ? state.contactQueue.shift() : { data: structuredClone(state.contacts), error: null };
      return state.rpcPending?.promise || ({ data: roomA, error: null });
    }
  };
  const document = { getElementById: $, createElement: tag => new Element(tag), addEventListener() {}, hidden: false };
  const context = vm.createContext({
    createClient: () => sb,
    testConfig: options.testConfig || { SUPABASE_URL: 'https://lab.example.invalid', SUPABASE_PUBLISHABLE_KEY: 'public-test-placeholder' },
    document, window: { addEventListener() {}, dispatchEvent(event) { (state.cofreEvents ||= []).push(event.detail); },
      CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
      location: { origin: options.origin || 'https://pilot.example.invalid', pathname: '/', hash: '' }, history: { replaceState() {} } },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    sessionStorage: { getItem: key => drafts.get(key) || null, setItem: (key, value) => drafts.set(key, value), removeItem: key => drafts.delete(key) },
    navigator: { onLine: true, clipboard: { writeText: async () => {} } },
    crypto: { randomUUID }, URLSearchParams,
    console: { error: (...args) => state.errors.push(args) },
    setInterval: fn => { state.timers.add(fn); return fn; }, clearInterval: fn => state.timers.delete(fn),
    setTimeout
  });
  await vm.runInContext(`(async () => { ${source}\n globalThis.api = { showAuthenticated, showSignedOut, activateRoom, readMessages, refreshAuth, refreshContacts, decideContact, changeContactBlock, setEasyMode }; })()`, context);
  return { $, sb, state, storage, drafts, context, api: context.api };
}
function row(id, room = roomA, sender = 'alice', body = `message ${id}`) {
  return { id, room_id: room, sender_id: sender, body, created_at: '2026-10-16T12:00:00Z' };
}
const bodies = h => h.$('messages').children.filter(child => child.className?.startsWith('msg')).map(child => child.children[1].textContent);
async function enter(h, room = roomA) { await h.api.showAuthenticated(alice); await h.api.activateRoom(room); }

const cofreTestConfig = { SUPABASE_URL: 'https://lab.example.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictitious-key', COFRE_LOCAL_ENABLED: true };

test('incoming messages keep an earlier reading position while initial and near-bottom reads follow the latest', async () => {
  const h = await harness(), list = h.$('messages');
  Object.defineProperty(list, 'scrollHeight', { get: () => list.children.length * 100 }); list.clientHeight = 300;
  h.state.messages = Array.from({ length: 12 }, (_, index) => row(index + 1));
  await enter(h); assert.equal(list.scrollTop, 1200, 'initial history opens at the latest message');
  list.scrollTop = 240; h.state.messages.push(row(13, roomA, 'bob')); await h.api.readMessages();
  assert.equal(list.scrollTop, 240, 'incoming message must not interrupt reading earlier messages');
  list.scrollTop = list.scrollHeight - list.clientHeight - 30;
  h.state.messages.push(row(14, roomA, 'bob')); await h.api.readMessages();
  assert.equal(list.scrollTop, 1400, 'somebody already near the bottom keeps following');
  list.scrollTop = 150; h.$('body').value = 'Mi respuesta'; h.state.messages.push(row(15, roomA, 'alice', 'Mi respuesta'));
  await h.$('send-form').fire('submit'); assert.equal(list.scrollTop, 1500, 'an intentional own send follows its result');
});

test('message viewport anchors the same visible message when the oldest entry leaves the 150-message page', async () => {
  const h = await harness(), list = h.$('messages'), create = h.context.document.createElement;
  list.getBoundingClientRect = () => ({ top: 100, bottom: 500 });
  Object.defineProperty(list, 'scrollHeight', { get: () => list.children.length * 100 }); list.clientHeight = 400;
  h.context.document.createElement = tag => {
    const node = create(tag); node.getAttribute = key => node[key];
    node.getBoundingClientRect = () => { const top = 100 + list.children.indexOf(node) * 100 - (list.scrollTop || 0); return { top, bottom: top + 100 }; };
    return node;
  };
  h.state.messages = Array.from({ length: 150 }, (_, index) => row(index + 1));
  await enter(h); list.scrollTop = 500;
  h.state.messages.push(row(151, roomA, 'bob')); await h.api.readMessages();
  assert.equal(list.scrollTop, 400, 'message 6 remains in the same visual position after message 1 is trimmed');
});

test('opening a conversation marks presentation and returning to contacts preserves its pending draft', async () => {
  const h = await harness(); await enter(h);
  assert.equal(h.$('chat-panel')['data-conversation-open'], 'true');
  assert.equal(h.$('active-contact-title').focused, true);
  assert.equal(h.$('active-chat').scrollOptions?.block, 'start');
  assert.equal(h.$('active-chat').scrollOptions?.behavior, 'instant');
  assert.match(h.$('leave-room').textContent, /Volver a contactos/u);
  h.$('body').value = 'Para seguir después'; await h.$('body').fire('input');
  await h.$('leave-room').fire('click');
  assert.equal(h.$('chat-panel')['data-conversation-open'], 'false'); assert.equal(h.$('active-chat').hidden, true);
  assert.equal(h.$('contacts-title').focused, true);
  assert.equal(h.$('contacts-title').scrollOptions?.block, 'start');
  await h.api.activateRoom(roomA); assert.equal(h.$('body').value, 'Para seguir después');
});

test('restoring a cached conversation does not take focus from the user', async () => {
  const h = await harness(); await h.api.showAuthenticated(alice); await h.api.activateRoom(roomA, true);
  assert.equal(h.$('chat-panel')['data-conversation-open'], 'true');
  assert.equal(h.$('active-contact-title').focused, undefined);
  assert.equal(h.$('active-chat').scrollOptions, undefined);
});
test('cached INITIAL_SESSION cannot publish credentials before server validation and an invalid cached JWT shows access again', async () => {
  const verification = deferred(); let observed;
  const building = harness({ testConfig: cofreTestConfig, verifyUser: () => verification.promise,
    onAuthSubscribed: (callback, current) => {
      observed = current; current.state.localSession = { user: alice, access_token: 'cached-invalid-token' };
      callback('INITIAL_SESSION', current.state.localSession);
    } });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(observed.state.rpcCalls.length, 0, 'cached identity must not start private module queries');
  assert.equal(observed.$('identity').textContent, '', 'cached identity is not yet authenticated');
  assert.equal((observed.state.cofreEvents || []).some(session => session?.access_token === 'cached-invalid-token'), false);
  verification.resolve({ data: { user: null }, error: { status: 401, code: 'bad_jwt', message: 'Sesión local no válida.' } });
  const h = await building;
  assert.equal(h.$('auth-panel').hidden, false); assert.equal(h.$('chat-panel').hidden, true);
  assert.equal(h.$('identity').textContent, ''); assert.equal(h.context.window.__sxCofreSession, null);
  assert.equal(h.state.authReads, 1);
});

test('a valid server result opens the initial account once using its verified user instead of cached metadata', async () => {
  const verification = deferred(), verified = { ...alice, email: 'verified-alice@example.invalid' };
  const hBuilding = harness({ verifyUser: () => verification.promise,
    onAuthSubscribed: callback => callback('INITIAL_SESSION', { user: { ...alice, email: 'unverified-cache@example.invalid' }, access_token: 'cached' }) });
  await new Promise(resolve => setTimeout(resolve, 5));
  verification.resolve({ data: { user: verified }, error: null });
  const h = await hBuilding;
  assert.equal(h.$('identity').textContent, verified.email);
  assert.equal(h.$('chat-panel').hidden, false); assert.equal(h.$('auth-panel').hidden, true);
  assert.equal(h.state.rpcCalls.filter(call => call.name === 'sx_list_contacts').length, 1);
  assert.equal(h.state.authReads, 1);
});

test('fresh sign-in supersedes a pending old verification while a late INITIAL_SESSION cannot revert the account', async () => {
  const verification = deferred(); let observed;
  const building = harness({ testConfig: cofreTestConfig, verifyUser: () => verification.promise,
    onAuthSubscribed: (callback, current) => {
      observed = current; callback('INITIAL_SESSION', { user: alice, access_token: 'cached-a' });
    } });
  observed.state.localSession = { user: bob, access_token: 'fresh-b' };
  observed.state.authEvent('SIGNED_IN', observed.state.localSession);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(observed.$('identity').textContent, bob.email);
  verification.resolve({ data: { user: null }, error: { status: 401, message: 'Old cached token expired.' } });
  const h = await building;
  h.state.authEvent('INITIAL_SESSION', { user: alice, access_token: 'late-cached-a' });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.$('identity').textContent, bob.email); assert.equal(h.$('chat-panel').hidden, false);
  assert.equal(h.context.window.__sxCofreSession.user.id, bob.id);
  assert.equal(h.state.cofreEvents.some(session => session?.access_token === 'late-cached-a'), false);
});

test('coalesced password recovery and initial-session callbacks preserve the dedicated recovery flow', async () => {
  const h = await harness({ authResult: { data: { user: alice }, error: null },
    onAuthSubscribed: callback => {
      callback('PASSWORD_RECOVERY', { user: alice });
      callback('INITIAL_SESSION', { user: alice });
    } });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.$('recovery-panel').hidden, false); assert.equal(h.$('chat-panel').hidden, true);
  assert.equal(h.$('recovery-email').textContent, alice.email);
  assert.equal(h.state.rpcCalls.length, 0);
});

test('local Cofre receives current credentials, refreshes same account and clears immediately on logout', async () => {
  const h = await harness({ testConfig: cofreTestConfig });
  h.state.localSession = { user: alice, access_token: 'synthetic-a-one' };
  await h.api.showAuthenticated(alice);
  assert.equal(h.context.window.__sxCofreSession.access_token, 'synthetic-a-one');
  assert.equal(h.context.window.__sxCofreSession.apikey, 'fictitious-key');
  h.state.localSession = { user: alice, access_token: 'synthetic-a-refreshed' };
  h.state.authEvent('TOKEN_REFRESHED', h.state.localSession);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(h.context.window.__sxCofreSession.access_token, 'synthetic-a-refreshed');
  h.api.showSignedOut();
  assert.equal(h.context.window.__sxCofreSession, null);
  assert.equal(h.state.cofreEvents.at(-1), null);
});
test('a delayed old-account credential lookup cannot restore Cofre after an account change', async () => {
  const h = await harness({ testConfig: cofreTestConfig });
  const old = deferred(); h.state.sessionPending = old;
  await h.api.showAuthenticated(alice);
  h.api.showSignedOut();
  h.state.sessionPending = null;
  h.state.localSession = { user: bob, access_token: 'synthetic-b' };
  await h.api.showAuthenticated(bob);
  old.resolve({ data: { session: { user: alice, access_token: 'stale-a' } }, error: null });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.context.window.__sxCofreSession.user.id, bob.id);
  assert.equal(h.context.window.__sxCofreSession.access_token, 'synthetic-b');
  assert.equal(h.state.cofreEvents.some(session => session?.access_token === 'stale-a'), false);
});

test('real app selects newest 150 of 203 and renders chronological, safe text and ownership', async () => {
  const h = await harness();
  h.state.messages = Array.from({ length: 203 }, (_, i) => row(i + 1));
  h.state.messages[202] = row(203, roomA, 'bob', '<img src=x onerror=alert(1)>');
  await enter(h);
  const query = h.state.queries.at(-1);
  assert.equal(query.ascending, false); assert.equal(query.limit, 150);
  assert.equal(bodies(h).length, 150); assert.equal(bodies(h)[0], 'message 54');
  assert.equal(bodies(h).at(-1), '<img src=x onerror=alert(1)>');
  assert.equal(h.$('messages').children.at(-1).children[1].children.length, 0);
  assert.equal(h.$('messages').children[0].children[0].textContent, 'Tú');
  assert.equal(h.$('messages').children.at(-1).children[0].textContent, 'La otra persona');
  h.state.messages.push(row(204)); await h.api.readMessages();
  assert.equal(bodies(h)[0], 'message 55'); assert.equal(bodies(h).at(-1), 'message 204');
});

test('logout clears account content immediately and rejects pending reads despite slow channel cleanup', async () => {
  const h = await harness(); h.state.messages = [row(1)]; await enter(h);
  const pending = deferred(); h.state.messageQueue.push(pending.promise);
  const read = h.api.readMessages(); h.state.removePending = deferred();
  const signOut = deferred(); h.sb.auth.signOut = () => signOut.promise;
  const logout = h.$('logout-btn').fire('click');
  assert.deepEqual(bodies(h), []); assert.equal(h.$('chat-panel').hidden, true);
  assert.equal(h.$('body').value, ''); assert.equal(h.state.timers.size, 0);
  pending.resolve({ data: [row(2)], error: null }); await read;
  assert.deepEqual(bodies(h), []);
  signOut.resolve({ error: null }); await logout;
});

test('switch room prevents old membership, reads, and channel callbacks from changing new room', async () => {
  const h = await harness(); await h.api.showAuthenticated(alice);
  const membership = deferred(); h.state.memberQueue.push(membership.promise);
  const oldActivation = h.api.activateRoom(roomA);
  h.state.messages = [row(10, roomB)]; await h.api.activateRoom(roomB);
  membership.resolve({ data: { room_id: roomA }, error: null }); await oldActivation;
  assert.equal(h.$('room-code').textContent, roomB); assert.equal(h.state.channels.length, 1);
  const pending = deferred(); h.state.messageQueue.push(pending.promise); const oldRead = h.api.readMessages();
  void h.api.readMessages(); // A queued refresh for the old view must be discarded too.
  const oldChannel = h.state.channels[0]; h.state.messages = [row(20)]; await h.api.activateRoom(roomA);
  pending.resolve({ data: [row(99, roomB)], error: null }); await oldRead;
  oldChannel.onStatus('CHANNEL_ERROR'); oldChannel.onInsert();
  assert.deepEqual(bodies(h), ['message 20']);
  assert.match(h.$('connection-status').textContent, /Última actualización/);
  assert.equal(h.state.queries.length, 3, 'discarded room must not issue its queued refresh');
});

test('same room across accounts cannot reuse an older account read', async () => {
  const h = await harness(); await enter(h);
  const pending = deferred(); h.state.messageQueue.push(pending.promise); const read = h.api.readMessages();
  h.storage.set('sx_connect_room:bob', roomA); h.state.messages = [row(3, roomA, 'bob')];
  await h.api.showAuthenticated(bob);
  pending.resolve({ data: [row(99)], error: null }); await read;
  assert.deepEqual(bodies(h), ['message 3']);
  assert.equal(h.$('messages').children[0].children[0].textContent, 'Tú');
});

test('new device discovers only the newest own membership without a cached room', async () => {
  const h = await harness();
  h.state.memberships = [
    { user_id: 'alice', room_id: roomA, joined_at: '2026-10-15T12:00:00Z' },
    { user_id: 'alice', room_id: roomB, joined_at: '2026-10-16T12:00:00Z' },
    { user_id: 'bob', room_id: 'other-account-room', joined_at: '2026-10-17T12:00:00Z' }
  ];
  h.state.messages = [row(9, roomB)];
  await h.api.showAuthenticated(alice);
  const query = h.state.memberListQueries.at(-1);
  assert.deepEqual({ ...query.filters }, { user_id: 'alice' });
  assert.equal(query.order, 'joined_at'); assert.equal(query.ascending, false); assert.equal(query.limit, 1);
  assert.equal(h.$('room-code').textContent, roomB);
  assert.equal(h.storage.get('sx_connect_room:alice'), roomB);
  assert.deepEqual(bodies(h), ['message 9']);
});

test('late own-membership discovery cannot activate a room after account changes', async () => {
  const h = await harness(); const pending = deferred();
  h.state.memberListQueue.push(pending.promise);
  const discoveringAlice = h.api.showAuthenticated(alice);
  h.state.memberships = [{ user_id: 'bob', room_id: roomB, joined_at: '2026-10-16T12:00:00Z' }];
  h.state.messages = [row(4, roomB, 'bob')];
  await h.api.showAuthenticated(bob);
  pending.resolve({ data: [{ room_id: roomA }], error: null }); await discoveringAlice;
  assert.equal(h.$('identity').textContent, bob.email);
  assert.equal(h.$('room-code').textContent, roomB); assert.deepEqual(bodies(h), ['message 4']);
  assert.equal(h.storage.has('sx_connect_room:alice'), false);
  assert.equal(h.state.channels.length, 1);
});

test('membership discovery shows network errors and leaves setup available without a room', async () => {
  const h = await harness();
  h.state.memberListQueue.push({ data: null, error: { message: 'membership discovery offline' } });
  await h.api.showAuthenticated(alice);
  assert.match(h.$('notice').textContent, /No hemos podido conectar/);
  assert.equal(h.$('setup-room').hidden, false); assert.equal(h.$('active-chat').hidden, true);
  assert.equal(h.storage.has('sx_connect_room:alice'), false);
});

test('sustained slow reads render results while two polling ticks coalesce into one following read', async () => {
  const h = await harness(); await enter(h);
  const first = deferred(); const second = deferred(); const third = deferred();
  h.state.messageQueue.push(first.promise, second.promise, third.promise);
  const countBefore = h.state.queries.length;
  const read = h.api.readMessages();
  const poll = [...h.state.timers].at(-1); poll(); poll();
  assert.equal(h.state.queries.length, countBefore + 1);
  first.resolve({ data: [row(1, roomA, 'alice', 'first slow result')], error: null }); await read;
  assert.deepEqual(bodies(h), ['first slow result']);
  assert.equal(h.state.queries.length, countBefore + 2);
  const queued = h.api.readMessages(); poll(); poll();
  assert.equal(h.state.queries.length, countBefore + 2);
  second.resolve({ data: [row(1, roomA, 'alice', 'second slow result')], error: null }); await queued;
  assert.deepEqual(bodies(h), ['second slow result']);
  assert.equal(h.state.queries.length, countBefore + 3);
  third.resolve({ data: [row(1, roomA, 'alice', 'third slow result')], error: null });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(bodies(h), ['third slow result']);
  h.state.messages = [row(1, roomA, 'alice', 'changed body')]; await h.api.readMessages();
  assert.deepEqual(bodies(h), ['changed body']);
});

test('cached restoration reports network failure and preserves retry info; absent membership clears cache', async () => {
  const h = await harness(); h.storage.set('sx_connect_room:alice', roomA);
  h.state.memberQueue.push({ data: null, error: { message: 'offline' } });
  await h.api.showAuthenticated(alice);
  assert.match(h.$('notice').textContent, /No hemos podido conectar/); assert.equal(h.$('active-chat').hidden, true);
  assert.equal(h.storage.get('sx_connect_room:alice'), roomA);
  h.state.memberQueue.push({ data: null, error: null }); await h.api.activateRoom(roomA, true);
  assert.equal(h.storage.has('sx_connect_room:alice'), false);
});

test('send completion preserves a newer draft and cannot clear another room draft', async () => {
  const h = await harness(); await enter(h);
  h.$('body').value = ' first '; const first = deferred(); h.state.insertQueue.push(first.promise);
  const send = h.$('send-form').fire('submit'); h.$('body').value = 'new draft';
  first.resolve({ error: null }); await send; assert.equal(h.$('body').value, 'new draft');
  assert.deepEqual({ ...h.state.lastInsert, client_message_id: undefined }, { room_id: roomA, sender_id: 'alice', body: 'first', client_message_id: undefined });
  assert.match(h.state.lastInsert.client_message_id, /^[a-f0-9-]{36}$/);
  const second = deferred(); h.state.insertQueue.push(second.promise); const oldSend = h.$('send-form').fire('submit');
  await h.api.activateRoom(roomB); h.$('body').value = 'room B draft';
  second.resolve({ error: { message: 'old request failed' } }); await oldSend;
  assert.equal(h.$('body').value, 'room B draft'); assert.equal(h.$('notice').hidden, true);
});

test('late create RPC cannot reopen room after logout; failed logout restores authenticated view', async () => {
  const h = await harness(); await enter(h);
  h.state.rpcPending = deferred(); const create = h.$('create-room').fire('click');
  h.api.showSignedOut(); h.state.rpcPending.resolve({ data: roomA, error: null }); await create;
  assert.equal(h.$('chat-panel').hidden, true); assert.deepEqual(bodies(h), []);
  await h.api.showAuthenticated(alice);
  h.sb.auth.signOut = async () => ({ error: { message: 'logout failed' } });
  h.sb.auth.getUser = async () => ({ data: { user: alice }, error: null });
  await h.$('logout-btn').fire('click');
  assert.equal(h.$('chat-panel').hidden, false); assert.match(h.$('notice').textContent, /No hemos podido completar/);
});

test('empty messages render an explicit empty state; failed read remains recoverable', async () => {
  const h = await harness(); await enter(h);
  assert.equal(h.$('messages').children[0].className, 'empty');
  h.state.messageQueue.push({ data: null, error: { message: 'fetch failed' } }); await h.api.readMessages();
  assert.match(h.$('connection-status').textContent, /No se pudo actualizar/);
  h.state.messages = [row(1)]; await h.api.readMessages(); assert.deepEqual(bodies(h), ['message 1']);
});

test('double submit while pending sends once; success means saved, not recipient receipt', async () => {
  const h = await harness(); await enter(h);
  const pending = deferred(); let calls = 0;
  h.sb.from = new Proxy(h.sb.from, { apply(target, that, args) { const chain = Reflect.apply(target, that, args); if (args[0] === 'sx_messages') chain.insert = async data => { calls++; h.state.lastInsert = data; return pending.promise; }; return chain; } });
  h.$('body').value = 'once'; const first = h.$('send-form').fire('submit');
  await h.$('send-form').fire('submit'); assert.equal(calls, 1);
  assert.equal(h.$('send-status').textContent, 'Enviando…');
  pending.resolve({ error: null }); await first;
  assert.match(h.$('send-status').textContent, /Guardado.*recepción.*no se confirma/);
});

test('lost acknowledgement resolves against the exact stored client ID without inserting twice', async () => {
  const h = await harness(); await enter(h);
  h.$('body').value = 'lost ack';
  h.sb.from = new Proxy(h.sb.from, { apply(target, that, args) { const chain = Reflect.apply(target, that, args); if (args[0] === 'sx_messages') chain.insert = async data => { h.state.messages.push({ ...row(10), ...data }); return { error: { message: 'Failed to fetch' } }; }; return chain; } });
  await h.$('send-form').fire('submit');
  assert.equal(h.state.messages.length, 1); assert.equal(h.$('body').value, '');
  assert.match(h.$('send-status').textContent, /Guardado/);
});

test('unconfirmed retries reuse their client ID across room restoration and retain draft', async () => {
  const h = await harness(); await enter(h); h.$('body').value = 'retry me';
  h.state.insertQueue.push({ error: { message: 'network failed' } });
  await h.$('send-form').fire('submit'); const original = h.state.lastInsert.client_message_id;
  assert.equal(h.$('body').value, 'retry me'); assert.match(h.$('send-status').textContent, /sin confirmar/);
  await h.api.activateRoom(roomA); assert.equal(h.$('body').value, 'retry me');
  h.state.messages.push({ ...row(11), ...h.state.lastInsert });
  h.state.insertQueue.push({ error: { code: '23505', message: 'duplicate key' } });
  await h.$('send-form').fire('submit');
  assert.equal(h.state.lastInsert.client_message_id, original); assert.equal(h.state.messages.length, 1);
  assert.equal(h.$('body').value, '');
});

test('drafts restore only for their room and are cleared for the active room at logout', async () => {
  const h = await harness(); await enter(h); h.$('body').value = 'private A'; await h.$('body').fire('input');
  await h.api.activateRoom(roomB); assert.equal(h.$('body').value, '');
  h.$('body').value = 'private B'; await h.api.activateRoom(roomA); assert.equal(h.$('body').value, 'private A');
  h.api.showSignedOut(); assert.equal(h.$('body').value, '');
  assert.equal(h.drafts.has(`sx_draft:alice:${roomA}`), false);
  await h.api.showAuthenticated(bob); await h.api.activateRoom(roomA); assert.equal(h.$('body').value, '');
});

test('offline send preserves draft without submitting a request', async () => {
  const h = await harness(); await enter(h); h.context.navigator.onLine = false;
  h.$('body').value = 'later'; await h.$('send-form').fire('submit');
  assert.equal(h.state.lastInsert, undefined); assert.equal(h.$('body').value, 'later');
  assert.match(h.$('notice').textContent, /sin conexión/);
});

test('show password and invalid login expose helpful Spanish instructions', async () => {
  const h = await harness(); h.$('password').type = 'password';
  await h.$('show-password').fire('click'); assert.equal(h.$('password').type, 'text');
  await h.$('show-password').fire('click'); assert.equal(h.$('password').type, 'password');
  h.sb.auth.signInWithPassword = async () => ({ error: { code: 'invalid_credentials' } });
  await h.$('auth-form').fire('submit'); assert.match(h.$('notice').textContent, /contraseña de Connect no coinciden/);
});

test('signup and recovery use the public return origin without promising email delivery', async () => {
  const h = await harness(); h.$('email').value = 'new@example.invalid'; h.$('password').value = 'new-password';
  let signup, recovery;
  h.sb.auth.signUp = async args => { signup = args; return { data: { session: null }, error: null }; };
  h.sb.auth.resetPasswordForEmail = async (...args) => { recovery = args; return { error: null }; };
  await h.$('signup-btn').fire('click'); assert.equal(signup.options.emailRedirectTo, 'https://pilot.example.invalid/');
  assert.match(h.$('notice').textContent, /repetir el registro no la cambia/);
  await h.$('recover-btn').fire('click'); assert.equal(recovery[1].redirectTo, 'https://pilot.example.invalid/');
  assert.match(h.$('notice').textContent, /envío del laboratorio es limitado/);
});

for (const password of ['abcde', 'abcdef']) {
  const accepted = password.length === 6;
  test(`signup ${accepted ? 'accepts six' : 'rejects five'} password characters before contacting auth`, async () => {
    const h = await harness(); h.$('email').value = 'new@example.invalid'; h.$('password').value = password;
    const calls = [];
    h.sb.auth.signUp = async args => { calls.push(args); return { data: { session: null }, error: null }; };
    await h.$('signup-btn').fire('click');
    assert.equal(calls.length, accepted ? 1 : 0);
    if (accepted) assert.equal(calls[0].password, password);
    else assert.match(h.$('notice').textContent, /al menos 6 caracteres/);
  });

  test(`recovery ${accepted ? 'accepts six' : 'rejects five'} password characters before updating auth`, async () => {
    const h = await harness();
    h.state.authEvent('PASSWORD_RECOVERY', { user: alice }); await new Promise(r => setTimeout(r, 5));
    h.$('new-password').value = password; h.$('repeat-password').value = password;
    const calls = [];
    h.sb.auth.updateUser = async args => { calls.push(args); return { error: null }; };
    await h.$('recovery-form').fire('submit');
    assert.equal(calls.length, accepted ? 1 : 0);
    if (accepted) assert.equal(calls[0].password, password);
    else assert.match(h.$('notice').textContent, /al menos 6 caracteres/);
  });
}

test('native recovery fields accept the same six-character minimum as the app', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const id of ['new-password', 'repeat-password']) {
    const input = html.match(new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`))?.[0];
    assert.ok(input, `${id} exists`);
    assert.match(input, /\bminlength="6"/);
  }
});

test('recovery event shows dedicated password form and USER_UPDATED cannot interrupt saving', async () => {
  const h = await harness();
  h.state.authEvent('PASSWORD_RECOVERY', { user: alice }); await new Promise(r => setTimeout(r, 5));
  assert.equal(h.$('recovery-panel').hidden, false); assert.equal(h.$('chat-panel').hidden, true);
  h.$('new-password').value = 'a-new-password'; h.$('repeat-password').value = 'different';
  let calls = 0; h.sb.auth.updateUser = async () => { calls++; return { error: null }; };
  await h.$('recovery-form').fire('submit'); assert.equal(calls, 0);
  h.$('repeat-password').value = 'a-new-password';
  h.sb.auth.updateUser = async () => { calls++; h.state.authEvent('USER_UPDATED', { user: alice }); await new Promise(r => setTimeout(r, 5)); return { error: null }; };
  await h.$('recovery-form').fire('submit'); assert.equal(calls, 1);
  assert.equal(h.$('recovery-panel').hidden, true); assert.equal(h.$('chat-panel').hidden, false);
  assert.equal(h.$('new-password').value, ''); assert.match(h.$('notice').textContent, /actualizada/);
});

test('recovery survives reloading with a verified session but cannot leak to another account', async () => {
  const h = await harness(); h.state.authEvent('PASSWORD_RECOVERY', { user: alice });
  h.state.authEvent('SIGNED_IN', { user: alice }); // Coalesced initial events still open recovery.
  await new Promise(r => setTimeout(r, 5));
  assert.equal(h.$('recovery-panel').hidden, false);
  const reloaded = await harness({ drafts: h.drafts, authResult: { data: { user: alice }, error: null } });
  assert.equal(reloaded.$('recovery-panel').hidden, false); assert.equal(reloaded.$('chat-panel').hidden, true);
  const different = await harness({ drafts: h.drafts, authResult: { data: { user: bob }, error: null } });
  assert.equal(different.$('recovery-panel').hidden, true); assert.equal(different.$('identity').textContent, bob.email);
});

test('blocked room storage cannot prevent membership discovery or opening a valid room', async () => {
  const h = await harness();
  h.context.localStorage.getItem = () => { throw new Error('SecurityError'); };
  h.context.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  h.context.localStorage.removeItem = () => { throw new Error('SecurityError'); };
  h.state.memberships = [{ user_id: 'alice', room_id: roomA, joined_at: '2026-10-16T12:00:00Z' }];
  await h.api.showAuthenticated(alice);
  assert.equal(h.$('active-chat').hidden, false); assert.equal(h.$('room-code').textContent, roomA);
  h.api.showSignedOut(); assert.equal(h.$('chat-panel').hidden, true);
});

test('expired cached membership falls back to current own membership', async () => {
  const h = await harness(); h.storage.set('sx_connect_room:alice', roomA);
  h.state.memberQueue.push({ data: null, error: null });
  h.state.memberships = [{ user_id: 'alice', room_id: roomB, joined_at: '2026-10-16T12:00:00Z' }];
  await h.api.showAuthenticated(alice);
  assert.equal(h.$('room-code').textContent, roomB);
});

test('temporary auth network failure does not delete the saved draft', async () => {
  const h = await harness(); await enter(h); h.$('body').value = 'keep through outage'; await h.$('body').fire('input');
  h.sb.auth.getUser = async () => ({ data: { user: null }, error: { message: 'network error' } });
  await h.api.refreshAuth();
  assert.equal(h.$('body').value, 'keep through outage'); assert.equal(h.drafts.has(`sx_draft:alice:${roomA}`), true);
});

function contact(overrides = {}) {
  return { id: 'contact-1', direction: 'incoming', counterpart_label: 'Compañera', status: 'pending', room_id: null, blocked: false, blocked_by_me: false, created_at: '2026-10-21T12:00:00Z', ...overrides };
}
const cardButtons = h => h.$('contacts-list').children[0]?.children[2].children || [];
const contactButtons = h => cardButtons(h).map(b => b.textContent);
async function enterContacts(h, entries) { h.state.contacts = entries; await h.api.showAuthenticated(alice); await h.api.refreshContacts(); }

test('incoming request renders safe alias and only acceptance opens a conversation', async () => {
  const h = await harness(); const entry = contact({ counterpart_label: '<img onerror=alert(1)>' });
  await enterContacts(h, [entry]);
  assert.deepEqual(contactButtons(h), ['Aceptar', 'Rechazar', 'Bloquear']);
  assert.equal(h.$('contacts-list').children[0].children[0].textContent, '<img onerror=alert(1)>');
  assert.equal(h.$('contacts-list').children[0].children[0].children.length, 0);
  assert.equal(h.$('active-chat').hidden, true);
  h.state.rpcHandlers.sx_decide_contact = async args => {
    assert.equal(args.p_contact_id, 'contact-1'); assert.equal(args.p_accept, true);
    h.state.contacts = [contact({ status: 'accepted', room_id: roomA })];
    return { data: roomA, error: null };
  };
  await cardButtons(h)[0].fire('click');
  assert.equal(h.$('room-code').textContent, roomA);
  assert.deepEqual(contactButtons(h), ['Abrir conversación', 'Bloquear']);
  assert.equal(h.$('copy-code').hidden, true);
});

test('rejecting a request creates no room and preserves its terminal status', async () => {
  const h = await harness(); await enterContacts(h, [contact()]);
  h.state.rpcHandlers.sx_decide_contact = async args => {
    assert.equal(args.p_accept, false); h.state.contacts = [contact({ status: 'rejected' })];
    return { data: null, error: null };
  };
  await cardButtons(h)[1].fire('click');
  assert.equal(h.$('active-chat').hidden, true);
  assert.deepEqual(contactButtons(h), ['Bloquear']);
  assert.match(h.$('contacts-list').children[0].children[1].textContent, /rechazada/);
});

test('outgoing and unavailable requests cannot be accepted from rendered controls', async () => {
  const h = await harness(); await enterContacts(h, [contact({ direction: 'outgoing' })]);
  assert.deepEqual(contactButtons(h), ['Bloquear']);
  assert.match(h.$('contacts-list').children[0].children[1].textContent, /Esperando/);
  h.state.contacts = [contact({ blocked: true })]; await h.api.refreshContacts();
  assert.deepEqual(contactButtons(h), ['Bloquear']);
  assert.equal(h.$('contacts-list').children[0].children[1].textContent, 'Contacto no disponible');
});

test('blocking disables new sends, keeps history and draft, and is enforced by its RPC', async () => {
  const h = await harness(); const entry = contact({ status: 'accepted', room_id: roomA });
  await enterContacts(h, [entry]); h.state.messages = [row(1)]; await h.api.activateRoom(roomA);
  h.$('body').value = 'my unsent draft'; await h.$('body').fire('input');
  h.state.rpcHandlers.sx_set_contact_block = async args => {
    assert.equal(args.p_contact_id, entry.id); assert.equal(args.p_blocked, true);
    h.state.contacts = [contact({ ...entry, blocked: true, blocked_by_me: true })];
    return { data: true, error: null };
  };
  await h.$('active-block').fire('click');
  assert.equal(h.$('body').disabled, true); assert.equal(h.$('send-form').querySelector().disabled, true);
  assert.equal(h.$('body').value, 'my unsent draft'); assert.deepEqual(bodies(h), ['message 1']);
  await h.$('send-form').fire('submit'); assert.equal(h.state.lastInsert, undefined);
  assert.equal(h.$('active-block').textContent, 'Desbloquear');
  assert.deepEqual(contactButtons(h), ['Ver historial', 'Desbloquear']);
});

test('removing only my block does not restore sending if the other block remains', async () => {
  const h = await harness(); const entry = contact({ status: 'accepted', room_id: roomA, blocked: true, blocked_by_me: true });
  await enterContacts(h, [entry]); await h.api.activateRoom(roomA);
  h.state.rpcHandlers.sx_set_contact_block = async args => {
    assert.equal(args.p_blocked, false); h.state.contacts = [contact({ ...entry, blocked_by_me: false })];
    return { data: true, error: null };
  };
  await h.$('active-block').fire('click');
  assert.equal(h.$('body').disabled, true); assert.equal(h.$('active-block').textContent, 'Bloquear');
  assert.match(h.$('notice').textContent, /sigue sin estar disponible/);
});

test('late contact list response after account change cannot expose old aliases', async () => {
  const h = await harness(); await enterContacts(h, []);
  const pending = deferred(); h.state.contactQueue.push(pending.promise); const read = h.api.refreshContacts();
  h.state.contacts = [contact({ counterpart_label: 'Bob contact' })]; await h.api.showAuthenticated(bob); await h.api.refreshContacts();
  pending.resolve({ data: [contact({ counterpart_label: 'Alice private contact' })], error: null }); await read;
  assert.equal(h.$('contacts-list').children[0].children[0].textContent, 'Bob contact');
  h.api.showSignedOut(); assert.equal(h.$('contacts-list').children.length, 0); assert.equal(h.state.timers.size, 0);
});

test('late invitation operation after logout cannot restore its code or notice', async () => {
  const h = await harness(); await enterContacts(h, []); h.$('contact-label').value = 'Alias';
  const pending = deferred(); h.state.rpcHandlers.sx_contact_invite = () => pending.promise;
  const creating = h.$('create-invite').fire('click'); h.api.showSignedOut();
  pending.resolve({ data: roomB, error: null }); await creating;
  assert.equal(h.$('invite-result').hidden, true); assert.equal(h.$('invite-code').value, '');
  assert.equal(h.$('contacts-list').children.length, 0);
});

test('contact request uses only invite code and chosen alias, preserving empty chat', async () => {
  const h = await harness(); await enterContacts(h, []);
  h.$('contact-label').value = '  Seudónimo  '; h.$('contact-code').value = roomB;
  h.state.rpcHandlers.sx_request_contact = async args => {
    assert.deepEqual({ ...args }, { p_invite_code: roomB, p_label: 'Seudónimo' });
    h.state.contacts = [contact({ direction: 'outgoing' })]; return { data: 'contact-1', error: null };
  };
  await h.$('request-contact-form').fire('submit');
  assert.equal(h.$('contact-code').value, ''); assert.equal(h.$('active-chat').hidden, true);
  assert.match(h.$('notice').textContent, /Solicitud registrada/);
});

test('invalid invite and missing alias fail before any request mutation', async () => {
  const h = await harness(); await enterContacts(h, []); h.$('contact-code').value = 'invalid';
  await h.$('request-contact-form').fire('submit');
  h.$('contact-code').value = roomB; await h.$('request-contact-form').fire('submit');
  assert.equal(h.state.rpcCalls.filter(c => c.name === 'sx_request_contact').length, 0);
});

test('contact polls coalesce slow reads, preserve buttons when unchanged, and report failures without losing entries', async () => {
  const h = await harness(); await enterContacts(h, [contact()]);
  const button = cardButtons(h)[0]; await h.api.refreshContacts(); assert.equal(cardButtons(h)[0], button);
  const pending = deferred(); h.state.contactQueue.push(pending.promise); const read = h.api.refreshContacts();
  const count = h.state.rpcCalls.length; await Promise.resolve(); void h.api.refreshContacts(); void h.api.refreshContacts();
  assert.equal(h.state.rpcCalls.length, count);
  pending.resolve({ data: [contact({ counterpart_label: 'updated alias' })], error: null }); await read;
  assert.equal(h.$('contacts-list').children[0].children[0].textContent, 'updated alias');
  h.state.contactQueue.push({ data: null, error: { message: 'network error' } }); await h.api.refreshContacts();
  assert.equal(h.$('contacts-list').children[0].children[0].textContent, 'updated alias');
  assert.match(h.$('contacts-status').textContent, /No se han podido actualizar/);
});

test('easy mode changes presentation without requesting different identity or permissions', async () => {
  const h = await harness(); await enterContacts(h, [contact()]); const calls = h.state.rpcCalls.length;
  await h.$('easy-mode').fire('click');
  assert.equal(h.$('easy-mode')['aria-pressed'], 'true'); assert.equal(h.$('easy-help').hidden, false);
  assert.equal(h.$('legacy-room-options').hidden, true); assert.match(h.$('app-layout').className, /easy-mode/);
  assert.equal(h.state.rpcCalls.length, calls); assert.equal(h.$('identity').textContent, alice.email);
  await h.$('easy-mode').fire('click'); assert.equal(h.$('easy-mode')['aria-pressed'], 'false');
});

test('accepted request with a failed room read reports retry honestly and retains accepted contact', async () => {
  const h = await harness(); await enterContacts(h, [contact()]);
  h.state.rpcHandlers.sx_decide_contact = async () => {
    h.state.contacts = [contact({ status: 'accepted', room_id: roomA })];
    h.state.memberQueue.push({ data: null, error: { message: 'network failure' } });
    return { data: roomA, error: null };
  };
  await cardButtons(h)[0].fire('click');
  assert.equal(h.$('active-chat').hidden, true);
  assert.match(h.$('notice').textContent, /aceptada, pero no se ha podido abrir/);
  assert.equal(h.$('notice').className, 'notice error');
  assert.deepEqual(contactButtons(h), ['Abrir conversación', 'Bloquear']);
});

test('contact read started before blocking cannot restore pre-block send controls', async () => {
  const h = await harness(); const entry = contact({ status: 'accepted', room_id: roomA });
  await enterContacts(h, [entry]); await h.api.activateRoom(roomA);
  const stale = deferred(); h.state.contactQueue.push(stale.promise); const read = h.api.refreshContacts();
  h.state.rpcHandlers.sx_set_contact_block = async () => {
    h.state.contacts = [contact({ ...entry, blocked: true, blocked_by_me: true })]; return { data: true, error: null };
  };
  const block = h.$('active-block').fire('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.$('body').disabled, true);
  stale.resolve({ data: [entry], error: null }); await read;
  assert.equal(h.$('body').disabled, true);
  await block; assert.equal(h.$('body').disabled, true);
});

test('accepted RPC cannot undo navigation chosen while its decision was pending', async () => {
  const h = await harness(); await enterContacts(h, [contact()]);
  const pending = deferred(); h.state.rpcHandlers.sx_decide_contact = () => pending.promise;
  const accepting = cardButtons(h)[0].fire('click');
  await h.$('leave-room').fire('click');
  h.state.contacts = [contact({ status: 'accepted', room_id: roomA })];
  pending.resolve({ data: roomA, error: null }); await accepting;
  assert.equal(h.$('active-chat').hidden, true); assert.equal(h.$('room-code').textContent, '');
  assert.equal(h.storage.has('sx_connect_room:alice'), false);
  assert.deepEqual(contactButtons(h), ['Abrir conversación', 'Bloquear']);
});

test('local QA accepts HTTP only on exact same loopback origin', async () => {
  const config = { SUPABASE_URL: 'http://127.0.0.1:4341', SUPABASE_PUBLISHABLE_KEY: 'local-public-fixture' };
  const h = await harness({ testConfig: config, origin: config.SUPABASE_URL });
  await h.api.showAuthenticated(alice); assert.equal(h.$('identity').textContent, alice.email);
  await assert.rejects(harness({ testConfig: config }), /Configuración de Supabase pendiente/);
  await assert.rejects(harness({ testConfig: { ...config, SUPABASE_URL: 'http://example.invalid:4341' }, origin: 'http://example.invalid:4341' }), /Configuración de Supabase pendiente/);
});
