import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const sql = await readFile(new URL('../supabase/webapp-profile.sql', import.meta.url), 'utf8');
const ids = Object.fromEntries(['a', 'b', 'outside'].map((name, i) => [name, `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`]));
const draft = (extra = {}) => ({ privateAlias: 'PRIVATE ALIAS', privateBio: 'PRIVATE NOTES', publicAlias: 'Mi presentación', publicBio: '<img src=x> Literal', photos: [], coverId: null, ...extra });
async function fixture(t) {
 const db = new PGlite(); t.after(() => db.close());
 await db.exec(`create role anon nologin;create role authenticated nologin;create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth,public to anon,authenticated;
 create schema sx_private;create table sx_private.test_contacts(owner_id uuid,reader_id uuid,accepted boolean,blocked boolean default false);
 create function sx_private.are_contacts(p_owner uuid,p_reader uuid) returns boolean language sql stable security definer set search_path='' as $$select auth.uid()=p_reader and exists(select 1 from sx_private.test_contacts where owner_id=p_owner and reader_id=p_reader and accepted and not blocked)$$;
 create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text,owner_id text,metadata jsonb,unique(bucket_id,name));
 alter table storage.objects enable row level security;grant usage on schema storage to anon,authenticated;grant select,insert,update,delete on storage.objects to anon,authenticated;
 create function storage.allow_any_operation(ops text[]) returns boolean language sql stable as $$select coalesce(current_setting('storage.operation',true),'')=any(ops)$$;
 create policy broad_existing_policy on storage.objects for all to public using(true) with check(true);
 insert into storage.buckets values('unrelated','unrelated',false,1000000,array['text/plain']);`);
 for (const id of Object.values(ids)) await db.query('insert into auth.users values($1)', [id]);
 await db.query('insert into sx_private.test_contacts values($1,$2,true,false)', [ids.a, ids.b]);
 try { await db.exec(sql); } catch (error) { throw new Error(`${error.message}; position=${error.position}; ${sql.slice(Number(error.position)-90,Number(error.position)+110)}`); }
 const as = async (actor, query, values = [], operation = 'object.get_authenticated') => {
  await db.exec(`set role ${actor === null ? 'anon' : 'authenticated'}`);
  try { await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('storage.operation',$2,false)", [ids[actor] || '', operation]); return await db.query(query, values); }
  finally { await db.exec("reset role;select set_config('request.jwt.claim.sub','',false),set_config('storage.operation','',false)"); }
 };
 const rpc = async (actor, name, args = []) => { assert.match(name, /^sx_profile_[a-z_]+$/); return (await as(actor, `select ${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) value`, args)).rows[0].value; };
 const reserve = (actor = 'a', bytes = 100) => rpc(actor, 'sx_profile_reserve_photo', [bytes]);
 const upload = async (actor, file) => {
  await as(actor, 'insert into storage.objects(bucket_id,name,owner_id,metadata) values($1,$2,$3,$4)', [file.bucket_id,file.object_path,ids[actor],{mimetype:'image/webp',size:Number(file.byte_size)}]);
  return rpc(actor,'sx_profile_finish_photo',[file.id]);
 };
 return { db, as, rpc, reserve, upload };
}

test('profile schema is repeatable, private and independent from forum roles', async t => {
 const { db, as, rpc } = await fixture(t);
 assert.doesNotMatch(sql,/\bdrop\s+(?:policy|table|schema|function)\b/i);
 const policies=(await db.query("select oid,polname from pg_policy where polname like 'sx_profile_%' order by polname")).rows;
 await db.exec(sql);
 assert.deepEqual((await db.query("select oid,polname from pg_policy where polname like 'sx_profile_%' order by polname")).rows,policies,'reapplying updates policies without destroying them');
 assert.equal((await db.query("select public from storage.buckets where id='sx-profile-photos'")).rows[0].public, false);
 await assert.rejects(rpc(null, 'sx_profile_state'), /permission denied|auth_required/);
 await assert.rejects(as('a','select * from sx_private.profiles'), /permission denied/);
 const own = await rpc('outside','sx_profile_state'); assert.equal(own.revision,0); assert.equal(own.publication,null);
 const wrappers = (await db.query("select prosecdef,proconfig from pg_proc where pronamespace='public'::regnamespace and proname like 'sx_profile_%'")).rows;
 assert.ok(wrappers.length >= 10 && wrappers.every(f => !f.prosecdef && f.proconfig.includes('search_path=""')));
});

test('four texts persist privately by account and stale revisions cannot overwrite a newer draft', async t => {
 const { rpc } = await fixture(t);
 const state = await rpc('a','sx_profile_save',[0,draft()]); assert.equal(state.revision,1); assert.deepEqual(state.draft,draft()); assert.equal(state.publication,null);
 assert.deepEqual((await rpc('a','sx_profile_state')).draft,draft()); assert.equal((await rpc('b','sx_profile_state')).draft.privateBio,'');
 await assert.rejects(rpc('a','sx_profile_save',[0,draft({publicAlias:'Late update'})]), /revision_conflict/);
 assert.equal(await rpc('b','sx_profile_shared',[ids.a]),null);
 await assert.rejects(rpc('a','sx_profile_save',[1,{...draft(),url:'blob:never-persist'}]), /invalid_draft/);
});

test('photo reservations enforce six slots, normalized WebP size and immutable owned Storage uploads', async t => {
 const { as, rpc, reserve, upload } = await fixture(t);
 await assert.rejects(reserve('a',950001),/invalid_file/); const file=await reserve();
 assert.equal(file.object_path,`${ids.a}/${file.id}.webp`); assert.equal(file.mime_type,'image/webp');
 for (const [actor,owner,metadata] of [['b',ids.b,{mimetype:'image/webp',size:100}],['a',ids.a,{mimetype:'image/jpeg',size:100}],['a',ids.a,{mimetype:'image/webp',size:101}],['a',ids.b,{mimetype:'image/webp',size:100}]]) {
  await assert.rejects(as(actor,'insert into storage.objects(bucket_id,name,owner_id,metadata) values($1,$2,$3,$4)',[file.bucket_id,file.object_path,owner,metadata]),/row-level security/);
 }
 await assert.rejects(rpc('a','sx_profile_finish_photo',[file.id]),/upload_incomplete/); await upload('a',file);
 assert.equal((await as('a','update storage.objects set metadata=$1 where name=$2 returning name',[{mimetype:'image/webp',size:1},file.object_path])).rows.length,0);
 for(let i=0;i<5;i++) await reserve(); await assert.rejects(reserve(),/photo_limit/);
});

test('only accepted unblocked contacts can read the chosen snapshot and exactly its photos, with signed access denied', async t => {
 const { db, as, rpc, reserve, upload } = await fixture(t); const first=await upload('a',await reserve()), second=await upload('a',await reserve());
 const prepared=draft({photos:[{id:first.id,zoom:1.5,x:20,y:80},{id:second.id,zoom:1,x:50,y:50}],coverId:first.id});
 await rpc('a','sx_profile_save',[0,prepared]); const published=await rpc('a','sx_profile_publish',[1,true,true]);
 assert.equal(published.publication.audience,'contacts'); assert.doesNotMatch(JSON.stringify(published.publication),/PRIVATE/);
 const shared=await rpc('b','sx_profile_shared',[ids.a]); assert.deepEqual(shared.publication,published.publication); assert.equal(shared.files.length,2);
 assert.equal(await rpc('outside','sx_profile_shared',[ids.a]),null);
 assert.equal((await as('b','select name from storage.objects')).rows.length,2);
 assert.equal((await as(null,'select name from storage.objects')).rows.length,0);
 assert.equal((await as('b','select name from storage.objects',[],'object.sign')).rows.length,0);
 const own=await rpc('a','sx_profile_state'); await rpc('a','sx_profile_save',[own.revision,draft({photos:prepared.photos,coverId:first.id,publicAlias:'Unshared edit'})]);
 assert.equal((await rpc('b','sx_profile_shared',[ids.a])).publication.alias,'Mi presentación');
 await db.query('update sx_private.test_contacts set blocked=true');
 assert.equal(await rpc('b','sx_profile_shared',[ids.a]),null); assert.equal((await as('b','select name from storage.objects')).rows.length,0);
 assert.equal((await as('a','select name from storage.objects')).rows.length,2);
});

test('withdrawing or removing a published photo revokes access before physical deletion and preserves other draft data', async t => {
 const { as, rpc, reserve, upload } = await fixture(t); const file=await upload('a',await reserve());
 await rpc('a','sx_profile_save',[0,draft({photos:[{id:file.id,zoom:1,x:50,y:50}],coverId:file.id})]); await rpc('a','sx_profile_publish',[1,false,true]);
 assert.equal((await rpc('b','sx_profile_shared',[ids.a])).publication.alias,'');
 const removed=await rpc('a','sx_profile_remove_photo',[file.id]); assert.equal(removed.state.publication,null); assert.equal(removed.state.draft.privateBio,'PRIVATE NOTES'); assert.equal(removed.state.draft.photos.length,0);
 assert.equal(await rpc('b','sx_profile_shared',[ids.a]),null); assert.equal((await as('b','select name from storage.objects')).rows.length,0);
 assert.equal((await as('a','delete from storage.objects where name=$1 returning name',[file.object_path],'object.delete')).rows.length,1);
 await rpc('a','sx_profile_save',[removed.state.revision,draft()]); await rpc('a','sx_profile_publish',[removed.state.revision+1,true,false]);
 await rpc('a','sx_profile_withdraw'); assert.equal(await rpc('b','sx_profile_shared',[ids.a]),null);
});

test('foreign photos, malformed framing and duplicate IDs cannot enter a private draft or publication', async t => {
 const { rpc, reserve, upload } = await fixture(t); const file=await upload('b',await reserve('b'));
 await assert.rejects(rpc('a','sx_profile_save',[0,draft({photos:[{id:file.id,zoom:1,x:50,y:50}],coverId:file.id})]),/file_unavailable/);
 const own=await upload('a',await reserve());
 for(const photo of [{id:own.id,zoom:10,x:50,y:50},{id:own.id,zoom:1,x:-1,y:50},{id:own.id,zoom:1,x:50,y:50,url:'https://tracker.invalid'},{id:own.id,zoom:'1',x:50,y:50}]) await assert.rejects(rpc('a','sx_profile_save',[0,draft({photos:[photo],coverId:own.id})]),/invalid_draft/);
 const photo={id:own.id,zoom:1,x:50,y:50}; await assert.rejects(rpc('a','sx_profile_save',[0,draft({photos:[photo,photo],coverId:own.id})]),/invalid_draft/);
 await assert.rejects(rpc('a','sx_profile_publish',[0,false,false]),/empty_publication/);
});

test('owner and project budgets retain removed reservations and include already stored bytes', async t => {
 const { db, reserve } = await fixture(t);
 await db.query("insert into sx_private.profile_files(owner_id,object_path,byte_size,status) select $1,'held-'||n,950000,'removed' from generate_series(1,32) n",[ids.a]);
 await assert.rejects(reserve(),/storage_limit/);
 await db.query('delete from sx_private.profile_files');
 await db.query("insert into storage.objects(bucket_id,name,metadata) values('unrelated','large',jsonb_build_object('size',900000000))");
 await assert.rejects(reserve(),/storage_limit/);
});

test('delete clears texts and publication, exposes only owned cleanup paths and does not delete Storage with SQL', async t => {
 const { as, rpc, reserve, upload } = await fixture(t); const file=await upload('a',await reserve());
 await rpc('a','sx_profile_save',[0,draft({photos:[{id:file.id,zoom:1,x:50,y:50}],coverId:file.id})]);await rpc('a','sx_profile_publish',[1,true,true]);
 const result=await rpc('a','sx_profile_delete'); assert.equal(result.state.draft.privateBio,''); assert.equal(result.state.publication,null);assert.equal(result.files.length,1);
 assert.equal((await as('a','select name from storage.objects',[],'object.delete')).rows.length,1);
 assert.equal((await as('b','select name from storage.objects')).rows.length,0);
 assert.equal((await rpc('a','sx_profile_cleanup')).length,1); assert.equal((await rpc('b','sx_profile_cleanup')).length,0);
});

test('discarding a failed upload cannot remove a photo already committed to either saved version',async t=>{
 const {rpc,reserve,upload}=await fixture(t);const first=await upload('a',await reserve()),second=await upload('a',await reserve());
 await rpc('a','sx_profile_save',[0,draft({photos:[{id:first.id,zoom:1,x:50,y:50}],coverId:first.id})]);await rpc('a','sx_profile_publish',[1,false,true]);
 await rpc('a','sx_profile_save',[2,draft()]);
 assert.equal((await rpc('a','sx_profile_discard_photo',[first.id])).discarded,false,'the shared copy still references it');
 assert.equal((await rpc('a','sx_profile_discard_photo',[second.id])).discarded,true);
 assert.notEqual((await rpc('a','sx_profile_state')).publication,null);
});
