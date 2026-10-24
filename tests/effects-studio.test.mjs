import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JSDOM} from 'jsdom';
import {buildDemo} from '../scripts/build-demo.mjs';
import {SXFluid} from '../demo/effects/fluid.js';
let output,html,bootStudio;
before(async()=>{output=await mkdtemp(join(tmpdir(),'sx-v2-effects-'));await buildDemo({output});html=await readFile(join(output,'index.html'),'utf8');const bundle=await readFile(join(output,'demo.js'),'utf8');({bootStudio}=await import(`data:text/javascript;base64,${Buffer.from(bundle).toString('base64')}`));});
after(async()=>{if(output)await rm(output,{recursive:true,force:true});});
function setup(t,{reduced=false}={}){
  const dom=new JSDOM(html,{url:'https://trece37.github.io/SensualXcape/v2/',pretendToBeVisual:true}),w=dom.window,d=w.document;
  const calls={network:0,storage:0},states=[],accepted=[],messages=[];
  for(const key of['localStorage','sessionStorage'])Object.defineProperty(w,key,{get(){calls.storage++;throw new Error('Storage outside the demo');}});
  w.fetch=w.XMLHttpRequest=w.WebSocket=()=>{calls.network++;throw new Error('Network outside the demo');};
  w.matchMedia=()=>({matches:reduced,addEventListener(){},removeEventListener(){}});
  w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
  w.URL.createObjectURL=()=>`blob:example-${Math.random()}`;w.URL.revokeObjectURL=()=>{};
  d.addEventListener('sx:effects-change',e=>states.push(e.detail));
  d.addEventListener('sx:contact-accepted',e=>accepted.push({detail:e.detail,status:d.querySelector(`[data-contact-id="${e.detail.contactId}"]`)?.dataset.contactStatus,conversation:d.getElementById('active-chat').hidden}));
  d.addEventListener('sx:demo-message-added',e=>messages.push({detail:e.detail,body:d.querySelector('#messages .msg:last-child .body')?.textContent}));
  const app=bootStudio({documentRef:d,windowRef:w});let destroyed=false;
  const destroy=()=>{if(!destroyed){destroyed=true;app.destroy();}};
  t.after(()=>{destroy();w.close();});
  const byText=(text,root=d)=>[...root.querySelectorAll('button')].find(n=>n.textContent.trim()===text);
  const start=()=>{byText('Tengo 18 años o más').click();app.platform.navigate('professional');byText('Explorar con una cuenta de muestra').click();};
  return{w,d,app,calls,states,accepted,messages,byText,start,destroy};
}
test('V2 labels its version and points back to the unchanged V1 location without accessing browser storage',t=>{
  const h=setup(t);assert.equal(h.d.body.dataset.sxVersion,'2');assert.match(h.d.querySelector('.demo-banner').textContent,/V2/);assert.equal(h.d.querySelector('.sx-version-link').href,'https://trece37.github.io/SensualXcape/');assert.ok(h.d.getElementById('sx-effects-enabled').checked);assert.equal(h.states.at(-1).enabled,true);assert.deepEqual(h.calls,{network:0,storage:0});
});
test('smoke is mounted only in dedicated image surfaces and never inside buttons, forms or notices',t=>{
  const h=setup(t);const art=[...h.d.querySelectorAll('.sx-hero-fx')];assert.equal(art.length,2);for(const region of art){assert.equal(region.dataset.sxEffectRegion,'image');assert.equal(region.getAttribute('aria-hidden'),'true');assert.equal(region.querySelector('button,input,label,a,form'),null);}assert.equal(h.d.querySelector('button canvas,form canvas,.sx-info canvas'),null);
});
test('the visual preference and easy mode synchronously emit the effective state without changing access',t=>{
  const h=setup(t);h.start();h.app.platform.navigate('settings');const control=h.d.getElementById('sx-effects-enabled');control.checked=false;control.dispatchEvent(new h.w.Event('change'));assert.equal(h.states.at(-1).enabled,false);assert.ok(h.d.body.classList.contains('sx-effects-off'));assert.equal(h.app.platform.route,'settings');control.checked=true;control.dispatchEvent(new h.w.Event('change'));assert.equal(h.states.at(-1).enabled,true);
  const easy=h.d.getElementById('sx-easy-mode');easy.checked=true;easy.dispatchEvent(new h.w.Event('change'));assert.equal(h.states.at(-1).enabled,false);assert.equal(h.states.at(-1).easy,true);assert.equal(control.checked,true);assert.equal(h.app.platform.route,'settings');assert.deepEqual(h.calls,{network:0,storage:0});
});
test('reduced motion keeps the routes and controls usable while disabling decorative motion',t=>{
  const h=setup(t,{reduced:true});assert.equal(h.states.at(-1).reduced,true);assert.equal(h.states.at(-1).enabled,false);assert.ok(h.d.body.classList.contains('sx-effects-off'));h.start();h.app.platform.navigate('messages');h.byText('Aceptar ejemplo').click();assert.equal(h.accepted.length,1);assert.equal(h.d.querySelector('.sx-connection-rail').classList.contains('is-active'),false);
});
test('connection feedback is emitted only after a fictitious request is accepted and rendered',t=>{
  const h=setup(t);h.start();h.app.platform.navigate('messages');assert.equal(h.accepted.length,0);h.byText('Aceptar ejemplo').click();assert.equal(h.accepted.length,1);assert.equal(h.accepted[0].status,'accepted');assert.equal(h.accepted[0].conversation,false);assert.equal(h.d.querySelector('.sx-connection-rail').classList.contains('is-active'),true);assert.match(h.d.getElementById('active-contact-status').textContent,/ficticia|envía/);
});
test('message feedback follows the added DOM message and a blocked conversation cannot emit it',t=>{
  const h=setup(t);h.start();h.app.platform.navigate('messages');h.byText('Abrir conversación').click();const input=h.d.getElementById('body'),form=h.d.getElementById('send-form');input.value='Idea de prueba';form.dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));assert.equal(h.messages.length,1);assert.equal(h.messages[0].body,'Idea de prueba');assert.ok(h.d.querySelector('#messages .msg:last-child').classList.contains('sx-message-arrival'));h.d.getElementById('active-block').click();input.value='No debe añadirse';form.dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));assert.equal(h.messages.length,1);assert.match(h.d.getElementById('send-status').textContent,/No se ha enviado ni entregado/);
});
test('the optional shelf links three real routes and keeps the complete service catalogue',t=>{
  const h=setup(t);h.start();const shelf=h.d.querySelector('.sx-shelf-panel');assert.equal(shelf.open,false);assert.equal(shelf.querySelectorAll('.sx-shelf-card').length,3);assert.equal(h.d.querySelectorAll('.sx-dashboard-grid .sx-dashboard-card').length,5);for(const card of shelf.querySelectorAll('.sx-shelf-card'))assert.ok(['messages','cofre','community'].includes(card.dataset.route));assert.equal(h.d.querySelectorAll('.sx-story-number').length,0);assert.ok(h.byText('Qué simula el check-in'));
});
test('destroy removes visual surfaces, preference and observers without leaving motion controls behind',t=>{
  const h=setup(t);h.destroy();assert.equal(h.d.querySelector('.sx-hero-fx,.sx-connection-rail,#sx-effects-enabled'),null);assert.equal(h.d.body.classList.contains('sx-v2'),false);assert.equal(h.d.body.hasAttribute('data-sx-version'),false);h.d.dispatchEvent(new h.w.CustomEvent('sx:contact-accepted',{detail:{name:'Ficticia'}}));assert.equal(h.d.querySelector('.sx-connection-rail'),null);
});

test('fluid pointer input ignores ordinary recovery controls while retaining chest and file-object gestures',()=>{
  const dom=new JSDOM('<div id="stage"><button class="vo-recover"><span>Recuperar</span></button><button class="sx-cofre-chest-touch">Cofre</button><article class="vo-card"><button class="vo-handle">Asa</button></article><button data-sx-fluid-ignore>Sin humo</button></div>');
  const d=dom.window.document,host=d.getElementById('stage'),calls=[];
  host.getBoundingClientRect=()=>({left:0,top:0,width:400,height:400});
  const fluid=Object.assign(Object.create(SXFluid.prototype),{host,enabled:true,destroyed:false,width:64,previous:new Map(),burst:(x,y)=>calls.push(['burst',x,y]),splat:()=>calls.push(['splat'])});
  const gesture=target=>fluid._pointer({target,pointerId:1,pointerType:'mouse',type:'pointerdown',clientX:200,clientY:200});
  gesture(d.querySelector('.vo-recover span'));assert.equal(calls.length,0);assert.equal(fluid.previous.size,0);
  gesture(d.querySelector('[data-sx-fluid-ignore]'));assert.equal(calls.length,0);
  gesture(d.querySelector('.sx-cofre-chest-touch'));assert.deepEqual(calls.at(-1),['burst',.5,.5]);
  gesture(d.querySelector('.vo-handle'));assert.equal(calls.length,2);
  fluid._pointer({target:d.querySelector('.vo-recover'),pointerId:1,pointerType:'mouse',type:'pointermove',clientX:220,clientY:210});assert.equal(calls.length,2);assert.equal(fluid.previous.size,0);
  dom.window.close();
});
