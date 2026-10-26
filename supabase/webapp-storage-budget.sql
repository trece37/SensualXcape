-- Shared physical+reserved capacity for V2 and the forum. Apply after the
-- profile SQL. No data, policies, privileges or roles are changed by this file.
-- Reserve callers already hold the same fc_private.storage_budget(id=1) mutex.
-- READ COMMITTED is required. One post-wait statement snapshots both physical
-- objects and reservations together, including uploads completing concurrently.
begin;
create or replace function fc_private.storage_reserved_bytes()
returns bigint language plpgsql volatile security definer set search_path='' as $$
declare v_total bigint;
begin
 if current_setting('transaction_isolation')<>'read committed' then
  raise exception using errcode='25000',message='sx_storage_budget_requires_read_committed';
 end if;
 select coalesce(sum(allocated.bytes),0)into v_total from (
  select case when coalesce(metadata->>'size',metadata->>'contentLength','')~'^[0-9]+$'
   then coalesce(metadata->>'size',metadata->>'contentLength')::bigint else 0 end as bytes from storage.objects
  union all select f.byte_size from public.fc_files f where f.expires_at>now()
   and not exists(select 1 from storage.objects o where o.bucket_id=f.bucket_id and o.name=f.object_path)
  union all select f.byte_size from sx_private.profile_files f where f.expires_at>now()
   and not exists(select 1 from storage.objects o where o.bucket_id=f.bucket_id and o.name=f.object_path)
 )allocated;
 return v_total;
end;$$;
revoke all on function fc_private.storage_reserved_bytes()from public,anon,authenticated,service_role;

-- Exact function definition from forocromos-community.sql; existing grants
-- and OID remain intact. Only its optional global-budget source is added.
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

-- Exact profile command definition from webapp-profile.sql; existing grants stay.
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
commit;
