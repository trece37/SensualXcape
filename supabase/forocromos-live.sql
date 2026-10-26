-- Foro Cromos: isolated private community. No existing sx_* object is changed.
-- Run as the database administrator. No member, moderator or content is seeded.
-- Bootstrap a moderator separately, using a verified auth.users id; no client RPC
-- can assign roles. fc_private must remain outside the Data API exposed schemas.
begin;

create schema if not exists fc_private;
revoke all on schema fc_private from public, anon, authenticated;
grant usage on schema fc_private to authenticated;

create table if not exists public.fc_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  alias text not null check (char_length(btrim(alias)) between 2 and 36 and alias !~ '[[:cntrl:]@]'),
  status text not null default 'pending' check (status in ('pending','active','suspended')),
  role text not null default 'member' check (role in ('member','moderator')),
  created_at timestamptz not null default now()
);
create table if not exists public.fc_topics (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('cuidado','zaragoza','rutas','oficio','bienestar','aplicacion')),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  body text not null check (char_length(btrim(body)) between 1 and 5000),
  author_id uuid references public.fc_members(user_id) on delete cascade,
  editorial boolean not null default false,
  pinned boolean not null default false,
  closed boolean not null default false,
  hidden boolean not null default false,
  withdrawn_at timestamptz,
  created_at timestamptz not null default now(),
  check ((editorial and author_id is null) or (not editorial and author_id is not null))
);
create table if not exists public.fc_replies (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references public.fc_topics(id) on delete cascade,
  author_id uuid not null references public.fc_members(user_id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 3000),
  hidden boolean not null default false,
  withdrawn_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists public.fc_reports (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid references public.fc_topics(id) on delete cascade,
  reply_id uuid references public.fc_replies(id) on delete cascade,
  reporter_id uuid not null references public.fc_members(user_id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 1000),
  status text not null default 'open' check (status in ('open','resolved')),
  created_at timestamptz not null default now(),
  -- Neither target is a confidential general notice; one target is a content report.
  check (num_nonnulls(topic_id,reply_id) <= 1)
);
create table if not exists public.fc_saved (
  user_id uuid not null references public.fc_members(user_id) on delete cascade,
  topic_id uuid not null references public.fc_topics(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id,topic_id)
);

create index if not exists fc_members_status_idx on public.fc_members(status);
create index if not exists fc_topics_feed_idx on public.fc_topics(category,pinned desc,created_at desc);
create index if not exists fc_topics_author_created_idx on public.fc_topics(author_id,created_at desc);
create index if not exists fc_replies_topic_created_idx on public.fc_replies(topic_id,created_at);
create index if not exists fc_replies_author_created_idx on public.fc_replies(author_id,created_at desc);
create index if not exists fc_reports_reporter_created_idx on public.fc_reports(reporter_id,created_at desc);
create index if not exists fc_reports_queue_idx on public.fc_reports(status,created_at);
create index if not exists fc_reports_topic_idx on public.fc_reports(topic_id);
create index if not exists fc_reports_reply_idx on public.fc_reports(reply_id);
create index if not exists fc_saved_topic_idx on public.fc_saved(topic_id);
create unique index if not exists fc_reports_open_topic_unique on public.fc_reports(reporter_id,topic_id)
  where status = 'open' and topic_id is not null;
create unique index if not exists fc_reports_open_reply_unique on public.fc_reports(reporter_id,reply_id)
  where status = 'open' and reply_id is not null;

alter table public.fc_members enable row level security;
alter table public.fc_topics enable row level security;
alter table public.fc_replies enable row level security;
alter table public.fc_reports enable row level security;
alter table public.fc_saved enable row level security;

-- This narrowly scoped lookup breaks membership-policy recursion. It reveals
-- only the current authenticated caller's access, never another user's record.
create or replace function fc_private.access(p_moderator boolean)
returns boolean language sql stable security definer set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1 from public.fc_members m where m.user_id = auth.uid()
      and m.status = 'active' and (not p_moderator or m.role = 'moderator')
  );
$$;
revoke all on function fc_private.access(boolean) from public, anon, authenticated;
grant execute on function fc_private.access(boolean) to authenticated;

drop policy if exists fc_members_read on public.fc_members;
create policy fc_members_read on public.fc_members for select to authenticated using (
  user_id = (select auth.uid()) or (status = 'active' and (select fc_private.access(false)))
  or (select fc_private.access(true))
);
drop policy if exists fc_topics_read on public.fc_topics;
create policy fc_topics_read on public.fc_topics for select to authenticated using (
  (select fc_private.access(false))
  and ((not hidden and withdrawn_at is null) or (select fc_private.access(true)))
);
drop policy if exists fc_replies_read on public.fc_replies;
create policy fc_replies_read on public.fc_replies for select to authenticated using (
  (select fc_private.access(false))
  and ((not hidden and withdrawn_at is null) or (select fc_private.access(true)))
  and exists (select 1 from public.fc_topics t where t.id = topic_id)
);
drop policy if exists fc_reports_read on public.fc_reports;
create policy fc_reports_read on public.fc_reports for select to authenticated using (
  (select fc_private.access(false))
  and (reporter_id = (select auth.uid()) or (select fc_private.access(true)))
);
drop policy if exists fc_saved_read on public.fc_saved;
create policy fc_saved_read on public.fc_saved for select to authenticated using (
  (select fc_private.access(false)) and user_id = (select auth.uid())
);

-- Clients have no INSERT/UPDATE/DELETE/TRUNCATE rights and no write policies.
-- Atomic mutations need a private definer because invoker RPCs cannot write
-- revoked tables. Every action checks auth.uid(), current database membership,
-- ownership and target state here. The public API wrappers remain invokers.
revoke all on public.fc_members, public.fc_topics, public.fc_replies, public.fc_reports, public.fc_saved
  from public, anon, authenticated;
grant select on public.fc_members, public.fc_topics, public.fc_replies, public.fc_reports, public.fc_saved
  to authenticated;

create or replace function fc_private.mutate(p_action text, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_member public.fc_members%rowtype;
  v_topic public.fc_topics%rowtype;
  v_reply public.fc_replies%rowtype;
  v_report public.fc_reports%rowtype;
  v_alias text;
  v_body text;
  v_id uuid;
  v_topic_id uuid;
  v_reply_id uuid;
  v_target_user uuid;
  v_kind text;
  v_status text;
  v_action text;
  v_deleted integer;
begin
  if v_actor is null then
    raise exception using errcode = '42501', message = 'fc_auth_required';
  end if;

  if p_action in ('join','profile') then
    v_alias := btrim(p_data->>'alias');
    if v_alias is null or char_length(v_alias) not between 2 and 36 or v_alias ~ '[[:cntrl:]@]' then
      raise exception using errcode = '22023', message = 'fc_invalid_alias';
    end if;
  end if;
  if p_action = 'join' then
    -- Idempotent; an existing pending/suspended member cannot rejoin to reset status.
    insert into public.fc_members(user_id,alias,status,role)
      values (v_actor,v_alias,'pending','member') on conflict (user_id) do nothing;
    select * into v_member from public.fc_members where user_id = v_actor;
    return to_jsonb(v_member);
  end if;

  -- Serializes each author's mutations: concurrent requests cannot evade limits.
  -- Holding this row also orders posting against admission/suspension changes.
  select * into v_member from public.fc_members where user_id = v_actor for update;
  if not found or v_member.status <> 'active' then
    raise exception using errcode = '42501', message = 'fc_active_member_required';
  end if;

  if p_action = 'profile' then
    update public.fc_members set alias = v_alias where user_id = v_actor returning * into v_member;
    return to_jsonb(v_member);

  elsif p_action = 'create_topic' then
    if p_data->>'category' is null or p_data->>'category' not in ('cuidado','zaragoza','rutas','oficio','bienestar','aplicacion')
       or p_data->>'title' is null or char_length(btrim(p_data->>'title')) not between 1 and 120
       or p_data->>'body' is null or char_length(btrim(p_data->>'body')) not between 1 and 5000 then
      raise exception using errcode = '22023', message = 'fc_invalid_topic';
    end if;
    if (select count(*) from public.fc_topics where author_id = v_actor and created_at > now() - interval '10 minutes') >= 4
       or (select count(*) from public.fc_topics where author_id = v_actor and created_at > now() - interval '1 day') >= 20 then
      raise exception using errcode = '54000', message = 'fc_rate_limit';
    end if;
    insert into public.fc_topics(category,title,body,author_id)
      values (p_data->>'category',btrim(p_data->>'title'),btrim(p_data->>'body'),v_actor)
      returning * into v_topic;
    return to_jsonb(v_topic);

  elsif p_action = 'reply' then
    v_topic_id := (p_data->>'topic_id')::uuid;
    v_body := btrim(p_data->>'body');
    if v_body is null or char_length(v_body) not between 1 and 3000 then
      raise exception using errcode = '22023', message = 'fc_invalid_body';
    end if;
    select * into v_topic from public.fc_topics where id = v_topic_id for update;
    if not found or v_topic.hidden or v_topic.withdrawn_at is not null then
      raise exception using errcode = '42501', message = 'fc_content_unavailable';
    end if;
    if v_topic.closed then raise exception using errcode = '55000', message = 'fc_topic_closed'; end if;
    if (select count(*) from public.fc_replies where author_id = v_actor and created_at > now() - interval '10 minutes') >= 20
       or (select count(*) from public.fc_replies where author_id = v_actor and created_at > now() - interval '1 day') >= 100 then
      raise exception using errcode = '54000', message = 'fc_rate_limit';
    end if;
    insert into public.fc_replies(topic_id,author_id,body) values (v_topic_id,v_actor,v_body) returning * into v_reply;
    return to_jsonb(v_reply);

  elsif p_action = 'report' then
    v_topic_id := (p_data->>'topic_id')::uuid;
    v_reply_id := (p_data->>'reply_id')::uuid;
    v_body := btrim(p_data->>'body');
    if v_body is null or char_length(v_body) not between 1 and 1000 then
      raise exception using errcode = '22023', message = 'fc_invalid_report';
    end if;
    if v_reply_id is not null then
      select * into v_reply from public.fc_replies where id = v_reply_id;
      if not found or v_reply.hidden or v_reply.withdrawn_at is not null then
        raise exception using errcode = '42501', message = 'fc_content_unavailable';
      end if;
      if v_topic_id is not null and v_topic_id <> v_reply.topic_id then
        raise exception using errcode = '22023', message = 'fc_report_target_mismatch';
      end if;
      v_topic_id := v_reply.topic_id;
    end if;
    if v_topic_id is not null then
      select * into v_topic from public.fc_topics where id = v_topic_id;
      if not found or v_topic.hidden or v_topic.withdrawn_at is not null then
        raise exception using errcode = '42501', message = 'fc_content_unavailable';
      end if;
    end if;
    -- Repeat a content report safely; general notices are independent submissions.
    select * into v_report from public.fc_reports where reporter_id = v_actor and status = 'open'
      and ((v_reply_id is not null and reply_id = v_reply_id)
        or (v_reply_id is null and v_topic_id is not null and topic_id = v_topic_id));
    if found then return jsonb_build_object('id',v_report.id,'status',v_report.status); end if;
    if (select count(*) from public.fc_reports where reporter_id = v_actor and created_at > now() - interval '1 hour') >= 10 then
      raise exception using errcode = '54000', message = 'fc_rate_limit';
    end if;
    insert into public.fc_reports(topic_id,reply_id,reporter_id,body)
      values (case when v_reply_id is null then v_topic_id else null end,v_reply_id,v_actor,v_body) returning * into v_report;
    return jsonb_build_object('id',v_report.id,'status',v_report.status);

  elsif p_action = 'edit' then
    v_id := (p_data->>'id')::uuid;
    v_kind := p_data->>'kind';
    v_body := btrim(p_data->>'body');
    if v_kind is null or v_kind not in ('topic','reply') or v_body is null
       or char_length(v_body) not between 1 and (case when v_kind = 'topic' then 5000 else 3000 end) then
      raise exception using errcode = '22023', message = 'fc_invalid_body';
    end if;
    if v_kind = 'topic' then
      select * into v_topic from public.fc_topics where id = v_id for update;
      if not found or v_topic.author_id is distinct from v_actor or v_topic.editorial
         or v_topic.hidden or v_topic.withdrawn_at is not null then
        raise exception using errcode = '42501', message = 'fc_content_unavailable';
      end if;
    else
      select * into v_reply from public.fc_replies where id = v_id for update;
      if not found or v_reply.author_id <> v_actor or v_reply.hidden or v_reply.withdrawn_at is not null then
        raise exception using errcode = '42501', message = 'fc_content_unavailable';
      end if;
      select * into v_topic from public.fc_topics where id = v_reply.topic_id for update;
      if v_topic.hidden or v_topic.withdrawn_at is not null then
        raise exception using errcode = '42501', message = 'fc_content_unavailable';
      end if;
    end if;
    if v_topic.closed then raise exception using errcode = '55000', message = 'fc_topic_closed'; end if;
    if v_kind = 'topic' then update public.fc_topics set body = v_body where id = v_id;
    else update public.fc_replies set body = v_body where id = v_id; end if;
    return jsonb_build_object('ok',true);

  elsif p_action = 'withdraw' then
    v_id := (p_data->>'id')::uuid;
    v_kind := p_data->>'kind';
    if v_kind = 'topic' then
      update public.fc_topics set title = 'Tema retirado', body = 'Aportación retirada por su autora.',
        hidden = true, closed = true, withdrawn_at = coalesce(withdrawn_at,now())
        where id = v_id and author_id = v_actor and not editorial returning * into v_topic;
    elsif v_kind = 'reply' then
      update public.fc_replies set body = 'Aportación retirada por su autora.',
        hidden = true, withdrawn_at = coalesce(withdrawn_at,now())
        where id = v_id and author_id = v_actor returning * into v_reply;
    else raise exception using errcode = '22023', message = 'fc_invalid_kind';
    end if;
    if not found then raise exception using errcode = '42501', message = 'fc_content_unavailable'; end if;
    return jsonb_build_object('ok',true);

  elsif p_action = 'toggle_save' then
    v_topic_id := (p_data->>'topic_id')::uuid;
    -- A member can always remove their own saved reference, even if moderation
    -- has since hidden its topic. New saves still require a visible topic.
    delete from public.fc_saved where user_id = v_actor and topic_id = v_topic_id;
    get diagnostics v_deleted = row_count;
    if v_deleted > 0 then return jsonb_build_object('saved',false); end if;
    select * into v_topic from public.fc_topics where id = v_topic_id;
    if not found or v_topic.hidden or v_topic.withdrawn_at is not null then
      raise exception using errcode = '42501', message = 'fc_content_unavailable';
    end if;
    insert into public.fc_saved(user_id,topic_id) values (v_actor,v_topic_id);
    return jsonb_build_object('saved',true);

  elsif p_action = 'admit' then
    if v_member.role <> 'moderator' then raise exception using errcode = '42501', message = 'fc_moderator_required'; end if;
    v_target_user := (p_data->>'user_id')::uuid;
    v_status := p_data->>'status';
    if v_status is null or v_status not in ('active','suspended') or v_target_user is null or v_target_user = v_actor then
      raise exception using errcode = '22023', message = 'fc_invalid_admission';
    end if;
    update public.fc_members set status = v_status where user_id = v_target_user returning * into v_member;
    if not found then raise exception using errcode = '22023', message = 'fc_member_not_found'; end if;
    return to_jsonb(v_member);

  elsif p_action = 'moderate' then
    if v_member.role <> 'moderator' then raise exception using errcode = '42501', message = 'fc_moderator_required'; end if;
    v_id := (p_data->>'target_id')::uuid;
    v_action := p_data->>'action';
    if v_action = 'report_resolve' then
      update public.fc_reports set status = 'resolved' where id = v_id returning * into v_report;
      if not found then raise exception using errcode = '22023', message = 'fc_target_not_found'; end if;
    elsif v_action in ('topic_pin','topic_unpin','topic_close','topic_open','topic_hide','topic_show') then
      select * into v_topic from public.fc_topics where id = v_id for update;
      if not found then raise exception using errcode = '22023', message = 'fc_target_not_found'; end if;
      if v_topic.withdrawn_at is not null and v_action = 'topic_show' then
        raise exception using errcode = '55000', message = 'fc_content_withdrawn';
      end if;
      update public.fc_topics set
        pinned = case when v_action = 'topic_pin' then true when v_action = 'topic_unpin' then false else pinned end,
        closed = case when v_action = 'topic_close' then true when v_action = 'topic_open' then false else closed end,
        hidden = case when v_action = 'topic_hide' then true when v_action = 'topic_show' then false else hidden end
        where id = v_id;
    elsif v_action in ('reply_hide','reply_show') then
      select * into v_reply from public.fc_replies where id = v_id for update;
      if not found then raise exception using errcode = '22023', message = 'fc_target_not_found'; end if;
      if v_reply.withdrawn_at is not null and v_action = 'reply_show' then
        raise exception using errcode = '55000', message = 'fc_content_withdrawn';
      end if;
      update public.fc_replies set hidden = (v_action = 'reply_hide') where id = v_id;
    else raise exception using errcode = '22023', message = 'fc_invalid_moderation';
    end if;
    return jsonb_build_object('ok',true);
  end if;
  raise exception using errcode = '22023', message = 'fc_unknown_action';
end;
$$;
revoke all on function fc_private.mutate(text,jsonb) from public, anon, authenticated;
grant execute on function fc_private.mutate(text,jsonb) to authenticated;

create or replace function public.fc_join(p_alias text) returns jsonb
language sql security invoker set search_path = '' as $$
  select fc_private.mutate('join',jsonb_build_object('alias',p_alias)); $$;
create or replace function public.fc_profile(p_alias text) returns jsonb
language sql security invoker set search_path = '' as $$
  select fc_private.mutate('profile',jsonb_build_object('alias',p_alias)); $$;
create or replace function public.fc_create_topic(p_category text,p_title text,p_body text) returns jsonb
language sql security invoker set search_path = '' as $$
  select fc_private.mutate('create_topic',jsonb_build_object('category',p_category,'title',p_title,'body',p_body)); $$;
create or replace function public.fc_reply(p_topic_id uuid,p_body text) returns jsonb
language sql security invoker set search_path = '' as $$
  select fc_private.mutate('reply',jsonb_build_object('topic_id',p_topic_id,'body',p_body)); $$;
create or replace function public.fc_report(p_topic_id uuid,p_reply_id uuid,p_body text) returns jsonb
language sql security invoker set search_path = '' as $$
  select fc_private.mutate('report',jsonb_build_object('topic_id',p_topic_id,'reply_id',p_reply_id,'body',p_body)); $$;
create or replace function public.fc_edit(p_kind text,p_id uuid,p_body text) returns jsonb
language sql security invoker set search_path = '' as $$
  select fc_private.mutate('edit',jsonb_build_object('kind',p_kind,'id',p_id,'body',p_body)); $$;
create or replace function public.fc_withdraw(p_kind text,p_id uuid) returns jsonb
language sql security invoker set search_path = '' as $$
  select fc_private.mutate('withdraw',jsonb_build_object('kind',p_kind,'id',p_id)); $$;
create or replace function public.fc_toggle_save(p_topic_id uuid) returns jsonb
language sql security invoker set search_path = '' as $$
  select fc_private.mutate('toggle_save',jsonb_build_object('topic_id',p_topic_id)); $$;
create or replace function public.fc_admit(p_user_id uuid,p_status text) returns jsonb
language sql security invoker set search_path = '' as $$
  select fc_private.mutate('admit',jsonb_build_object('user_id',p_user_id,'status',p_status)); $$;
create or replace function public.fc_moderate(p_action text,p_target_id uuid) returns jsonb
language sql security invoker set search_path = '' as $$
  select fc_private.mutate('moderate',jsonb_build_object('action',p_action,'target_id',p_target_id)); $$;

revoke all on function public.fc_join(text), public.fc_profile(text), public.fc_create_topic(text,text,text),
  public.fc_reply(uuid,text), public.fc_report(uuid,uuid,text), public.fc_edit(text,uuid,text),
  public.fc_withdraw(text,uuid), public.fc_toggle_save(uuid), public.fc_admit(uuid,text), public.fc_moderate(text,uuid)
  from public, anon, authenticated;
grant execute on function public.fc_join(text), public.fc_profile(text), public.fc_create_topic(text,text,text),
  public.fc_reply(uuid,text), public.fc_report(uuid,uuid,text), public.fc_edit(text,uuid,text),
  public.fc_withdraw(text,uuid), public.fc_toggle_save(uuid), public.fc_admit(uuid,text), public.fc_moderate(text,uuid)
  to authenticated;

commit;
