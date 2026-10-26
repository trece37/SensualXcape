import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID,createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
const setup=await readFile(new URL('../supabase/setup.sql',import.meta.url),'utf8');
const reliable=await readFile(new URL('../supabase/reliable-send.sql',import.meta.url),'utf8');
const sql=await readFile(new URL('../supabase/webapp-live.sql',import.meta.url),'utf8');
const ids=Object.fromEntries(['a','b','c','forum_suspended'].map((n,i)=>[n,`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`]));
async function fixture(t,{install=true}={}){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth,public to anon,authenticated;`);
 for(const id of Object.values(ids))await db.query('insert into auth.users values($1)',[id]);
 await db.exec(setup);await db.exec(reliable);
 const legacy=[];
 for(let i=0;i<4;i++){
  const room=randomUUID();legacy.push(room);
  await db.query('insert into sx_rooms(id,created_by,created_at)values($1,$2,$3)',[room,ids.a,`2026-10-${String(10+i).padStart(2,'0')}T12:00:00Z`]);
  await db.query('insert into sx_room_members(room_id,user_id)values($1,$2),($1,$3)',[room,ids.a,i===3?ids.forum_suspended:ids.b]);
 }
 // Reproduce the observed shape without real accounts or message contents.
 for(let i=0;i<167;i++)await db.query('insert into sx_messages(room_id,sender_id,body,client_message_id)values($1,$2,$3,$4)',[legacy[i%4],ids.a,`Fictitious historical message ${i}`,i<165?null:randomUUID()]);
 const apply=async()=>{try{await db.exec(sql);}catch(e){throw new Error(`${e.message} at ${e.position}: ${sql.slice(Number(e.position)-100,Number(e.position)+100)}`);}};
 if(install)await apply();
 const as=async(actor,q,args=[],operation='')=>{
  await db.exec(`set role ${actor===null?'anon':'authenticated'}`);
  try{await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('storage.operation',$2,false)",[actor===null?'':ids[actor]??actor,operation]);return await db.query(q,args);}
  finally{await db.exec('reset role');await db.exec("select set_config('request.jwt.claim.sub','',false),set_config('storage.operation','',false)");}
 };
 const rpc=async(actor,name,args=[],table=false)=>{
  const result=await as(actor,`select ${table?'* from ':''}${name}(${args.map((_,i)=>`$${i+1}`).join(',')})${table?'':' value'}`,args);
  return table?result.rows:result.rows[0].value;
 };
 const invite=(actor='a',label=`Alias ${actor}`)=>rpc(actor,'sx_contact_invite',[label]);
 const request=async(requester='b',recipient='c')=>rpc(requester,'sx_request_contact',[await invite(recipient),`Alias ${requester}`]);
 const contact=async(requester='b',recipient='c')=>{const id=await request(requester,recipient);const room=await rpc(recipient,'sx_decide_contact',[id,true]);return{id,room};};
 const send=(actor,room,body='A new message',key=randomUUID())=>rpc(actor,'sx_send_message',[room,body,key]);
 const list=actor=>rpc(actor,'sx_list_conversations',[],true);
 const messages=(actor,room,args=[])=>rpc(actor,'sx_messages_page',[room,...args],true);
 return{db,as,rpc,legacy,apply,invite,request,contact,send,list,messages};
}
const fingerprint=rows=>createHash('sha256').update(JSON.stringify(rows)).digest('hex');

test('additive installation preserves all four rooms, eight members and 167 historical messages byte-for-byte',async t=>{
 const{db,apply}=await fixture(t,{install:false});
 const snapshot=async()=>Promise.all(['sx_rooms','sx_room_members','sx_messages'].map(async table=>fingerprint((await db.query(`select * from ${table} order by 1,2`)).rows)));
 const before=await snapshot();await apply();await apply();assert.deepEqual(await snapshot(),before);
 const counts=(await db.query('select (select count(*)::int from sx_rooms)rooms,(select count(*)::int from sx_room_members)members,(select count(*)::int from sx_messages)messages,(select count(*)::int from sx_messages where client_message_id is null)legacy')).rows[0];
 assert.deepEqual(counts,{rooms:4,members:8,messages:167,legacy:165});
 assert.doesNotMatch(sql,/\bdrop\s+(table|schema|policy|trigger|function)\b/i);
 assert.doesNotMatch(sql.replace(/^--.*$/gm,''),/fc_members|auth\.users\s+set|smtp/i);
});

test('legacy history remains private and visible after refresh while outsiders and anonymous sessions are excluded',async t=>{
 const{as,list,messages,legacy}=await fixture(t);
 assert.equal((await list('a')).length,4);assert.equal((await list('b')).length,3);assert.equal((await list('c')).length,0);
 assert.ok((await list('a')).every(row=>row.legacy&&row.can_send&&row.counterpart_label==='Conversación anterior'));
 assert.ok((await messages('b',legacy[0])).length>0);assert.equal((await as('c','select * from sx_messages')).rows.length,0);
 await assert.rejects(messages('c',legacy[0]),/no está disponible/);await assert.rejects(list(null),/permission denied/);
 assert.doesNotMatch(JSON.stringify(await list('a')),/@|email/);
});

test('private contacts require Auth but do not depend on admission or suspension in the forum',async t=>{
 const{db,invite,contact,send,messages,legacy}=await fixture(t);
 assert.equal((await db.query("select to_regclass('public.fc_members') as member_table")).rows[0].member_table,null);
 assert.ok(await invite('forum_suspended'));const relation=await contact('c','forum_suspended');
 assert.equal((await send('forum_suspended',relation.room)).sender_id,ids.forum_suspended);
 assert.ok((await messages('forum_suspended',legacy[3])).length>0);
});

test('request and acceptance are idempotent; only the recipient decides and creates the two-person room',async t=>{
 const{db,rpc,invite,request,send}=await fixture(t);const code=await invite('c');assert.equal(await invite('c','New label'),code);
 const id=await request('b','c');assert.equal(await rpc('b','sx_request_contact',[code,'Retry']),id);
 await assert.rejects(rpc('b','sx_decide_contact',[id,true]),/no está disponible/);await assert.rejects(rpc('a','sx_decide_contact',[id,true]),/no está disponible/);
 const room=await rpc('c','sx_decide_contact',[id,true]);assert.equal(await rpc('c','sx_decide_contact',[id,true]),room);
 assert.equal((await db.query('select count(*)::int n from sx_room_members where room_id=$1',[room])).rows[0].n,2);
 assert.equal((await send('b',room)).sender_id,ids.b);assert.equal((await send('c',room)).sender_id,ids.c);
 await assert.rejects(send('a',room),/No puedes enviar/);
});

test('accepting an existing pair reuses its oldest two-person room without hiding the other histories',async t=>{
 const{db,rpc,request,legacy,list}=await fixture(t);const id=await request('b','a');
 assert.equal((await db.query('select status from sx_contacts where id=$1',[id])).rows[0].status,'accepted','legacy consent is adopted without a contradictory pending state');
 const room=await rpc('a','sx_decide_contact',[id,true]);
 assert.equal(room,legacy[0]);assert.equal((await db.query('select count(*)::int n from sx_rooms')).rows[0].n,4);
 const rooms=await list('a');assert.equal(rooms.length,4);assert.equal(rooms.find(r=>r.room_id===room).legacy,false);assert.equal(rooms.filter(r=>r.legacy).length,3);
});

test('rejecting is terminal and no create/join or direct table mutation can bypass consent',async t=>{
 const{as,rpc,request,legacy}=await fixture(t);const id=await request('b','c');assert.equal(await rpc('c','sx_decide_contact',[id,false]),null);
 await assert.rejects(rpc('c','sx_decide_contact',[id,true]),/ya está resuelta/);await assert.rejects(request('c','b'),/no está disponible/);
 await assert.rejects(rpc('a','sx_create_chat'),/requieren una solicitud/);await assert.rejects(rpc('c','sx_join_chat',[legacy[0]]),/requieren una solicitud/);
 assert.equal(await rpc('b','sx_join_chat',[legacy[0]]),true);
 for(const query of ['update sx_contacts set status=\'accepted\'','delete from sx_room_members','delete from sx_messages','update sx_rooms set created_by=null'])await assert.rejects(as('a',query),/permission denied/);
 await assert.rejects(as('c','insert into sx_room_members(room_id,user_id)values($1,$2)',[legacy[0],ids.c]),/permission denied/);
});

test('blocking a historical room stops both directions across every room of the pair and preserves all history',async t=>{
 const{db,rpc,as,legacy,send,messages,list}=await fixture(t);const original=await messages('a',legacy[0]);
 await assert.rejects(rpc('c','sx_set_room_block',[legacy[0],true]),/no está disponible/);
 assert.equal(await rpc('b','sx_set_room_block',[legacy[0],true]),true);
 assert.equal((await db.query('select count(*)::int n from sx_contacts')).rows[0].n,1);
 for(const room of legacy.slice(0,3)){
  await assert.rejects(send('a',room),/no está disponible/);await assert.rejects(send('b',room),/no está disponible/);
  await assert.rejects(as('a','insert into sx_messages(room_id,sender_id,body)values($1,$2,$3)',[room,ids.a,'Legacy bypass']),/no está disponible/);
 }
 assert.deepEqual(await messages('a',legacy[0]),original);assert.ok((await list('a')).filter(r=>r.counterpart_id===ids.b).every(r=>r.blocked&&!r.can_send&&!r.blocked_by_me));
 assert.equal(await rpc('a','sx_set_room_block',[legacy[0],false]),true);assert.equal(await rpc('b','sx_set_room_block',[legacy[0],false]),false);
 assert.ok(await send('a',legacy[1],'After voluntary unblock'));
});

test('each participant owns their block; profile contact visibility follows all pair blocks and never a guessed reader',async t=>{
 const{as,rpc,legacy}=await fixture(t);const visible=(actor,owner,reader)=>as(actor,'select sx_private.are_contacts($1,$2) allowed',[ids[owner],ids[reader]]).then(r=>r.rows[0].allowed);
 assert.equal(await visible('a','b','a'),true);assert.equal(await visible('c','a','b'),false);assert.equal(await visible('a','c','a'),false);assert.equal(await visible('a','a','a'),false);
 await rpc('a','sx_set_room_block',[legacy[0],true]);await rpc('b','sx_set_room_block',[legacy[1],true]);assert.equal(await visible('a','b','a'),false);
 assert.equal(await rpc('a','sx_set_room_block',[legacy[0],false]),true);assert.equal(await visible('a','b','a'),false);
 assert.equal(await rpc('b','sx_set_room_block',[legacy[1],false]),false);assert.equal(await visible('a','b','a'),true);
});

test('retry keys are author-bound and never duplicate or overwrite a committed message, including after a block',async t=>{
 const{db,as,rpc,legacy,send}=await fixture(t);const key=randomUUID();const first=await send('a',legacy[0],'Same payload',key);assert.deepEqual(await send('a',legacy[0],'Same payload',key),first);
 await assert.rejects(send('a',legacy[0],'Changed payload',key),/clave de reintento/);await assert.rejects(send('a',legacy[1],'Same payload',key),/clave de reintento/);
 assert.equal((await db.query('select count(*)::int n from sx_messages where client_message_id=$1',[key])).rows[0].n,1);
 await db.query('delete from sx_room_members where room_id=$1 and user_id=$2',[legacy[0],ids.a]);
 await assert.rejects(send('a',legacy[0],'Same payload',key),/No puedes enviar/,'retry does not bypass revoked room membership');
 await db.query('insert into sx_room_members(room_id,user_id)values($1,$2)',[legacy[0],ids.a]);
 await assert.rejects(as('b','insert into sx_messages(room_id,sender_id,body)values($1,$2,$3)',[legacy[0],ids.a,'Spoof']),/No puedes enviar/);
 await rpc('b','sx_set_room_block',[legacy[0],true]);assert.deepEqual(await send('a',legacy[0],'Same payload',key),first);await assert.rejects(send('a',legacy[0],'A new message'),/no está disponible/);
});

test('message and conversation pages are bounded, chronological and preserve history under blocks',async t=>{
 const{rpc,list,messages,legacy}=await fixture(t);const page=await messages('a',legacy[0],[3]);assert.equal(page.length,3);assert.ok(Number(page[0].id)<Number(page[2].id));
 const earlier=await messages('a',legacy[0],[3,page[0].id]);assert.equal(earlier.length,3);assert.ok(Number(earlier.at(-1).id)<Number(page[0].id));
 const all=await list('a');const first=await rpc('a','sx_list_conversations',[2],true);const next=await rpc('a','sx_list_conversations',[2,first.at(-1).activity_at,first.at(-1).room_id],true);
 assert.equal(new Set([...first,...next].map(r=>r.room_id)).size,all.length);
 for(const limit of [0,151])await assert.rejects(messages('a',legacy[0],[limit]),/Página de mensajes/);
 await assert.rejects(rpc('a','sx_list_conversations',[101],true),/Página de conversaciones/);
});

test('new SDK inserts receive a server timestamp even when the caller supplies a future date',async t=>{
 const{db,as,legacy,list}=await fixture(t);
 const before=(await db.query('select clock_timestamp() moment')).rows[0].moment;
 const row=(await as('a',"insert into sx_messages(room_id,sender_id,body,created_at)values($1,$2,$3,'2099-01-01T00:00:00Z')returning created_at",[legacy[0],ids.a,'Caller cannot fake this timestamp'])).rows[0];
 const after=(await db.query('select clock_timestamp() moment')).rows[0].moment;
 assert.ok(new Date(row.created_at)>=new Date(before));assert.ok(new Date(row.created_at)<=new Date(after));
 assert.ok(new Date((await list('a'))[0].activity_at)<=new Date(after));
});

test('an explicit rejected legacy relation overrides old consent for writes and profiles while preserving readable history',async t=>{
 const{db,as,rpc,legacy,invite,send,list,messages}=await fixture(t);
 await db.query("insert into sx_contacts(requester_id,recipient_id,requester_label,recipient_label,status)values($1,$2,'Alias B','Alias A','rejected')",[ids.b,ids.a]);
 await assert.rejects(rpc('b','sx_request_contact',[await invite('a'),'Retry cannot reset rejection']),/no está disponible/);
 await assert.rejects(send('b',legacy[0]),/no está disponible/);
 await assert.rejects(as('a','insert into sx_messages(room_id,sender_id,body)values($1,$2,$3)',[legacy[1],ids.a,'Direct bypass after rejection']),/no está disponible/);
 assert.equal((await as('a','select sx_private.are_contacts($1,$2) allowed',[ids.b,ids.a])).rows[0].allowed,false);
 assert.ok((await list('a')).filter(r=>r.counterpart_id===ids.b).every(r=>!r.can_send));
 assert.ok((await messages('a',legacy[0])).length>0);assert.ok((await messages('b',legacy[0])).length>0);
 assert.equal(await rpc('a','sx_set_room_block',[legacy[0],false]),false);
 await assert.rejects(send('a',legacy[0]),/no está disponible/,'unblocking cannot override a rejected contact decision');
});

test('logout push snapshot returns only the old Auth owner binding ID even when disabled or forum membership is absent',async t=>{
 const{db,rpc}=await fixture(t);
 const endpointA='https://fcm.googleapis.com/fcm/send/fictitious-a',endpointB='https://fcm.googleapis.com/fcm/send/fictitious-b';
 assert.deepEqual(await rpc('a','sx_push_binding',[endpointA]),{id:null},'push is an optional module');
 await db.exec('create schema fc_private;create table fc_private.push_subscriptions(id uuid primary key,user_id uuid not null references auth.users(id),endpoint text unique,enabled boolean,auth text,p256dh text)');
 const bindingA=randomUUID(),bindingB=randomUUID();
 await db.query('insert into fc_private.push_subscriptions values($1,$2,$3,false,$4,$4),($5,$6,$7,true,$4,$4)',[bindingA,ids.a,endpointA,'dummy-private-key',bindingB,ids.b,endpointB]);
 assert.deepEqual(await rpc('a','sx_push_binding',[endpointA]),{id:bindingA});
 assert.equal((await db.query("select has_function_privilege('service_role','public.sx_push_binding(text)','EXECUTE')allowed")).rows[0].allowed,false);
 assert.deepEqual(await rpc('a','sx_push_binding',[endpointB]),{id:null});
 assert.deepEqual(await rpc('b','sx_push_binding',[endpointA]),{id:null});
 assert.deepEqual(await rpc('b','sx_push_binding',[endpointB]),{id:bindingB});
 assert.deepEqual(await rpc('forum_suspended','sx_push_binding',[endpointA]),{id:null});
 await assert.rejects(rpc(null,'sx_push_binding',[endpointA]),/permission denied/);
 await assert.rejects(rpc('','sx_push_binding',[endpointA]),/Autenticación requerida/);
 assert.doesNotMatch(JSON.stringify(await rpc('a','sx_push_binding',[endpointA])),/endpoint|enabled|auth|p256dh|dummy-private-key/);
});

test('profile integration uses real contact consent for both snapshots and Storage blobs across acceptance, legacy blocks and rejection',async t=>{
 const{db,as,rpc,legacy,request,messages}=await fixture(t);
 await db.exec(`create schema storage;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text,owner_id text,metadata jsonb,unique(bucket_id,name));
 alter table storage.objects enable row level security;
 grant usage on schema storage to anon,authenticated;
 grant select,insert,update,delete on storage.objects to anon,authenticated;
 create function storage.allow_any_operation(ops text[])returns boolean language sql stable as $$select coalesce(current_setting('storage.operation',true),'')=any(ops)$$;
 create policy unrelated_broad_policy on storage.objects for all to public using(true)with check(true);`);
 await db.exec(await readFile(new URL('../supabase/webapp-profile.sql',import.meta.url),'utf8'));
 async function publish(actor){
  const file=await rpc(actor,'sx_profile_reserve_photo',[100]);
  await as(actor,'insert into storage.objects(bucket_id,name,owner_id,metadata)values($1,$2,$3,$4)',[file.bucket_id,file.object_path,ids[actor],{mimetype:'image/webp',size:100}]);
  await rpc(actor,'sx_profile_finish_photo',[file.id]);
  const draft={privateAlias:`PRIVATE ${actor}`,privateBio:`PRIVATE NOTES ${actor}`,publicAlias:`Alias ${actor}`,publicBio:`Presentation ${actor}`,photos:[{id:file.id,zoom:1,x:50,y:50}],coverId:file.id};
  await rpc(actor,'sx_profile_save',[0,draft]);await rpc(actor,'sx_profile_publish',[1,true,true]);return file;
 }
 const files={a:await publish('a'),b:await publish('b'),c:await publish('c')};
 const snapshot=(reader,owner)=>rpc(reader,'sx_profile_shared',[ids[owner]]);
 const blob=(reader,owner)=>as(reader,'select name from storage.objects where bucket_id=$1 and name=$2',[files[owner].bucket_id,files[owner].object_path],'object.get_authenticated').then(r=>r.rows);
 assert.equal(await snapshot('c','a'),null);assert.deepEqual(await blob('c','a'),[]);
 assert.equal(await snapshot('a','c'),null);assert.deepEqual(await blob('a','c'),[]);
 const pending=await request('c','a');
 assert.equal(await snapshot('c','a'),null);assert.deepEqual(await blob('c','a'),[],'pending does not expose photos');
 await rpc('a','sx_decide_contact',[pending,true]);
 assert.ok(await snapshot('c','a'));assert.equal((await blob('c','a')).length,1);
 assert.ok(await snapshot('a','c'));assert.equal((await blob('a','c')).length,1);
 assert.doesNotMatch(JSON.stringify(await snapshot('c','a')),/PRIVATE/);
 assert.ok(await snapshot('b','a'),'existing two-person legacy history retains accepted visibility');assert.equal((await blob('b','a')).length,1);
 assert.ok(await snapshot('a','b'));assert.equal((await blob('a','b')).length,1);
 await rpc('b','sx_set_room_block',[legacy[1],true]);
 for(const[reader,owner]of[['a','b'],['b','a']]){assert.equal(await snapshot(reader,owner),null);assert.deepEqual(await blob(reader,owner),[],'a block from any shared room revokes every shared profile/photo');}
 assert.equal((await blob('a','a')).length,1,'the owner retains private access');
 assert.ok(await snapshot('c','a'),'another accepted pair is unaffected');
 await rpc('b','sx_set_room_block',[legacy[1],false]);assert.ok(await snapshot('b','a'));
 await db.query("update sx_contacts set status='rejected',room_id=null where least(requester_id,recipient_id)=least($1::uuid,$2::uuid)and greatest(requester_id,recipient_id)=greatest($1::uuid,$2::uuid)",[ids.a,ids.b]);
 for(const[reader,owner]of[['a','b'],['b','a']]){assert.equal(await snapshot(reader,owner),null);assert.deepEqual(await blob(reader,owner),[],'explicit rejection overrides legacy profile access');}
 assert.ok((await messages('a',legacy[0])).length>0);assert.ok((await messages('b',legacy[0])).length>0,'profile revocation preserves conversation history');
});

test('shared storage budget prevents forum/profile over-allocation in both directions without double-counting uploaded reservations',async t=>{
 const{db,as,rpc}=await fixture(t);
 await db.exec(`create schema storage;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text,owner_id text,metadata jsonb,unique(bucket_id,name));
 alter table storage.objects enable row level security;grant usage on schema storage to anon,authenticated;
 grant select,insert,update,delete on storage.objects to anon,authenticated;
 create function storage.allow_any_operation(ops text[])returns boolean language sql stable as $$select coalesce(current_setting('storage.operation',true),'')=any(ops)$$;`);
 const forumBase=await readFile(new URL('../supabase/forocromos-live.sql',import.meta.url),'utf8');
 const community=await readFile(new URL('../supabase/forocromos-community.sql',import.meta.url),'utf8');
 const budget=await readFile(new URL('../supabase/webapp-storage-budget.sql',import.meta.url),'utf8');
 await db.exec(forumBase);await db.exec(community);
 for(const actor of ['a','b'])await db.query("insert into fc_members(user_id,alias,status)values($1,$2,'active')",[ids[actor],`Alias ${actor}`]);
 const profileSource=await readFile(new URL('../supabase/webapp-profile.sql',import.meta.url),'utf8');
 await db.exec(profileSource);await db.exec(budget);
 const functionStart=community.indexOf('create or replace function fc_private.community('),functionEnd=community.indexOf('revoke all on function fc_private.community(',functionStart);
 assert.ok(budget.includes(community.slice(functionStart,functionEnd).trimEnd()),'migration preserves the exact reviewed community function');
 const profileStart=profileSource.indexOf('create or replace function sx_private.profile_command('),profileEnd=profileSource.indexOf('revoke all on function sx_private.profile_command(',profileStart);
 assert.ok(budget.includes(profileSource.slice(profileStart,profileEnd).trimEnd()),'migration preserves the exact reviewed profile function');
 const used=async()=>Number((await db.query('select fc_private.storage_reserved_bytes() bytes')).rows[0].bytes);
 const profile=await rpc('a','sx_profile_reserve_photo',[100]);
 const attachment=await rpc('b','fc_reserve_file',['attachment','check.png','image/png',200]);
 assert.equal(await used(),300,'pending reservations in both ledgers count');
 await as('a','insert into storage.objects(bucket_id,name,owner_id,metadata)values($1,$2,$3,$4)',[profile.bucket_id,profile.object_path,ids.a,{mimetype:'image/webp',size:100}]);
 await as('b','insert into storage.objects(bucket_id,name,owner_id,metadata)values($1,$2,$3,$4)',[attachment.bucket_id,attachment.object_path,ids.b,{mimetype:'image/png',size:200}]);
 assert.equal(await used(),300,'physical bytes replace their reservation charge rather than doubling it');
 await db.exec("delete from storage.objects;update sx_private.profile_files set status='removed',expires_at=now()-interval '1 second';update fc_files set status='removed',expires_at=now()-interval '1 second'");
 assert.equal(await used(),0);
 // Administrative fixture models a populated installation, using valid per-file
 // sizes and no real contents/accounts. Physical objects need not retain ledgers.
 await db.query("insert into storage.objects(bucket_id,name,owner_id,metadata)select 'sx-profile-photos','capacity-profile/'||g,$1,jsonb_build_object('size',900000,'mimetype','image/webp')from generate_series(1,1000)g",[ids.a]);
 assert.equal(await used(),900000000);
 await assert.rejects(rpc('b','fc_reserve_file',['attachment','blocked.png','image/png',100]),/fc_file_quota/,'profile storage exhausts the same budget seen by the forum');
 await db.exec("update storage.objects set bucket_id='fc-attachments',name=replace(name,'capacity-profile/','capacity-forum/'),metadata=jsonb_build_object('size',900000,'mimetype','image/png')");
 await assert.rejects(rpc('b','sx_profile_reserve_photo',[100]),/sx_profile_storage_limit/,'forum storage exhausts the same budget seen by profiles');
});
