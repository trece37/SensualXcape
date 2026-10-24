import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { buildDemo } from '../scripts/build-demo.mjs';
let output, html, bootStudio;
before(async()=>{output=await mkdtemp(join(tmpdir(),'sx-studio-'));await buildDemo({output});html=await readFile(join(output,'index.html'),'utf8');const bundle=await readFile(join(output,'demo.js'),'utf8');({bootStudio}=await import(`data:text/javascript;base64,${Buffer.from(bundle).toString('base64')}`));});
after(async()=>{if(output)await rm(output,{recursive:true,force:true});});
function setup(t,hash=''){
  const dom=new JSDOM(html,{url:`https://demo.invalid/SensualXcape/${hash}`,pretendToBeVisual:true});const w=dom.window,d=w.document;
  const calls={network:0,storage:0};for(const key of['localStorage','sessionStorage'])Object.defineProperty(w,key,{get(){calls.storage++;throw new Error('Storage must not be used');}});
  w.fetch=w.XMLHttpRequest=w.WebSocket=()=>{calls.network++;throw new Error('No data may leave the demo');};
  w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
  w.URL.createObjectURL=()=>`blob:demo-${Math.random()}`;w.URL.revokeObjectURL=()=>{};
  const app=bootStudio({documentRef:d,windowRef:w});t.after(()=>{app.destroy();w.close();});
  const byText=(text,root=d)=>[...root.querySelectorAll('button')].find(n=>n.textContent.trim()===text);
  const start=()=>{byText('Tengo 18 años o más').click();app.platform.navigate('professional');byText('Explorar con una cuenta de muestra').click();};
  return{w,d,app,calls,byText,start};
}
test('first entry declares adulthood separately, opens the public story and defaults to Noir without storage or network',t=>{
  const h=setup(t);assert.equal(h.d.getElementById('sx-age-gate').open,true);assert.match(h.d.getElementById('sx-age-gate').textContent,/declaración de edad/);assert.equal(h.app.platform.route,'welcome');assert.equal(h.d.body.dataset.theme,'noir');assert.match(h.d.querySelector('.sx-welcome').textContent,/Área profesional/);assert.equal(h.d.querySelector('.sx-welcome .sx-services'),null);assert.deepEqual(h.calls,{network:0,storage:0});
});
test('a private deep link presents professional access; visitor views do not open the Cofre or private profile',t=>{
  const h=setup(t,'#cofre');assert.equal(h.app.platform.route,'professional');h.app.platform.navigate('visitors');assert.equal(h.app.platform.route,'visitors');h.app.platform.navigate('profile');assert.equal(h.app.platform.route,'professional');assert.equal(h.app.studio.entered,false);h.byText('Tengo 18 años o más').click();h.byText('Explorar con una cuenta de muestra').click();assert.equal(h.app.platform.route,'profile');assert.equal(h.app.studio.entered,true);
});
test('an unknown hash cannot fall through to the private dashboard before demo entry',t=>{
  const h=setup(t,'#unknown-route');assert.equal(h.app.platform.route,'professional');assert.equal(h.app.studio.entered,false);h.app.platform.navigate('another-unknown');assert.equal(h.app.platform.route,'professional');assert.equal(h.d.querySelector('[data-v11-page=home]').hasAttribute('v11-hidden'),true);
});
test('professional entry connects the dashboard to each service while preserving only one visible page',t=>{
  const h=setup(t);h.start();assert.equal(h.app.platform.route,'home');for(const route of['profile','cofre','messages','community','care','trust','auralink','feedback','plans','settings']){h.app.platform.navigate(route);assert.equal(h.app.platform.route,route);const visible=[...h.d.querySelectorAll('main>[data-v11-page]')].filter(n=>!n.hasAttribute('v11-hidden'));assert.equal(visible.length,1,route);assert.equal(visible[0].dataset.v11Page,route);}
  assert.match(h.d.querySelector('[data-v11-page=cofre]').textContent,/Añadir|Elegir/);assert.ok(h.d.querySelector('[data-v11-page=profile] input[type=file]'));assert.deepEqual(h.calls,{network:0,storage:0});
});
test('context information opens a labelled readable dialog and cancel, Escape and confirm resolve correctly',async t=>{
  const h=setup(t);h.app.studio.showInfo('deletion');const modal=h.d.getElementById('sx-info-dialog');assert.equal(modal.open,true);assert.match(modal.textContent,/dispositivo|original/);h.byText('Entendido',modal).click();assert.equal(modal.open,false);
  let result=h.app.studio.confirmAction({title:'Borrar una prueba',description:'Solo un ejemplo.'});h.byText('Conservar',modal).click();assert.equal(await result,false);
  result=h.app.studio.confirmAction({title:'Borrar una prueba',description:'Solo un ejemplo.',confirmLabel:'Borrar ejemplo'});h.byText('Borrar ejemplo',modal).click();assert.equal(await result,true);
  result=h.app.studio.confirmAction({title:'Otra prueba',description:'Solo un ejemplo.'});modal.dispatchEvent(new h.w.Event('cancel',{cancelable:true}));assert.equal(await result,false);
});
test('visitors see four clearly synthetic presentations, no contact, prices or private files, and can change appearance',t=>{
  const h=setup(t);h.app.platform.navigate('visitors');const page=h.d.querySelector('.sx-visitors');assert.equal(page.querySelectorAll('.sx-visitor-card').length,4);assert.equal(page.querySelector('input, form, [type=file]'),null);assert.match(page.textContent,/sintétic|fictici/);assert.doesNotMatch(page.textContent,/Reservar|Contratar|WhatsApp|€|€/u);h.byText('Cambiar a claro',page).click();assert.equal(page.dataset.appearance,'light');h.byText('Cambiar a oscuro',page).click();assert.equal(page.dataset.appearance,'dark');
});
test('every legal footer control resolves to a specific notice rather than an empty link',t=>{
  const h=setup(t),footer=h.d.getElementById('sx-studio-footer'),modal=h.d.getElementById('sx-info-dialog');const titles=new Set();for(const b of footer.querySelectorAll('.sx-footer-links button')){b.click();assert.equal(modal.open,true);assert.ok(modal.querySelectorAll('p').length>=2);titles.add(modal.querySelector('h2').textContent);h.byText('Entendido',modal).click();}assert.equal(titles.size,6);assert.equal(h.d.querySelector('.sx-footer a[href="#"]'),null);
});
test('the three themes and simple reading mode change presentation without expanding access or using storage',t=>{
  const h=setup(t);h.start();h.app.platform.navigate('settings');for(const value of['rose','neon','noir']){h.app.platform.setTheme(value);assert.equal(h.d.body.dataset.theme,value);assert.equal(h.app.platform.route,'settings');}const easy=h.d.getElementById('sx-easy-mode');easy.checked=true;easy.dispatchEvent(new h.w.Event('change'));assert.ok(h.d.body.classList.contains('sx-easy'));const optional=h.d.getElementById('sx-feedback-choice');assert.equal(optional.checked,false);assert.deepEqual(h.calls,{network:0,storage:0});
});
test('the demo entry discards password and address immediately rather than keeping credentials',t=>{
  const h=setup(t);h.byText('Tengo 18 años o más').click();h.app.platform.navigate('professional');h.d.getElementById('sx-demo-email').value='example@example.invalid';h.d.getElementById('sx-demo-password').value='fictional-only';h.d.querySelector('.sx-login-form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));assert.equal(h.app.studio.entered,true);assert.equal(h.d.getElementById('sx-demo-password').value,'');assert.equal(h.d.getElementById('sx-demo-email').value,'');assert.deepEqual(h.calls,{network:0,storage:0});
});
test('each service has a readable guide and the guide hub is available without entering the private workspace',t=>{
  const h=setup(t);h.app.platform.navigate('guide');assert.equal(h.app.platform.route,'guide');const page=h.d.querySelector('[data-v11-page=guide]');const buttons=[...page.querySelectorAll('button')].filter(n=>n.getAttribute('aria-label')?.startsWith('Cómo funciona'));assert.equal(buttons.length,9);const modal=h.d.getElementById('sx-info-dialog');for(const button of buttons){button.click();assert.equal(modal.open,true);assert.ok(modal.querySelectorAll('.sx-how-steps li').length>=2);h.byText('Cerrar guía',modal).click();}assert.equal(h.app.studio.entered,false);assert.deepEqual(h.calls,{network:0,storage:0});
});
