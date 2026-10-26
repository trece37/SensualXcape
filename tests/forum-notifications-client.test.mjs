import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createNotifications, notificationTopic, decodePublicKey } from '../forum/notifications.js';
const topic = '11111111-1111-4111-8111-111111111111', notification = '22222222-2222-4222-8222-222222222222';
const flush = async () => { for(let i=0;i<6;i++) await new Promise(resolve=>setImmediate(resolve)); };
function fixture(t,{rpc:custom}={}) {
 const dom=new JSDOM('<button id="notifications-button"></button>',{url:'https://example.invalid/foro/',pretendToBeVisual:true}),win=dom.window,doc=win.document;
 win.HTMLDialogElement.prototype.showModal=function(){this.open=true;};win.HTMLDialogElement.prototype.close=function(){this.open=false;};
 let actor='a',epoch=0;const opened=[],calls=[];
 const rpc=async(name,args)=>{calls.push({name,args,actor});if(custom){const v=await custom(name,args);if(v!==undefined)return v;}
  if(name==='fc_notifications')return{items:[{id:notification,topic_id:topic,reply_id:'reply',created_at:'2026-10-26T09:00:00Z',read_at:null}],unread_count:1,has_more:false};
  if(name==='fc_notification_settings')return{email_enabled:true,email:'private@example.invalid',email_verified:true,deliveryConfigured:false};
  return{updated:1};};
 const client={from:()=>({select(){return this;},in(){return Promise.resolve({data:[{id:topic,title:'PRIVATE TOPIC <script>bad</script>'}],error:null});}})};
 const ui=createNotifications({doc,win,client,rpc,isActive:()=>!!actor,capture:()=>{const old=epoch;return()=>{if(old!==epoch||!actor)throw Object.assign(new Error('changed'),{code:'FC_SESSION_CHANGED'});};},onOpenTopic:async id=>opened.push(id),errorText:e=>e.message});
 t.after(()=>{ui.destroy();win.close();});return{doc,win,ui,calls,opened,switch(id){actor=id;epoch++;ui.reset();},button(text){return[...doc.querySelectorAll('button')].find(n=>n.textContent===text);}};
}
test('notification deep links accept only a UUID and VAPID decoding is URL-safe',()=>{
 assert.equal(notificationTopic(`https://example.invalid/foro/?topic=${topic}`),topic);
 for(const value of ['<script>','javascript:alert(1)','../private',''])assert.equal(notificationTopic(`https://example.invalid/?topic=${value}`),null);
 assert.deepEqual([...decodePublicKey('AQI_', {atob:value=>Buffer.from(value,'base64').toString('binary')})],[1,2,63]);
});
test('the inbox shows a private authorized title as text and marks only its selected notice read',async t=>{
 const h=fixture(t);await h.ui.open();
 assert.match(h.doc.querySelector('#notifications-dialog').textContent,/PRIVATE TOPIC/);
 assert.equal(h.doc.querySelector('script'),null);assert.match(h.doc.querySelector('#notifications-button').getAttribute('aria-label'),/1 sin leer/);
 h.button('Nueva respuesta · abrir').click();await flush();assert.deepEqual(h.opened,[topic]);
 assert.deepEqual(h.calls.find(c=>c.name==='fc_read_notifications').args,{p_ids:[notification]});
});
test('a late inbox result cannot repopulate an account after reset',async t=>{
 let resolve;const pending=new Promise(done=>resolve=done);const h=fixture(t,{rpc:name=>name==='fc_notifications'?pending:undefined});
 const loading=h.ui.open();h.switch(null);resolve({items:[],unread_count:9,has_more:false});await loading;
 assert.equal(h.doc.querySelector('#notifications-dialog'),null);assert.equal(h.doc.querySelector('#notifications-button').hidden,true);assert.doesNotMatch(h.doc.body.textContent,/PRIVATE/);
});
test('email preferences disclose pending delivery and never enable browser permissions automatically',async t=>{
 const h=fixture(t),section=h.ui.settingsPanel();h.doc.body.append(section);await flush();
 assert.match(section.textContent,/private@example.invalid/);assert.match(section.textContent,/pendiente de conectar/);
 assert.match(section.textContent,/Este navegador no permite/);
 h.button('Guardar preferencia de correo').click();await flush();assert.deepEqual(h.calls.find(c=>c.name==='fc_set_notifications').args,{p_email_enabled:true});
 assert.match(section.textContent,/sigue pendiente/);
});
test('closing the inbox while a read is pending cancels its later navigation',async t=>{
 let resolve;const pending=new Promise(done=>resolve=done),h=fixture(t,{rpc:name=>name==='fc_read_notifications'?pending:undefined});
 await h.ui.open();h.button('Nueva respuesta · abrir').click();h.button('Cerrar avisos').click();resolve({updated:1});await flush();assert.deepEqual(h.opened,[]);
});
