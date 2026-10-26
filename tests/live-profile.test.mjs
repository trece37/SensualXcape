import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createLiveProfileView, createProfileAdapter, prepareProfilePhoto } from '../demo/live-profile.js';
const a='00000000-0000-4000-8000-000000000001',b='00000000-0000-4000-8000-000000000002';
const photoId='00000000-0000-4000-8000-000000000010';
const draft=()=>({privateAlias:'',privateBio:'',publicAlias:'',publicBio:'',photos:[],coverId:null});
const clone=value=>structuredClone(value);
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
const flush=async()=>{for(let i=0;i<14;i++)await new Promise(resolve=>setImmediate(resolve));};
function fixture(t,{rpcOverride,downloadOverride,confirm=true,onAuthLost=()=>{}}={}){
 const dom=new JSDOM('<!doctype html><body></body>',{url:'https://example.invalid/v2/',pretendToBeVisual:true});const w=dom.window,d=w.document;
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
 const urls=[],revoked=[],calls=[],notices=[],confirmations=[],publications=[];let actor=a,sequence=20,allowed=true;
 w.URL.createObjectURL=blob=>{const url=`blob:private-profile-${urls.length+1}`;urls.push({url,blob});return url;};
 w.URL.revokeObjectURL=url=>{revoked.push(url);calls.push({kind:'revoke',url});};
 for(const key of ['localStorage','sessionStorage'])Object.defineProperty(w,key,{get(){throw new Error('Profile data must not enter web storage');}});
 w.fetch=()=>{throw new Error('No external fetch');};
 const states=new Map([a,b].map(id=>[id,{revision:0,draft:draft(),publication:null,files:[]}])),blobs=new Map();
 const client={async rpc(name,args){
  calls.push({kind:'rpc',name,args:clone(args||{}),actor});
  if(rpcOverride){const override=await rpcOverride(name,args,actor);if(override!==undefined)return override;}
  const state=states.get(actor);
  if(name==='sx_profile_state')return{data:clone(state),error:null};
  if(name==='sx_profile_shared')return{data:allowed?clone({publication:states.get(args.p_owner_id).publication,files:states.get(args.p_owner_id).files}):null,error:null};
  if(name==='sx_profile_reserve_photo'){const id=`00000000-0000-4000-8000-${String(sequence++).padStart(12,'0')}`,file={id,owner_id:actor,bucket_id:'sx-profile-photos',object_path:`${actor}/${id}.webp`,mime_type:'image/webp',byte_size:args.p_bytes,status:'reserved'};state.files.push(file);return{data:clone(file),error:null};}
  if(name==='sx_profile_finish_photo'){const file=state.files.find(file=>file.id===args.p_id);file.status='ready';return{data:clone(file),error:null};}
  if(name==='sx_profile_save'){if(args.p_expected_revision!==state.revision)return{data:null,error:{code:'40001',message:'sx_profile_revision_conflict'}};state.draft=clone(args.p_draft);state.revision++;}
  else if(name==='sx_profile_publish'){if(args.p_expected_revision!==state.revision)return{data:null,error:{code:'40001',message:'sx_profile_revision_conflict'}};state.publication={alias:args.p_include_information?state.draft.publicAlias:'',bio:args.p_include_information?state.draft.publicBio:'',photos:args.p_include_photos?clone(state.draft.photos):[],coverIndex:args.p_include_photos?state.draft.photos.findIndex(photo=>photo.id===state.draft.coverId):-1,audience:'contacts'};state.revision++;}
  else if(name==='sx_profile_withdraw'){state.publication=null;state.revision++;}
  else if(name==='sx_profile_remove_photo'){const file=state.files.find(file=>file.id===args.p_id);file.status='removed';state.draft.photos=state.draft.photos.filter(photo=>photo.id!==file.id);if(state.publication?.photos.some(photo=>photo.id===file.id))state.publication=null;state.revision++;return{data:{state:clone(state),file:clone(file)},error:null};}
  else if(name==='sx_profile_discard_photo'){const file=state.files.find(file=>file.id===args.p_id),used=[...state.draft.photos,...(state.publication?.photos||[])].some(photo=>photo.id===file.id);if(!used)file.status='removed';return{data:{state:clone(state),discarded:!used,file:clone(file)},error:null};}
  else if(name==='sx_profile_delete'){state.draft=draft();state.publication=null;state.revision++;for(const file of state.files)file.status='removed';return{data:{state:clone(state),files:clone(state.files)},error:null};}
  else throw new Error(`Unexpected RPC ${name}`);
  return{data:clone(state),error:null};
 },storage:{from(bucket){assert.equal(bucket,'sx-profile-photos');return{
  async upload(path,bytes,options){calls.push({kind:'upload',path,options});blobs.set(path,new Blob([bytes],{type:'image/webp'}));return{data:{path},error:null};},
  async download(path){calls.push({kind:'download',path});if(downloadOverride){const override=await downloadOverride(path);if(override!==undefined)return override;}return{data:blobs.get(path),error:null};},
  async remove(paths){calls.push({kind:'remove',paths});for(const path of paths)blobs.delete(path);return{data:paths,error:null};}
 };}}};
 const session=()=>actor?{user:{id:actor}}:null;
 const view=createLiveProfileView({client,getSession:session,documentRef:d,windowRef:w,onAuthLost,confirmAction:async details=>{confirmations.push(details);return typeof confirm==='function'?confirm(details):confirm;},notify:text=>notices.push(text),onPublish:value=>publications.push(value),preparePhoto:async()=>new File(['prepared'],'foto.webp',{type:'image/webp'})});
 view.setSession(session());d.body.append(view.element);t.after(()=>{view.destroy();w.close();});
 const $=selector=>view.element.querySelector(selector);
 const input=(name,value)=>{const node=$(`[data-field="${name}"]`);node.value=value;node.dispatchEvent(new w.Event('input',{bubbles:true}));};
 const include=(name,value=true)=>{const node=$(`[data-include="${name}"]`);node.checked=value;node.dispatchEvent(new w.Event('change',{bubbles:true}));};
 const action=name=>$(`[data-action="${name}"]`).click();
 const choose=()=>{const node=$('[data-field="photos"]');Object.defineProperty(node,'files',{configurable:true,value:[new w.File(['source'],'original.jpg',{type:'image/jpeg'})]});node.dispatchEvent(new w.Event('change',{bubbles:true}));};
 const addPhoto=(owner,id=photoId)=>{const blob=new Blob(['image'],{type:'image/webp'}),file={id,owner_id:owner,bucket_id:'sx-profile-photos',object_path:`${owner}/${id}.webp`,mime_type:'image/webp',byte_size:blob.size,status:'ready'};states.get(owner).files.push(file);blobs.set(file.object_path,blob);return{id,zoom:1.4,x:30,y:70};};
 return{view,w,d,$,client,states,blobs,calls,urls,revoked,notices,confirmations,publications,input,include,action,choose,addPhoto,session,setAccount(id){actor=id;view.setSession(session());},setAllowed(value){allowed=value;}};
}

test('saving the live studio persists all four texts and privately uploads normalized photos without publishing',async t=>{
 const h=fixture(t);await h.view.refresh();h.input('private-alias','PRIVATE ALIAS');h.input('private-bio','PRIVATE NOTES');h.input('public-alias','Alias visible');h.input('public-bio','Mi presentación');h.choose();
 assert.equal(h.calls.filter(call=>call.kind==='upload').length,0);h.action('save-texts');await flush();
 const state=h.states.get(a);assert.equal(state.draft.privateBio,'PRIVATE NOTES');assert.equal(state.publication,null);assert.equal(h.view.getPublicProfile(),null);
 const save=h.calls.find(call=>call.name==='sx_profile_save');assert.equal(save.args.p_expected_revision,0);assert.equal(save.args.p_draft.photos.length,1);assert.match(save.args.p_draft.photos[0].id,/^[0-9a-f-]{36}$/);
 assert.doesNotMatch(JSON.stringify(save.args),/blob:|original\.jpg|file"|includeInformation/);
 assert.deepEqual(h.calls.find(call=>call.kind==='upload').options,{contentType:'image/webp',upsert:false,cacheControl:'0'});
 assert.ok(h.revoked.includes('blob:private-profile-1'),'the local original URL is released after hydration');
 await h.view.refresh();assert.equal(h.$('[data-field="private-bio"]').value,'PRIVATE NOTES');assert.equal(h.$('[data-role="photo-list"]').children.length,1);
});

test('sharing requires specific consent, excludes private texts and keeps the chosen version independent from later draft edits',async t=>{
 const h=fixture(t);await h.view.refresh();h.input('private-bio','PRIVATE NOTE');h.input('public-alias','Alias compartido');h.input('public-bio','<img src=x onerror=alert(1)>');h.include('information');
 h.action('share');await flush();assert.equal(h.confirmations.length,1);assert.match(h.confirmations[0].description,/contactos aceptados por ambas partes y sin bloqueo/);
 assert.equal(h.states.get(a).publication.alias,'Alias compartido');assert.doesNotMatch(JSON.stringify(h.states.get(a).publication),/PRIVATE/);
 assert.equal(h.$('[data-role="public-preview"]').querySelector('script,img'),null);
 h.input('public-alias','Edición sin compartir');h.action('save-texts');await flush();assert.equal(h.states.get(a).publication.alias,'Alias compartido');
 h.input('private-alias','Texto aún sin guardar');h.action('withdraw');await flush();assert.equal(h.states.get(a).publication,null);assert.equal(h.$('[data-field="private-alias"]').value,'Texto aún sin guardar');
});

test('declining the share confirmation performs no upload, save or publication',async t=>{
 const h=fixture(t,{confirm:false});await h.view.refresh();h.input('public-alias','Alias');h.include('information');h.choose();h.include('photos');const before=h.calls.length;
 h.action('share');await flush();assert.equal(h.confirmations.length,1);assert.equal(h.calls.length,before);assert.equal(h.view.getPublicProfile(),null);
});

test('changing accounts immediately clears private fields, previews, shared view and all authenticated object URLs',async t=>{
 const h=fixture(t);const photo=h.addPhoto(a);h.states.get(a).draft={...draft(),privateBio:'ACCOUNT A PRIVATE',photos:[photo],coverId:photo.id};await h.view.refresh();
 assert.equal(h.urls.length,1);h.setAccount(b);assert.equal(h.$('[data-field="private-bio"]').value,'');assert.equal(h.$('[data-role="photo-list"]').children.length,0);assert.deepEqual(h.revoked,['blob:private-profile-1']);
 await h.view.refresh();assert.equal(h.$('[data-field="private-bio"]').value,'');assert.equal(h.view.getPublicProfile(),null);
});

test('late account A loads cannot hydrate account B or allocate a new object URL',async t=>{
 const late=deferred();const h=fixture(t,{downloadOverride:()=>late.promise});const photo=h.addPhoto(a);h.states.get(a).draft={...draft(),privateBio:'LATE A PRIVATE',photos:[photo],coverId:photo.id};
 const loading=h.view.refresh();await flush();h.setAccount(b);late.resolve({data:new Blob(['image'],{type:'image/webp'}),error:null});
 await assert.rejects(loading,error=>error.code==='SX_PROFILE_SESSION_CHANGED');assert.equal(h.urls.length,0);assert.equal(h.$('[data-field="private-bio"]').value,'');
});

test('contacts see only their shared snapshot as text and permission loss closes the modal and revokes its blobs',async t=>{
 const h=fixture(t);const photo=h.addPhoto(b);h.states.get(b).publication={alias:'<svg/onload=alert(1)>',bio:'<script>alert(2)</script>',photos:[photo],coverIndex:0,audience:'contacts'};
 await h.view.openContact(b);const dialog=h.d.querySelector('dialog');assert.ok(dialog?.open);assert.match(dialog.textContent,/<script>alert/);assert.equal(dialog.querySelector('script,svg,iframe,a'),null);assert.equal(dialog.querySelector('img').src,'blob:private-profile-1');
 h.setAllowed(false);await h.view.refreshContact();assert.equal(h.d.querySelector('dialog'),null);assert.deepEqual(h.revoked,['blob:private-profile-1']);
});

test('closing a contact during a pending download prevents stale blobs or a late modal from appearing',async t=>{
 const late=deferred();const h=fixture(t,{downloadOverride:()=>late.promise});const photo=h.addPhoto(b);h.states.get(b).publication={alias:'Contacto',bio:'',photos:[photo],coverIndex:0};
 const opening=h.view.openContact(b);await flush();h.view.closeContact();late.resolve({data:new Blob(['image'],{type:'image/webp'}),error:null});await opening;
 assert.equal(h.urls.length,0);assert.equal(h.d.querySelector('dialog'),null);
});

test('removing a shared photo calls the atomic withdrawal RPC before Storage deletion and preserves unsaved text',async t=>{
 const h=fixture(t);const photo=h.addPhoto(a);h.states.get(a).draft={...draft(),photos:[photo],coverId:photo.id};h.states.get(a).publication={alias:'',bio:'',photos:[photo],coverIndex:0};await h.view.refresh();
 h.input('private-bio','UNSAVED NOTES');h.$(`[data-photo-id="${photo.id}"] button[data-action="remove"]`).click();await flush();
 assert.equal(h.states.get(a).publication,null);assert.equal(h.$('[data-role="photo-list"]').children.length,0);assert.equal(h.$('[data-field="private-bio"]').value,'UNSAVED NOTES');
 assert.ok(h.calls.findIndex(call=>call.name==='sx_profile_remove_photo')<h.calls.findIndex(call=>call.kind==='remove'));
});

test('stale save errors keep the editor intact and explain how to recover the other tab version',async t=>{
 const h=fixture(t);await h.view.refresh();h.states.get(a).revision=5;h.input('private-bio','KEEP MY INPUT');h.action('save-texts');await flush();
 assert.equal(h.$('[data-field="private-bio"]').value,'KEEP MY INPUT');assert.match(h.$('[data-role="sharing-status"]').textContent,/otra pestaña/);assert.equal(h.$('[data-action="save-texts"]').disabled,false);
});

test('a late save success after sign-out cannot restore private text or publication',async t=>{
 const late=deferred();const h=fixture(t,{rpcOverride:(name)=>name==='sx_profile_save'?late.promise:undefined});await h.view.refresh();h.input('private-bio','UNSENT PRIVATE');h.action('save-texts');await flush();h.setAccount(null);
 late.resolve({data:{revision:1,draft:{...draft(),privateBio:'LATE SERVER PRIVATE'},publication:null,files:[]},error:null});await flush();
 assert.equal(h.$('[data-field="private-bio"]').value,'');assert.equal(h.view.getPublicProfile(),null);assert.equal(h.urls.length,0);
});

test('normalization decodes only raster input, strips source metadata, reduces oversized output and closes resources',async()=>{
 const dimensions=[],canvas={width:0,height:0,getContext:()=>({drawImage(){dimensions.push([canvas.width,canvas.height]);}}),toBlob(done,type){done(new Blob([new Uint8Array(dimensions.length===1?950001:20)],{type}));}};let closed=0;
 const win={File,document:{createElement:()=>canvas},createImageBitmap:async()=>({width:4000,height:3000,close(){closed++;}})};
 const file=new File([new Uint8Array([255,216,255]),'PRIVATE EXIF SOURCE'],'original.jpg',{type:'image/jpeg'});const prepared=await prepareProfilePhoto(file,{windowRef:win});
 assert.equal(prepared.type,'image/webp');assert.equal(prepared.size,20);assert.doesNotMatch(await prepared.text(),/PRIVATE EXIF/);assert.deepEqual(dimensions,[[2048,1536],[1600,1200]]);assert.equal(closed,1);assert.equal(canvas.width,0);
 await assert.rejects(prepareProfilePhoto(new File(['<svg/>'],'fake.png',{type:'image/png'}),{windowRef:win}),/leer esta foto/);
});

test('a forbidden Storage path from a response is never downloaded or turned into an image URL',async t=>{
 const h=fixture(t);const photo=h.addPhoto(a);h.states.get(a).draft={...draft(),photos:[photo],coverId:photo.id};h.states.get(a).files[0].object_path=`${b}/${photo.id}.webp`;
 await assert.rejects(h.view.refresh(),/Archivo de perfil no válido/);assert.equal(h.calls.some(call=>call.kind==='download'),false);assert.equal(h.urls.length,0);
});

test('SDK authentication loss clears private DOM and blobs and notifies the runtime, while 42501 does not log out',async t=>{
 let fail=null,lost=0;const h=fixture(t,{onAuthLost:()=>lost++,rpcOverride:name=>name==='sx_profile_state'&&fail?{data:null,error:fail}:undefined});
 const photo=h.addPhoto(a);h.states.get(a).draft={...draft(),privateBio:'EXPIRED PRIVATE',photos:[photo],coverId:photo.id};await h.view.refresh();
 fail={code:'PGRST301',message:'JWT expired'};await assert.rejects(h.view.refresh(),error=>error.code==='SX_PROFILE_SESSION_CHANGED');
 assert.equal(lost,1);assert.equal(h.$('[data-field="private-bio"]').value,'');assert.equal(h.$('[data-role="photo-list"]').children.length,0);assert.equal(h.revoked.length,1);
 fail={code:'42501',message:'Permission denied'};await assert.rejects(h.view.refresh(),error=>error.code==='42501');assert.equal(lost,1);
});

test('Storage authentication failure is handled after the account guard and clears the runtime',async t=>{
 let lost=0;const h=fixture(t,{onAuthLost:()=>lost++,downloadOverride:()=>({data:null,error:{statusCode:'401',message:'unauthorized'}})});const photo=h.addPhoto(a);h.states.get(a).draft={...draft(),photos:[photo],coverId:photo.id};
 await assert.rejects(h.view.refresh(),error=>error.code==='SX_PROFILE_SESSION_CHANGED');assert.equal(lost,1);assert.equal(h.urls.length,0);
});

test('withdrawing after a different tab changes the draft cannot silently authorize overwriting that unseen revision',async t=>{
 const h=fixture(t);h.states.get(a).publication={alias:'Old',bio:'',photos:[],coverIndex:-1};await h.view.refresh();h.input('private-bio','LOCAL UNSAVED');
 h.states.get(a).draft.privateBio='OTHER TAB SAVED';h.states.get(a).revision=3;h.action('withdraw');await flush();
 h.action('save-texts');await flush();assert.equal(h.states.get(a).draft.privateBio,'OTHER TAB SAVED');assert.equal(h.$('[data-field="private-bio"]').value,'LOCAL UNSAVED');assert.match(h.$('[data-role="sharing-status"]').textContent,/otra pestaña/);
});

test('the profile stays disabled until its stored draft has loaded',async t=>{
 const h=fixture(t);assert.equal(h.$('[data-action="save-texts"]').disabled,true);h.action('save-texts');await flush();assert.equal(h.calls.length,0);
 await h.view.refresh();assert.equal(h.$('[data-action="save-texts"]').disabled,false);
});

test('an upload preceding a failed save is discarded only when it is still unreferenced',async t=>{
 const h=fixture(t);await h.view.refresh();h.states.get(a).revision=4;h.choose();h.action('save-texts');await flush();
 assert.equal(h.calls.filter(call=>call.name==='sx_profile_discard_photo').length,1);assert.equal(h.calls.filter(call=>call.kind==='remove').length,1);
 assert.equal(h.states.get(a).files[0].status,'removed');assert.equal(h.$('[data-role="photo-list"]').children.length,1,'the local original remains available for retry');
});
