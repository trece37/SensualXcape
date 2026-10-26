-- Durable reply notifications. No provider, scheduler, secrets or real email
-- addresses are installed here. Apply after forocromos-live.sql.
-- Administrators provision explicit verified notification destinations in the
-- private settings table; login identities in auth.users are never modified.
begin;

create table if not exists fc_private.notification_config (
 id integer primary key check(id=1), delivery_configured boolean not null default false,
 base_url text not null default 'https://trece37.github.io/SensualXcape/foro/' check(base_url ~ '^https://[^[:space:]?#]+$')
);
insert into fc_private.notification_config(id) values(1) on conflict do nothing;
create table if not exists fc_private.notification_settings (
 user_id uuid primary key references public.fc_members(user_id) on delete cascade,
 email text check(email is null or (char_length(email)<=254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')),
 email_verified_at timestamptz,
 email_enabled boolean not null default false,
 updated_at timestamptz not null default clock_timestamp(),
 check(not email_enabled or (email is not null and email_verified_at is not null)),
 check(email_verified_at is null or email is not null)
);
create table if not exists fc_private.topic_follows (
 user_id uuid not null references public.fc_members(user_id) on delete cascade,
 topic_id uuid not null references public.fc_topics(id) on delete cascade,
 following boolean not null,
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 primary key(user_id,topic_id)
);
create index if not exists fc_topic_follow_recipients_idx on fc_private.topic_follows(topic_id,user_id) where following;

create table if not exists public.fc_inbox (
 id uuid primary key default gen_random_uuid(),
 recipient_id uuid not null references public.fc_members(user_id) on delete cascade,
 topic_id uuid not null references public.fc_topics(id) on delete cascade,
 reply_id uuid not null references public.fc_replies(id) on delete cascade,
 created_at timestamptz not null default clock_timestamp(),
 read_at timestamptz,
 unique(recipient_id,reply_id)
);
create index if not exists fc_inbox_page_idx on public.fc_inbox(recipient_id,created_at desc,id desc);
create index if not exists fc_inbox_unread_idx on public.fc_inbox(recipient_id) where read_at is null;
create index if not exists fc_inbox_topic_idx on public.fc_inbox(topic_id);
create index if not exists fc_inbox_reply_idx on public.fc_inbox(reply_id);
alter table public.fc_inbox enable row level security;
revoke all on public.fc_inbox from public,anon,authenticated;
grant select on public.fc_inbox to authenticated;

create table if not exists fc_private.notification_outbox (
 id uuid primary key default gen_random_uuid(),
 notification_id uuid not null unique references public.fc_inbox(id) on delete cascade,
 recipient_id uuid not null references public.fc_members(user_id) on delete cascade,
 topic_id uuid not null references public.fc_topics(id) on delete cascade,
 reply_id uuid not null references public.fc_replies(id) on delete cascade,
 state text not null default 'pending' check(state in ('pending','leased','sent','cancelled','failed')),
 attempts integer not null default 0 check(attempts between 0 and 8),
 delivery_email text,
 lease_token uuid, lease_until timestamptz,
 first_attempt_at timestamptz, last_attempt_at timestamptz,
 next_attempt_at timestamptz not null default clock_timestamp(),
 created_at timestamptz not null default clock_timestamp(), finished_at timestamptz,
 error_code text check(error_code is null or error_code ~ '^[a-z0-9_.-]{1,64}$'),
 provider_id text check(provider_id is null or (char_length(provider_id)<=200 and provider_id !~ '[[:cntrl:]]')),
 unique(recipient_id,reply_id)
);
create index if not exists fc_delivery_claim_idx on fc_private.notification_outbox(next_attempt_at,created_at,id) where state in ('pending','leased');
create index if not exists fc_delivery_recipient_idx on fc_private.notification_outbox(recipient_id);
create index if not exists fc_delivery_topic_idx on fc_private.notification_outbox(topic_id);
create index if not exists fc_delivery_reply_idx on fc_private.notification_outbox(reply_id);
alter table fc_private.notification_config enable row level security;
alter table fc_private.notification_settings enable row level security;
alter table fc_private.topic_follows enable row level security;
alter table fc_private.notification_outbox enable row level security;
revoke all on fc_private.notification_config,fc_private.notification_settings,fc_private.topic_follows,fc_private.notification_outbox from public,anon,authenticated,service_role;

-- Internal eligibility has no caller-supplied claims and grants no moderator
-- exception. Hidden/withdrawn replies or parents never produce/send alerts.
create or replace function fc_private.notification_eligible(p_recipient uuid,p_topic uuid,p_reply uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.fc_members m
  join fc_private.topic_follows f on f.user_id=m.user_id and f.topic_id=p_topic and f.following
  join public.fc_replies r on r.id=p_reply and r.topic_id=p_topic and r.author_id<>m.user_id
  join public.fc_members a on a.user_id=r.author_id and a.status='active'
  join public.fc_topics t on t.id=r.topic_id
  where m.user_id=p_recipient and m.status='active' and not r.hidden and r.withdrawn_at is null and not t.hidden and t.withdrawn_at is null);
$$;
revoke all on function fc_private.notification_eligible(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create or replace function fc_private.notification_visible(p_topic uuid,p_reply uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and fc_private.notification_eligible(auth.uid(),p_topic,p_reply);
$$;
revoke all on function fc_private.notification_visible(uuid,uuid) from public,anon,authenticated;
grant execute on function fc_private.notification_visible(uuid,uuid) to authenticated;
do $fc_policy$ begin
 if not exists(select 1 from pg_policies where schemaname='public' and tablename='fc_inbox' and policyname='fc_inbox_own') then
  execute $policy$create policy fc_inbox_own on public.fc_inbox for select to authenticated using (
   recipient_id=(select auth.uid()) and fc_private.notification_visible(topic_id,reply_id))$policy$;
 end if;
end $fc_policy$;

create or replace function fc_private.notification_on_post()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_recipient uuid; v_notification uuid;
begin
 if new.hidden or new.withdrawn_at is not null then return new; end if;
 if tg_table_name='fc_topics' then
  if new.author_id is not null and exists(select 1 from public.fc_members where user_id=new.author_id and status='active') then
   insert into fc_private.topic_follows(user_id,topic_id,following) values(new.author_id,new.id,true) on conflict do nothing;
  end if;
  return new;
 end if;
 if not exists(select 1 from public.fc_topics where id=new.topic_id and not hidden and withdrawn_at is null) then return new; end if;
 if exists(select 1 from public.fc_members where user_id=new.author_id and status='active') then
  insert into fc_private.topic_follows(user_id,topic_id,following) values(new.author_id,new.topic_id,true) on conflict do nothing;
 end if;
 for v_recipient in select f.user_id from fc_private.topic_follows f where f.topic_id=new.topic_id and f.following and f.user_id<>new.author_id loop
  if not fc_private.notification_eligible(v_recipient,new.topic_id,new.id) then continue; end if;
  v_notification:=null;
  insert into public.fc_inbox(recipient_id,topic_id,reply_id) values(v_recipient,new.topic_id,new.id)
   on conflict(recipient_id,reply_id) do nothing returning id into v_notification;
  if v_notification is not null and (select delivery_configured from fc_private.notification_config where id=1)
   and exists(select 1 from fc_private.notification_settings s where s.user_id=v_recipient and s.email_enabled and s.email is not null and s.email_verified_at is not null) then
   insert into fc_private.notification_outbox(notification_id,recipient_id,topic_id,reply_id)
    values(v_notification,v_recipient,new.topic_id,new.id) on conflict(recipient_id,reply_id) do nothing;
  end if;
 end loop;
 return new;
end; $$;
revoke all on function fc_private.notification_on_post() from public,anon,authenticated,service_role;
create or replace trigger fc_notify_topic after insert on public.fc_topics for each row execute function fc_private.notification_on_post();
create or replace trigger fc_notify_reply after insert on public.fc_replies for each row execute function fc_private.notification_on_post();

-- Follow existing owned/participated topics, but generate NO historical inbox
-- entries or deliveries. Reinstallation preserves every explicit mute.
insert into fc_private.topic_follows(user_id,topic_id,following)
 select distinct p.user_id,p.topic_id,true from (
  select author_id user_id,id topic_id from public.fc_topics where author_id is not null
  union select author_id,topic_id from public.fc_replies where not hidden and withdrawn_at is null
 ) p join public.fc_members m on m.user_id=p.user_id and m.status='active'
 join public.fc_topics t on t.id=p.topic_id and not t.hidden and t.withdrawn_at is null
 on conflict do nothing;

create or replace function fc_private.notification_user(p_action text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=auth.uid(); v_topic uuid; v_follow boolean; s fc_private.notification_settings%rowtype;
 v_ids uuid[]; v_limit integer; v_before timestamptz; v_before_id uuid; v_items jsonb; v_unread bigint; v_has_more boolean; v_count integer;
begin
 if v_actor is null or not fc_private.access(false) then raise exception using errcode='42501',message='fc_active_member_required'; end if;
 if p_action in ('settings','set') then
  insert into fc_private.notification_settings(user_id) values(v_actor) on conflict do nothing;
  if p_action='set' then
   if jsonb_typeof(p_data->'enabled') is distinct from 'boolean' then raise exception using errcode='22023',message='fc_invalid_preference'; end if;
   select * into s from fc_private.notification_settings where user_id=v_actor for update;
   if (p_data->>'enabled')::boolean and (s.email is null or s.email_verified_at is null) then raise exception using errcode='22023',message='fc_notification_email_unverified'; end if;
   update fc_private.notification_settings set email_enabled=(p_data->>'enabled')::boolean,updated_at=clock_timestamp() where user_id=v_actor;
   if not (p_data->>'enabled')::boolean then update fc_private.notification_outbox set state='cancelled',finished_at=clock_timestamp(),error_code='email_disabled' where recipient_id=v_actor and state in ('pending','leased'); end if;
  end if;
  select * into s from fc_private.notification_settings where user_id=v_actor;
  return jsonb_build_object('email_enabled',s.email_enabled,'enabled',s.email_enabled,'email',s.email,
   'email_masked',case when s.email is null then null else left(split_part(s.email,'@',1),1)||'***@'||split_part(s.email,'@',2) end,
   'email_verified',s.email_verified_at is not null,'deliveryConfigured',(select delivery_configured from fc_private.notification_config where id=1));
 elsif p_action in ('follow','is_following') then
  v_topic:=(p_data->>'topic_id')::uuid;
  if not exists(select 1 from public.fc_topics where id=v_topic and not hidden and withdrawn_at is null) then raise exception using errcode='42501',message='fc_content_unavailable'; end if;
  if p_action='follow' then
   if jsonb_typeof(p_data->'follow') is distinct from 'boolean' then raise exception using errcode='22023',message='fc_invalid_preference'; end if;
   v_follow:=(p_data->>'follow')::boolean;
   insert into fc_private.topic_follows(user_id,topic_id,following) values(v_actor,v_topic,v_follow)
    on conflict(user_id,topic_id) do update set following=excluded.following,updated_at=clock_timestamp();
   if not v_follow then update fc_private.notification_outbox set state='cancelled',finished_at=clock_timestamp(),error_code='topic_unfollowed' where recipient_id=v_actor and topic_id=v_topic and state in ('pending','leased'); end if;
   return jsonb_build_object('topic_id',v_topic,'following',v_follow);
  end if;
  return to_jsonb(exists(select 1 from fc_private.topic_follows where user_id=v_actor and topic_id=v_topic and following));
 elsif p_action='read' then
  if jsonb_typeof(p_data->'ids') is distinct from 'array' then raise exception using errcode='22023',message='fc_invalid_notification_ids'; end if;
  v_ids:=array(select value::uuid from jsonb_array_elements_text(p_data->'ids'));
  if cardinality(v_ids)>100 then raise exception using errcode='22023',message='fc_invalid_notification_ids'; end if;
  update public.fc_inbox n set read_at=coalesce(read_at,clock_timestamp()) where n.id=any(v_ids) and n.recipient_id=v_actor and n.read_at is null
   and fc_private.notification_eligible(v_actor,n.topic_id,n.reply_id);
  get diagnostics v_count=row_count;
  return jsonb_build_object('updated',v_count);
 elsif p_action='list' then
  v_limit:=(p_data->>'limit')::integer; v_before:=(p_data->>'before')::timestamptz; v_before_id:=(p_data->>'before_id')::uuid;
  if v_limit is null or v_limit not between 1 and 50 or (v_before is null and v_before_id is not null) then raise exception using errcode='22023',message='fc_invalid_notification_page'; end if;
  select count(*) into v_unread from public.fc_inbox n where recipient_id=v_actor and read_at is null and fc_private.notification_eligible(v_actor,n.topic_id,n.reply_id);
  select coalesce(jsonb_agg(to_jsonb(page) order by created_at desc,id desc),'[]'::jsonb) into v_items from (
   select id,topic_id,reply_id,created_at,read_at from public.fc_inbox n where recipient_id=v_actor and fc_private.notification_eligible(v_actor,n.topic_id,n.reply_id)
    and (v_before is null or n.created_at<v_before or (n.created_at=v_before and v_before_id is not null and n.id<v_before_id))
    order by created_at desc,id desc limit v_limit+1
  ) page;
  v_has_more:=jsonb_array_length(v_items)>v_limit;
  if v_has_more then v_items:=v_items-v_limit; end if;
  return jsonb_build_object('items',v_items,'unread_count',v_unread,'has_more',v_has_more,
   'next_before',case when v_has_more then v_items->-1->>'created_at' else null end,
   'next_before_id',case when v_has_more then v_items->-1->>'id' else null end);
 end if;
 raise exception using errcode='22023',message='fc_unknown_action';
end; $$;
revoke all on function fc_private.notification_user(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function fc_private.notification_user(text,jsonb) to authenticated;

create or replace function fc_private.notification_worker(p_action text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j fc_private.notification_outbox%rowtype; s fc_private.notification_settings%rowtype; v_now timestamptz:=clock_timestamp();
 v_limit integer; v_lease integer; v_count integer:=0; v_jobs jsonb:='[]'; v_token uuid; v_reason text; v_outcome text; v_retry timestamptz; v_provider text; v_error text;
begin
 if p_action='claim' then
  v_limit:=(p_data->>'limit')::integer; v_lease:=(p_data->>'lease_seconds')::integer;
  if v_limit is null or v_limit not between 1 and 25 or v_lease is null or v_lease not between 30 and 300 then raise exception using errcode='22023',message='fc_invalid_delivery_claim'; end if;
  if not (select delivery_configured from fc_private.notification_config where id=1) then return '[]'; end if;
  for j in select * from fc_private.notification_outbox where (state='pending' or (state='leased' and lease_until<=v_now))
    and next_attempt_at<=v_now order by created_at,id limit v_limit*4 for update skip locked loop
   select * into s from fc_private.notification_settings where user_id=j.recipient_id;
   v_reason:=null;
   if j.created_at<=v_now-interval '24 hours' or j.first_attempt_at<=v_now-interval '24 hours' then v_reason:='delivery_window_expired';
   elsif j.attempts>=8 then v_reason:='attempt_limit';
   elsif not fc_private.notification_eligible(j.recipient_id,j.topic_id,j.reply_id) then v_reason:='recipient_unavailable';
   elsif not found or not s.email_enabled or s.email is null or s.email_verified_at is null then v_reason:='email_unavailable';
   elsif j.delivery_email is not null and j.delivery_email is distinct from s.email then v_reason:='destination_changed'; end if;
   if v_reason is not null then update fc_private.notification_outbox set state='cancelled',finished_at=v_now,error_code=v_reason where id=j.id; continue; end if;
   update fc_private.notification_outbox set state='leased',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=v_now+make_interval(secs=>v_lease),
    first_attempt_at=coalesce(first_attempt_at,v_now),last_attempt_at=v_now,delivery_email=coalesce(delivery_email,s.email) where id=j.id returning * into j;
   v_jobs:=v_jobs||jsonb_build_array(jsonb_build_object('id',j.id,'topic_id',j.topic_id,'lease_token',j.lease_token,'created_at',j.created_at,
    'attempts',j.attempts,'first_attempt_at',j.first_attempt_at,'last_attempt_at',j.last_attempt_at));
   v_count:=v_count+1; exit when v_count>=v_limit;
  end loop;
  return v_jobs;
 end if;
 select * into j from fc_private.notification_outbox where id=(p_data->>'id')::uuid for update;
 v_token:=(p_data->>'lease_token')::uuid;
 if not found or v_token is null or j.lease_token is distinct from v_token then raise exception using errcode='42501',message='fc_delivery_lease_invalid'; end if;
 if p_action='revalidate' then
  if j.state<>'leased' or j.lease_until<=v_now then return jsonb_build_object('allowed',false,'reason','lease_expired'); end if;
  select * into s from fc_private.notification_settings where user_id=j.recipient_id;
  v_reason:=null;
  if not (select delivery_configured from fc_private.notification_config where id=1) then v_reason:='delivery_disabled';
  elsif j.first_attempt_at<=v_now-interval '24 hours' then v_reason:='delivery_window_expired';
  elsif not fc_private.notification_eligible(j.recipient_id,j.topic_id,j.reply_id) then v_reason:='recipient_unavailable';
  elsif not found or not s.email_enabled or s.email is null or s.email_verified_at is null then v_reason:='email_unavailable';
  elsif s.email is distinct from j.delivery_email then v_reason:='destination_changed'; end if;
  if v_reason is not null then update fc_private.notification_outbox set state='cancelled',finished_at=v_now,error_code=v_reason where id=j.id;
   return jsonb_build_object('allowed',false,'reason',v_reason); end if;
  return jsonb_build_object('allowed',true,'email',j.delivery_email,'topic_id',j.topic_id,
   'deep_url',(select base_url from fc_private.notification_config where id=1)||'?topic='||j.topic_id::text,
   'idempotency_key','fc-reply-'||j.id::text);
 elsif p_action='ack' then
  if j.state in ('sent','cancelled','failed') then return jsonb_build_object('ok',true,'state',j.state); end if;
  if j.state<>'leased' then raise exception using errcode='42501',message='fc_delivery_lease_invalid'; end if;
  v_outcome:=p_data->>'outcome'; v_provider:=p_data->>'provider_id'; v_error:=p_data->>'error_code';
  if v_outcome is null or v_outcome not in ('accepted','retry','discarded','failed')
   or (v_error is not null and v_error !~ '^[a-z0-9_.-]{1,64}$')
   or (v_provider is not null and (char_length(v_provider)>200 or v_provider ~ '[[:cntrl:]]')) then raise exception using errcode='22023',message='fc_invalid_delivery_ack'; end if;
  v_retry:=coalesce((p_data->>'retry_at')::timestamptz,v_now+make_interval(secs=>least(3600,30*power(2,least(j.attempts-1,7))::integer)));
  v_retry:=greatest(v_now+interval '30 seconds',least(v_retry,v_now+interval '1 hour'));
  update fc_private.notification_outbox set
   state=case when v_outcome='accepted' then 'sent' when v_outcome='discarded' then 'cancelled'
     when v_outcome='failed' or attempts>=8 or v_retry>=first_attempt_at+interval '24 hours' then 'failed' else 'pending' end,
   next_attempt_at=v_retry,lease_until=null,provider_id=coalesce(v_provider,provider_id),error_code=v_error,
   finished_at=case when v_outcome<>'retry' or attempts>=8 or v_retry>=first_attempt_at+interval '24 hours' then v_now else null end
   where id=j.id returning * into j;
  return jsonb_build_object('ok',true,'state',j.state);
 end if;
 raise exception using errcode='22023',message='fc_unknown_action';
end; $$;
revoke all on function fc_private.notification_worker(text,jsonb) from public,anon,authenticated,service_role;
grant usage on schema fc_private to service_role;
grant execute on function fc_private.notification_worker(text,jsonb) to service_role;

create or replace function public.fc_notification_settings() returns jsonb language sql security invoker set search_path='' as $$ select fc_private.notification_user('settings','{}'); $$;
create or replace function public.fc_set_notifications(p_email_enabled boolean) returns jsonb language sql security invoker set search_path='' as $$ select fc_private.notification_user('set',jsonb_build_object('enabled',p_email_enabled)); $$;
create or replace function public.fc_follow_topic(p_topic_id uuid,p_follow boolean) returns jsonb language sql security invoker set search_path='' as $$ select fc_private.notification_user('follow',jsonb_build_object('topic_id',p_topic_id,'follow',p_follow)); $$;
create or replace function public.fc_is_following(p_topic_id uuid) returns boolean language sql security invoker set search_path='' as $$ select (fc_private.notification_user('is_following',jsonb_build_object('topic_id',p_topic_id)))::boolean; $$;
create or replace function public.fc_notifications(p_limit integer default 25,p_before timestamptz default null,p_before_id uuid default null) returns jsonb language sql security invoker set search_path='' as $$ select fc_private.notification_user('list',jsonb_build_object('limit',p_limit,'before',p_before,'before_id',p_before_id)); $$;
create or replace function public.fc_read_notifications(p_ids uuid[]) returns jsonb language sql security invoker set search_path='' as $$ select fc_private.notification_user('read',jsonb_build_object('ids',to_jsonb(coalesce(p_ids,'{}'::uuid[])))); $$;
revoke all on function public.fc_notification_settings(),public.fc_set_notifications(boolean),public.fc_follow_topic(uuid,boolean),public.fc_is_following(uuid),public.fc_notifications(integer,timestamptz,uuid),public.fc_read_notifications(uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.fc_notification_settings(),public.fc_set_notifications(boolean),public.fc_follow_topic(uuid,boolean),public.fc_is_following(uuid),public.fc_notifications(integer,timestamptz,uuid),public.fc_read_notifications(uuid[]) to authenticated;
create or replace function public.fc_claim_delivery(p_limit integer default 25,p_lease_seconds integer default 120) returns jsonb language sql security invoker set search_path='' as $$ select fc_private.notification_worker('claim',jsonb_build_object('limit',p_limit,'lease_seconds',p_lease_seconds)); $$;
create or replace function public.fc_revalidate_delivery(p_id uuid,p_lease_token uuid) returns jsonb language sql security invoker set search_path='' as $$ select fc_private.notification_worker('revalidate',jsonb_build_object('id',p_id,'lease_token',p_lease_token)); $$;
create or replace function public.fc_ack_delivery(p_id uuid,p_lease_token uuid,p_outcome text,p_provider_id text default null,p_error_code text default null,p_retry_at timestamptz default null) returns jsonb language sql security invoker set search_path='' as $$ select fc_private.notification_worker('ack',jsonb_build_object('id',p_id,'lease_token',p_lease_token,'outcome',p_outcome,'provider_id',p_provider_id,'error_code',p_error_code,'retry_at',p_retry_at)); $$;
revoke all on function public.fc_claim_delivery(integer,integer),public.fc_revalidate_delivery(uuid,uuid),public.fc_ack_delivery(uuid,uuid,text,text,text,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.fc_claim_delivery(integer,integer),public.fc_revalidate_delivery(uuid,uuid),public.fc_ack_delivery(uuid,uuid,text,text,text,timestamptz) to service_role;
commit;
