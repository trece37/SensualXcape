-- Read-only community activity + private, exact rendered-post read receipts.
-- Apply after forocromos-live.sql. No content/history/auth state is rewritten.
-- General activity excludes hidden/withdrawn content even for moderators.
-- Suspended authors' existing visible contributions remain, as in the current
-- forum: generic alias, no profile; recent contributors include active users only.
begin;

create table if not exists fc_private.topic_reads (
 user_id uuid not null references public.fc_members(user_id) on delete cascade,
 topic_id uuid not null references public.fc_topics(id) on delete cascade,
 topic_seen_at timestamptz,last_read_at timestamptz not null default clock_timestamp(),
 primary key(user_id,topic_id)
);
create index if not exists fc_topic_reads_topic_idx on fc_private.topic_reads(topic_id);
create table if not exists fc_private.reply_reads (
 user_id uuid not null references public.fc_members(user_id) on delete cascade,
 topic_id uuid not null references public.fc_topics(id) on delete cascade,
 reply_id uuid not null references public.fc_replies(id) on delete cascade,
 read_at timestamptz not null default clock_timestamp(),
 primary key(user_id,reply_id)
);
create index if not exists fc_reply_reads_user_topic_idx on fc_private.reply_reads(user_id,topic_id);
create index if not exists fc_reply_reads_topic_idx on fc_private.reply_reads(topic_id);
create index if not exists fc_reply_reads_reply_idx on fc_private.reply_reads(reply_id);
alter table fc_private.topic_reads enable row level security;
alter table fc_private.reply_reads enable row level security;
revoke all on fc_private.topic_reads,fc_private.reply_reads from public,anon,authenticated,service_role;
create index if not exists fc_activity_topics_feed_idx on public.fc_topics(created_at desc,id desc) where not hidden and withdrawn_at is null;
create index if not exists fc_activity_replies_feed_idx on public.fc_replies(created_at desc,id desc) where not hidden and withdrawn_at is null;

create or replace view fc_private.activity_posts with(security_invoker=true) as
 select '1:'||t.id::text as event_id,t.id,'topic'::text as kind,t.id as topic_id,null::uuid as reply_id,
  t.title as topic_title,t.author_id,
  case when t.author_id is null then 'Equipo Foro Cromos' else coalesce(m.alias,'Compañera')end as alias,
  t.created_at,t.body
 from public.fc_topics t left join public.fc_members m on m.user_id=t.author_id and m.status='active'
 where not t.hidden and t.withdrawn_at is null
 union all
 select '2:'||r.id::text,r.id,'reply'::text,r.topic_id,r.id,t.title,r.author_id,coalesce(m.alias,'Compañera'),r.created_at,r.body
 from public.fc_replies r join public.fc_topics t on t.id=r.topic_id
 left join public.fc_members m on m.user_id=r.author_id and m.status='active'
 where not r.hidden and r.withdrawn_at is null and not t.hidden and t.withdrawn_at is null;
revoke all on fc_private.activity_posts from public,anon,authenticated,service_role;

create or replace function fc_private.activity(p_action text,p_data jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
 v_actor uuid:=auth.uid();v_status text;v_snapshot timestamptz;v_limit integer;v_offset integer;
 v_category text;v_search text;v_order text;v_saved boolean;v_unread_only boolean;
 v_before timestamptz;v_before_id text;v_before_uid uuid;v_items jsonb;v_more boolean;
 v_topic uuid;v_reply uuid;v_ids uuid[];v_seen boolean;v_updated integer;v_result jsonb;
begin
 if v_actor is null then raise exception using errcode='42501',message='fc_active_member_required';end if;
 -- A membership decision cannot commit halfway through a successful response.
 -- SHARE remains compatible with a reply notification's recipient FK lock.
 -- Never take UPDATE here: publisher(topic)->recipient and reader(member)->topic
 -- would otherwise invert locks. Own receipt UPSERTs serialize concurrent ACKs.
 select status into v_status from public.fc_members where user_id=v_actor for share;
 if not found or v_status<>'active' then raise exception using errcode='42501',message='fc_active_member_required';end if;
 v_snapshot:=clock_timestamp();

 if p_action='topics' then
  v_limit:=(p_data->>'limit')::integer;v_offset:=(p_data->>'offset')::integer;
  v_category:=nullif(p_data->>'category','');if v_category='all'then v_category:=null;end if;
  v_search:=coalesce(btrim(p_data->>'search'),'');v_order:=coalesce(p_data->>'order','activity');
  v_saved:=coalesce((p_data->>'saved_only')::boolean,false);v_unread_only:=coalesce((p_data->>'unread_only')::boolean,false);
  if v_limit is null or v_limit not between 1 and 50 or v_offset is null or v_offset not between 0 and 10000
   or char_length(v_search)>160 or v_order not in('activity','newest','pinned')
   or(v_category is not null and v_category not in('cuidado','zaragoza','rutas','oficio','bienestar','aplicacion'))then
   raise exception using errcode='22023',message='fc_invalid_activity_page';end if;
  with base as(
   select t.*,coalesce(replies.total,0)as reply_count,coalesce(replies.total,0)as replies_count,
    latest.created_at as last_activity_at,latest.author_id as last_author_id,latest.reply_id as last_reply_id,
    latest.alias as last_author_alias,
    (t.author_id is distinct from v_actor and read.topic_seen_at is null)as topic_unread,
    coalesce(replies.unread,0)as unread_replies,replies.first_unread as first_unread_reply_id
   from public.fc_topics t
   left join fc_private.topic_reads read on read.user_id=v_actor and read.topic_id=t.id
   cross join lateral(select a.created_at,a.author_id,a.reply_id,a.alias from fc_private.activity_posts a where a.topic_id=t.id order by a.created_at desc,a.event_id desc limit 1)latest
   left join lateral(
    select count(*)as total,count(*)filter(where r.author_id<>v_actor and seen.reply_id is null)as unread,
     (array_agg(r.id order by r.created_at,r.id)filter(where r.author_id<>v_actor and seen.reply_id is null))[1]as first_unread
    from public.fc_replies r left join fc_private.reply_reads seen on seen.user_id=v_actor and seen.reply_id=r.id
    where r.topic_id=t.id and not r.hidden and r.withdrawn_at is null
   )replies on true
   where not t.hidden and t.withdrawn_at is null
    and(v_category is null or t.category=v_category)
    and(v_search=''or strpos(lower(t.title||E'\n'||t.body),lower(v_search))>0)
    and(not v_saved or exists(select 1 from public.fc_saved s where s.user_id=v_actor and s.topic_id=t.id))
  ),filtered as(
   select b.*,b.unread_replies as unread_count from base b
    where not v_unread_only or b.topic_unread or b.unread_replies>0
  ),page as(
   select f.* from filtered f order by case when v_order='pinned'then f.pinned::integer else 0 end desc,
    case when v_order='newest'then f.created_at else f.last_activity_at end desc,f.id desc limit v_limit offset v_offset
  )select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(p)-'unread_replies'order by case when v_order='pinned'then p.pinned::integer else 0 end desc,
    case when v_order='newest'then p.created_at else p.last_activity_at end desc,p.id desc)from page p),'[]'::jsonb),
   'total',(select count(*)from filtered),'has_more',v_offset+(select count(*)from page)<(select count(*)from filtered),
   'next_offset',case when v_offset+(select count(*)from page)<(select count(*)from filtered)then v_offset+v_limit else null end,
   'snapshot_at',v_snapshot)into v_result;
  return v_result;

 elsif p_action in('feed','contributors')then
  v_limit:=(p_data->>'limit')::integer;v_before:=(p_data->>'before')::timestamptz;v_before_id:=p_data->>'before_id';v_before_uid:=(p_data->>'before_uid')::uuid;
  if v_limit is null or v_limit not between 1 and 25 or(v_before is null and(v_before_id is not null or v_before_uid is not null))
   or(p_action='feed'and v_before_id is not null and v_before_id!~'^[12]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')then
   raise exception using errcode='22023',message='fc_invalid_activity_page';end if;
  if p_action='feed'then
   select coalesce(jsonb_agg(to_jsonb(page)order by created_at desc,event_id desc),'[]'::jsonb)into v_items from(
    select a.id,a.event_id,a.kind,a.topic_id,a.reply_id,a.topic_title,a.author_id,a.alias,a.created_at,
     left(regexp_replace(a.body,'[[:space:]]+',' ','g'),160)as excerpt,
     case when a.author_id=v_actor then false when a.kind='topic'then tr.topic_seen_at is null else rr.reply_id is null end as unread
    from fc_private.activity_posts a
    left join fc_private.topic_reads tr on tr.user_id=v_actor and tr.topic_id=a.topic_id
    left join fc_private.reply_reads rr on rr.user_id=v_actor and rr.reply_id=a.reply_id
    where v_before is null or a.created_at<v_before or(a.created_at=v_before and v_before_id is not null and a.event_id<v_before_id)
    order by a.created_at desc,a.event_id desc limit v_limit+1
   )page;
   v_more:=jsonb_array_length(v_items)>v_limit;if v_more then v_items:=v_items-v_limit;end if;
   return jsonb_build_object('items',v_items,'has_more',v_more,'snapshot_at',v_snapshot,
    'next_before',case when v_more then v_items->-1->>'created_at'else null end,'next_before_id',case when v_more then v_items->-1->>'event_id'else null end);
  end if;
  with recent as(
   select distinct on(a.author_id)a.author_id as user_id,a.alias,a.created_at as last_post_at,a.topic_id,a.reply_id
    from fc_private.activity_posts a join public.fc_members m on m.user_id=a.author_id and m.status='active'
    order by a.author_id,a.created_at desc,a.event_id desc
  )select coalesce(jsonb_agg(to_jsonb(page)order by last_post_at desc,user_id desc),'[]'::jsonb)into v_items from(
   select r.*from recent r where v_before is null or r.last_post_at<v_before or(r.last_post_at=v_before and v_before_uid is not null and r.user_id<v_before_uid)
    order by r.last_post_at desc,r.user_id desc limit v_limit+1
  )page;
  v_more:=jsonb_array_length(v_items)>v_limit;if v_more then v_items:=v_items-v_limit;end if;
  return jsonb_build_object('items',v_items,'has_more',v_more,'snapshot_at',v_snapshot,
   'next_before',case when v_more then v_items->-1->>'last_post_at'else null end,'next_before_uid',case when v_more then v_items->-1->>'user_id'else null end);

 elsif p_action in('mark','locate')then
  v_topic:=(p_data->>'topic_id')::uuid;
  if not exists(select 1 from public.fc_topics where id=v_topic and not hidden and withdrawn_at is null)then raise exception using errcode='42501',message='fc_content_unavailable';end if;
  if p_action='locate'then
   v_reply:=(p_data->>'reply_id')::uuid;
   with ordered as(select r.id,row_number()over(order by r.created_at,r.id)-1 as index from public.fc_replies r where r.topic_id=v_topic and not r.hidden and r.withdrawn_at is null)
    select jsonb_build_object('reply_page',floor(index/50.0)::integer,'index',index,'page_size',50)into v_result from ordered where id=v_reply;
   if v_result is null then raise exception using errcode='42501',message='fc_activity_post_unavailable';end if;
   return v_result;
  end if;
  if jsonb_typeof(p_data->'reply_ids')is distinct from'array'then raise exception using errcode='22023',message='fc_invalid_read_receipt';end if;
  v_ids:=array(select distinct value::uuid from jsonb_array_elements_text(p_data->'reply_ids'));
  if jsonb_array_length(p_data->'reply_ids')>100 or array_position(v_ids,null)is not null then raise exception using errcode='22023',message='fc_invalid_read_receipt';end if;
  if cardinality(v_ids)<>(select count(*)from public.fc_replies where id=any(v_ids)and topic_id=v_topic and not hidden and withdrawn_at is null)then
   raise exception using errcode='42501',message='fc_activity_post_unavailable';end if;
  v_seen:=coalesce((p_data->>'topic_seen')::boolean,false);
  insert into fc_private.topic_reads(user_id,topic_id,topic_seen_at,last_read_at)values(v_actor,v_topic,case when v_seen then v_snapshot else null end,v_snapshot)
   on conflict(user_id,topic_id)do update set topic_seen_at=coalesce(fc_private.topic_reads.topic_seen_at,excluded.topic_seen_at),last_read_at=greatest(fc_private.topic_reads.last_read_at,excluded.last_read_at);
  insert into fc_private.reply_reads(user_id,topic_id,reply_id,read_at)select v_actor,v_topic,x,v_snapshot from unnest(v_ids)x on conflict(user_id,reply_id)do nothing;
  get diagnostics v_updated=row_count;
  select jsonb_build_object('updated',v_updated,'topic_id',v_topic,'topic_unread',t.author_id is distinct from v_actor and tr.topic_seen_at is null,
   'unread_count',(select count(*)from public.fc_replies r where r.topic_id=v_topic and not r.hidden and r.withdrawn_at is null and r.author_id<>v_actor
     and not exists(select 1 from fc_private.reply_reads seen where seen.user_id=v_actor and seen.reply_id=r.id)),
   'last_read_at',tr.last_read_at,'snapshot_at',v_snapshot)into v_result
   from public.fc_topics t join fc_private.topic_reads tr on tr.topic_id=t.id and tr.user_id=v_actor where t.id=v_topic;
  return v_result;
 end if;
 raise exception using errcode='22023',message='fc_unknown_action';
end;$$;
revoke all on function fc_private.activity(text,jsonb)from public,anon,authenticated,service_role;
grant execute on function fc_private.activity(text,jsonb)to authenticated;

create or replace function public.fc_topics_page(p_category text default null,p_search text default null,p_saved_only boolean default false,p_unread_only boolean default false,p_order text default 'activity',p_limit integer default 20,p_offset integer default 0)
returns jsonb language sql security invoker set search_path=''as $$select fc_private.activity('topics',jsonb_build_object('category',p_category,'search',p_search,'saved_only',p_saved_only,'unread_only',p_unread_only,'order',p_order,'limit',p_limit,'offset',p_offset));$$;
create or replace function public.fc_activity_feed(p_limit integer default 6,p_before timestamptz default null,p_before_id text default null)
returns jsonb language sql security invoker set search_path=''as $$select fc_private.activity('feed',jsonb_build_object('limit',p_limit,'before',p_before,'before_id',p_before_id));$$;
create or replace function public.fc_recent_contributors(p_limit integer default 6,p_before timestamptz default null,p_before_uid uuid default null)
returns jsonb language sql security invoker set search_path=''as $$select fc_private.activity('contributors',jsonb_build_object('limit',p_limit,'before',p_before,'before_uid',p_before_uid));$$;
create or replace function public.fc_mark_topic_read(p_topic_id uuid,p_reply_ids uuid[]default'{}',p_topic_seen boolean default true)
returns jsonb language sql security invoker set search_path=''as $$select fc_private.activity('mark',jsonb_build_object('topic_id',p_topic_id,'reply_ids',to_jsonb(coalesce(p_reply_ids,'{}'::uuid[])),'topic_seen',p_topic_seen));$$;
create or replace function public.fc_locate_reply(p_topic_id uuid,p_reply_id uuid)
returns jsonb language sql security invoker set search_path=''as $$select fc_private.activity('locate',jsonb_build_object('topic_id',p_topic_id,'reply_id',p_reply_id));$$;
revoke all on function public.fc_topics_page(text,text,boolean,boolean,text,integer,integer),public.fc_activity_feed(integer,timestamptz,text),public.fc_recent_contributors(integer,timestamptz,uuid),public.fc_mark_topic_read(uuid,uuid[],boolean),public.fc_locate_reply(uuid,uuid)from public,anon,authenticated,service_role;
grant execute on function public.fc_topics_page(text,text,boolean,boolean,text,integer,integer),public.fc_activity_feed(integer,timestamptz,text),public.fc_recent_contributors(integer,timestamptz,uuid),public.fc_mark_topic_read(uuid,uuid[],boolean),public.fc_locate_reply(uuid,uuid)to authenticated;
commit;
