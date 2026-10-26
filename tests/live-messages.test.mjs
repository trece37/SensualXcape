import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createLiveMessages } from '../demo/live-messages.js';
const alice = { user: { id: 'a' } }, bob = { user: { id: 'b' } };
const room = { room_id: '10000000-0000-4000-8000-000000000001', counterpart_id: 'b', counterpart_label: 'Mi contacto', blocked: false, blocked_by_me: false, legacy: true };
const flush = async () => { for (let n = 0; n < 5; n++) await new Promise(r => setImmediate(r)); };
function setup(t, handler, options={}) {
  const dom = new JSDOM('<body></body>', { url: 'https://example.test/SensualXcape/v2/', pretendToBeVisual: true }); const w = dom.window, calls = [];
  const client = { rpc: async (name, args) => { calls.push({ name, args }); return handler ? handler(name, args) : { data: name === 'sx_list_conversations' ? [room] : [] }; }, channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel: async () => {} };
  const app = createLiveMessages({ client, documentRef: w.document, windowRef: w, confirmAction: async () => true,...options }); w.document.body.append(app.element);
  t.after(() => { app.destroy(); w.close(); }); const button = text => [...app.element.querySelectorAll('button')].find(n => n.textContent === text);
  return { app, w, calls, button };
}
test('real conversations render without sample people and incoming requests need an explicit decision', async t => {
  const h = setup(t, name => ({ data: name === 'sx_list_contacts' ? [{ id: 'request', status: 'pending', direction: 'incoming', counterpart_label: 'Invitada' }] : name === 'sx_list_conversations' ? [room] : null }));
  h.app.setSession(alice); await flush(); assert.match(h.app.element.textContent, /Invitada/); assert.doesNotMatch(h.app.element.textContent, /Marina|Lúa/);
  assert.equal(h.calls.some(c => c.name === 'sx_decide_contact'), false); h.button('Aceptar').click(); await flush(); assert.deepEqual(h.calls.find(c => c.name === 'sx_decide_contact').args, { p_contact_id: 'request', p_accept: true });
});
test('responses from an old account cannot restore its contacts after logout or a switch', async t => {
  let release; const h = setup(t, name => name === 'sx_list_conversations' ? new Promise(resolve => { release = resolve; }) : { data: [] });
  h.app.setSession(alice); await flush(); h.app.setSession(null); release({ data: [room] }); await flush(); assert.doesNotMatch(h.app.element.textContent, /Mi contacto/);
  h.app.setSession(bob); await flush(); h.app.setSession(null); release({ data: [{ ...room, counterpart_label: 'Otro contacto' }] }); await flush(); assert.doesNotMatch(h.app.element.textContent, /Otro contacto/);
});
test('an ambiguous send retry retains its idempotency key and stays usable after a contact refresh', async t => {
  let failures = 1; const h = setup(t, (name, args) => name === 'sx_send_message' ? failures-- > 0 ? { error: { code: 'NETWORK' } } : { data: { id: 9, body: args.p_body, sender_id: 'a', created_at: new Date().toISOString() } } : { data: name === 'sx_list_conversations' ? [room] : [] });
  h.app.setSession(alice); await flush(); h.button('Abrir conversación').click(); await flush(); const input = h.app.element.querySelector('textarea'), form = input.closest('form'); input.value = 'Mi mensaje'; form.dispatchEvent(new h.w.Event('submit', { cancelable: true })); await flush();
  await h.app.refresh(); assert.equal(h.button('Enviar').disabled, false); form.dispatchEvent(new h.w.Event('submit', { cancelable: true })); await flush(); const sends = h.calls.filter(c => c.name === 'sx_send_message'); assert.equal(sends.length, 2); assert.equal(sends[0].args.p_client_message_id, sends[1].args.p_client_message_id); assert.equal(h.app.element.querySelectorAll('.message').length, 1); assert.equal(input.value, '');
});
test('blocking is a server action and clears any open shared profile', async t => {
  let blocked = false; const h = setup(t, name => { if (name === 'sx_set_room_block') blocked = true; return { data: name === 'sx_list_conversations' ? [{ ...room, blocked, blocked_by_me: blocked }] : [] }; });
  let invalidated = false; h.w.addEventListener('sx:contact-block', event => { invalidated = event.detail.blocked; }); h.app.setSession(alice); await flush(); h.button('Abrir conversación').click(); await flush(); h.button('Bloquear').click(); await flush();
  assert.equal(invalidated, true); assert.equal(h.app.element.querySelector('textarea').disabled, true); assert.equal(h.calls.some(c => c.name === 'sx_set_room_block'), true); assert.equal(h.button('Ver perfil').disabled, true);
});
test('text is rendered as text and drafts are cleared between identities', async t => {
  const h = setup(t, name => ({ data: name === 'sx_list_conversations' ? [room] : name === 'sx_messages_page' ? [{ id: 1, body: '<img src=x onerror=alert(1)>', sender_id: 'b' }] : [] }));
  h.app.setSession(alice); await flush(); h.button('Abrir conversación').click(); await flush(); assert.equal(h.app.element.querySelector('.messages img'), null); const input = h.app.element.querySelector('textarea'); input.value = 'borrador privado'; input.dispatchEvent(new h.w.Event('input')); h.app.setSession(null); h.app.setSession(bob); await flush(); h.button('Abrir conversación').click(); await flush(); assert.equal(input.value, '');
});
test('an uncertain retry keeps its key after leaving and reopening a conversation',async t=>{
 const h=setup(t,name=>name==='sx_send_message'?{error:{code:'NETWORK'}}:{data:name==='sx_list_conversations'?[room]:[]});h.app.setSession(alice);await flush();h.button('Abrir conversación').click();await flush();const input=h.app.element.querySelector('textarea'),form=input.closest('form');input.value='Una sola vez';input.dispatchEvent(new h.w.Event('input'));form.dispatchEvent(new h.w.Event('submit',{cancelable:true}));await flush();h.button('← Volver a contactos').click();h.button('Abrir conversación').click();await flush();form.dispatchEvent(new h.w.Event('submit',{cancelable:true}));await flush();const sends=h.calls.filter(c=>c.name==='sx_send_message');assert.equal(sends.length,2);assert.equal(sends[0].args.p_client_message_id,sends[1].args.p_client_message_id);
});
test('a block confirmation opened by A cannot mutate under account B',async t=>{
 let resolve;const h=setup(t,null,{confirmAction:()=>new Promise(r=>{resolve=r;})});h.app.setSession(alice);await flush();h.button('Abrir conversación').click();await flush();h.button('Bloquear').click();h.app.setSession(bob);resolve(true);await flush();assert.equal(h.calls.some(c=>c.name==='sx_set_room_block'),false);
});
test('an authentication failure invalidates and clears history, unlike a network failure',async t=>{
 let unauthorized=false,h;h=setup(t,name=>unauthorized?{error:{code:'PGRST301'},status:401}:{data:name==='sx_list_conversations'?[room]:name==='sx_messages_page'?[{id:1,body:'PRIVATE HISTORY',sender_id:'a'}]:[]},{onAuthLost:()=>h.app.setSession(null)});h.app.setSession(alice);await flush();h.button('Abrir conversación').click();await flush();assert.match(h.app.element.textContent,/PRIVATE HISTORY/);unauthorized=true;await h.app.refresh();await flush();assert.doesNotMatch(h.app.element.textContent,/PRIVATE HISTORY/);assert.equal(h.app.element.querySelector('.sx-live-conversation').hidden,true);
});
