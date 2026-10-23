import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as rawHttpRequest } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { createLocalQaServer, LOCAL_QA_PUBLIC_KEY, LOCAL_QA_BODY_LIMIT } from '../scripts/local-qa-server.mjs';

async function fixture(t) {
  const app = await createLocalQaServer({ port: 0 });
  t.after(() => app.close());
  async function request(path, { method = 'GET', token, body, headers = {} } = {}) {
    const response = await fetch(app.origin + path, { method, headers: {
      apikey: LOCAL_QA_PUBLIC_KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null, response };
  }
  async function login(email) {
    const result = await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: '123456' } });
    assert.equal(result.status, 200); return result.data;
  }
  const rpc = (name, params, session) => request(`/rest/v1/rpc/${name}`, { method: 'POST', token: session.access_token, body: params });
  return { app, request, login, rpc };
}

test('local HTTP contract uses real SQL/RLS for requests, decisions, chat, outsider denial and independent blocks', async t => {
  const { request, login, rpc } = await fixture(t);
  const [a, b, c] = await Promise.all(['a', 'b', 'c'].map(name => login(`${name}@example.invalid`)));
  const invite = await rpc('sx_contact_invite', { p_label: 'A receptora' }, a);
  assert.equal(invite.status, 200); assert.equal(typeof invite.data, 'string');
  assert.equal((await rpc('sx_contact_invite', { p_label: 'A receptora' }, a)).data, invite.data);
  const contact = await rpc('sx_request_contact', { p_invite_code: invite.data, p_label: 'B solicitante' }, b);
  assert.equal(contact.status, 200);
  assert.equal((await rpc('sx_request_contact', { p_invite_code: invite.data, p_label: 'retry' }, b)).data, contact.data);
  assert.equal((await rpc('sx_decide_contact', { p_contact_id: contact.data, p_accept: true }, b)).status, 403);
  assert.deepEqual((await rpc('sx_list_contacts', {}, c)).data, []);
  const room = await rpc('sx_decide_contact', { p_contact_id: contact.data, p_accept: true }, a);
  assert.equal(room.status, 200); assert.equal(typeof room.data, 'string');
  assert.equal((await rpc('sx_decide_contact', { p_contact_id: contact.data, p_accept: true }, a)).data, room.data);
  assert.equal((await rpc('sx_create_chat', {}, a)).status, 403);
  assert.equal((await rpc('sx_join_chat', { p_room_id: room.data }, c)).status, 403);
  const members = await request(`/rest/v1/sx_room_members?select=room_id,user_id&room_id=eq.${room.data}`, { token: a.access_token });
  assert.equal(members.status, 200); assert.deepEqual(members.data, [{ room_id: room.data, user_id: a.user.id }]);
  const first = { room_id: room.data, sender_id: a.user.id, body: 'Texto ficticio A', client_message_id: randomUUID() };
  assert.equal((await request('/rest/v1/sx_messages', { method: 'POST', token: a.access_token, body: first })).status, 201);
  assert.equal((await request('/rest/v1/sx_messages', { method: 'POST', token: a.access_token, body: first })).status, 409);
  assert.equal((await request('/rest/v1/sx_messages', { method: 'POST', token: b.access_token,
    body: { room_id: room.data, sender_id: a.user.id, body: 'spoof' } })).status, 403);
  assert.equal((await request('/rest/v1/sx_messages', { method: 'POST', token: b.access_token,
    body: { room_id: room.data, sender_id: b.user.id, body: 'Respuesta ficticia B' } })).status, 201);
  const path = `/rest/v1/sx_messages?select=id,body&room_id=eq.${room.data}&order=id.desc&limit=150`;
  assert.deepEqual((await request(path, { token: b.access_token })).data.map(row => row.body), ['Respuesta ficticia B', 'Texto ficticio A']);
  assert.deepEqual((await request(path, { token: c.access_token })).data, []);
  assert.equal((await request(path)).status, 401);
  assert.equal((await request('/rest/v1/sx_messages', { method: 'POST', token: c.access_token,
    body: { room_id: room.data, sender_id: c.user.id, body: 'outsider' } })).status, 403);
  assert.equal((await rpc('sx_set_contact_block', { p_contact_id: contact.data, p_blocked: true }, b)).data, true);
  const blockedList = (await rpc('sx_list_contacts', {}, a)).data;
  assert.equal(blockedList[0].blocked, true); assert.equal(blockedList[0].blocked_by_me, false);
  assert.equal((await request('/rest/v1/sx_messages', { method: 'POST', token: a.access_token,
    body: { room_id: room.data, sender_id: a.user.id, body: 'blocked' } })).status, 403);
  assert.equal((await rpc('sx_request_contact', { p_invite_code: invite.data, p_label: 'blocked request' }, b)).status, 403);
  assert.equal((await rpc('sx_set_contact_block', { p_contact_id: contact.data, p_blocked: false }, a)).data, true);
  assert.equal((await request(path, { token: a.access_token })).data.length, 2, 'blocking preserves history');
  assert.equal((await rpc('sx_set_contact_block', { p_contact_id: contact.data, p_blocked: false }, b)).data, false);
  assert.equal((await request('/rest/v1/sx_messages', { method: 'POST', token: a.access_token,
    body: { room_id: room.data, sender_id: a.user.id, body: 'after voluntary unblock' } })).status, 201);
  const rejected = await rpc('sx_request_contact', { p_invite_code: invite.data, p_label: 'C solicitante' }, c);
  assert.equal(rejected.status, 200);
  assert.equal((await rpc('sx_decide_contact', { p_contact_id: rejected.data, p_accept: false }, a)).data, null);
  assert.equal((await rpc('sx_request_contact', { p_invite_code: invite.data, p_label: 'C retry' }, c)).status, 403);
  assert.equal((await rpc('sx_decide_contact', { p_contact_id: rejected.data, p_accept: true }, a)).status, 403);
  assert.deepEqual((await rpc('sx_list_contacts', {}, c)).data.map(row => [row.status, row.room_id]), [['rejected', null]]);
});

test('real supabase-js 2.49.10 client completes auth, scalar/table RPC, maybeSingle, sending and refresh/logout', async t => {
  const { app } = await fixture(t);
  const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
  const a = createClient(app.origin, LOCAL_QA_PUBLIC_KEY, options);
  const b = createClient(app.origin, LOCAL_QA_PUBLIC_KEY, options);
  const c = createClient(app.origin, LOCAL_QA_PUBLIC_KEY, options);
  for (const [client, name] of [[a, 'a'], [b, 'b'], [c, 'c']]) {
    const result = await client.auth.signInWithPassword({ email: `${name}@example.invalid`, password: '123456' });
    assert.equal(result.error, null); assert.ok(result.data.session.access_token); assert.equal(result.data.user.email, `${name}@example.invalid`);
  }
  const user = await a.auth.getUser(); assert.equal(user.error, null);
  const invited = await a.rpc('sx_contact_invite', { p_label: 'A SDK' }); assert.equal(invited.error, null);
  const requested = await b.rpc('sx_request_contact', { p_invite_code: invited.data, p_label: 'B SDK' }); assert.equal(requested.error, null);
  const listed = await a.rpc('sx_list_contacts'); assert.equal(listed.error, null); assert.equal(listed.data[0].direction, 'incoming');
  const accepted = await a.rpc('sx_decide_contact', { p_contact_id: requested.data, p_accept: true }); assert.equal(accepted.error, null);
  const member = await a.from('sx_room_members').select('room_id').eq('room_id', accepted.data).eq('user_id', user.data.user.id).maybeSingle();
  assert.equal(member.error, null); assert.equal(member.data.room_id, accepted.data);
  const absent = await c.from('sx_room_members').select('room_id').eq('room_id', accepted.data).maybeSingle();
  assert.equal(absent.error, null); assert.equal(absent.data, null);
  const sent = await a.from('sx_messages').insert({ room_id: accepted.data, sender_id: user.data.user.id,
    body: 'SDK real contra datos ficticios', client_message_id: randomUUID() });
  assert.equal(sent.error, null); assert.equal(sent.data, null);
  const received = await b.from('sx_messages').select('id,body').eq('room_id', accepted.data).order('id', { ascending: false }).limit(150);
  assert.equal(received.error, null); assert.equal(received.data[0].body, 'SDK real contra datos ficticios');
  const refreshed = await a.auth.refreshSession(); assert.equal(refreshed.error, null); assert.ok(refreshed.data.session.refresh_token);
  assert.equal((await a.auth.getUser()).error, null);
  assert.equal((await a.auth.signOut()).error, null);
  assert.ok((await a.auth.getUser()).error);
});

test('local boundary rejects foreign Host/Origin, excessive bodies, unsupported writes/SQL and unknown identities', async t => {
  const { app, request, login, rpc } = await fixture(t);
  const index = await fetch(app.origin); assert.equal(index.status, 200); assert.match(await index.text(), /Local · datos ficticios/);
  const config = await (await fetch(app.origin + '/config.js')).text();
  assert.ok(config.includes(app.origin)); assert.ok(config.includes(LOCAL_QA_PUBLIC_KEY)); assert.doesNotMatch(config, /supabase\.co/);
  const invalidHostStatus = await new Promise((resolve, reject) => {
    const raw = rawHttpRequest(app.origin, { headers: { Host: 'localhost:4341' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    raw.on('error', reject); raw.end();
  });
  assert.equal(invalidHostStatus, 403);
  assert.equal((await fetch(app.origin, { headers: { Origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await fetch(app.origin, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(app.origin + '/auth/v1/token?grant_type=password', { method: 'POST',
    headers: { apikey: LOCAL_QA_PUBLIC_KEY, 'Content-Type': 'application/json' }, body: 'x'.repeat(LOCAL_QA_BODY_LIMIT + 1) })).status, 413);
  assert.equal((await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: 'someone@example.invalid', password: '123456' } })).status, 400);
  assert.equal((await request('/auth/v1/signup', { method: 'POST', body: {} })).status, 403);
  assert.equal((await request('/auth/v1/recover', { method: 'POST', body: {} })).status, 403);
  const a = await login('a@example.invalid');
  assert.equal((await rpc('sx_contact_invite', { p_label: 'A', owner_id: randomUUID() }, a)).status, 400);
  assert.equal((await request('/rest/v1/sx_messages?select=id;drop table auth.users', { token: a.access_token })).status, 400);
  assert.equal((await request('/rest/v1/sx_messages?limit=151', { token: a.access_token })).status, 400);
  assert.equal((await request('/rest/v1/sx_messages?room_id=not.eq.uuid', { token: a.access_token })).status, 400);
  assert.equal((await request('/rest/v1/sx_messages', { method: 'POST', token: a.access_token, body: [] })).status, 400);
  assert.equal((await request('/rest/v1/sx_messages', { method: 'DELETE', token: a.access_token })).status, 405);
  assert.equal((await request('/rest/v1/rpc/execute_sql', { method: 'POST', token: a.access_token, body: { query: 'select 1' } })).status, 404);
  assert.equal((await request('/README.md')).status, 404);
  assert.equal((await request('/realtime/v1/websocket')).status, 503);
  assert.equal((await request('/rest/v1/sx_messages', { token: LOCAL_QA_PUBLIC_KEY })).status, 401);
});
