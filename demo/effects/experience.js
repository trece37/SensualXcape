import { SXFluid } from './fluid.js';

/** Visual feedback for the V2 demo. Content and permissions remain in their modules. */
export function mountEffects({documentRef = document, windowRef = window, platform, settings} = {}) {
  const d=documentRef,w=windowRef,cleanups=[],timers=new Set(),scenes=[];
  if(!platform||d.body.classList.contains('sx-v2'))return null;
  let disposed=false,preference=true,lastState='';
  const motion=w.matchMedia?.('(prefers-reduced-motion: reduce)')||{matches:false,addEventListener(){},removeEventListener(){}};
  const listen=(target,type,fn,options)=>{target.addEventListener(type,fn,options);cleanups.push(()=>target.removeEventListener(type,fn,options));};
  const later=(fn,ms)=>{const id=w.setTimeout(()=>{timers.delete(id);if(!disposed)fn();},ms);timers.add(id);return id;};
  const node=(tag,cls,text)=>{const el=d.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};
  const state=()=>({enabled:preference&&!motion.matches&&!d.body.classList.contains('sx-easy'),preferenceEnabled:preference,reduced:motion.matches,easy:d.body.classList.contains('sx-easy'),theme:d.body.dataset.theme||'noir',route:platform.route});
  d.body.classList.add('sx-v2');d.body.dataset.sxVersion='2';

  const preferenceRow=node('label','sx-preference sx-glass sx-effects-preference');
  const check=node('input');check.type='checkbox';check.id='sx-effects-enabled';check.checked=true;
  const preferenceCopy=node('span');preferenceCopy.append(node('strong','','Luz y movimiento'),node('small','','Puedes apagarlos. Modo fácil y movimiento reducido mantienen una vista más tranquila.'));
  preferenceRow.append(check,preferenceCopy);
  if(settings){const easy=settings.querySelector('#sx-easy-mode')?.closest('label');if(easy)easy.before(preferenceRow);else settings.append(preferenceRow);}

  // An art-only surface: no form, button, text or private image enters this canvas.
  for(const [selector,route] of [['.sx-landing-hero','welcome'],['.sx-pro-hero','professional']]){
    const host=d.querySelector(selector);if(!host)continue;
    const art=node('div','sx-hero-fx');art.dataset.sxEffectRegion='image';art.setAttribute('aria-hidden','true');host.append(art);
    const fluid=new SXFluid({host:art,palette:state().theme});
    const previous=new Map();
    const move=event=>{
      if(!state().enabled||platform.route!==route||event.target.closest?.('button,a,input,textarea,select,summary,[role="button"]'))return;
      const rect=art.getBoundingClientRect();if(rect.width<1||rect.height<1)return;
      const x=(event.clientX-rect.left)/rect.width,y=(event.clientY-rect.top)/rect.height;
      if(x<0||x>1||y<0||y>1)return;
      if(event.pointerType==='touch'&&event.type==='pointermove'&&!previous.has(event.pointerId))return;
      const before=previous.get(event.pointerId)||{x,y};
      fluid.splat(x,y,x-before.x,y-before.y,event.type==='pointerdown'?1.1:.8);
      previous.set(event.pointerId,{x,y});
    };
    listen(host,'pointerdown',move,{passive:true});listen(host,'pointermove',move,{passive:true});
    for(const type of ['pointerup','pointercancel','pointerleave'])listen(host,type,event=>previous.delete(event.pointerId),{passive:true});
    scenes.push({art,fluid,route,previous});
  }

  const chat=d.getElementById('active-chat');
  const rail=node('div','sx-connection-rail');rail.setAttribute('aria-hidden','true');
  const self=node('span','sx-connection-node','Tú'),thread=node('span','sx-connection-thread'),other=node('span','sx-connection-node','');
  for(let i=0;i<7;i++){const spark=node('i','sx-connection-spark');spark.style.setProperty('--sx-spark-delay',`${i*45}ms`);thread.append(spark);}
  rail.append(self,thread,other);if(chat)chat.querySelector('.active-contact')?.append(rail);
  let railTimer=0;
  listen(d,'sx:contact-accepted',event=>{
    if(!state().enabled||platform.route!=='messages')return;
    other.textContent=String(event.detail?.name||'').trim().slice(0,1).toUpperCase();
    rail.classList.remove('is-active');void rail.offsetWidth;rail.classList.add('is-active');
    w.clearTimeout(railTimer);timers.delete(railTimer);railTimer=later(()=>rail.classList.remove('is-active'),1200);
  });
  listen(d,'sx:demo-message-added',()=>{
    if(!state().enabled)return;const item=d.querySelector('#messages .msg:last-child');if(!item)return;
    item.classList.add('sx-message-arrival');later(()=>item.classList.remove('sx-message-arrival'),450);
  });

  const pulse=event=>{
    if(!state().enabled)return;
    const target=event.target.closest?.('.sx-button,.sx-overview-card,.sx-dashboard-card,.sx-extra-link,.sx-shelf-card,.sx-cofre-button');
    if(!target||!d.body.contains(target)||target.disabled)return;
    target.classList.remove('sx-action-pulse');void target.offsetWidth;target.classList.add('sx-action-pulse');later(()=>target.classList.remove('sx-action-pulse'),460);
  };
  listen(d,'click',pulse);

  function refresh(){
    if(disposed)return;
    const current=state(),off=!current.enabled;
    if(d.body.classList.contains('sx-effects-off')!==off)d.body.classList.toggle('sx-effects-off',off);
    for(const scene of scenes){scene.fluid.setPalette(current.theme);scene.fluid.setEnabled(current.enabled&&scene.route===current.route);if(!current.enabled)scene.previous.clear();}
    if(!current.enabled){rail.classList.remove('is-active');for(const n of d.querySelectorAll('.sx-action-pulse,.sx-message-arrival'))n.classList.remove('sx-action-pulse','sx-message-arrival');}
    const key=JSON.stringify(current);
    if(key!==lastState){lastState=key;d.dispatchEvent(new w.CustomEvent('sx:effects-change',{detail:current}));}
  }
  function setEnabled(value){preference=Boolean(value);check.checked=preference;refresh();}
  listen(check,'change',()=>setEnabled(check.checked));listen(w,'sx:route',refresh);listen(motion,'change',refresh);
  const observer=w.MutationObserver?new w.MutationObserver(refresh):null;
  observer?.observe(d.body,{attributes:true,attributeFilter:['class','data-theme']});
  refresh();
  return {refresh,setEnabled,get enabled(){return state().enabled;},
    destroy(){if(disposed)return;disposed=true;observer?.disconnect();for(const remove of cleanups)remove();for(const id of timers)w.clearTimeout(id);timers.clear();for(const scene of scenes){scene.fluid.destroy();scene.art.remove();}rail.remove();preferenceRow.remove();d.body.classList.remove('sx-v2','sx-effects-off');delete d.body.dataset.sxVersion;}
  };
}
