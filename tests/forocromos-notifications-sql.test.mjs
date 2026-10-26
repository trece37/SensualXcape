import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const base=await readFile(new URL('../supabase/forocromos-live.sql',import.meta.url),'utf8');
const sql=await readFile(new URL('../supabase/forocromos-notifications.sql',import.meta.url),'utf8');
const ids=Object.fromEntries(['a','b','c','mod','pending','suspended','outside'].map((n,i)=>[n,`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`]));
const array=values=>`{${values.join(',')}}`;
async function fixture(t,{configured=true,install=true}={}){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth,public to anon,authenticated,service_role;`);
 for(const id of Object.values(ids))await db.query('insert into auth.users values($1)',[id]);
 await db.exec(base);
 for(const n of ['a','b','c','mod','pending','suspended'])await db.query('insert into fc_members(user_id,alias,status,role)values($1,$2,$3,$4)',[ids[n],`Alias ${n}`,['pending','suspended'].includes(n)?n:'active',n==='mod'?'moderator':'member']);
 const installSql=async()=>{
  try{await db.exec(sql);}catch(e){throw new Error(`${e.message} position ${e.position}: ${sql.slice(Number(e.position)-100,Number(e.position)+100)}`);}
  await db.query('update fc_private.notification_config set delivery_configured=$1',[configured]);
  for(const n of ['a','b','c'])await db.query('insert into fc_private.notification_settings(user_id,email,email_verified_at,email_enabled)values($1,$2,clock_timestamp(),true) on conflict(user_id) do nothing',[ids[n],`${n}@example.invalid`]);
 };
 if(install)await installSql();
 const as=async(actor,q,args=[])=>{
  await db.exec(`set role ${actor===null?'anon':actor==='service'?'service_role':'authenticated'}`);
  try{await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor===null||actor==='service'?'':ids[actor]??actor]);return await db.query(q,args);}
  finally{await db.exec('reset role');await db.exec("select set_config('request.jwt.claim.sub','',false)");}
 };
 const rpc=async(actor,n,args=[])=>(await as(actor,`select ${n}(${args.map((_,i)=>`$${i+1}`).join(',')}) value`,args)).rows[0].value;
 const topic=()=>rpc('a','fc_create_topic',['cuidado','Tema privado','Contenido que no debe llegar al correo.']);
 const reply=(id,actor='b')=>rpc(actor,'fc_reply',[id,'Texto privado de respuesta.']);
 const claim=()=>rpc('service','fc_claim_delivery');
 return{db,as,rpc,topic,reply,claim,installSql};
}

test('installation is repeatable and does not replay historical replies or override explicit mutes',async t=>{
 const f=await fixture(t,{install:false});const item=await f.topic();await f.reply(item.id);await f.installSql();
 assert.equal((await f.db.query('select count(*)::int n from fc_inbox')).rows[0].n,0);
 assert.equal(await f.rpc('a','fc_is_following',[item.id]),true);assert.equal(await f.rpc('b','fc_is_following',[item.id]),true);
 await f.rpc('a','fc_follow_topic',[item.id,false]);await f.db.exec(sql);assert.equal(await f.rpc('a','fc_is_following',[item.id]),false);
 assert.equal((await f.db.query('select count(*)::int n from fc_inbox')).rows[0].n,0);
});
test('private destinations never change login or appear in public notifications and are self-only',async t=>{
 const{db,as,rpc}=await fixture(t);const settings=await rpc('a','fc_notification_settings');assert.equal(settings.email,'a@example.invalid');assert.equal(settings.deliveryConfigured,true);
 for(const actor of [null,'pending','suspended','outside'])await assert.rejects(rpc(actor,'fc_notification_settings'),/permission denied|fc_active_member_required/);
 for(const table of ['notification_settings','notification_config','notification_outbox','topic_follows'])await assert.rejects(as('a',`select * from fc_private.${table}`),/permission denied/);
 await assert.rejects(rpc('mod','fc_set_notifications',[true]),/fc_notification_email_unverified/);
 await assert.rejects(as('a','update fc_private.notification_settings set email=$1 where user_id=$2',['forged@example.invalid',ids.a]),/permission denied/);
 assert.deepEqual((await db.query("select column_name from information_schema.columns where table_schema='auth' and table_name='users'")).rows,[{column_name:'id'}]);
 assert.deepEqual((await db.query("select column_name from information_schema.columns where table_schema='public' and table_name='fc_inbox' order by ordinal_position")).rows.map(x=>x.column_name),['id','recipient_id','topic_id','reply_id','created_at','read_at']);
});
test('reply trigger targets followers and owners once, excludes own reply and never adds moderators automatically',async t=>{
 const{db,rpc,topic,reply}=await fixture(t);const item=await topic();const answer=await reply(item.id);
 let a=await rpc('a','fc_notifications');assert.equal(a.items.length,1);assert.equal(a.items[0].reply_id,answer.id);assert.equal(a.unread_count,1);
 assert.equal((await rpc('b','fc_notifications')).items.length,0);assert.equal((await rpc('mod','fc_notifications')).items.length,0);
 await reply(item.id,'c');a=await rpc('a','fc_notifications');assert.equal(a.items.length,2);assert.equal((await rpc('b','fc_notifications')).items.length,1);
 assert.doesNotMatch(JSON.stringify(a),/example.invalid|Texto privado|Contenido|Alias/);
 assert.equal((await db.query('select count(*)::int n from fc_private.notification_outbox')).rows[0].n,3);
});
test('muting is immediate and subsequent own participation never silently re-enables a muted topic',async t=>{
 const{rpc,topic,reply,claim,db}=await fixture(t);const item=await topic();await reply(item.id);
 await rpc('a','fc_follow_topic',[item.id,false]);assert.equal((await rpc('a','fc_notifications')).unread_count,0);assert.deepEqual(await claim(),[]);
 await reply(item.id,'a');assert.equal(await rpc('a','fc_is_following',[item.id]),false);
 await rpc('b','fc_follow_topic',[item.id,false]);await reply(item.id,'b');assert.equal(await rpc('b','fc_is_following',[item.id]),false);
 assert.ok((await db.query("select count(*)::int n from fc_private.notification_outbox where state='cancelled'")).rows[0].n>=1);
});
test('inbox RLS and bounded pagination/read state prevent access to another member or hidden content',async t=>{
 const{as,rpc,topic,reply}=await fixture(t);const item=await topic();await reply(item.id);await reply(item.id);await reply(item.id);
 const first=await rpc('a','fc_notifications',[2]);assert.equal(first.items.length,2);assert.equal(first.has_more,true);
 const second=await rpc('a','fc_notifications',[2,first.next_before,first.next_before_id]);assert.equal(second.items.length,1);
 assert.equal((await as('b','select * from fc_inbox where recipient_id=$1',[ids.a])).rows.length,0);
 assert.equal((await rpc('b','fc_read_notifications',[array([first.items[0].id])])).updated,0);
 assert.equal((await rpc('a','fc_read_notifications',[array([first.items[0].id])])).updated,1);assert.equal((await rpc('a','fc_notifications')).unread_count,2);
 for(const n of [0,51])await assert.rejects(rpc('a','fc_notifications',[n]),/fc_invalid_notification_page/);
 await assert.rejects(as('a','update fc_inbox set read_at=now()'),/permission denied/);
 await rpc('mod','fc_moderate',['topic_hide',item.id]);assert.equal((await rpc('a','fc_notifications')).items.length,0);assert.equal((await as('a','select * from fc_inbox')).rows.length,0);
});
test('delivery-disabled installation still creates inbox entries and never grows an email backlog',async t=>{
 const{db,rpc,topic,reply,claim}=await fixture(t,{configured:false});const item=await topic();await reply(item.id);
 assert.equal((await rpc('a','fc_notifications')).items.length,1);assert.equal((await db.query('select count(*)::int n from fc_private.notification_outbox')).rows[0].n,0);assert.deepEqual(await claim(),[]);
});
test('only service_role claims leases; stable payload, acknowledgement and retries are durable',async t=>{
 const{db,rpc,topic,reply,claim}=await fixture(t);const item=await topic();await reply(item.id);
 for(const actor of [null,'a','mod'])await assert.rejects(rpc(actor,'fc_claim_delivery'),/permission denied/);
 const[job]=await claim();assert.equal(job.attempts,1);assert.equal('email'in job,false);assert.deepEqual(await claim(),[]);
 const payload=await rpc('service','fc_revalidate_delivery',[job.id,job.lease_token]);assert.equal(payload.allowed,true);assert.equal(payload.email,'a@example.invalid');assert.equal(payload.deep_url.endsWith(`?topic=${item.id}`),true);assert.doesNotMatch(JSON.stringify(payload),/Texto privado|Contenido/);
 await rpc('service','fc_ack_delivery',[job.id,job.lease_token,'retry',null,'provider_timeout']);assert.deepEqual(await claim(),[]);
 await db.query("update fc_private.notification_outbox set next_attempt_at=clock_timestamp()-interval '1 second' where id=$1",[job.id]);
 const[retried]=await claim();assert.equal(retried.attempts,2);assert.notEqual(retried.lease_token,job.lease_token);
 const again=await rpc('service','fc_revalidate_delivery',[retried.id,retried.lease_token]);assert.equal(again.idempotency_key,payload.idempotency_key);assert.equal(again.email,payload.email);
 await assert.rejects(rpc('service','fc_ack_delivery',[job.id,job.lease_token,'accepted']),/fc_delivery_lease_invalid/);
 assert.equal((await rpc('service','fc_ack_delivery',[retried.id,retried.lease_token,'accepted','provider-receipt'])).state,'sent');
 assert.equal((await rpc('service','fc_ack_delivery',[retried.id,retried.lease_token,'accepted','provider-receipt'])).state,'sent');assert.deepEqual(await claim(),[]);
});
test('lease expiry can be reclaimed but frozen destination changes cancel rather than send to either address',async t=>{
 const{db,rpc,topic,reply,claim}=await fixture(t);const item=await topic();await reply(item.id);const[job]=await claim();
 await db.query("update fc_private.notification_outbox set lease_until=clock_timestamp()-interval '1 second' where id=$1",[job.id]);
 assert.equal((await rpc('service','fc_revalidate_delivery',[job.id,job.lease_token])).allowed,false);const[next]=await claim();assert.equal(next.attempts,2);
 await db.query('update fc_private.notification_settings set email=$1 where user_id=$2',['changed@example.invalid',ids.a]);
 const result=await rpc('service','fc_revalidate_delivery',[next.id,next.lease_token]);assert.equal(result.allowed,false);assert.equal(result.reason,'destination_changed');assert.equal('email'in result,false);
});
test('membership, visibility and subscription are revalidated immediately before external delivery',async t=>{
 const{db,rpc,topic,reply,claim}=await fixture(t);const item=await topic();await reply(item.id);const[job]=await claim();
 await rpc('mod','fc_admit',[ids.a,'suspended']);assert.equal((await rpc('service','fc_revalidate_delivery',[job.id,job.lease_token])).allowed,false);
 assert.equal((await db.query('select state from fc_private.notification_outbox where id=$1',[job.id])).rows[0].state,'cancelled');
 await rpc('mod','fc_admit',[ids.a,'active']);await reply(item.id);const[next]=await claim();await rpc('a','fc_set_notifications',[false]);
 assert.equal((await rpc('service','fc_revalidate_delivery',[next.id,next.lease_token])).allowed,false);
 await rpc('a','fc_set_notifications',[true]);await reply(item.id);const[last]=await claim();await rpc('mod','fc_moderate',['reply_hide',last.reply_id??(await db.query('select reply_id from fc_private.notification_outbox where id=$1',[last.id])).rows[0].reply_id]);
 assert.equal((await rpc('service','fc_revalidate_delivery',[last.id,last.lease_token])).allowed,false);
});
test('old or exhausted email work expires and actual database timestamps determine the retry window',async t=>{
 const{db,rpc,topic,reply,claim}=await fixture(t);const item=await topic();await reply(item.id);
 await db.exec("update fc_private.notification_outbox set created_at=clock_timestamp()-interval '25 hours'");assert.deepEqual(await claim(),[]);
 await reply(item.id);const[job]=await claim();await db.query("update fc_private.notification_outbox set attempts=8 where id=$1",[job.id]);
 assert.equal((await rpc('service','fc_ack_delivery',[job.id,job.lease_token,'retry',null,'provider_timeout'])).state,'failed');
});
