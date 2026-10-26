import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const base=await readFile(new URL('../supabase/forocromos-live.sql',import.meta.url),'utf8');
const notifications=await readFile(new URL('../supabase/forocromos-notifications.sql',import.meta.url),'utf8');
const source=await readFile(new URL('../supabase/forocromos-push.sql',import.meta.url),'utf8');
// PGlite has no pg_cron/pg_net. Only installation declarations are omitted;
// Vault reads and net.http_post are mocked below, with no network traffic.
const sql=source.replace(/^create extension if not exists .*;$/gm,'');
const ids=Object.fromEntries(['a','b','c','mod','pending','suspended','outside'].map((n,i)=>[n,`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`]));
const publicKey='B'+'A'.repeat(86),authKey='A'.repeat(22),workerSecret='dummy-test-only-'.repeat(4);
const endpoint=n=>`https://fcm.googleapis.com/fcm/send/fictitious-device-${n}-no-real-destination`;
async function fixture(t,{configured=true}={}){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth,public to anon,authenticated,service_role;
 create schema vault;create table vault.decrypted_secrets(id uuid primary key,decrypted_secret text);
 create schema net;create table net.requests(id bigint generated always as identity,url text,body jsonb,headers jsonb,timeout_milliseconds integer);
 create function net.http_post(url text,body jsonb,headers jsonb,timeout_milliseconds integer)returns bigint language sql as $$insert into net.requests(url,body,headers,timeout_milliseconds)values(url,body,headers,timeout_milliseconds)returning id$$;`);
 for(const id of Object.values(ids))await db.query('insert into auth.users values($1)',[id]);
 await db.exec(base);
 for(const n of ['a','b','c','mod','pending','suspended'])await db.query('insert into fc_members(user_id,alias,status,role)values($1,$2,$3,$4)',[ids[n],`Alias ${n}`,['pending','suspended'].includes(n)?n:'active',n==='mod'?'moderator':'member']);
 await db.exec(notifications);
 try{await db.exec(sql);}catch(e){throw new Error(`${e.message} position ${e.position}: ${sql.slice(Number(e.position)-100,Number(e.position)+100)}`);}
 const privateId='10000000-0000-4000-8000-000000000001',workerId='10000000-0000-4000-8000-000000000002';
 await db.query('insert into vault.decrypted_secrets values($1,$2),($3,$4)',[privateId,'A'.repeat(43),workerId,workerSecret]);
 await db.query('update fc_private.push_config set configured=$1,vapid_public_key=$2,vapid_secret_id=$3,worker_secret_id=$4',[configured,publicKey,privateId,workerId]);
 const as=async(actor,q,args=[])=>{
  await db.exec(`set role ${actor===null?'anon':actor==='service'?'service_role':'authenticated'}`);
  try{await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor===null||actor==='service'?'':ids[actor]??actor]);return await db.query(q,args);}
  finally{await db.exec('reset role');await db.exec("select set_config('request.jwt.claim.sub','',false)");}
 };
 const rpc=async(actor,n,args=[])=>(await as(actor,`select ${n}(${args.map((_,i)=>`$${i+1}`).join(',')}) value`,args)).rows[0].value;
 const register=(actor='a',name=actor,key=publicKey)=>rpc(actor,'fc_register_push',[endpoint(name),key,authKey]);
 const topic=()=>rpc('a','fc_create_topic',['cuidado','Tema privado','No copiar al push.']);
 const reply=(id,actor='b')=>rpc(actor,'fc_reply',[id,'Respuesta privada.']);
 const claim=(limit=20)=>rpc('service','fc_claim_push_delivery',[limit]);
 return{db,as,rpc,register,topic,reply,claim};
}

test('push secrets, subscriptions and outbox remain private; worker config requires service role plus Vault secret',async t=>{
 const{as,rpc}=await fixture(t);
 for(const actor of [null,'a','mod'])await assert.rejects(rpc(actor,'fc_push_worker_config',[workerSecret]),/permission denied/);
 assert.equal(await rpc('service','fc_push_worker_config',['wrong']),null);assert.equal(await rpc('service','fc_push_worker_config',[null]),null);
 const config=await rpc('service','fc_push_worker_config',[workerSecret]);assert.equal(config.configured,true);assert.equal(config.vapid_public_key,publicKey);assert.equal('worker_secret'in config,false);
 for(const table of ['push_config','push_subscriptions','push_outbox'])await assert.rejects(as('a',`select * from fc_private.${table}`),/permission denied/);
 const settings=await rpc('a','fc_push_settings');assert.deepEqual(settings,{configured:true,public_key:publicKey});
});
test('registration validates endpoints against SSRF and validates key shape before storing private data',async t=>{
 const{rpc}=await fixture(t);
 for(const bad of ['http://fcm.googleapis.com/fcm/send/example','https://127.0.0.1/push','https://169.254.169.254/latest/meta-data','https://fcm.googleapis.com.evil.invalid/path','https://fcm.googleapis.com:443/path','https://user@fcm.googleapis.com/path','https://fcm.googleapis.com/path#secret','https://evil.invalid/https://web.push.apple.com/token','https://web.push.apple.com/token\nheader']){
  await assert.rejects(rpc('a','fc_register_push',[bad,publicKey,authKey]),/fc_invalid_push_endpoint/);
 }
 for(const [key,auth]of[['invalid',authKey],[publicKey,'bad'],['A'.repeat(87),authKey]])await assert.rejects(rpc('a','fc_register_push',[endpoint('invalid'),key,auth]),/fc_invalid_push_keys/);
 for(const good of ['https://updates.push.services.mozilla.com/wpush/v2/fictitious-token','https://web.push.apple.com/fictitious-token','https://sub.web.push.apple.com/fictitious-token','https://wns2-test.notify.windows.com/w/?token=fictitious'])assert.ok((await rpc('a','fc_register_push',[good,publicKey,authKey])).id);
});
test('a device cannot be stolen, status identifies only the current owner, and device count is bounded',async t=>{
 const{rpc,register}=await fixture(t);const device=await register();
 assert.deepEqual(await rpc('a','fc_push_status',[endpoint('a')]),{registered:true,id:device.id});
 assert.deepEqual(await rpc('b','fc_push_status',[endpoint('a')]),{registered:false,id:null});
 await assert.rejects(register('b','a'),/fc_push_endpoint_unavailable/);
 for(const actor of [null,'outside','pending','suspended'])await assert.rejects(register(actor,'forbidden'),/permission denied|fc_active_member_required/);
 for(let i=1;i<5;i++)await register('a',`extra-${i}`);await assert.rejects(register('a','six'),/fc_push_device_limit/);
 assert.equal((await register('a')).id,device.id);
});
test('new inbox notifications enqueue once per device and never notify the author or all moderators',async t=>{
 const{db,rpc,register,topic,reply}=await fixture(t);await register('a','one');await register('a','two');await register('b');await register('mod');const item=await topic();await reply(item.id);
 assert.equal((await db.query('select count(*)::int n from fc_private.push_outbox')).rows[0].n,2);
 assert.equal((await db.query('select count(*)::int n from fc_private.notification_outbox')).rows[0].n,0,'email stays disabled');
 assert.equal((await rpc('a','fc_notifications')).items.length,1);await db.exec(sql);
 assert.equal((await db.query('select count(*)::int n from fc_private.push_outbox')).rows[0].n,2,'reinstallation does not replay notifications');
});
test('claims lease each job once and revalidate returns only a generic deep link plus private device keys to the worker',async t=>{
 const{rpc,register,topic,reply,claim}=await fixture(t);const device=await register();const item=await topic();await reply(item.id);
 for(const actor of [null,'a','mod'])await assert.rejects(rpc(actor,'fc_claim_push_delivery'),/permission denied/);
 const[job]=await claim(1);assert.equal(job.subscription_id,device.id);assert.equal('endpoint'in job,false);assert.deepEqual(await claim(),[]);
 const payload=await rpc('service','fc_revalidate_push_delivery',[job.id,job.lease_token]);assert.equal(payload.allowed,true);assert.equal(payload.device_id,device.id);assert.equal(payload.subscription.id,device.id);assert.equal(payload.subscription.endpoint,endpoint('a'));assert.equal(payload.deep_url.endsWith(`?topic=${item.id}`),true);assert.doesNotMatch(JSON.stringify(payload),/Respuesta privada|No copiar/);
 assert.equal((await rpc('service','fc_ack_push_delivery',[job.id,job.lease_token,'accepted'])).state,'sent');assert.deepEqual(await claim(),[]);
});
test('unregister and mute revoke leases permanently even after immediate unmute',async t=>{
 const{db,rpc,register,topic,reply,claim}=await fixture(t);await register();const item=await topic();await reply(item.id);const[job]=await claim();
 await rpc('a','fc_unregister_push',[endpoint('a')]);assert.equal((await rpc('a','fc_push_status',[endpoint('a')])).registered,false);assert.equal((await rpc('service','fc_revalidate_push_delivery',[job.id,job.lease_token])).allowed,false);
 await register();await reply(item.id);const[next]=await claim();await rpc('a','fc_follow_topic',[item.id,false]);
 assert.equal((await db.query('select state from fc_private.push_outbox where id=$1',[next.id])).rows[0].state,'cancelled');
 await rpc('a','fc_follow_topic',[item.id,true]);
 assert.equal((await rpc('service','fc_revalidate_push_delivery',[next.id,next.lease_token])).allowed,false,'unmute does not resurrect a previously revoked lease');
 assert.deepEqual(await claim(),[]);
 await reply(item.id);const[fresh]=await claim();assert.equal((await rpc('service','fc_revalidate_push_delivery',[fresh.id,fresh.lease_token])).allowed,true,'new replies after explicit unmute still notify');
});
test('key changes preserve device identity while cancelling stale payloads and never revive old work',async t=>{
 const{db,rpc,register,topic,reply,claim}=await fixture(t);const first=await register();const item=await topic();await reply(item.id);const[job]=await claim();
 const next=await register('a','a','B'+'C'.repeat(86));assert.equal(next.id,first.id);assert.equal((await rpc('service','fc_revalidate_push_delivery',[job.id,job.lease_token])).allowed,false);
 await reply(item.id);const[fresh]=await claim();const payload=await rpc('service','fc_revalidate_push_delivery',[fresh.id,fresh.lease_token]);assert.equal(payload.subscription.keys.p256dh,'B'+'C'.repeat(86));assert.equal((await db.query('select key_version from fc_private.push_subscriptions where id=$1',[first.id])).rows[0].key_version,2);
});
test('404/410 expiry disables only that device and cancels its pending deliveries',async t=>{
 const{db,rpc,register,topic,reply,claim}=await fixture(t);const dead=await register('a','dead'),live=await register('a','live');const item=await topic();await reply(item.id);await reply(item.id);
 const jobs=await claim();const job=jobs.find(j=>j.subscription_id===dead.id);await rpc('service','fc_ack_push_delivery',[job.id,job.lease_token,'expired',null,'push_410']);
 assert.equal((await rpc('a','fc_push_status',[endpoint('dead')])).registered,false);assert.equal((await rpc('a','fc_push_status',[endpoint('live')])).id,live.id);
 assert.equal((await db.query("select count(*)::int n from fc_private.push_outbox where subscription_id=$1 and state<>'cancelled'",[dead.id])).rows[0].n,0);
});
test('retries, lease expiry and membership/visibility revalidation use database time and stable job identity',async t=>{
 const{db,rpc,register,topic,reply,claim}=await fixture(t);await register();const item=await topic();await reply(item.id);const[job]=await claim();
 const first=await rpc('service','fc_revalidate_push_delivery',[job.id,job.lease_token]);await rpc('service','fc_ack_push_delivery',[job.id,job.lease_token,'retry',null,'push_timeout']);assert.deepEqual(await claim(),[]);
 await db.query("update fc_private.push_outbox set next_attempt_at=clock_timestamp()-interval '1 second' where id=$1",[job.id]);const[retry]=await claim();assert.equal(retry.attempts,2);assert.notEqual(retry.lease_token,job.lease_token);
 assert.equal((await rpc('service','fc_revalidate_push_delivery',[retry.id,retry.lease_token])).idempotency_key,first.idempotency_key);
 await rpc('mod','fc_admit',[ids.a,'suspended']);assert.equal((await rpc('service','fc_revalidate_push_delivery',[retry.id,retry.lease_token])).allowed,false);
 await rpc('mod','fc_admit',[ids.a,'active']);await reply(item.id);const[next]=await claim();await rpc('mod','fc_moderate',['topic_hide',item.id]);assert.equal((await rpc('service','fc_revalidate_push_delivery',[next.id,next.lease_token])).allowed,false);
});
test('disabled delivery never queues backlog; dispatch reads Vault only inside the private function and installs no cron job',async t=>{
 const{db,as,rpc,register,topic,reply,claim}=await fixture(t,{configured:false});assert.deepEqual(await rpc('a','fc_push_settings'),{configured:false,public_key:null});await assert.rejects(register(),/fc_push_not_configured/);const item=await topic();await reply(item.id);assert.deepEqual(await claim(),[]);assert.equal((await db.query('select count(*)::int n from fc_private.push_outbox')).rows[0].n,0);
 assert.equal((await db.query('select fc_private.run_push_dispatch() id')).rows[0].id,null);
 await db.exec('update fc_private.push_config set configured=true');assert.ok((await db.query('select fc_private.run_push_dispatch() id')).rows[0].id);
 const request=(await db.query('select url,body,timeout_milliseconds from net.requests')).rows[0];assert.equal(request.timeout_milliseconds,10000);assert.deepEqual(request.body,{});assert.match(request.url,/\/functions\/v1\/fc-deliver-push$/);
 await assert.rejects(as('service','select fc_private.run_push_dispatch()'),/permission denied/);assert.doesNotMatch(source,/\bcron\.schedule\s*\(/i);assert.match(source,/create extension if not exists pg_cron/);assert.match(source,/create extension if not exists pg_net/);
});
