-- V2 private profile studio. Requires sx_private.are_contacts(owner,reader).
-- Independent of the forum identity. No anonymous profile or image access.
-- Storage bytes are uploaded/deleted only through Storage API, never SQL.
begin;
create schema if not exists sx_private;
grant usage on schema sx_private to authenticated;
create schema if not exists fc_private;
create table if not exists fc_private.storage_budget(id integer primary key check(id=1));
insert into fc_private.storage_budget values(1) on conflict do nothing;
alter table fc_private.storage_budget enable row level security;
revoke all on fc_private.storage_budget from public,anon,authenticated;

create table if not exists sx_private.profiles (
 owner_id uuid primary key references auth.users(id) on delete cascade,
 revision bigint not null default 0,
 draft jsonb not null default '{"privateAlias":"","privateBio":"","publicAlias":"","publicBio":"","photos":[],"coverId":null}',
 publication jsonb,
 updated_at timestamptz not null default now()
);
create table if not exists sx_private.profile_files (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete cascade,
 bucket_id text not null default 'sx-profile-photos' check(bucket_id='sx-profile-photos'),
 object_path text not null,
 mime_type text not null default 'image/webp' check(mime_type='image/webp'),
 byte_size bigint not null check(byte_size between 1 and 950000),
 status text not null default 'reserved' check(status in('reserved','ready','removed')),
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default now()+interval '24 hours',
 unique(bucket_id,object_path)
);
create index if not exists sx_profile_files_owner_idx on sx_private.profile_files(owner_id,created_at);
alter table sx_private.profiles enable row level security;
alter table sx_private.profile_files enable row level security;
revoke all on sx_private.profiles,sx_private.profile_files from public,anon,authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('sx-profile-photos','sx-profile-photos',false,950000,array['image/webp'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

create or replace function sx_private.profile_file_guard(p_bucket text,p_path text,p_operation text,p_metadata jsonb default null,p_owner text default null)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare f sx_private.profile_files%rowtype;v_actor uuid:=auth.uid();
begin
 if v_actor is null or p_bucket<>'sx-profile-photos' then return false;end if;
 select * into f from sx_private.profile_files where bucket_id=p_bucket and object_path=p_path;
 if not found then return false;end if;
 if p_operation='upload' then return f.owner_id=v_actor and f.status='reserved' and f.expires_at>now() and p_owner=v_actor::text
  and p_metadata->>'mimetype'='image/webp' and coalesce(p_metadata->>'size',p_metadata->>'contentLength','')~'^[0-9]+$'
  and coalesce(p_metadata->>'size',p_metadata->>'contentLength')::numeric=f.byte_size;end if;
 if p_operation='delete' then return f.owner_id=v_actor and f.status='removed';end if;
 if p_operation<>'read' or f.status='removed' then return false;end if;
 if f.owner_id=v_actor then return f.status='ready' or f.expires_at>now();end if;
 return f.status='ready' and sx_private.are_contacts(f.owner_id,v_actor)
  and exists(select 1 from sx_private.profiles p where p.owner_id=f.owner_id
   and exists(select 1 from jsonb_array_elements(coalesce(p.publication->'photos','[]'::jsonb)) photo where photo->>'id'=f.id::text));
end;$$;
revoke all on function sx_private.profile_file_guard(text,text,text,jsonb,text) from public,anon,authenticated;
grant execute on function sx_private.profile_file_guard(text,text,text,jsonb,text) to authenticated,anon;
grant usage on schema sx_private to anon;
do $policy$ begin
 if exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='sx_profile_insert_guard') then
  alter policy sx_profile_insert_guard on storage.objects to anon,authenticated
 with check(bucket_id<>'sx-profile-photos' or sx_private.profile_file_guard(bucket_id,name,'upload',metadata,owner_id));
 else
  create policy sx_profile_insert_guard on storage.objects as restrictive for insert to anon,authenticated
 with check(bucket_id<>'sx-profile-photos' or sx_private.profile_file_guard(bucket_id,name,'upload',metadata,owner_id));
 end if;
end $policy$;
do $policy$ begin
 if exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='sx_profile_insert') then
  alter policy sx_profile_insert on storage.objects to authenticated
 with check(bucket_id='sx-profile-photos' and sx_private.profile_file_guard(bucket_id,name,'upload',metadata,owner_id));
 else
  create policy sx_profile_insert on storage.objects for insert to authenticated
 with check(bucket_id='sx-profile-photos' and sx_private.profile_file_guard(bucket_id,name,'upload',metadata,owner_id));
 end if;
end $policy$;
do $policy$ begin
 if exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='sx_profile_read_guard') then
  alter policy sx_profile_read_guard on storage.objects to anon,authenticated using (
 bucket_id<>'sx-profile-photos'
 or (storage.allow_any_operation(array['object.get_authenticated','object.get_authenticated_info','object.head_authenticated_info','object.info_authenticated']) and sx_private.profile_file_guard(bucket_id,name,'read'))
 or (storage.allow_any_operation(array['object.delete','object.delete_many']) and sx_private.profile_file_guard(bucket_id,name,'delete')));
 else
  create policy sx_profile_read_guard on storage.objects as restrictive for select to anon,authenticated using (
 bucket_id<>'sx-profile-photos'
 or (storage.allow_any_operation(array['object.get_authenticated','object.get_authenticated_info','object.head_authenticated_info','object.info_authenticated']) and sx_private.profile_file_guard(bucket_id,name,'read'))
 or (storage.allow_any_operation(array['object.delete','object.delete_many']) and sx_private.profile_file_guard(bucket_id,name,'delete')));
 end if;
end $policy$;
do $policy$ begin
 if exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='sx_profile_read') then
  alter policy sx_profile_read on storage.objects to authenticated using (bucket_id='sx-profile-photos' and (
 (storage.allow_any_operation(array['object.get_authenticated','object.get_authenticated_info','object.head_authenticated_info','object.info_authenticated']) and sx_private.profile_file_guard(bucket_id,name,'read'))
 or (storage.allow_any_operation(array['object.delete','object.delete_many']) and sx_private.profile_file_guard(bucket_id,name,'delete'))));
 else
  create policy sx_profile_read on storage.objects for select to authenticated using (bucket_id='sx-profile-photos' and (
 (storage.allow_any_operation(array['object.get_authenticated','object.get_authenticated_info','object.head_authenticated_info','object.info_authenticated']) and sx_private.profile_file_guard(bucket_id,name,'read'))
 or (storage.allow_any_operation(array['object.delete','object.delete_many']) and sx_private.profile_file_guard(bucket_id,name,'delete'))));
 end if;
end $policy$;
do $policy$ begin
 if exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='sx_profile_delete_guard') then
  alter policy sx_profile_delete_guard on storage.objects to anon,authenticated using (
 bucket_id<>'sx-profile-photos' or sx_private.profile_file_guard(bucket_id,name,'delete'));
 else
  create policy sx_profile_delete_guard on storage.objects as restrictive for delete to anon,authenticated using (
 bucket_id<>'sx-profile-photos' or sx_private.profile_file_guard(bucket_id,name,'delete'));
 end if;
end $policy$;
do $policy$ begin
 if exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='sx_profile_delete') then
  alter policy sx_profile_delete on storage.objects to authenticated using (
 bucket_id='sx-profile-photos' and sx_private.profile_file_guard(bucket_id,name,'delete'));
 else
  create policy sx_profile_delete on storage.objects for delete to authenticated using (
 bucket_id='sx-profile-photos' and sx_private.profile_file_guard(bucket_id,name,'delete'));
 end if;
end $policy$;
do $policy$ begin
 if exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='sx_profile_update_guard') then
  alter policy sx_profile_update_guard on storage.objects to anon,authenticated
 using(bucket_id<>'sx-profile-photos') with check(bucket_id<>'sx-profile-photos');
 else
  create policy sx_profile_update_guard on storage.objects as restrictive for update to anon,authenticated
 using(bucket_id<>'sx-profile-photos') with check(bucket_id<>'sx-profile-photos');
 end if;
end $policy$;

create or replace function sx_private.profile_state(p_owner uuid)
returns jsonb language sql stable security definer set search_path='' as $$
 select case when auth.uid()=p_owner then jsonb_build_object('revision',p.revision,'draft',p.draft,'publication',p.publication,
  'files',coalesce((select jsonb_agg(to_jsonb(f) order by f.created_at,f.id) from sx_private.profile_files f where f.owner_id=p_owner and f.status<>'removed'),'[]'::jsonb)) else null end
 from sx_private.profiles p where p.owner_id=p_owner;
$$;
revoke all on function sx_private.profile_state(uuid) from public,anon,authenticated;

create or replace function sx_private.profile_command(p_action text,p_data jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=auth.uid();p sx_private.profiles%rowtype;f sx_private.profile_files%rowtype;
 v_draft jsonb;v_photos jsonb;v_photo jsonb;v_id uuid;v_cover uuid;v_expected bigint;v_bytes bigint;v_owner_bytes bigint;v_global_bytes bigint;v_pending bigint:=0;
 v_metadata jsonb;v_storage_owner text;v_snapshot jsonb;v_files jsonb;v_include_info boolean;v_include_photos boolean;v_cover_index integer;
begin
 if v_actor is null then raise exception using errcode='42501',message='sx_profile_auth_required';end if;
 -- Reservation order is shared budget -> owner row -> file row, never reversed.
 if p_action='reserve' then perform 1 from fc_private.storage_budget where id=1 for update;end if;
 insert into sx_private.profiles(owner_id) values(v_actor) on conflict do nothing;
 select * into p from sx_private.profiles where owner_id=v_actor for update;
 if p_action='state' then return sx_private.profile_state(v_actor);end if;
 if p_action='reserve' then
  v_bytes:=(p_data->>'bytes')::bigint;
  if v_bytes is null or v_bytes<1 or v_bytes>950000 then raise exception using errcode='22023',message='sx_profile_invalid_file';end if;
  if (select count(*) from sx_private.profile_files where owner_id=v_actor and (status='ready' or (status='reserved' and expires_at>now())))>=6
   then raise exception using errcode='54000',message='sx_profile_photo_limit';end if;
  select coalesce(sum(byte_size),0) into v_owner_bytes from sx_private.profile_files asset where asset.owner_id=v_actor and
   (asset.status='ready' or asset.expires_at>now() or exists(select 1 from storage.objects o where o.bucket_id=asset.bucket_id and o.name=asset.object_path));
  select coalesce(sum(case when coalesce(metadata->>'size',metadata->>'contentLength','')~'^[0-9]+$' then coalesce(metadata->>'size',metadata->>'contentLength')::bigint else 0 end),0)
   into v_global_bytes from storage.objects;
  select coalesce(sum(byte_size),0) into v_pending from sx_private.profile_files asset where asset.expires_at>now()
   and not exists(select 1 from storage.objects o where o.bucket_id=asset.bucket_id and o.name=asset.object_path);
  v_global_bytes:=v_global_bytes+v_pending;
  if to_regclass('public.fc_files') is not null then
   execute 'select coalesce(sum(byte_size),0) from public.fc_files f where f.expires_at>now() and not exists(select 1 from storage.objects o where o.bucket_id=f.bucket_id and o.name=f.object_path)' into v_pending;
   v_global_bytes:=v_global_bytes+v_pending;
  end if;
  if to_regprocedure('fc_private.storage_reserved_bytes()')is not null then
   v_global_bytes:=fc_private.storage_reserved_bytes();
  end if;
  if v_owner_bytes+v_bytes>30000000 or v_global_bytes+v_bytes>900000000 then raise exception using errcode='54000',message='sx_profile_storage_limit';end if;
  v_id:=gen_random_uuid();insert into sx_private.profile_files(id,owner_id,object_path,byte_size) values(v_id,v_actor,v_actor::text||'/'||v_id::text||'.webp',v_bytes) returning * into f;
  return to_jsonb(f);
 elsif p_action='finish' then
  select * into f from sx_private.profile_files where id=(p_data->>'id')::uuid and owner_id=v_actor for update;
  if not found or f.status not in('reserved','ready') or (f.status='reserved' and f.expires_at<=now()) then raise exception using errcode='42501',message='sx_profile_file_unavailable';end if;
  select metadata,owner_id into v_metadata,v_storage_owner from storage.objects where bucket_id=f.bucket_id and name=f.object_path;
  if v_metadata is null or v_storage_owner is distinct from v_actor::text or v_metadata->>'mimetype' is distinct from 'image/webp'
   or coalesce(v_metadata->>'size',v_metadata->>'contentLength','')!~'^[0-9]+$' or coalesce(v_metadata->>'size',v_metadata->>'contentLength')::numeric<>f.byte_size
   then raise exception using errcode='22023',message='sx_profile_upload_incomplete';end if;
  update sx_private.profile_files set status='ready' where id=f.id returning * into f;return to_jsonb(f);
 elsif p_action='save' then
  v_expected:=(p_data->>'expected_revision')::bigint;
  if v_expected is null or v_expected<>p.revision then raise exception using errcode='40001',message='sx_profile_revision_conflict';end if;
  v_draft:=p_data->'draft';
  if jsonb_typeof(v_draft)<>'object' or (v_draft-array['privateAlias','privateBio','publicAlias','publicBio','photos','coverId'])<>'{}'::jsonb
   or not(v_draft?&array['privateAlias','privateBio','publicAlias','publicBio','photos','coverId']) then raise exception using errcode='22023',message='sx_profile_invalid_draft';end if;
  if jsonb_typeof(v_draft->'privateAlias')<>'string' or char_length(v_draft->>'privateAlias')>50
   or jsonb_typeof(v_draft->'privateBio')<>'string' or char_length(v_draft->>'privateBio')>1000
   or jsonb_typeof(v_draft->'publicAlias')<>'string' or char_length(v_draft->>'publicAlias')>50
   or jsonb_typeof(v_draft->'publicBio')<>'string' or char_length(v_draft->>'publicBio')>600
   or jsonb_typeof(v_draft->'photos')<>'array' then raise exception using errcode='22023',message='sx_profile_invalid_draft';end if;
  v_photos:=v_draft->'photos';
  if jsonb_array_length(v_photos)>6 then raise exception using errcode='22023',message='sx_profile_invalid_draft';end if;
  for v_photo in select value from jsonb_array_elements(v_photos) loop
   if jsonb_typeof(v_photo)<>'object' or (v_photo-array['id','zoom','x','y'])<>'{}'::jsonb or not(v_photo?&array['id','zoom','x','y'])
    or jsonb_typeof(v_photo->'zoom')<>'number' or jsonb_typeof(v_photo->'x')<>'number' or jsonb_typeof(v_photo->'y')<>'number'
    then raise exception using errcode='22023',message='sx_profile_invalid_draft';end if;
   if (v_photo->>'zoom')::numeric not between 1 and 2.5 or (v_photo->>'x')::numeric not between 0 and 100 or (v_photo->>'y')::numeric not between 0 and 100
    then raise exception using errcode='22023',message='sx_profile_invalid_draft';end if;
   v_id:=(v_photo->>'id')::uuid;
   if not exists(select 1 from sx_private.profile_files where id=v_id and owner_id=v_actor and status='ready') then raise exception using errcode='42501',message='sx_profile_file_unavailable';end if;
  end loop;
  if (select count(distinct value->>'id') from jsonb_array_elements(v_photos))<>jsonb_array_length(v_photos) then raise exception using errcode='22023',message='sx_profile_invalid_draft';end if;
  v_cover:=(v_draft->>'coverId')::uuid;
  if (jsonb_array_length(v_photos)=0 and v_cover is not null) or (jsonb_array_length(v_photos)>0 and (v_cover is null or not exists(select 1 from jsonb_array_elements(v_photos) x where x->>'id'=v_cover::text)))
   then raise exception using errcode='22023',message='sx_profile_invalid_draft';end if;
  update sx_private.profiles set draft=v_draft,revision=revision+1,updated_at=now() where owner_id=v_actor;return sx_private.profile_state(v_actor);
 elsif p_action='publish' then
  v_expected:=(p_data->>'expected_revision')::bigint;
  if v_expected is null or v_expected<>p.revision then raise exception using errcode='40001',message='sx_profile_revision_conflict';end if;
  v_include_info:=coalesce((p_data->>'include_information')::boolean,false);v_include_photos:=coalesce((p_data->>'include_photos')::boolean,false);
  v_photos:=case when v_include_photos then p.draft->'photos' else '[]'::jsonb end;
  if not(v_include_info or v_include_photos) or (v_include_info and btrim(p.draft->>'publicAlias')='') or (v_include_photos and jsonb_array_length(v_photos)=0)
   then raise exception using errcode='22023',message='sx_profile_empty_publication';end if;
  if exists(select 1 from jsonb_array_elements(v_photos) x where not exists(select 1 from sx_private.profile_files asset where asset.id=(x->>'id')::uuid and asset.owner_id=v_actor and asset.status='ready'))
   then raise exception using errcode='42501',message='sx_profile_file_unavailable';end if;
  select ordinality::integer-1 into v_cover_index from jsonb_array_elements(v_photos) with ordinality x where x.value->>'id'=p.draft->>'coverId';
  v_snapshot:=jsonb_build_object('alias',case when v_include_info then btrim(p.draft->>'publicAlias') else '' end,'bio',case when v_include_info then btrim(p.draft->>'publicBio') else '' end,
   'photos',v_photos,'coverIndex',coalesce(v_cover_index,-1),'audience','contacts');
  update sx_private.profiles set publication=v_snapshot,revision=revision+1,updated_at=now() where owner_id=v_actor;return sx_private.profile_state(v_actor);
 elsif p_action='withdraw' then
  update sx_private.profiles set publication=null,revision=revision+1,updated_at=now() where owner_id=v_actor;return sx_private.profile_state(v_actor);
 elsif p_action in('remove','discard') then
  select * into f from sx_private.profile_files where id=(p_data->>'id')::uuid and owner_id=v_actor for update;
  if not found then raise exception using errcode='42501',message='sx_profile_file_unavailable';end if;
  if p_action='discard' then
   if exists(select 1 from jsonb_array_elements((p.draft->'photos')||coalesce(p.publication->'photos','[]'::jsonb)) x where x->>'id'=f.id::text)
    then return jsonb_build_object('discarded',false,'state',sx_private.profile_state(v_actor));end if;
   update sx_private.profile_files set status='removed' where id=f.id returning * into f;
   return jsonb_build_object('discarded',true,'state',sx_private.profile_state(v_actor),'file',to_jsonb(f));
  end if;
  select coalesce(jsonb_agg(value order by ordinality),'[]'::jsonb) into v_photos from jsonb_array_elements(p.draft->'photos') with ordinality where value->>'id'<>f.id::text;
  v_cover:=case when p.draft->>'coverId'=f.id::text then (v_photos->0->>'id')::uuid else (p.draft->>'coverId')::uuid end;
  update sx_private.profiles set draft=jsonb_set(jsonb_set(draft,'{photos}',v_photos),'{coverId}',coalesce(to_jsonb(v_cover),'null'::jsonb)),
   publication=case when exists(select 1 from jsonb_array_elements(coalesce(publication->'photos','[]'::jsonb)) x where x->>'id'=f.id::text) then null else publication end,
   revision=revision+1,updated_at=now() where owner_id=v_actor;
  update sx_private.profile_files set status='removed' where id=f.id returning * into f;
  return jsonb_build_object('state',sx_private.profile_state(v_actor),'file',to_jsonb(f));
 elsif p_action='delete' then
  update sx_private.profiles set draft='{"privateAlias":"","privateBio":"","publicAlias":"","publicBio":"","photos":[],"coverId":null}',publication=null,revision=revision+1,updated_at=now() where owner_id=v_actor;
  update sx_private.profile_files set status='removed' where owner_id=v_actor;
  select coalesce(jsonb_agg(to_jsonb(asset)),'[]'::jsonb) into v_files from sx_private.profile_files asset where owner_id=v_actor;
  return jsonb_build_object('state',sx_private.profile_state(v_actor),'files',v_files);
 elsif p_action='cleanup' then
  update sx_private.profile_files set status='removed' where owner_id=v_actor and status='reserved' and expires_at<=now();
  select coalesce(jsonb_agg(to_jsonb(asset)),'[]'::jsonb) into v_files from sx_private.profile_files asset where owner_id=v_actor and status='removed'
   and exists(select 1 from storage.objects o where o.bucket_id=asset.bucket_id and o.name=asset.object_path);
  return v_files;
 end if;
 raise exception using errcode='22023',message='sx_profile_invalid_action';
end;$$;
revoke all on function sx_private.profile_command(text,jsonb) from public,anon,authenticated;
grant execute on function sx_private.profile_command(text,jsonb) to authenticated;

create or replace function public.sx_profile_state() returns jsonb language sql security invoker set search_path='' as $$select sx_private.profile_command('state');$$;
create or replace function public.sx_profile_save(p_expected_revision bigint,p_draft jsonb) returns jsonb language sql security invoker set search_path='' as $$select sx_private.profile_command('save',jsonb_build_object('expected_revision',p_expected_revision,'draft',p_draft));$$;
create or replace function public.sx_profile_reserve_photo(p_bytes bigint) returns jsonb language sql security invoker set search_path='' as $$select sx_private.profile_command('reserve',jsonb_build_object('bytes',p_bytes));$$;
create or replace function public.sx_profile_finish_photo(p_id uuid) returns jsonb language sql security invoker set search_path='' as $$select sx_private.profile_command('finish',jsonb_build_object('id',p_id));$$;
create or replace function public.sx_profile_remove_photo(p_id uuid) returns jsonb language sql security invoker set search_path='' as $$select sx_private.profile_command('remove',jsonb_build_object('id',p_id));$$;
create or replace function public.sx_profile_discard_photo(p_id uuid) returns jsonb language sql security invoker set search_path='' as $$select sx_private.profile_command('discard',jsonb_build_object('id',p_id));$$;
create or replace function public.sx_profile_publish(p_expected_revision bigint,p_include_information boolean,p_include_photos boolean) returns jsonb language sql security invoker set search_path='' as $$select sx_private.profile_command('publish',jsonb_build_object('expected_revision',p_expected_revision,'include_information',p_include_information,'include_photos',p_include_photos));$$;
create or replace function public.sx_profile_withdraw() returns jsonb language sql security invoker set search_path='' as $$select sx_private.profile_command('withdraw');$$;
create or replace function public.sx_profile_delete() returns jsonb language sql security invoker set search_path='' as $$select sx_private.profile_command('delete');$$;
create or replace function public.sx_profile_cleanup() returns jsonb language sql security invoker set search_path='' as $$select sx_private.profile_command('cleanup');$$;

create or replace function sx_private.profile_shared(p_owner uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_actor uuid:=auth.uid();v_snapshot jsonb;v_files jsonb;
begin
 if v_actor is null or (v_actor<>p_owner and not sx_private.are_contacts(p_owner,v_actor)) then return null;end if;
 select publication into v_snapshot from sx_private.profiles where owner_id=p_owner;
 if v_snapshot is null then return null;end if;
 select coalesce(jsonb_agg(to_jsonb(f)),'[]'::jsonb) into v_files from sx_private.profile_files f where f.owner_id=p_owner and f.status='ready'
  and exists(select 1 from jsonb_array_elements(v_snapshot->'photos') x where x->>'id'=f.id::text);
 return jsonb_build_object('publication',v_snapshot,'files',v_files);
end;$$;
revoke all on function sx_private.profile_shared(uuid) from public,anon,authenticated;
grant execute on function sx_private.profile_shared(uuid) to authenticated;
create or replace function public.sx_profile_shared(p_owner_id uuid) returns jsonb language sql security invoker set search_path='' as $$select sx_private.profile_shared(p_owner_id);$$;
revoke all on function public.sx_profile_state(),public.sx_profile_save(bigint,jsonb),public.sx_profile_reserve_photo(bigint),public.sx_profile_finish_photo(uuid),public.sx_profile_remove_photo(uuid),public.sx_profile_discard_photo(uuid),public.sx_profile_publish(bigint,boolean,boolean),public.sx_profile_withdraw(),public.sx_profile_delete(),public.sx_profile_cleanup(),public.sx_profile_shared(uuid) from public,anon,authenticated;
grant execute on function public.sx_profile_state(),public.sx_profile_save(bigint,jsonb),public.sx_profile_reserve_photo(bigint),public.sx_profile_finish_photo(uuid),public.sx_profile_remove_photo(uuid),public.sx_profile_discard_photo(uuid),public.sx_profile_publish(bigint,boolean,boolean),public.sx_profile_withdraw(),public.sx_profile_delete(),public.sx_profile_cleanup(),public.sx_profile_shared(uuid) to authenticated;
commit;
