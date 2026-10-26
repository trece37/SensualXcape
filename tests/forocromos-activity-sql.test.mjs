import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const base=await readFile(new URL('../supabase/forocromos-live.sql',import.meta.url),'utf8');
const sql=await readFile(new URL('../supabase/forocromos-activity.sql',import.meta.url),'utf8');
const ids=Object.fromEntries(['a','b','c','mod','pending','suspended','outside'].map((n,i)=>[n,`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`]));
const pgArray=values=>`{${values.join(',')}}`;
async function fixture(t){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth,public to anon,authenticated;`);
 for(const id of Object.values(ids))await db.query('insert into auth.users values($1)',[id]);
 await db.exec(base);
 for(const n of ['a','b','c','mod','pending','suspended'])await db.query('insert into fc_members(user_id,alias,status,role)values($1,$2,$3,$4)',[ids[n],`Alias ${n}`,['pending','suspended'].includes(n)?n:'active',n==='mod'?'moderator':'member']);
 try{await db.exec(sql);}catch(e){throw new Error(`${e.message}; position=${e.position}; ${sql.slice(Number(e.position)-90,Number(e.position)+110)}`);}
 const as=async(actor,query,args=[])=>{
  await db.exec(`set role ${actor===null?'anon':'authenticated'}`);
  try{await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor===null?'':ids[actor]??actor]);return await db.query(query,args);}
  finally{await db.exec('reset role');await db.exec("select set_config('request.jwt.claim.sub','',false)");}
 };
 const rpc=async(actor,name,args=[])=>(await as(actor,`select ${name}(${args.map((_,i)=>`$${i+1}`).join(',')})value`,args)).rows[0].value;
 const topic=async(actor='a',extra={})=>{
  const p=(await db.query('insert into fc_topics(category,title,body,author_id,editorial,pinned,created_at)values($1,$2,$3,$4,$5,$6,$7)returning *',[
   extra.category??'cuidado',extra.title??'Tema de prueba',extra.body??'Texto privado de prueba.',extra.editorial?null:ids[actor],extra.editorial??false,extra.pinned??false,extra.time??'2026-10-20T10:00:00Z'])).rows[0];return p;
 };
 const reply=async(topicId,actor='b',extra={})=>(await db.query('insert into fc_replies(topic_id,author_id,body,hidden,created_at)values($1,$2,$3,$4,$5)returning *',[
  topicId,ids[actor],extra.body??'Una respuesta privada.',extra.hidden??false,extra.time??'2026-10-20T11:00:00Z'])).rows[0];
 const topics=(actor='c',extra={})=>rpc(actor,'fc_topics_page',[extra.category??null,extra.search??null,extra.saved??false,extra.unread??false,extra.order??'activity',extra.limit??20,extra.offset??0]);
 const mark=(actor,topicId,replies=[],topicSeen=true)=>rpc(actor,'fc_mark_topic_read',[topicId,pgArray(replies),topicSeen]);
 return{db,as,rpc,topic,reply,topics,mark};
}

test('activity schema is additive/repeatable, private and restricted to current active membership',async t=>{
 const{db,as,rpc,topic,reply}=await fixture(t);const item=await topic();const answer=await reply(item.id);
 await db.exec(sql);assert.doesNotMatch(sql,/\bdrop\s+(table|schema|policy|trigger|function|view)\b/i);
 for(const actor of [null,'outside','pending','suspended'])for(const[name,args]of[
  ['fc_topics_page',[]],['fc_activity_feed',[]],['fc_recent_contributors',[]],['fc_locate_reply',[item.id,answer.id]],['fc_mark_topic_read',[item.id,pgArray([answer.id]),true]],
 ])await assert.rejects(rpc(actor,name,args),/permission denied|fc_active_member_required/);
 for(const table of ['topic_reads','reply_reads','activity_posts'])await assert.rejects(as('mod',`select * from fc_private.${table}`),/permission denied/);
 // PGlite cannot run two backend connections. Check the installed lock contract
 // explicitly; recipient FK KEY SHARE must remain compatible with this lock.
 const installed=(await db.query("select pg_get_functiondef('fc_private.activity(text,jsonb)'::regprocedure)definition")).rows[0].definition.replace(/--[^\n]*/g,'');
 const memberLocks=installed.match(/select\s+status\s+into\s+v_status\s+from\s+public\.fc_members\b[^;]*;/gi)||[];
 assert.equal(memberLocks.length,1);assert.match(memberLocks[0],/\bfor\s+share\b/i);
 assert.doesNotMatch(memberLocks[0],/\bfor\s+update\b/i,'an exclusive membership lock can deadlock against the publisher notification FK');
 assert.equal((await db.query('select count(*)::int n from fc_topics')).rows[0].n,1);assert.equal((await db.query('select count(*)::int n from fc_replies')).rows[0].n,1);
});

test('thread order, last author and reply totals derive from visible posts and recalculate after moderation/withdrawal',async t=>{
 const{db,rpc,topic,reply,topics}=await fixture(t);const first=await topic('a',{time:'2026-10-20T10:00:00Z'}),second=await topic('b',{time:'2026-10-21T10:00:00Z'});
 const early=await reply(first.id,'b',{time:'2026-10-22T10:00:00Z'}),last=await reply(first.id,'a',{time:'2026-10-23T10:00:00Z'});
 let list=await topics();assert.equal(list.items[0].id,first.id);assert.equal(list.items[0].last_reply_id,last.id);assert.equal(list.items[0].last_author_id,ids.a);assert.equal(list.items[0].reply_count,2);assert.equal(list.items[0].replies_count,2);
 assert.equal((await topics('c',{order:'newest'})).items[0].id,second.id);
 await rpc('mod','fc_moderate',['reply_hide',last.id]);list=await topics();assert.equal(list.items[0].last_reply_id,early.id);assert.equal(list.items[0].reply_count,1);
 await rpc('b','fc_withdraw',['reply',early.id]);list=await topics();assert.equal(list.items[0].id,second.id);assert.equal(list.items.find(p=>p.id===first.id).reply_count,0);assert.equal(list.items.find(p=>p.id===first.id).last_reply_id,null);
 await rpc('a','fc_withdraw',['topic',first.id]);assert.equal((await topics()).total,1);assert.equal((await topics('mod')).total,1,'general feed never reveals withdrawn topics to moderators');
 assert.equal((await db.query('select count(*)::int n from fc_replies where topic_id=$1',[first.id])).rows[0].n,2,'activity changes never delete other authors history');
});

test('thread filters are literal, bounded, private and paginate with deterministic ordering',async t=>{
 const{rpc,topic,topics}=await fixture(t);const a=await topic('a',{title:'100%_literal',category:'rutas'});await topic('b',{title:'Other',category:'cuidado',pinned:true});await topic('b',{title:'Third',time:'2026-10-22T00:00:00Z'});
 assert.equal((await topics('c',{search:'%_literal'})).total,1);assert.equal((await topics('c',{search:"' or 1=1 --"})).total,0);assert.equal((await topics('c',{category:'rutas'})).items[0].id,a.id);
 await rpc('c','fc_toggle_save',[a.id]);assert.equal((await topics('c',{saved:true})).total,1);assert.equal((await topics('a',{saved:true})).total,0);
 assert.equal((await topics('c',{order:'pinned'})).items[0].pinned,true);
 const first=await topics('c',{limit:2}),second=await topics('c',{limit:2,offset:first.next_offset});assert.equal(first.total,3);assert.equal(first.has_more,true);assert.equal(new Set([...first.items,...second.items].map(p=>p.id)).size,3);
 assert.equal((await topics('c',{search:'x'.repeat(160)})).total,0);
 for(const extra of[{limit:0},{limit:51},{offset:-1},{offset:10001},{search:'x'.repeat(161)},{category:'unknown'},{order:'online'}])await assert.rejects(topics('c',extra),/fc_invalid_activity_page/);
});

test('activity feed combines topics/replies with safe plain excerpts, current aliases and complete cursor pagination',async t=>{
 const{db,rpc,topic,reply}=await fixture(t);const item=await topic('a',{body:'<script>literal only</script>\n'+('x'.repeat(200))});await topic('a',{editorial:true,title:'Editorial'});await reply(item.id,'b');await reply(item.id,'a');
 await db.query('update fc_members set alias=$1 where user_id=$2',['Nombre actual',ids.b]);
 const all=[];let page=await rpc('c','fc_activity_feed',[2]);while(true){all.push(...page.items);if(!page.has_more)break;page=await rpc('c','fc_activity_feed',[2,page.next_before,page.next_before_id]);}
 assert.equal(all.length,4);assert.equal(new Set(all.map(p=>p.event_id)).size,4);assert.ok(all.every(p=>p.excerpt.length<=160&&!p.excerpt.includes('\n')));assert.ok(all.some(p=>p.kind==='topic'));assert.ok(all.some(p=>p.kind==='reply'));assert.equal(all.find(p=>p.author_id===ids.b).alias,'Nombre actual');
 assert.equal(all.find(p=>p.author_id===null).alias,'Equipo Foro Cromos');assert.doesNotMatch(JSON.stringify(all),/email|online|last_sign_in/);
 assert.ok(all.find(p=>p.id===item.id).excerpt.startsWith('<script>literal only</script>'),'excerpt stays text, not generated markup');assert.ok(page.snapshot_at);
});

test('recent contributors deduplicate actual publishers, paginate and exclude pending/suspended authors without erasing visible history',async t=>{
 const{db,rpc,topic,reply,topics}=await fixture(t);const item=await topic('a');await reply(item.id,'b');await reply(item.id,'b',{time:'2026-10-21T11:00:00Z'});await reply(item.id,'c',{time:'2026-10-22T11:00:00Z'});await topic('a',{editorial:true});
 let page=await rpc('a','fc_recent_contributors',[2]);assert.equal(page.items.length,2);assert.equal(page.items[0].user_id,ids.c);assert.equal(page.has_more,true);const next=await rpc('a','fc_recent_contributors',[2,page.next_before,page.next_before_uid]);assert.equal(new Set([...page.items,...next.items].map(p=>p.user_id)).size,3);
 await db.query("update fc_members set status='suspended' where user_id=$1",[ids.c]);
 assert.equal((await rpc('a','fc_recent_contributors')).items.some(p=>p.user_id===ids.c),false);
 const feed=await rpc('a','fc_activity_feed');assert.equal(feed.items.find(p=>p.author_id===ids.c).alias,'Compañera');assert.equal((await topics('a')).items.find(p=>p.id===item.id).reply_count,3);
});

test('exact rendered receipts remain monotonic across devices and never consume a concurrent/backdated reply',async t=>{
 const{topic,reply,topics,mark}=await fixture(t);const item=await topic('a');const rendered=await reply(item.id,'b');
 assert.equal((await topics()).items[0].unread_count,1);assert.equal((await topics()).items[0].topic_unread,true);const delayed=await reply(item.id,'b',{time:'2026-10-19T11:00:00Z'});
 const ack=await mark('c',item.id,[rendered.id]);assert.equal(ack.unread_count,1);assert.equal(ack.topic_unread,false);
 assert.equal((await topics()).items[0].first_unread_reply_id,delayed.id);
 await mark('c',item.id,[delayed.id]);assert.equal((await topics()).items[0].unread_count,0);
 await mark('c',item.id,[rendered.id]);assert.equal((await topics()).items[0].unread_count,0,'an older device never rewinds or overwrites the union');
 const newest=await reply(item.id,'b',{time:'2026-10-23T00:00:00Z'});assert.equal((await mark('c',item.id,[rendered.id,delayed.id])).unread_count,1);assert.equal((await topics('c',{unread:true})).items[0].first_unread_reply_id,newest.id);
});

test('own contributions are never unread; marking a topic alone cannot silently mark its unseen replies',async t=>{
 const{topic,reply,topics,mark}=await fixture(t);const item=await topic('a');const own=await reply(item.id,'a');
 assert.equal((await topics('a')).items[0].unread_count,0);assert.equal((await topics('a')).items[0].topic_unread,false);
 await reply(item.id,'b');assert.equal((await topics('a')).items[0].unread_count,1);
 assert.equal((await mark('c',item.id,[])).unread_count,2);assert.equal((await topics('c')).items[0].topic_unread,false);
 await mark('a',item.id,[own.id]);assert.equal((await topics('a')).items[0].unread_count,1);
});

test('receipt validation and membership lifecycle isolate users and never acknowledge another topic or hidden reply',async t=>{
 const{db,as,rpc,topic,reply,topics,mark}=await fixture(t);const first=await topic('a'),other=await topic('b');const response=await reply(first.id,'b'),foreign=await reply(other.id,'a');
 await assert.rejects(mark('c',first.id,[foreign.id]),/fc_activity_post_unavailable/);
 await rpc('mod','fc_moderate',['reply_hide',response.id]);await assert.rejects(mark('c',first.id,[response.id]),/fc_activity_post_unavailable/);await rpc('mod','fc_moderate',['reply_show',response.id]);
 await mark('c',first.id,[response.id]);assert.equal((await topics('c')).items.find(p=>p.id===first.id).unread_count,0);assert.ok((await topics('a')).items.find(p=>p.id===first.id).unread_count>0);
 await db.query("update fc_members set status='suspended' where user_id=$1",[ids.c]);await assert.rejects(topics('c'),/fc_active_member_required/);
 await db.query("update fc_members set status='active' where user_id=$1",[ids.c]);assert.equal((await topics('c')).items.find(p=>p.id===first.id).unread_count,0);
 await db.query('delete from fc_members where user_id=$1',[ids.c]);await db.query("insert into fc_members(user_id,alias,status)values($1,'Alias C','active')",[ids.c]);assert.equal((await topics('c')).items.find(p=>p.id===first.id).unread_count,1,'new membership has no old account-local receipts');
 await assert.rejects(as('c','insert into fc_private.reply_reads(user_id,topic_id,reply_id)values($1,$2,$3)',[ids.a,first.id,response.id]),/permission denied/);
});

test('locate reply uses the same visible ordering and fifty-row pages after hidden/withdrawn predecessors for both roles',async t=>{
 const{db,as,rpc,topic}=await fixture(t);const item=await topic();
 const replies=(await db.query("insert into fc_replies(topic_id,author_id,body,created_at)select $1,$2,'Fixture reply '||g,'2026-10-20T12:00:00Z'::timestamptz+g*interval '1 second'from generate_series(1,101)g returning id,created_at",[item.id,ids.b])).rows.sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
 assert.deepEqual(await rpc('c','fc_locate_reply',[item.id,replies[100].id]),{reply_page:2,index:100,page_size:50});
 await rpc('mod','fc_moderate',['reply_hide',replies[0].id]);assert.deepEqual(await rpc('c','fc_locate_reply',[item.id,replies[100].id]),{reply_page:1,index:99,page_size:50});
 await rpc('b','fc_withdraw',['reply',replies[1].id]);
 for(const actor of['c','mod']){
  const raw=(await as(actor,'select id from fc_replies where topic_id=$1 and hidden=false order by created_at,id',[item.id])).rows;
  const location=await rpc(actor,'fc_locate_reply',[item.id,replies[100].id]);
  assert.equal(location.index,raw.findIndex(r=>r.id===replies[100].id));assert.equal(location.index,98);assert.equal(location.reply_page,1);
 }
 await assert.rejects(rpc('mod','fc_locate_reply',[item.id,replies[0].id]),/fc_activity_post_unavailable/);
});

test('hidden parents and withdrawals disappear from all activity surfaces without exposing content to moderators',async t=>{
 const{db,rpc,topic,reply,topics}=await fixture(t);const item=await topic('a',{title:'Confidential topic',body:'Private original'});await reply(item.id,'b',{body:'Other author original'});
 await rpc('mod','fc_moderate',['topic_hide',item.id]);for(const actor of['a','mod']){assert.equal((await topics(actor)).total,0);assert.deepEqual((await rpc(actor,'fc_activity_feed')).items,[]);assert.deepEqual((await rpc(actor,'fc_recent_contributors')).items,[]);}
 await rpc('a','fc_withdraw',['topic',item.id]);assert.equal((await db.query('select body from fc_replies where topic_id=$1',[item.id])).rows[0].body,'Other author original');
 assert.equal((await topics('mod')).total,0);await assert.rejects(rpc('a','fc_mark_topic_read',[item.id,pgArray([]),true]),/fc_content_unavailable/);
});
