import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../forum/sw.js',import.meta.url),'utf8');
const device='11111111-1111-4111-8111-111111111111',topic='22222222-2222-4222-8222-222222222222',scope='https://example.invalid/foro/';
const flush=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};
function fixture({waitForShow}={}){
 const listeners=new Map(),cache=new Map(),cards=[],opened=[],acks=[];
 const context=vm.createContext({URL,Response,caches:{open:async()=>({match:async key=>cache.has(key)?new Response(cache.get(key)):undefined,put:async(key,response)=>cache.set(key,await response.text())})},self:{registration:{scope,getNotifications:async()=>[...cards],showNotification:async(title,options)=>{if(waitForShow)await waitForShow;const card={title,options,close(){const index=cards.indexOf(card);if(index>=0)cards.splice(index,1);}};cards.push(card);}},clients:{claim:async()=>{},matchAll:async()=>[],openWindow:async url=>opened.push(url)},skipWaiting:async()=>{},addEventListener:(name,fn)=>listeners.set(name,fn)}});
 vm.runInContext(source,context);
 const emit=(type,extra={})=>{let promise=Promise.resolve();listeners.get(type)({...extra,waitUntil:value=>promise=value});return promise;};
 const bind=id=>emit('message',{data:{type:'FC_SET_PUSH_BINDING',id},source:{url:scope},ports:[{postMessage:value=>acks.push(value)}]});
 const push=data=>emit('push',{data:{json:()=>data}});
 return{bind,push,emit,cards,opened,acks,cache};
}
test('push displays only for the current opaque device binding and keeps private payload text out of notifications',async()=>{
 const h=fixture();await h.bind(device);
 const payload={device_id:device,url:`${scope}?topic=${topic}`,tag:'foro-job',body:'PRIVATE BODY',title:'PRIVATE TITLE'};
 await h.push({...payload,device_id:topic});assert.equal(h.cards.length,0);
 await h.push({...payload,url:`https://tracker.invalid/?topic=${topic}`});assert.equal(h.cards.length,0);
 await h.push(payload);assert.equal(h.cards.length,1);assert.equal(h.cards[0].title,'Nueva respuesta');assert.doesNotMatch(JSON.stringify(h.cards[0].options),/PRIVATE/);
 assert.equal(h.cards[0].options.renotify,false);
});
test('logout binding acknowledgment waits for an in-flight display, then closes every old card',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve),h=fixture({waitForShow:pending});await h.bind(device);h.acks.length=0;
 const showing=h.push({device_id:device,url:`${scope}?topic=${topic}`,tag:'job'});await flush();
 const clearing=h.bind(null);await flush();assert.equal(h.acks.length,0);
 release();await showing;await clearing;assert.equal(h.cards.length,0);assert.equal(h.acks.length,1);
 await h.push({device_id:device,url:`${scope}?topic=${topic}`,tag:'job'});assert.equal(h.cards.length,0);
});
test('a notification from a logged-out account cannot open a conversation and bindings retain no credentials',async()=>{
 const h=fixture();await h.bind(device);await h.bind(null);
 await h.emit('notificationclick',{notification:{data:{device_id:device,topic_id:topic},close(){}}});assert.deepEqual(h.opened,[]);
 assert.equal([...h.cache.values()][0],'');assert.doesNotMatch(source,/addEventListener\(['"]fetch|access_token|refresh_token|localStorage/);
});
