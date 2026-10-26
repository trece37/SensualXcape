import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { PROFILE_STAGES } from '../forum/community.js';

const base = await readFile(new URL('../supabase/forocromos-live.sql',import.meta.url),'utf8');
const sql = await readFile(new URL('../supabase/forocromos-community.sql',import.meta.url),'utf8');
const ids = Object.fromEntries(['mod','a','b','pending','suspended','founder','outside'].map((name,i)=>[name,`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`]));
const pgArray = values => `{${values.join(',')}}`;

async function fixture(t) {
 const db=new PGlite(); t.after(()=>db.close());
 await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth; create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  grant usage on schema auth,public to anon,authenticated;
  create schema storage;
  create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
  create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text,owner_id text,metadata jsonb,unique(bucket_id,name));
  alter table storage.objects enable row level security;
  grant usage on schema storage to anon,authenticated;
  grant select,insert,update,delete on storage.objects to anon,authenticated;
  create function storage.allow_any_operation(ops text[]) returns boolean language sql stable as $$
    select replace(coalesce(current_setting('storage.operation',true),''),'storage.','')=any(ops);
  $$;
  -- An unrelated overly broad policy must NOT open the new media buckets.
  create policy existing_policy on storage.objects for all to public using(true) with check(true);
  insert into storage.buckets values('existing','existing',false,1000000,array['text/plain']);
  insert into storage.objects(bucket_id,name,metadata) values('existing','existing.txt','{}');
 `);
 for(const id of Object.values(ids)) await db.query('insert into auth.users values($1)',[id]);
 await db.exec(base);
 for(const name of ['mod','a','b','pending','suspended','founder']) await db.query(
  'insert into fc_members(user_id,alias,status,role) values($1,$2,$3,$4)',
  [ids[name],`Alias ${name}`,['pending','suspended'].includes(name)?name:'active',['mod','founder'].includes(name)?'moderator':'member']);
 try { await db.exec(sql); } catch(error) { throw new Error(`${error.message}; position=${error.position}; ${sql.slice(Number(error.position)-100,Number(error.position)+100)}`); }
 await db.query('insert into fc_private.founders values($1)',[ids.founder]);
 const as=async(actor,query,args=[],operation='object.get_authenticated')=>{
  await db.exec(`set role ${actor===null?'anon':'authenticated'}`);
  try {
   await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('storage.operation',$2,false)",[actor===null?'':ids[actor]??actor,operation]);
   return await db.query(query,args);
  } finally { await db.exec('reset role'); await db.exec("select set_config('request.jwt.claim.sub','',false),set_config('storage.operation','',false)"); }
 };
 const rpc=async(actor,name,args=[])=>{
  assert.match(name,/^fc_[a-z_]+$/);
  return (await as(actor,`select ${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) value`,args)).rows[0].value;
 };
 const reserve=(actor='a',extra={})=>rpc(actor,'fc_reserve_file',[extra.purpose??'attachment',extra.name??'prueba.png',extra.mime??'image/png',extra.size??100]);
 const upload=async(actor,file,extra={})=>{
  const metadata={mimetype:file.mime_type,contentLength:Number(file.byte_size),...extra};
  await as(actor,'insert into storage.objects(bucket_id,name,owner_id,metadata) values($1,$2,$3,$4)',[file.bucket_id,file.object_path,ids[actor],metadata]);
  await db.query('update storage.objects set metadata=$1 where bucket_id=$2 and name=$3',
    [{mimetype:file.mime_type,size:Number(file.byte_size),...extra},file.bucket_id,file.object_path]);
  return rpc(actor,'fc_finish_file',[file.id]);
 };
 const topic=(actor='a',files=[],style={})=>rpc(actor,'fc_publish',['topic',null,'cuidado','Tema de prueba','Texto plano <literal>.',style,pgArray(files)]);
 const reply=(topicId,actor='b',files=[],style={})=>rpc(actor,'fc_publish',['reply',topicId,null,null,'Respuesta de prueba.',style,pgArray(files)]);
 return {db,as,rpc,reserve,upload,topic,reply};
}

test('community SQL is additive/repeatable; buckets are private and credentials/entitlements stay private',async t=>{
 const {db,as,rpc}=await fixture(t); await db.exec(sql);
 const buckets=(await db.query("select * from storage.buckets where id like 'fc-%' order by id")).rows;
 assert.equal(buckets.length,3); assert.ok(buckets.every(b=>!b.public));
 assert.equal(buckets.find(b=>b.id==='fc-founder-files').file_size_limit,50000000);
 assert.ok(buckets.filter(b=>b.id!=='fc-founder-files').every(b=>b.file_size_limit===950000));
 await assert.rejects(as('a','select * from fc_private.founders'),/permission denied/);
 await assert.rejects(as('mod','insert into fc_private.founders values($1)',[ids.mod]),/permission denied/);
 await assert.rejects(as('a',"insert into fc_files(owner_id,purpose,bucket_id,object_path,file_name,mime_type,byte_size) values($1,'attachment','fc-attachments','fake','fake','text/plain',1)",[ids.a]),/permission denied/);
 assert.equal((await rpc('a','fc_create_topic',['cuidado','Título antiguo','Cuerpo antiguo'])).author_id,ids.a);
 assert.equal((await as(null,'select * from storage.objects')).rows.length,1,'unrelated bucket preserved');
 const functions=(await db.query("select prosecdef,proconfig from pg_proc where pronamespace='public'::regnamespace and proname like 'fc_%'")).rows;
 assert.ok(functions.every(f=>!f.prosecdef && f.proconfig.includes('search_path=""')));
});

test('reservations enforce identities, type/size limits and only private founder IDs get larger attachments',async t=>{
 const {as,rpc,reserve}=await fixture(t);
 for(const actor of [null,'outside','pending','suspended']) await assert.rejects(reserve(actor),/permission denied|fc_active_member_required/);
 assert.equal((await rpc('mod','fc_upload_policy')).attachment_limit,950000);
 const policy=await rpc('founder','fc_upload_policy'); assert.equal(policy.founder,true); assert.equal(policy.attachment_limit,50000000);
 const normal=await reserve(); assert.equal(normal.owner_id,ids.a); assert.equal(normal.bucket_id,'fc-attachments');
 assert.equal(normal.object_path,`${ids.a}/${normal.id}`); assert.equal(normal.status,'reserved');
 assert.equal((await reserve('founder',{size:950001,mime:'video/mp4',name:'clip.mp4'})).bucket_id,'fc-founder-files');
 for(const extra of [{size:950001},{size:0},{size:50000001},{mime:'text/html'},{mime:'image/svg+xml'},{name:'../unsafe.png'},{name:'<img>.png'},{purpose:'avatar',mime:'image/gif'},{purpose:'avatar',size:950001}]) {
  await assert.rejects(reserve(extra.purpose==='avatar'?'founder':'a',extra),/fc_invalid_file/);
 }
 assert.equal((await reserve('a',{name:'nota.txt',mime:'text/plain'})).mime_type,'text/plain');
 const cards=await rpc('a','fc_profile_cards',[pgArray([ids.a,ids.founder])]);
 assert.equal(cards.find(c=>c.user_id===ids.a).is_founder,false);
 assert.equal('is_founder' in cards.find(c=>c.user_id===ids.founder),false);
 await assert.rejects(as('a','update fc_members set role=$1 where user_id=$2',['moderator',ids.a]),/permission denied/);
});

test('Storage RLS rejects guessed paths, mismatched metadata, other owners and updates despite a broad existing policy',async t=>{
 const {db,as,reserve,upload}=await fixture(t); const f=await reserve();
 for(const [actor,bucket,path,owner,meta] of [
  [null,f.bucket_id,f.object_path,ids.a,{mimetype:f.mime_type,size:100}],
  ['b',f.bucket_id,f.object_path,ids.b,{mimetype:f.mime_type,size:100}],
  ['a',f.bucket_id,`${ids.a}/unreserved`,ids.a,{mimetype:f.mime_type,size:100}],
  ['a',f.bucket_id,f.object_path,ids.b,{mimetype:f.mime_type,size:100}],
  ['a',f.bucket_id,f.object_path,ids.a,{mimetype:'text/plain',size:100}],
  ['a',f.bucket_id,f.object_path,ids.a,{mimetype:f.mime_type,size:101}],
  ['a','fc-founder-files',f.object_path,ids.a,{mimetype:f.mime_type,size:100}],
 ]) await assert.rejects(as(actor,'insert into storage.objects(bucket_id,name,owner_id,metadata) values($1,$2,$3,$4)',[bucket,path,owner,meta]),/row-level security/);
 await upload('a',f);
 assert.equal((await as('a','select * from storage.objects where bucket_id=$1',[f.bucket_id])).rows.length,1);
 assert.equal((await as('a','select * from storage.objects where name=$1',[f.object_path],'object.sign')).rows.length,0);
 assert.equal((await as('a','select * from storage.objects where name=$1',[f.object_path],'object.sign_many')).rows.length,0);
 assert.equal((await as('b','select * from storage.objects where bucket_id=$1',[f.bucket_id])).rows.length,0);
 const changed=await as('a',"update storage.objects set metadata='{}' where bucket_id=$1 returning id",[f.bucket_id]); assert.equal(changed.rows.length,0);
 await assert.rejects(as('a','update storage.objects set bucket_id=$1,name=$2 where bucket_id=$3',['fc-attachments',f.object_path,'existing']),/row-level security/);
 const expired=await reserve('b'); await db.query("update fc_files set expires_at=now()-interval '1 second' where id=$1",[expired.id]);
 await assert.rejects(upload('b',expired),/row-level security/);
});

test('finish, publish and body/style editing enforce metadata, ownership and atomic state changes',async t=>{
 const {db,as,rpc,reserve,upload,topic,reply}=await fixture(t);
 const f=await reserve(); await assert.rejects(rpc('a','fc_finish_file',[f.id]),/fc_file_metadata_mismatch/);
 await assert.rejects(rpc('b','fc_finish_file',[f.id]),/fc_file_unavailable/);
 await assert.rejects(topic('a',[f.id]),/fc_file_unavailable/);
 await upload('a',f); const f2=await reserve(); await upload('a',f2);
 await db.query('update storage.objects set metadata=$1 where bucket_id=$2 and name=$3',[{mimetype:'image/png',size:101},f.bucket_id,f.object_path]);
 await assert.rejects(rpc('a','fc_finish_file',[f.id]),/fc_file_metadata_mismatch/);
 await db.query('update storage.objects set metadata=$1 where bucket_id=$2 and name=$3',[{mimetype:'image/png',size:100},f.bucket_id,f.object_path]);
 await assert.rejects(topic('a',[f.id,f.id]),/fc_invalid_files/);
 await assert.rejects(topic('a',[f.id,f2.id,f.id,f2.id]),/fc_invalid_files/);
 await assert.rejects(topic('b',[f.id]),/fc_file_unavailable/);
 const created=await topic('a',[f.id,f2.id],{font:'serif',color:'teal'});
 assert.deepEqual(created.style,{font:'serif',color:'teal'}); assert.equal(created.files.length,2);
 assert.equal(created.body,'Texto plano <literal>.');
 assert.equal((await as('b','select * from fc_files where topic_id=$1',[created.id])).rows.length,2);
 await assert.rejects(topic('a',[f.id]),/fc_file_unavailable/);
 const g=await reserve('b'); await upload('b',g); const answer=await reply(created.id,'b',[g.id]);
 assert.equal(answer.files[0].reply_id,answer.id); assert.equal(answer.files[0].topic_id,null);
 for(const actor of [null,'outside','pending','suspended','b','mod']) {
  await assert.rejects(rpc(actor,'fc_update_post',['topic',created.id,'Texto ajeno',{font:'mono',color:'rose'}]),/permission denied|fc_active_member_required|fc_content_unavailable/);
 }
 const edited=await rpc('a','fc_update_post',['topic',created.id,'Texto propio <sin HTML ejecutable>.',{font:'mono',color:'rose'}]);
 assert.equal(edited.body,'Texto propio <sin HTML ejecutable>.'); assert.deepEqual(edited.style,{font:'mono',color:'rose'}); assert.equal(edited.files.length,2);
 for(const field of ['id','title','category','author_id','editorial','pinned','closed','hidden','created_at']) assert.deepEqual(edited[field],created[field]);
 const editedReply=await rpc('b','fc_update_post',['reply',answer.id,'Respuesta corregida.',{font:'serif',color:'violet'}]);
 assert.equal(editedReply.body,'Respuesta corregida.'); assert.equal(editedReply.files[0].id,g.id);
 await assert.rejects(rpc('a','fc_update_post',['topic',created.id,'No debe guardarse',{font:'sans',html:'<b>x</b>'}]),/fc_invalid_style/);
 await assert.rejects(rpc('a','fc_update_post',['topic',created.id,'x'.repeat(5001),{font:'sans',color:'teal'}]),/fc_invalid_body/);
 const unchanged=(await db.query('select body,style from fc_topics where id=$1',[created.id])).rows[0];
 assert.equal(unchanged.body,edited.body); assert.deepEqual(unchanged.style,edited.style);
 assert.deepEqual(await rpc('a','fc_edit',['topic',created.id,'Editor anterior compatible.']),{ok:true});
 assert.deepEqual((await db.query('select style from fc_topics where id=$1',[created.id])).rows[0].style,edited.style);
 const h=await reserve('b'); await upload('b',h); await rpc('mod','fc_moderate',['topic_close',created.id]);
 await assert.rejects(reply(created.id,'b',[h.id]),/fc_topic_closed/);
 await assert.rejects(rpc('a','fc_update_post',['topic',created.id,'Cerrado',{font:'sans'}]),/fc_topic_closed/);
 await assert.rejects(rpc('b','fc_update_post',['reply',answer.id,'Cerrado',{font:'sans'}]),/fc_topic_closed/);
 assert.equal((await db.query('select status from fc_files where id=$1',[h.id])).rows[0].status,'ready');
 assert.equal((await db.query('select count(*)::integer n from fc_replies')).rows[0].n,1);
 for(const style of [{font:'bad'},{color:'red'},{html:'<b>x</b>'},{font:'sans;url(x)'},[]]) await assert.rejects(topic('a',[],style),/fc_invalid_style/);
});

test('hidden/withdrawn parents revoke attachment reads; provisional and removed media never become shared',async t=>{
 const {as,rpc,reserve,upload,topic,reply}=await fixture(t);
 const item=await topic(); const f=await reserve('b'); await upload('b',f); const answer=await reply(item.id,'b',[f.id]);
 assert.equal((await as('a','select * from storage.objects where name=$1',[f.object_path])).rows.length,1);
 await rpc('mod','fc_moderate',['topic_hide',item.id]);
 await assert.rejects(rpc('b','fc_update_post',['reply',answer.id,'Oculto',{font:'sans'}]),/fc_content_unavailable/);
 assert.equal((await as('b','select * from storage.objects where name=$1',[f.object_path])).rows.length,0);
 assert.equal((await as('mod','select * from storage.objects where name=$1',[f.object_path])).rows.length,1);
 await rpc('mod','fc_moderate',['topic_show',item.id]);
 await rpc('b','fc_withdraw',['reply',answer.id]);
 await assert.rejects(rpc('b','fc_update_post',['reply',answer.id,'Retirado',{font:'sans'}]),/fc_content_unavailable/);
 assert.equal((await as('mod','select * from storage.objects where name=$1',[f.object_path])).rows.length,0);
 await assert.rejects(rpc('a','fc_remove_file',[f.id]),/fc_file_unavailable/);
 const cleanup=await rpc('b','fc_file_cleanup'); assert.equal(cleanup[0].status,'removed');
 assert.equal((await as('b','select * from storage.objects where name=$1',[f.object_path])).rows.length,0);
 const deletion=await as('b','delete from storage.objects where name=$1 returning id',[f.object_path],'object.delete_many'); assert.equal(deletion.rows.length,1);
 assert.equal((await rpc('b','fc_upload_policy')).storage_used,100,'reservation holds its budget until expiry');
});

test('avatars and profile styles validate ownership, replacement revokes old avatar and bodies remain plain text',async t=>{
 const {as,rpc,reserve,upload}=await fixture(t);
 const avatar=await reserve('a',{purpose:'avatar'}); await upload('a',avatar);
 await assert.rejects(rpc('b','fc_profile_details',['Alias B','Texto',avatar.id,'sans','rose']),/fc_file_unavailable/);
 const card=await rpc('a','fc_profile_details',['Luna','Una presentación breve',avatar.id,'mono','violet']);
 assert.equal(card.tagline,'Una presentación breve'); assert.equal(card.avatar_file_id,avatar.id); assert.equal(card.avatar.object_path,avatar.object_path);
 assert.equal((await as('b','select * from storage.objects where name=$1',[avatar.object_path])).rows.length,1);
 for(const values of [['<b>Luna</b>','','sans','default'],['Luna','x'.repeat(161),'sans','default'],['Luna','<i>hola</i>','sans','default'],['Luna','','comic','default'],['Luna','','sans','url(x)']]) {
  await assert.rejects(rpc('a','fc_profile_details',[values[0],values[1],avatar.id,values[2],values[3]]),/fc_invalid_profile/);
 }
 const next=await reserve('a',{purpose:'avatar'}); await upload('a',next);
 await rpc('a','fc_profile_details',['Luna','',next.id,'sans','default']);
 assert.equal((await as('a','select * from storage.objects where name=$1',[avatar.object_path])).rows.length,0);
 assert.equal((await rpc('a','fc_my_files')).some(f=>f.id===avatar.id&&f.status==='removed'),true);
 await rpc('a','fc_profile_details',['Luna','',null,'sans','default']);
 assert.equal((await as('b','select * from storage.objects where name=$1',[next.object_path])).rows.length,0);
});

test('profile counters and progression count visible contributions and distinct UTC dates only',async t=>{
 const {db,rpc,topic,reply}=await fixture(t);
 const first=await topic(),second=await topic(); const answer=await reply(first.id,'a');
 await db.query("update fc_topics set created_at='2026-10-20T23:30:00Z' where id=$1",[first.id]);
 await db.query("update fc_topics set created_at='2026-10-21T00:30:00Z' where id=$1",[second.id]);
 await db.query("update fc_replies set created_at='2026-10-21T10:30:00Z' where id=$1",[answer.id]);
 let card=(await rpc('b','fc_profile_cards',[pgArray([ids.a])]))[0];
 assert.equal(card.topic_count,2); assert.equal(card.reply_count,1); assert.equal(card.active_days,2); assert.equal(card.contribution_count,3); assert.equal(card.level,1);
 assert.equal(card.days_member,0); assert.equal(card.stage_id,'bienvenida');
 assert.equal('upload_limit' in card,false);
 await rpc('mod','fc_moderate',['topic_hide',first.id]);
 card=(await rpc('a','fc_profile_cards',[pgArray([ids.a])]))[0]; assert.equal(card.topic_count,1); assert.equal(card.reply_count,0); assert.equal(card.active_days,1);
 async function stats(days,contributions,activeDays) {
  await db.query('delete from fc_topics where author_id=$1',[ids.a]);
  await db.query("update fc_members set created_at=now()-$2::integer*interval '1 day' where user_id=$1",[ids.a,days]);
  await db.query("insert into fc_topics(category,title,body,author_id,created_at) select 'cuidado','Prueba de trayectoria','Texto',$1,now()-((g-1)%greatest(1,$3::integer))*interval '1 day' from generate_series(1,$2::integer) g",[ids.a,contributions,activeDays]);
  return (await rpc('b','fc_profile_cards',[pgArray([ids.a])]))[0];
 }
 assert.equal((await stats(0,100,30)).stage_id,'bienvenida','contributions alone do not grant seniority');
 assert.equal((await stats(300,0,0)).stage_id,'bienvenida','seniority alone does not grant a stage');
 for(const [index,stage] of PROFILE_STAGES.entries()) {
  card=await stats(stage.minDays,stage.minContributions,Math.max(1,stage.minActiveDays));
  assert.equal(card.stage_id,stage.id); assert.equal(card.level,index+1); assert.equal(card.days_member,stage.minDays);
  if(stage.minDays) assert.notEqual((await stats(stage.minDays-1,stage.minContributions,Math.max(1,stage.minActiveDays))).stage_id,stage.id,'days are required');
  if(stage.minContributions) assert.notEqual((await stats(stage.minDays,stage.minContributions-1,Math.max(1,stage.minActiveDays))).stage_id,stage.id,'contributions are required');
  if(stage.minActiveDays) assert.notEqual((await stats(stage.minDays,stage.minContributions,stage.minActiveDays-1)).stage_id,stage.id,'distinct active days are required');
 }
 assert.equal(card.role,'member','progression never changes role');
 await rpc('mod','fc_admit',[ids.a,'suspended']);
 assert.deepEqual(await rpc('b','fc_profile_cards',[pgArray([ids.a])]),[]);
 assert.deepEqual(await rpc('pending','fc_profile_cards',[pgArray([ids.b])]),[]);
});

test('role assignment is founder-only; helper has no moderator powers and founders cannot be reassigned',async t=>{
 const {as,rpc,topic}=await fixture(t); const item=await topic();
 await assert.rejects(rpc('mod','fc_assign_role',[ids.b,'helper']),/fc_founder_required/);
 assert.equal((await rpc('founder','fc_assign_role',[ids.b,'helper'])).role,'helper');
 await assert.rejects(rpc('b','fc_moderate',['topic_close',item.id]),/fc_moderator_required/);
 await assert.rejects(rpc('b','fc_admit',[ids.pending,'active']),/fc_moderator_required/);
 await assert.rejects(rpc('b','fc_assign_role',[ids.a,'moderator']),/fc_founder_required/);
 await assert.rejects(rpc('founder','fc_assign_role',[ids.founder,'member']),/fc_invalid_role_assignment/);
 await assert.rejects(rpc('founder','fc_assign_role',[ids.pending,'helper']),/fc_member_not_active/);
 assert.equal((await rpc('founder','fc_assign_role',[ids.b,'moderator'])).role,'moderator');
 await rpc('b','fc_moderate',['topic_close',item.id]);
 await assert.rejects(as('a','update fc_members set tagline=$1 where user_id=$2',['forged',ids.a]),/permission denied/);
});

test('quota includes reservations/removals; physical remnants stay charged and expired staging is explicitly cleaned',async t=>{
 const {db,as,rpc,reserve,upload}=await fixture(t);
 const staged=[]; for(let i=0;i<6;i++) staged.push(await reserve());
 assert.equal((await rpc('a','fc_my_files')).length,6,'live reservations can be discarded before upload');
 await assert.rejects(reserve(),/fc_file_quota/);
 for(const f of staged) await rpc('a','fc_remove_file',[f.id]);
 assert.deepEqual(await rpc('a','fc_my_files'),[],'cancelled reservations without bytes disappear from the pending list');
 for(let i=6;i<20;i++){const f=await reserve();await rpc('a','fc_remove_file',[f.id]);}
 await assert.rejects(reserve(),/fc_file_quota/);
 assert.equal((await rpc('a','fc_upload_policy')).remaining_files,0);
 const f=await reserve('b'); await upload('b',f); await rpc('b','fc_remove_file',[f.id]);
 assert.ok((await rpc('b','fc_my_files')).some(row=>row.id===f.id));
 assert.ok((await rpc('b','fc_file_cleanup')).some(row=>row.id===f.id));
 assert.equal((await rpc('b','fc_upload_policy')).storage_used,100);
 assert.equal((await as('b','select * from storage.objects where name=$1',[f.object_path])).rows.length,0);
 await as('b','delete from storage.objects where name=$1',[f.object_path],'object.delete_many');
 assert.deepEqual(await rpc('b','fc_my_files'),[],'physical deletion clears the pending UI list');
 assert.deepEqual(await rpc('b','fc_file_cleanup'),[],'physical deletion clears cleanup candidates');
 assert.equal((await db.query('select status from fc_files where id=$1',[f.id])).rows[0].status,'removed','quota ledger is retained');
 assert.equal((await rpc('b','fc_upload_policy')).storage_used,100,'cancellation cannot reset reservation budget');
 await db.query("update fc_files set expires_at=now()-interval '1 second' where id=$1",[f.id]);
 assert.equal((await rpc('b','fc_upload_policy')).storage_used,0);
 const neverUploaded=await reserve('b');
 await db.query("update fc_files set expires_at=now()-interval '1 second' where id=$1",[neverUploaded.id]);
 assert.deepEqual(await rpc('b','fc_my_files'),[],'expired reservations without an object do not linger');
 assert.deepEqual(await rpc('b','fc_file_cleanup'),[]);
 assert.equal((await db.query('select status from fc_files where id=$1',[neverUploaded.id])).rows[0].status,'removed');
 const expired=await reserve('b'); await upload('b',expired);
 await db.query("update fc_files set expires_at=now()-interval '1 second' where id=$1",[expired.id]);
 assert.ok((await rpc('b','fc_file_cleanup')).some(row=>row.id===expired.id&&row.status==='removed'));
 await rpc('mod','fc_admit',[ids.b,'suspended']);
 assert.equal((await as('b','delete from storage.objects where name=$1 returning id',[expired.object_path],'object.delete_many')).rows.length,1);
 await assert.rejects(reserve('b'),/fc_active_member_required/);
});

test('founder daily bytes, retained capacity and the shared 900 MB budget are enforced independently',async t=>{
 const {db,reserve}=await fixture(t);
 const large=[];
 for(let i=0;i<4;i++) large.push(await reserve('founder',{size:50000000,mime:'video/mp4',name:'clip.mp4'}));
 await assert.rejects(reserve('founder',{size:1}),/fc_file_quota/,'daily byte cap before file-count/staging caps');
 await db.query("update fc_files set created_at=now()-interval '2 days',expires_at=now()-interval '1 day',status='linked' where owner_id=$1",[ids.founder]);
 await assert.rejects(reserve('founder',{size:1}),/fc_file_quota/,'retained capacity after daily window expires');
 // Administrative fixture simulates a populated shared installation; members
 // cannot insert these rows or alter their timestamps through the API.
 await db.query("insert into fc_files(owner_id,purpose,bucket_id,object_path,file_name,mime_type,byte_size,status,created_at,expires_at) select $1,'attachment','fc-founder-files','budget/'||g,'clip.mp4','video/mp4',50000000,'linked',now()-interval '2 days',now()-interval '1 day' from generate_series(1,14) g",[ids.founder]);
 await assert.rejects(reserve('a',{size:1}),/fc_file_quota/,'shared capacity applies to a member with no personal usage');
});
