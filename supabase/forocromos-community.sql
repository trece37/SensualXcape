-- Additive community/media contract. Install after forocromos-live.sql.
-- No real accounts or email addresses are embedded. An administrator provisions
-- verified auth.users IDs into fc_private.founders separately; moderator != founder.
-- Storage objects are never inserted/updated/deleted by these RPCs. Use Storage API.
-- Upload raw ArrayBuffer, explicit contentType, upsert:false; authenticated downloads.
-- Cleanup is explicit: fc_file_cleanup -> Storage.remove. No automatic job is installed.
begin;

create table if not exists fc_private.founders (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table fc_private.founders enable row level security;
revoke all on fc_private.founders from public,anon,authenticated;
create table if not exists fc_private.storage_budget (id integer primary key check (id = 1));
insert into fc_private.storage_budget values (1) on conflict do nothing;
alter table fc_private.storage_budget enable row level security;
revoke all on fc_private.storage_budget from public,anon,authenticated;

create table if not exists public.fc_files (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.fc_members(user_id) on delete cascade,
  purpose text not null check (purpose in ('attachment','avatar')),
  bucket_id text not null check (bucket_id in ('fc-attachments','fc-founder-files','fc-avatars')),
  object_path text not null,
  file_name text not null check (char_length(file_name) between 1 and 100 and file_name !~ '[[:cntrl:]<>/\\]'),
  mime_type text not null,
  byte_size bigint not null check (byte_size between 1 and 50000000),
  status text not null default 'reserved' check (status in ('reserved','ready','linked','removed')),
  topic_id uuid references public.fc_topics(id) on delete cascade,
  reply_id uuid references public.fc_replies(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  removed_at timestamptz,
  unique (bucket_id,object_path),
  check (num_nonnulls(topic_id,reply_id) <= 1),
  check ((purpose = 'avatar' and bucket_id = 'fc-avatars' and byte_size <= 950000 and topic_id is null and reply_id is null
    and mime_type in ('image/jpeg','image/png','image/webp')) or
    (purpose = 'attachment' and bucket_id in ('fc-attachments','fc-founder-files')
    and (bucket_id = 'fc-founder-files' or byte_size <= 950000)
    and mime_type in ('image/jpeg','image/png','image/webp','image/gif','audio/mpeg','audio/mp4','audio/ogg','audio/webm','audio/wav','video/mp4','video/webm','application/pdf','text/plain')))
);
create index if not exists fc_files_owner_created_idx on public.fc_files(owner_id,created_at);
create index if not exists fc_files_topic_idx on public.fc_files(topic_id) where topic_id is not null;
create index if not exists fc_files_reply_idx on public.fc_files(reply_id) where reply_id is not null;
alter table public.fc_files enable row level security;
revoke all on public.fc_files from public,anon,authenticated;
grant select on public.fc_files to authenticated;

alter table public.fc_members add column if not exists tagline text not null default '';
alter table public.fc_members add column if not exists font text not null default 'sans';
alter table public.fc_members add column if not exists color text not null default 'default';
alter table public.fc_members add column if not exists avatar_file_id uuid references public.fc_files(id) on delete set null;
create index if not exists fc_members_avatar_file_idx on public.fc_members(avatar_file_id) where avatar_file_id is not null;
alter table public.fc_members drop constraint if exists fc_members_role_check;
alter table public.fc_members add constraint fc_members_role_check check (role in ('member','helper','moderator'));
alter table public.fc_members drop constraint if exists fc_members_presentation_check;
alter table public.fc_members add constraint fc_members_presentation_check check (
  alias !~ '[<>]' and char_length(tagline) <= 160 and tagline !~ '[[:cntrl:]<>]'
  and font in ('sans','serif','mono') and color in ('default','rose','violet','teal')
);
alter table public.fc_topics add column if not exists style jsonb not null default '{"font":"sans","color":"default"}';
alter table public.fc_replies add column if not exists style jsonb not null default '{"font":"sans","color":"default"}';
alter table public.fc_topics drop constraint if exists fc_topics_style_check;
alter table public.fc_topics add constraint fc_topics_style_check check (
  jsonb_typeof(style) = 'object' and style ?& array['font','color'] and (style - 'font' - 'color') = '{}'
  and style->>'font' in ('sans','serif','mono') and style->>'color' in ('default','rose','violet','teal')
);
alter table public.fc_replies drop constraint if exists fc_replies_style_check;
alter table public.fc_replies add constraint fc_replies_style_check check (
  jsonb_typeof(style) = 'object' and style ?& array['font','color'] and (style - 'font' - 'color') = '{}'
  and style->>'font' in ('sans','serif','mono') and style->>'color' in ('default','rose','violet','teal')
);

-- Bucket-level byte/MIME caps also apply before finish/link validation.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
 ('fc-avatars','fc-avatars',false,950000,array['image/jpeg','image/png','image/webp']),
 ('fc-attachments','fc-attachments',false,950000,array['image/jpeg','image/png','image/webp','image/gif','audio/mpeg','audio/mp4','audio/ogg','audio/webm','audio/wav','video/mp4','video/webm','application/pdf','text/plain']),
 ('fc-founder-files','fc-founder-files',false,50000000,array['image/jpeg','image/png','image/webp','image/gif','audio/mpeg','audio/mp4','audio/ogg','audio/webm','audio/wav','video/mp4','video/webm','application/pdf','text/plain'])
on conflict (id) do update set public = false,file_size_limit = excluded.file_size_limit,allowed_mime_types = excluded.allowed_mime_types;

create or replace function fc_private.file_guard(p_bucket text,p_path text,p_operation text,p_metadata jsonb default null,p_owner text default null)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare f public.fc_files%rowtype; v_actor uuid := auth.uid(); v_mod boolean;
begin
  if v_actor is null then return false; end if;
  select * into f from public.fc_files where bucket_id = p_bucket and object_path = p_path;
  if not found then return false; end if;
  if p_operation = 'delete' then
    return f.owner_id = v_actor and (f.status = 'removed' or (f.status in ('reserved','ready') and f.expires_at <= now()));
  end if;
  if not fc_private.access(false) then return false; end if;
  if p_operation = 'upload' then
    return f.owner_id = v_actor and f.status = 'reserved' and f.expires_at > now() and p_owner = v_actor::text
      and (f.bucket_id <> 'fc-founder-files' or exists (select 1 from fc_private.founders where user_id = v_actor))
      and p_metadata->>'mimetype' = f.mime_type
      and coalesce(p_metadata->>'size',p_metadata->>'contentLength','') ~ '^[0-9]+$'
      and coalesce(p_metadata->>'size',p_metadata->>'contentLength')::numeric = f.byte_size;
  end if;
  if p_operation <> 'read' or f.status = 'removed' then return false; end if;
  if f.status in ('reserved','ready') then return f.owner_id = v_actor and f.expires_at > now(); end if;
  v_mod := fc_private.access(true);
  if f.purpose = 'avatar' then
    return exists (select 1 from public.fc_members m where m.user_id = f.owner_id and m.status = 'active' and m.avatar_file_id = f.id);
  elsif f.topic_id is not null then
    return exists (select 1 from public.fc_topics t where t.id = f.topic_id and t.withdrawn_at is null and (not t.hidden or v_mod));
  elsif f.reply_id is not null then
    return exists (select 1 from public.fc_replies r join public.fc_topics t on t.id = r.topic_id
      where r.id = f.reply_id and r.withdrawn_at is null and t.withdrawn_at is null and (not r.hidden or v_mod) and (not t.hidden or v_mod));
  end if;
  return false;
end; $$;
revoke all on function fc_private.file_guard(text,text,text,jsonb,text) from public,anon,authenticated;
grant execute on function fc_private.file_guard(text,text,text,jsonb,text) to authenticated,anon;
-- anon only executes the guard to evaluate restrictive shared-table policies;
-- its first auth.uid() check always rejects unauthenticated access.
grant usage on schema fc_private to anon;

drop policy if exists fc_files_read on public.fc_files;
create policy fc_files_read on public.fc_files for select to authenticated using (
  fc_private.file_guard(bucket_id,object_path,'read') or (owner_id = (select auth.uid()) and status = 'removed')
);

-- Restrictive guards prevent unrelated permissive policies from exposing OUR
-- three buckets. Existing policies/buckets are preserved. UPDATE/upsert is denied.
drop policy if exists fc_media_insert_guard on storage.objects;
create policy fc_media_insert_guard on storage.objects as restrictive for insert to anon,authenticated with check (
 bucket_id not in ('fc-attachments','fc-founder-files','fc-avatars') or fc_private.file_guard(bucket_id,name,'upload',metadata,owner_id)
);
drop policy if exists fc_media_insert on storage.objects;
create policy fc_media_insert on storage.objects for insert to authenticated with check (
 bucket_id in ('fc-attachments','fc-founder-files','fc-avatars') and fc_private.file_guard(bucket_id,name,'upload',metadata,owner_id)
);
drop policy if exists fc_media_read_guard on storage.objects;
create policy fc_media_read_guard on storage.objects as restrictive for select to anon,authenticated using (
 bucket_id not in ('fc-attachments','fc-founder-files','fc-avatars')
 or (storage.allow_any_operation(array['object.get_authenticated','object.get_authenticated_info','object.head_authenticated_info','object.info_authenticated']) and fc_private.file_guard(bucket_id,name,'read'))
 or (storage.allow_any_operation(array['object.delete','object.delete_many']) and fc_private.file_guard(bucket_id,name,'delete'))
);
drop policy if exists fc_media_read on storage.objects;
create policy fc_media_read on storage.objects for select to authenticated using (
 bucket_id in ('fc-attachments','fc-founder-files','fc-avatars') and (
 (storage.allow_any_operation(array['object.get_authenticated','object.get_authenticated_info','object.head_authenticated_info','object.info_authenticated']) and fc_private.file_guard(bucket_id,name,'read'))
 or (storage.allow_any_operation(array['object.delete','object.delete_many']) and fc_private.file_guard(bucket_id,name,'delete')))
);
drop policy if exists fc_media_delete_guard on storage.objects;
create policy fc_media_delete_guard on storage.objects as restrictive for delete to anon,authenticated using (
 bucket_id not in ('fc-attachments','fc-founder-files','fc-avatars') or fc_private.file_guard(bucket_id,name,'delete')
);
drop policy if exists fc_media_delete on storage.objects;
create policy fc_media_delete on storage.objects for delete to authenticated using (
 bucket_id in ('fc-attachments','fc-founder-files','fc-avatars') and fc_private.file_guard(bucket_id,name,'delete')
);
drop policy if exists fc_media_update_guard on storage.objects;
create policy fc_media_update_guard on storage.objects as restrictive for update to anon,authenticated
 using (bucket_id not in ('fc-attachments','fc-founder-files','fc-avatars'))
 with check (bucket_id not in ('fc-attachments','fc-founder-files','fc-avatars'));

create or replace function fc_private.profile_cards(p_ids uuid[])
returns jsonb language sql stable security definer set search_path = '' as $$
 select case when auth.uid() is not null and fc_private.access(false) then coalesce((
  select jsonb_agg(jsonb_build_object(
    'user_id',m.user_id,'alias',m.alias,'role',m.role,'created_at',m.created_at,'tagline',m.tagline,
    'font',m.font,'color',m.color,'avatar_file_id',m.avatar_file_id,
    'avatar',case when f.status = 'linked' then jsonb_build_object('id',f.id,'bucket_id',f.bucket_id,'object_path',f.object_path) else null end,
    'topic_count',s.topics,'reply_count',s.replies,'contribution_count',s.topics+s.replies,'active_days',s.days,
    'days_member',tenure.days,'level',progress.level,
    'stage_id',(array['bienvenida','vecina','habitual','referente','veterana'])[progress.level]
  ) || case when m.user_id = auth.uid() then jsonb_build_object('is_founder',exists(select 1 from fc_private.founders z where z.user_id=m.user_id),
    'upload_limit',case when exists(select 1 from fc_private.founders z where z.user_id=m.user_id) then 50000000 else 950000 end) else '{}'::jsonb end order by m.user_id)
  from public.fc_members m left join public.fc_files f on f.id=m.avatar_file_id and f.owner_id=m.user_id
  cross join lateral (
    select count(*) filter(where kind='topic') as topics,count(*) filter(where kind='reply') as replies,
      count(distinct (created_at at time zone 'UTC')::date) as days from (
       select 'topic' as kind,t.created_at from public.fc_topics t where t.author_id=m.user_id and not t.hidden and t.withdrawn_at is null
       union all select 'reply',r.created_at from public.fc_replies r join public.fc_topics t on t.id=r.topic_id
         where r.author_id=m.user_id and not r.hidden and r.withdrawn_at is null and not t.hidden and t.withdrawn_at is null
    ) posts
  ) s
  cross join lateral (select greatest(0,floor(extract(epoch from (now()-m.created_at))/86400)::integer) as days) tenure
  cross join lateral (select case
    when tenure.days >= 180 and s.topics+s.replies >= 100 and s.days >= 30 then 5
    when tenure.days >= 90 and s.topics+s.replies >= 50 and s.days >= 15 then 4
    when tenure.days >= 30 and s.topics+s.replies >= 15 and s.days >= 5 then 3
    when tenure.days >= 7 and s.topics+s.replies >= 3 then 2
    else 1 end as level) progress
  where m.status='active' and m.user_id = any(p_ids) and cardinality(p_ids) <= 100
 ),'[]'::jsonb) else '[]'::jsonb end;
$$;
revoke all on function fc_private.profile_cards(uuid[]) from public,anon,authenticated;
grant execute on function fc_private.profile_cards(uuid[]) to authenticated;

create or replace function fc_private.community(p_action text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
 v_actor uuid := auth.uid(); m public.fc_members%rowtype; f public.fc_files%rowtype;
 v_founder boolean; v_limit bigint; v_daily bigint; v_live bigint; v_daily_used bigint; v_global bigint;
 v_daily_count integer; v_pending integer; v_id uuid; v_old_avatar uuid; v_target uuid; v_ids uuid[];
 v_purpose text; v_name text; v_mime text; v_size bigint; v_bucket text; v_kind text; v_role text;
 v_style jsonb; v_post jsonb; v_meta jsonb; v_obj_owner text; v_font text; v_color text; v_tagline text;
begin
 if v_actor is null then raise exception using errcode='42501',message='fc_auth_required'; end if;
 select * into m from public.fc_members where user_id=v_actor for update;
 if not found then raise exception using errcode='42501',message='fc_active_member_required'; end if;
 if p_action not in ('remove','cleanup','my_files') and m.status <> 'active' then
   raise exception using errcode='42501',message='fc_active_member_required'; end if;
 v_founder := exists(select 1 from fc_private.founders where user_id=v_actor);
 v_limit := case when v_founder then 50000000 else 950000 end;
 v_daily := case when v_founder then 200000000 else 19000000 end;

 -- Publishing and editing share one closed presentation vocabulary. Body text
 -- stays plain text; only font/color are style metadata, never HTML or CSS.
 if p_action in ('publish','update_post') then
  v_style:=coalesce(p_data->'style','{}'::jsonb);
  if jsonb_typeof(v_style)<>'object' or (v_style-'font'-'color')<>'{}'::jsonb then raise exception using errcode='22023',message='fc_invalid_style'; end if;
  v_font:=coalesce(v_style->>'font','sans'); v_color:=coalesce(v_style->>'color','default');
  if v_font not in ('sans','serif','mono') or v_color not in ('default','rose','violet','teal') then raise exception using errcode='22023',message='fc_invalid_style'; end if;
  v_style:=jsonb_build_object('font',v_font,'color',v_color);
 end if;

 if p_action in ('reserve','policy') then
  if p_action='reserve' then perform 1 from fc_private.storage_budget where id=1 for update; end if;
  select coalesce(sum(byte_size) filter(where created_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'),0),
    count(*) filter(where created_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'),
    count(*) filter(where status in ('reserved','ready') and expires_at>now())
    into v_daily_used,v_daily_count,v_pending from public.fc_files where owner_id=v_actor;
  -- A reservation occupies capacity for its full 24h even after cancellation:
  -- an in-flight upload cannot race remove/reserve to evade the global budget.
  -- Afterwards linked files and physical remnants remain charged until removed.
  select coalesce(sum(byte_size),0),coalesce(sum(byte_size) filter(where owner_id=v_actor),0) into v_global,v_live
    from public.fc_files q where q.status='linked' or q.expires_at>now()
      or exists(select 1 from storage.objects o where o.bucket_id=q.bucket_id and o.name=q.object_path);
  -- Optional shared V2 budget: real objects across buckets plus outstanding
  -- reservations. Standalone forum installations retain the original fallback.
  if to_regprocedure('fc_private.storage_reserved_bytes()') is not null then
    v_global:=fc_private.storage_reserved_bytes();
  end if;
  if p_action='policy' then return jsonb_build_object('attachment_limit',v_limit,'avatar_limit',950000,'founder',v_founder,
   'daily_limit',v_daily,'remaining_bytes',greatest(0,v_daily-v_daily_used),'remaining_files',greatest(0,20-v_daily_count),'pending',v_pending,
   'storage_limit',case when v_founder then 200000000 else 50000000 end,'storage_used',v_live); end if;
  v_purpose:=p_data->>'purpose'; v_name:=btrim(p_data->>'name'); v_mime:=lower(p_data->>'mime'); v_size:=(p_data->>'size')::bigint;
  if v_purpose is null or v_purpose not in ('attachment','avatar') or v_name is null or char_length(v_name) not between 1 and 100
    or v_name ~ '[[:cntrl:]<>/\\]' or v_mime is null or v_size is null or v_size<1
    or v_size > (case when v_purpose='avatar' then 950000 else v_limit end)
    or (v_purpose='avatar' and v_mime not in ('image/jpeg','image/png','image/webp'))
    or v_mime not in ('image/jpeg','image/png','image/webp','image/gif','audio/mpeg','audio/mp4','audio/ogg','audio/webm','audio/wav','video/mp4','video/webm','application/pdf','text/plain')
    then raise exception using errcode='22023',message='fc_invalid_file'; end if;
  if v_daily_count >=20 or v_pending>=6 or v_daily_used+v_size>v_daily
    or v_live+v_size>(case when v_founder then 200000000 else 50000000 end) or v_global+v_size>900000000
    then raise exception using errcode='54000',message='fc_file_quota'; end if;
  v_id:=gen_random_uuid(); v_bucket:=case when v_purpose='avatar' then 'fc-avatars' when v_founder then 'fc-founder-files' else 'fc-attachments' end;
  insert into public.fc_files(id,owner_id,purpose,bucket_id,object_path,file_name,mime_type,byte_size)
    values(v_id,v_actor,v_purpose,v_bucket,v_actor::text||'/'||v_id::text,v_name,v_mime,v_size) returning * into f;
  return to_jsonb(f);

 elsif p_action='finish' then
  select * into f from public.fc_files where id=(p_data->>'id')::uuid and owner_id=v_actor for update;
  if not found or f.status not in ('reserved','ready') or f.expires_at<=now() then
    raise exception using errcode='42501',message='fc_file_unavailable'; end if;
  select metadata,owner_id into v_meta,v_obj_owner from storage.objects where bucket_id=f.bucket_id and name=f.object_path;
  if not found or v_obj_owner is distinct from v_actor::text or v_meta->>'mimetype' is distinct from f.mime_type
    or coalesce(v_meta->>'size','') !~ '^[0-9]+$' then
    raise exception using errcode='22023',message='fc_file_metadata_mismatch'; end if;
  if (v_meta->>'size')::numeric <> f.byte_size then raise exception using errcode='22023',message='fc_file_metadata_mismatch'; end if;
  update public.fc_files set status='ready' where id=f.id returning * into f;
  return to_jsonb(f);

 elsif p_action='publish' then
  v_kind:=p_data->>'kind';
  if jsonb_typeof(p_data->'files') is distinct from 'array' then raise exception using errcode='22023',message='fc_invalid_files'; end if;
  v_ids:=array(select value::uuid from jsonb_array_elements_text(p_data->'files'));
  if cardinality(v_ids)>3 or cardinality(v_ids)<>(select count(distinct x) from unnest(v_ids) x) then
    raise exception using errcode='22023',message='fc_invalid_files'; end if;
  perform 1 from public.fc_files where id=any(v_ids) order by id for update;
  if cardinality(v_ids)<>(select count(*) from public.fc_files q where q.id=any(v_ids) and q.owner_id=v_actor and q.purpose='attachment'
    and q.status='ready' and q.expires_at>now() and q.topic_id is null and q.reply_id is null
    and exists(select 1 from storage.objects o where o.bucket_id=q.bucket_id and o.name=q.object_path and o.owner_id=v_actor::text
      and o.metadata->>'size'=q.byte_size::text and o.metadata->>'mimetype'=q.mime_type)) then
    raise exception using errcode='42501',message='fc_file_unavailable'; end if;
  if v_kind='topic' then
    v_post:=fc_private.mutate('create_topic',jsonb_build_object('category',p_data->>'category','title',p_data->>'title','body',p_data->>'body'));
    v_id:=(v_post->>'id')::uuid; update public.fc_topics set style=v_style where id=v_id;
    update public.fc_files set status='linked',topic_id=v_id where id=any(v_ids);
  elsif v_kind='reply' then
    v_post:=fc_private.mutate('reply',jsonb_build_object('topic_id',p_data->>'topic_id','body',p_data->>'body'));
    v_id:=(v_post->>'id')::uuid; update public.fc_replies set style=v_style where id=v_id;
    update public.fc_files set status='linked',reply_id=v_id where id=any(v_ids);
  else raise exception using errcode='22023',message='fc_invalid_kind'; end if;
  return v_post||jsonb_build_object('style',v_style,'files',coalesce((select jsonb_agg(to_jsonb(q)) from public.fc_files q where q.id=any(v_ids)),'[]'::jsonb));

 elsif p_action='update_post' then
  v_kind:=p_data->>'kind'; v_id:=(p_data->>'id')::uuid;
  -- Reuse the established ownership/visibility/closed-thread checks. A later
  -- error rolls back both body and style, so no partial edit can be persisted.
  perform fc_private.mutate('edit',jsonb_build_object('kind',v_kind,'id',v_id,'body',p_data->>'body'));
  if v_kind='topic' then
    update public.fc_topics q set style=v_style where id=v_id returning to_jsonb(q) into v_post;
  else
    update public.fc_replies q set style=v_style where id=v_id returning to_jsonb(q) into v_post;
  end if;
  return v_post||jsonb_build_object('files',coalesce((select jsonb_agg(to_jsonb(q)) from public.fc_files q where q.status='linked'
    and ((v_kind='topic' and q.topic_id=v_id) or (v_kind='reply' and q.reply_id=v_id))),'[]'::jsonb));

 elsif p_action='profile' then
  v_font:=p_data->>'font'; v_color:=p_data->>'color'; v_tagline:=coalesce(btrim(p_data->>'tagline'),'');
  if v_font is null or v_font not in ('sans','serif','mono') or v_color is null or v_color not in ('default','rose','violet','teal')
    or char_length(v_tagline)>160 or v_tagline ~ '[[:cntrl:]<>]' or (p_data->>'alias') ~ '[<>]' then
    raise exception using errcode='22023',message='fc_invalid_profile'; end if;
  v_id:=(p_data->>'avatar')::uuid; v_old_avatar:=m.avatar_file_id;
  if v_id is not null then
    select * into f from public.fc_files where id=v_id and owner_id=v_actor and purpose='avatar' for update;
    if not found or (f.status='linked' and m.avatar_file_id is distinct from f.id) or f.status not in ('ready','linked')
      or (f.status='ready' and f.expires_at<=now()) then raise exception using errcode='42501',message='fc_file_unavailable'; end if;
    update public.fc_files set status='linked' where id=v_id;
  end if;
  perform fc_private.mutate('profile',jsonb_build_object('alias',p_data->>'alias'));
  update public.fc_members set tagline=v_tagline,font=v_font,color=v_color,avatar_file_id=v_id where user_id=v_actor;
  if v_old_avatar is not null and v_old_avatar is distinct from v_id then update public.fc_files set status='removed',removed_at=now() where id=v_old_avatar; end if;
  return fc_private.profile_cards(array[v_actor])->0;

 elsif p_action='remove' then
  select * into f from public.fc_files where id=(p_data->>'id')::uuid and owner_id=v_actor for update;
  if not found then raise exception using errcode='42501',message='fc_file_unavailable'; end if;
  update public.fc_members set avatar_file_id=null where user_id=v_actor and avatar_file_id=f.id;
  update public.fc_files set status='removed',removed_at=coalesce(removed_at,now()) where id=f.id;
  return jsonb_build_object('ok',true,'id',f.id,'bucket_id',f.bucket_id,'object_path',f.object_path);

 elsif p_action in ('my_files','cleanup') then
  if p_action='cleanup' then
    update public.fc_files q set status='removed',removed_at=coalesce(removed_at,now()) where owner_id=v_actor and status<>'removed' and (
      (status in ('reserved','ready') and expires_at<=now())
      or (purpose='avatar' and status='linked' and not exists(select 1 from public.fc_members a where a.avatar_file_id=q.id))
      or (topic_id is not null and exists(select 1 from public.fc_topics a where a.id=q.topic_id and a.withdrawn_at is not null))
      or (reply_id is not null and exists(select 1 from public.fc_replies a join public.fc_topics t on t.id=a.topic_id where a.id=q.reply_id and (a.withdrawn_at is not null or t.withdrawn_at is not null)))
    );
  end if;
  -- Keep ledger rows for quotas. A removed row is a cleanup candidate only
  -- while Storage still contains its object; successfully deleted files must
  -- disappear from the user's pending list without refunding the reservation.
  return coalesce((select jsonb_agg(to_jsonb(q) order by created_at desc) from public.fc_files q where owner_id=v_actor
    and ((q.status='removed' and exists(select 1 from storage.objects o where o.bucket_id=q.bucket_id and o.name=q.object_path))
      or (p_action='my_files' and q.status in ('reserved','ready') and (q.expires_at>now()
        or exists(select 1 from storage.objects o where o.bucket_id=q.bucket_id and o.name=q.object_path))))),'[]'::jsonb);

 elsif p_action='assign_role' then
  if not v_founder then raise exception using errcode='42501',message='fc_founder_required'; end if;
  v_target:=(p_data->>'user_id')::uuid; v_role:=p_data->>'role';
  if v_role is null or v_role not in ('member','helper','moderator') or v_target is null or v_target=v_actor
    or exists(select 1 from fc_private.founders where user_id=v_target) then raise exception using errcode='22023',message='fc_invalid_role_assignment'; end if;
  update public.fc_members set role=v_role where user_id=v_target and status='active' returning * into m;
  if not found then raise exception using errcode='22023',message='fc_member_not_active'; end if;
  return to_jsonb(m);
 end if;
 raise exception using errcode='22023',message='fc_unknown_action';
end; $$;
revoke all on function fc_private.community(text,jsonb) from public,anon,authenticated;
grant execute on function fc_private.community(text,jsonb) to authenticated;

create or replace function public.fc_reserve_file(p_purpose text,p_name text,p_mime text,p_size bigint) returns jsonb
 language sql security invoker set search_path='' as $$ select fc_private.community('reserve',jsonb_build_object('purpose',p_purpose,'name',p_name,'mime',p_mime,'size',p_size)); $$;
create or replace function public.fc_finish_file(p_id uuid) returns jsonb
 language sql security invoker set search_path='' as $$ select fc_private.community('finish',jsonb_build_object('id',p_id)); $$;
create or replace function public.fc_remove_file(p_id uuid) returns jsonb
 language sql security invoker set search_path='' as $$ select fc_private.community('remove',jsonb_build_object('id',p_id)); $$;
create or replace function public.fc_my_files() returns jsonb
 language sql security invoker set search_path='' as $$ select fc_private.community('my_files','{}'); $$;
create or replace function public.fc_file_cleanup() returns jsonb
 language sql security invoker set search_path='' as $$ select fc_private.community('cleanup','{}'); $$;
create or replace function public.fc_upload_policy() returns jsonb
 language sql security invoker set search_path='' as $$ select fc_private.community('policy','{}'); $$;
create or replace function public.fc_publish(p_kind text,p_topic_id uuid,p_category text,p_title text,p_body text,p_style jsonb,p_files uuid[]) returns jsonb
 language sql security invoker set search_path='' as $$ select fc_private.community('publish',jsonb_build_object('kind',p_kind,'topic_id',p_topic_id,'category',p_category,'title',p_title,'body',p_body,'style',coalesce(p_style,'{}'),'files',to_jsonb(coalesce(p_files,'{}'::uuid[])))); $$;
create or replace function public.fc_update_post(p_kind text,p_id uuid,p_body text,p_style jsonb) returns jsonb
 language sql security invoker set search_path='' as $$ select fc_private.community('update_post',jsonb_build_object('kind',p_kind,'id',p_id,'body',p_body,'style',coalesce(p_style,'{}'))); $$;
create or replace function public.fc_profile_details(p_alias text,p_tagline text,p_avatar uuid,p_font text,p_color text) returns jsonb
 language sql security invoker set search_path='' as $$ select fc_private.community('profile',jsonb_build_object('alias',p_alias,'tagline',p_tagline,'avatar',p_avatar,'font',p_font,'color',p_color)); $$;
create or replace function public.fc_profile_cards(p_ids uuid[]) returns jsonb
 language sql security invoker set search_path='' as $$ select fc_private.profile_cards(p_ids); $$;
create or replace function public.fc_assign_role(p_user_id uuid,p_role text) returns jsonb
 language sql security invoker set search_path='' as $$ select fc_private.community('assign_role',jsonb_build_object('user_id',p_user_id,'role',p_role)); $$;
revoke all on function public.fc_reserve_file(text,text,text,bigint),public.fc_finish_file(uuid),public.fc_remove_file(uuid),public.fc_my_files(),public.fc_file_cleanup(),public.fc_upload_policy(),public.fc_publish(text,uuid,text,text,text,jsonb,uuid[]),public.fc_update_post(text,uuid,text,jsonb),public.fc_profile_details(text,text,uuid,text,text),public.fc_profile_cards(uuid[]),public.fc_assign_role(uuid,text) from public,anon,authenticated;
grant execute on function public.fc_reserve_file(text,text,text,bigint),public.fc_finish_file(uuid),public.fc_remove_file(uuid),public.fc_my_files(),public.fc_file_cleanup(),public.fc_upload_policy(),public.fc_publish(text,uuid,text,text,text,jsonb,uuid[]),public.fc_update_post(text,uuid,text,jsonb),public.fc_profile_details(text,text,uuid,text,text),public.fc_profile_cards(uuid[]),public.fc_assign_role(uuid,text) to authenticated;
commit;
