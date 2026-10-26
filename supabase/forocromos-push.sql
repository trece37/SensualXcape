-- Web Push extension of forocromos-notifications.sql. No keys, destinations or
-- cron jobs are provisioned here. The administrator creates two Vault secrets
-- (VAPID private key and worker secret), then stores their IDs in push_config.
-- A later cron job may call ONLY fc_private.run_push_dispatch(), after the Edge
-- function is installed and verified. No credential belongs in cron.job.command.
begin;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create or replace function fc_private.push_endpoint_allowed(p_endpoint text)
returns boolean language sql immutable security invoker set search_path='' as $$
 select p_endpoint is not null and char_length(p_endpoint) between 30 and 2048
  and p_endpoint !~ '[[:space:]#<>\\]'
  and p_endpoint ~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|([a-z0-9-]+\.)?web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)/[^[:space:]#]+$';
$$;
revoke all on function fc_private.push_endpoint_allowed(text) from public,anon,authenticated,service_role;
create table if not exists fc_private.push_config (
 id integer primary key check(id=1),configured boolean not null default false,
 vapid_public_key text check(vapid_public_key is null or vapid_public_key ~ '^B[A-Za-z0-9_-]{86}$'),
 vapid_secret_id uuid,worker_secret_id uuid,
 vapid_subject text not null default 'https://trece37.github.io/SensualXcape/' check(vapid_subject ~ '^https://[^[:space:]@#]+$'),
 dispatch_url text not null default 'https://oorheeyyahpyiarwktbq.supabase.co/functions/v1/fc-deliver-push'
  check(dispatch_url='https://oorheeyyahpyiarwktbq.supabase.co/functions/v1/fc-deliver-push'),
 check(not configured or (vapid_public_key is not null and vapid_secret_id is not null and worker_secret_id is not null))
);
insert into fc_private.push_config(id) values(1) on conflict do nothing;
create table if not exists fc_private.push_subscriptions (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references public.fc_members(user_id) on delete cascade,
 endpoint text not null unique check(fc_private.push_endpoint_allowed(endpoint)),
 p256dh text not null check(p256dh ~ '^B[A-Za-z0-9_-]{86}$'),
 auth text not null check(auth ~ '^[A-Za-z0-9_-]{22}$'),
 enabled boolean not null default true,key_version integer not null default 1 check(key_version>0),
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp()
);
create index if not exists fc_push_subscription_user_idx on fc_private.push_subscriptions(user_id) where enabled;
create table if not exists fc_private.push_outbox (
 id uuid primary key default gen_random_uuid(),notification_id uuid not null references public.fc_inbox(id) on delete cascade,
 subscription_id uuid not null references fc_private.push_subscriptions(id) on delete cascade,subscription_version integer not null,
 recipient_id uuid not null references public.fc_members(user_id) on delete cascade,
 topic_id uuid not null references public.fc_topics(id) on delete cascade,reply_id uuid not null references public.fc_replies(id) on delete cascade,
 state text not null default 'pending' check(state in ('pending','leased','sent','cancelled','failed')),
 attempts integer not null default 0 check(attempts between 0 and 8),lease_token uuid,lease_until timestamptz,
 first_attempt_at timestamptz,last_attempt_at timestamptz,next_attempt_at timestamptz not null default clock_timestamp(),
 created_at timestamptz not null default clock_timestamp(),finished_at timestamptz,
 error_code text check(error_code is null or error_code ~ '^[a-z0-9_.-]{1,64}$'),
 provider_id text check(provider_id is null or (char_length(provider_id)<=200 and provider_id !~ '[[:cntrl:]]')),
 unique(notification_id,subscription_id)
);
create index if not exists fc_push_claim_idx on fc_private.push_outbox(next_attempt_at,created_at,id) where state in ('pending','leased');
create index if not exists fc_push_subscription_jobs_idx on fc_private.push_outbox(subscription_id);
create index if not exists fc_push_recipient_idx on fc_private.push_outbox(recipient_id);
create index if not exists fc_push_topic_idx on fc_private.push_outbox(topic_id);
create index if not exists fc_push_reply_idx on fc_private.push_outbox(reply_id);
alter table fc_private.push_config enable row level security;
alter table fc_private.push_subscriptions enable row level security;
alter table fc_private.push_outbox enable row level security;
revoke all on fc_private.push_config,fc_private.push_subscriptions,fc_private.push_outbox from public,anon,authenticated,service_role;

create or replace function fc_private.push_on_inbox()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if not (select configured from fc_private.push_config where id=1) or not fc_private.notification_eligible(new.recipient_id,new.topic_id,new.reply_id) then return new; end if;
 insert into fc_private.push_outbox(notification_id,subscription_id,subscription_version,recipient_id,topic_id,reply_id)
  select new.id,s.id,s.key_version,new.recipient_id,new.topic_id,new.reply_id from fc_private.push_subscriptions s
   where s.user_id=new.recipient_id and s.enabled on conflict do nothing;
 return new;
end; $$;
revoke all on function fc_private.push_on_inbox() from public,anon,authenticated,service_role;
create or replace trigger fc_enqueue_push after insert on public.fc_inbox for each row execute function fc_private.push_on_inbox();

-- A mute is a permanent revocation of already queued work. Merely checking
-- following at send time would resurrect an old lease after mute -> unmute.
create or replace function fc_private.push_follow_changed()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 update fc_private.push_outbox set state='cancelled',finished_at=clock_timestamp(),error_code='topic_unfollowed'
  where recipient_id=new.user_id and topic_id=new.topic_id and state in ('pending','leased');
 return new;
end; $$;
revoke all on function fc_private.push_follow_changed() from public,anon,authenticated,service_role;
create or replace trigger fc_cancel_push_on_unfollow after insert or update of following on fc_private.topic_follows
 for each row when (not new.following) execute function fc_private.push_follow_changed();

create or replace function fc_private.push_user(p_action text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=auth.uid();v_endpoint text;v_key text;v_auth text;s fc_private.push_subscriptions%rowtype;c fc_private.push_config%rowtype;
begin
 if v_actor is null or not fc_private.access(false) then raise exception using errcode='42501',message='fc_active_member_required'; end if;
 select * into c from fc_private.push_config where id=1;
 if p_action='settings' then return jsonb_build_object('configured',c.configured,'public_key',case when c.configured then c.vapid_public_key else null end); end if;
 v_endpoint:=p_data->>'endpoint';
 if not fc_private.push_endpoint_allowed(v_endpoint) then raise exception using errcode='22023',message='fc_invalid_push_endpoint'; end if;
 if p_action='status' then
  select * into s from fc_private.push_subscriptions where endpoint=v_endpoint and user_id=v_actor and enabled;
  return jsonb_build_object('registered',found,'id',case when found then s.id else null end);
 end if;
 perform 1 from public.fc_members where user_id=v_actor for update;
 if p_action='unregister' then
  update fc_private.push_subscriptions set enabled=false,key_version=key_version+1,updated_at=clock_timestamp() where endpoint=v_endpoint and user_id=v_actor returning * into s;
  if found then update fc_private.push_outbox set state='cancelled',finished_at=clock_timestamp(),error_code='device_unregistered' where subscription_id=s.id and state in ('pending','leased'); end if;
  return jsonb_build_object('ok',true);
 elsif p_action='register' then
  if not c.configured then raise exception using errcode='55000',message='fc_push_not_configured'; end if;
  v_key:=p_data->>'p256dh';v_auth:=p_data->>'auth';
  if v_key is null or v_key !~ '^B[A-Za-z0-9_-]{86}$' or v_auth is null or v_auth !~ '^[A-Za-z0-9_-]{22}$' then raise exception using errcode='22023',message='fc_invalid_push_keys'; end if;
  select * into s from fc_private.push_subscriptions where endpoint=v_endpoint for update;
  if found and s.user_id<>v_actor then raise exception using errcode='42501',message='fc_push_endpoint_unavailable'; end if;
  if (s.id is null or not s.enabled) and (select count(*) from fc_private.push_subscriptions where user_id=v_actor and enabled)>=5 then raise exception using errcode='54000',message='fc_push_device_limit'; end if;
  if s.id is null then
   insert into fc_private.push_subscriptions(user_id,endpoint,p256dh,auth) values(v_actor,v_endpoint,v_key,v_auth) returning * into s;
  else
   if not s.enabled or s.p256dh is distinct from v_key or s.auth is distinct from v_auth then
    update fc_private.push_outbox set state='cancelled',finished_at=clock_timestamp(),error_code='device_changed' where subscription_id=s.id and state in ('pending','leased');
    update fc_private.push_subscriptions set key_version=key_version+1 where id=s.id;
   end if;
   update fc_private.push_subscriptions set enabled=true,p256dh=v_key,auth=v_auth,updated_at=clock_timestamp() where id=s.id returning * into s;
  end if;
  return jsonb_build_object('id',s.id);
 end if;
 raise exception using errcode='22023',message='fc_unknown_action';
end; $$;
revoke all on function fc_private.push_user(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function fc_private.push_user(text,jsonb) to authenticated;

create or replace function fc_private.push_worker(p_action text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j fc_private.push_outbox%rowtype;s fc_private.push_subscriptions%rowtype;c fc_private.push_config%rowtype;
 v_now timestamptz:=clock_timestamp();v_limit integer;v_lease integer;v_count integer:=0;v_jobs jsonb:='[]';v_reason text;v_token uuid;v_outcome text;v_retry timestamptz;v_error text;v_provider text;
begin
 select * into c from fc_private.push_config where id=1;
 if p_action='claim' then
  v_limit:=(p_data->>'limit')::integer;v_lease:=(p_data->>'lease_seconds')::integer;
  if v_limit is null or v_limit not between 1 and 25 or v_lease is null or v_lease not between 30 and 300 then raise exception using errcode='22023',message='fc_invalid_delivery_claim'; end if;
  if not c.configured then return '[]'; end if;
  for j in select * from fc_private.push_outbox where (state='pending' or (state='leased' and lease_until<=v_now)) and next_attempt_at<=v_now
   order by created_at,id limit v_limit*4 for update skip locked loop
   select * into s from fc_private.push_subscriptions where id=j.subscription_id;
   v_reason:=null;
   if j.created_at<=v_now-interval '24 hours' or j.first_attempt_at<=v_now-interval '24 hours' then v_reason:='delivery_window_expired';
   elsif j.attempts>=8 then v_reason:='attempt_limit';
   elsif not found or not s.enabled or s.user_id<>j.recipient_id or s.key_version<>j.subscription_version then v_reason:='device_unavailable';
   elsif not fc_private.push_endpoint_allowed(s.endpoint) then v_reason:='invalid_endpoint';
   elsif not fc_private.notification_eligible(j.recipient_id,j.topic_id,j.reply_id) then v_reason:='recipient_unavailable';end if;
   if v_reason is not null then update fc_private.push_outbox set state='cancelled',finished_at=v_now,error_code=v_reason where id=j.id;continue;end if;
   update fc_private.push_outbox set state='leased',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=v_now+make_interval(secs=>v_lease),
    first_attempt_at=coalesce(first_attempt_at,v_now),last_attempt_at=v_now where id=j.id returning * into j;
   v_jobs:=v_jobs||jsonb_build_array(jsonb_build_object('id',j.id,'topic_id',j.topic_id,'subscription_id',j.subscription_id,'lease_token',j.lease_token,'created_at',j.created_at,'attempts',j.attempts,'first_attempt_at',j.first_attempt_at,'last_attempt_at',j.last_attempt_at));
   v_count:=v_count+1;exit when v_count>=v_limit;
  end loop;
  return v_jobs;
 end if;
 -- Match registration/unregistration's device -> job lock order. In particular,
 -- expired acknowledgements must not hold a job while waiting for its device.
 perform 1 from fc_private.push_subscriptions where id=(select subscription_id from fc_private.push_outbox where id=(p_data->>'id')::uuid) for update;
 select * into j from fc_private.push_outbox where id=(p_data->>'id')::uuid for update;
 v_token:=(p_data->>'lease_token')::uuid;
 if not found or v_token is null or j.lease_token is distinct from v_token then raise exception using errcode='42501',message='fc_delivery_lease_invalid'; end if;
 if p_action='revalidate' then
  if j.state<>'leased' or j.lease_until<=v_now then return jsonb_build_object('allowed',false,'reason','lease_expired');end if;
  select * into s from fc_private.push_subscriptions where id=j.subscription_id;
  v_reason:=null;
  if not c.configured then v_reason:='delivery_disabled';
  elsif j.first_attempt_at<=v_now-interval '24 hours' then v_reason:='delivery_window_expired';
  elsif not found or not s.enabled or s.user_id<>j.recipient_id or s.key_version<>j.subscription_version then v_reason:='device_unavailable';
  elsif not fc_private.push_endpoint_allowed(s.endpoint) then v_reason:='invalid_endpoint';
  elsif not fc_private.notification_eligible(j.recipient_id,j.topic_id,j.reply_id) then v_reason:='recipient_unavailable';end if;
  if v_reason is not null then update fc_private.push_outbox set state='cancelled',finished_at=v_now,error_code=v_reason where id=j.id;return jsonb_build_object('allowed',false,'reason',v_reason);end if;
  return jsonb_build_object('allowed',true,'topic_id',j.topic_id,'deep_url',(select base_url from fc_private.notification_config where id=1)||'?topic='||j.topic_id::text,
   'device_id',s.id,'subscription',jsonb_build_object('id',s.id,'endpoint',s.endpoint,'keys',jsonb_build_object('p256dh',s.p256dh,'auth',s.auth)),
   'idempotency_key','fc-push-'||j.id::text);
 elsif p_action='ack' then
  if j.state in ('sent','cancelled','failed') then return jsonb_build_object('ok',true,'state',j.state);end if;
  if j.state<>'leased' then raise exception using errcode='42501',message='fc_delivery_lease_invalid';end if;
  v_outcome:=p_data->>'outcome';v_error:=p_data->>'error_code';v_provider:=p_data->>'provider_id';
  if v_outcome is null or v_outcome not in ('accepted','retry','discarded','failed','expired') or (v_error is not null and v_error !~ '^[a-z0-9_.-]{1,64}$')
   or (v_provider is not null and (char_length(v_provider)>200 or v_provider ~ '[[:cntrl:]]')) then raise exception using errcode='22023',message='fc_invalid_delivery_ack';end if;
  if v_outcome='expired' then
   update fc_private.push_subscriptions set enabled=false,key_version=key_version+1,updated_at=v_now where id=j.subscription_id;
   update fc_private.push_outbox set state='cancelled',finished_at=v_now,error_code='device_expired' where subscription_id=j.subscription_id and state in ('pending','leased');
   return jsonb_build_object('ok',true,'state','cancelled');
  end if;
  v_retry:=coalesce((p_data->>'retry_at')::timestamptz,v_now+make_interval(secs=>least(3600,30*power(2,least(j.attempts-1,7))::integer)));
  v_retry:=greatest(v_now+interval '30 seconds',least(v_retry,v_now+interval '1 hour'));
  update fc_private.push_outbox set state=case when v_outcome='accepted' then 'sent' when v_outcome='discarded' then 'cancelled'
    when v_outcome='failed' or attempts>=8 or v_retry>=first_attempt_at+interval '24 hours' then 'failed' else 'pending' end,
   next_attempt_at=v_retry,lease_until=null,provider_id=coalesce(v_provider,provider_id),error_code=v_error,
   finished_at=case when v_outcome<>'retry' or attempts>=8 or v_retry>=first_attempt_at+interval '24 hours' then v_now else null end
   where id=j.id returning * into j;
  return jsonb_build_object('ok',true,'state',j.state);
 end if;
 raise exception using errcode='22023',message='fc_unknown_action';
end; $$;
revoke all on function fc_private.push_worker(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function fc_private.push_worker(text,jsonb) to service_role;

create or replace function fc_private.push_worker_config(p_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c fc_private.push_config%rowtype;v_worker text;v_key text;
begin
 select * into c from fc_private.push_config where id=1;
 select decrypted_secret into v_worker from vault.decrypted_secrets where id=c.worker_secret_id;
 if p_secret is null or v_worker is null or p_secret<>v_worker then return null;end if;
 select decrypted_secret into v_key from vault.decrypted_secrets where id=c.vapid_secret_id;
 if v_key is null or v_key !~ '^[A-Za-z0-9_-]{43}$' then return jsonb_build_object('configured',false);end if;
 return jsonb_build_object('configured',c.configured,'vapid_public_key',c.vapid_public_key,'vapid_private_key',v_key,'vapid_subject',c.vapid_subject);
end; $$;
revoke all on function fc_private.push_worker_config(text) from public,anon,authenticated,service_role;
grant execute on function fc_private.push_worker_config(text) to service_role;

create or replace function fc_private.run_push_dispatch()
returns bigint language plpgsql security definer set search_path='' as $$
declare c fc_private.push_config%rowtype;v_secret text;v_request bigint;
begin
 select * into c from fc_private.push_config where id=1;
 if not c.configured then return null;end if;
 select decrypted_secret into v_secret from vault.decrypted_secrets where id=c.worker_secret_id;
 if v_secret is null or char_length(v_secret)<32 then return null;end if;
 select net.http_post(url:=c.dispatch_url,body:='{}'::jsonb,
  headers:=jsonb_build_object('Content-Type','application/json','x-foro-worker-secret',v_secret),timeout_milliseconds:=10000) into v_request;
 return v_request;
end; $$;
revoke all on function fc_private.run_push_dispatch() from public,anon,authenticated,service_role;

create or replace function public.fc_push_settings() returns jsonb language sql security invoker set search_path='' as $$select fc_private.push_user('settings','{}');$$;
create or replace function public.fc_register_push(p_endpoint text,p_p256dh text,p_auth text) returns jsonb language sql security invoker set search_path='' as $$select fc_private.push_user('register',jsonb_build_object('endpoint',p_endpoint,'p256dh',p_p256dh,'auth',p_auth));$$;
create or replace function public.fc_unregister_push(p_endpoint text) returns jsonb language sql security invoker set search_path='' as $$select fc_private.push_user('unregister',jsonb_build_object('endpoint',p_endpoint));$$;
create or replace function public.fc_push_status(p_endpoint text) returns jsonb language sql security invoker set search_path='' as $$select fc_private.push_user('status',jsonb_build_object('endpoint',p_endpoint));$$;
revoke all on function public.fc_push_settings(),public.fc_register_push(text,text,text),public.fc_unregister_push(text),public.fc_push_status(text) from public,anon,authenticated,service_role;
grant execute on function public.fc_push_settings(),public.fc_register_push(text,text,text),public.fc_unregister_push(text),public.fc_push_status(text) to authenticated;
create or replace function public.fc_claim_push_delivery(p_limit integer default 20,p_lease_seconds integer default 120) returns jsonb language sql security invoker set search_path='' as $$select fc_private.push_worker('claim',jsonb_build_object('limit',p_limit,'lease_seconds',p_lease_seconds));$$;
create or replace function public.fc_revalidate_push_delivery(p_id uuid,p_lease_token uuid) returns jsonb language sql security invoker set search_path='' as $$select fc_private.push_worker('revalidate',jsonb_build_object('id',p_id,'lease_token',p_lease_token));$$;
create or replace function public.fc_ack_push_delivery(p_id uuid,p_lease_token uuid,p_outcome text,p_provider_id text default null,p_error_code text default null,p_retry_at timestamptz default null) returns jsonb language sql security invoker set search_path='' as $$select fc_private.push_worker('ack',jsonb_build_object('id',p_id,'lease_token',p_lease_token,'outcome',p_outcome,'provider_id',p_provider_id,'error_code',p_error_code,'retry_at',p_retry_at));$$;
create or replace function public.fc_push_worker_config(p_secret text) returns jsonb language sql security invoker set search_path='' as $$select fc_private.push_worker_config(p_secret);$$;
revoke all on function public.fc_claim_push_delivery(integer,integer),public.fc_revalidate_push_delivery(uuid,uuid),public.fc_ack_push_delivery(uuid,uuid,text,text,text,timestamptz),public.fc_push_worker_config(text) from public,anon,authenticated,service_role;
grant execute on function public.fc_claim_push_delivery(integer,integer),public.fc_revalidate_push_delivery(uuid,uuid),public.fc_ack_push_delivery(uuid,uuid,text,text,text,timestamptz),public.fc_push_worker_config(text) to service_role;
commit;
