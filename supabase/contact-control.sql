-- SensualXcape Connect: contact control, isolated laboratory only.
-- Apply after setup.sql and reliable-send.sql. No existing room/message is deleted.
-- History remains readable by its original members after blocking; new contact stops.
-- Public RPCs are SECURITY INVOKER; privileged implementations remain in sx_private.
begin;

do $$ begin
  if to_regclass('public.sx_rooms') is null or to_regclass('public.sx_room_members') is null
     or to_regclass('public.sx_messages') is null then
    raise exception 'Apply the Connect laboratory setup first';
  end if;
end $$;

revoke all on schema sx_private from public, anon, authenticated;
grant usage on schema sx_private to authenticated;

create table if not exists public.sx_contact_invites (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  code uuid not null unique default gen_random_uuid(),
  label text not null check (length(btrim(label)) between 1 and 80),
  created_at timestamptz not null default now()
);
create table if not exists public.sx_contacts (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  requester_label text not null check (length(btrim(requester_label)) between 1 and 80),
  recipient_label text not null check (length(btrim(recipient_label)) between 1 and 80),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  room_id uuid unique references public.sx_rooms(id),
  created_at timestamptz not null default now(),
  check (requester_id <> recipient_id),
  check ((status = 'accepted' and room_id is not null)
      or (status in ('pending', 'rejected') and room_id is null))
);
create unique index if not exists sx_contacts_pair_key
  on public.sx_contacts(least(requester_id, recipient_id), greatest(requester_id, recipient_id));
create index if not exists sx_contacts_requester_idx on public.sx_contacts(requester_id, created_at desc);
create index if not exists sx_contacts_recipient_idx on public.sx_contacts(recipient_id, created_at desc);
create table if not exists public.sx_contact_blocks (
  contact_id uuid not null references public.sx_contacts(id) on delete cascade,
  blocker_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(contact_id, blocker_id)
);
create index if not exists sx_contact_blocks_owner_idx on public.sx_contact_blocks(blocker_id);

alter table public.sx_contact_invites enable row level security;
alter table public.sx_contacts enable row level security;
alter table public.sx_contact_blocks enable row level security;
revoke all on public.sx_contact_invites, public.sx_contacts, public.sx_contact_blocks from public, anon, authenticated;
grant select on public.sx_contact_invites, public.sx_contacts, public.sx_contact_blocks to authenticated;
drop policy if exists sx_contact_invites_owner_read on public.sx_contact_invites;
create policy sx_contact_invites_owner_read on public.sx_contact_invites for select to authenticated
  using (owner_id = (select auth.uid()));
drop policy if exists sx_contacts_participant_read on public.sx_contacts;
create policy sx_contacts_participant_read on public.sx_contacts for select to authenticated
  using (requester_id = (select auth.uid()) or recipient_id = (select auth.uid()));
drop policy if exists sx_contact_blocks_owner_read on public.sx_contact_blocks;
create policy sx_contact_blocks_owner_read on public.sx_contact_blocks for select to authenticated
  using (blocker_id = (select auth.uid()));

-- All mutating paths take the same transaction-level pair mutex. Hash collisions
-- merely serialize unrelated pairs. A VOLATILE caller performs authorization reads
-- AFTER this wait under READ COMMITTED, so a committed block cannot be missed.
create or replace function sx_private.sx_lock_contact_pair(p_a uuid, p_b uuid)
returns void language plpgsql volatile security invoker set search_path = '' as $$
begin
  if p_a is null or p_b is null or p_a = p_b then
    raise exception using errcode = '22023', message = 'Par de contacto no válido';
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = '25000', message = 'El control de contacto requiere READ COMMITTED';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'sx-contact:' || least(p_a, p_b)::text || ':' || greatest(p_a, p_b)::text, 0));
end $$;

create or replace function sx_private.sx_pair_is_blocked(p_a uuid, p_b uuid)
returns boolean language sql volatile security invoker set search_path = '' as $$
  select exists (
    select 1 from public.sx_contacts c join public.sx_contact_blocks b on b.contact_id = c.id
    where least(c.requester_id, c.recipient_id) = least(p_a, p_b)
      and greatest(c.requester_id, c.recipient_id) = greatest(p_a, p_b)
  );
$$;

create or replace function sx_private.sx_contact_invite(p_label text)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_code uuid;
begin
  if v_actor is null then raise exception using errcode = '42501', message = 'Autenticación requerida'; end if;
  if p_label is null or length(btrim(p_label)) not between 1 and 80 then
    raise exception using errcode = '22023', message = 'Escribe un nombre de 1 a 80 caracteres';
  end if;
  insert into public.sx_contact_invites(owner_id, label) values(v_actor, btrim(p_label))
    on conflict(owner_id) do update set label = excluded.label returning code into v_code;
  return v_code;
end $$;

create or replace function sx_private.sx_request_contact(p_invite_code uuid, p_label text)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_invite public.sx_contact_invites%rowtype; v_contact public.sx_contacts%rowtype;
begin
  if v_actor is null then raise exception using errcode = '42501', message = 'Autenticación requerida'; end if;
  if p_label is null or length(btrim(p_label)) not between 1 and 80 then
    raise exception using errcode = '22023', message = 'Escribe un nombre de 1 a 80 caracteres';
  end if;
  select * into v_invite from public.sx_contact_invites where code = p_invite_code;
  if not found then raise exception using errcode = '42501', message = 'Este contacto no está disponible'; end if;
  if v_actor = v_invite.owner_id then raise exception using errcode = '22023', message = 'No puedes solicitar hablar contigo'; end if;
  perform sx_private.sx_lock_contact_pair(v_actor, v_invite.owner_id);
  if sx_private.sx_pair_is_blocked(v_actor, v_invite.owner_id) then
    raise exception using errcode = '42501', message = 'Este contacto no está disponible';
  end if;
  select * into v_contact from public.sx_contacts
    where least(requester_id, recipient_id) = least(v_actor, v_invite.owner_id)
      and greatest(requester_id, recipient_id) = greatest(v_actor, v_invite.owner_id);
  if found then
    if v_contact.status = 'rejected' then raise exception using errcode = '42501', message = 'Este contacto no está disponible'; end if;
    return v_contact.id;
  end if;
  insert into public.sx_contacts(requester_id, recipient_id, requester_label, recipient_label)
    values(v_actor, v_invite.owner_id, btrim(p_label), v_invite.label) returning * into v_contact;
  return v_contact.id;
end $$;

create or replace function sx_private.sx_decide_contact(p_contact_id uuid, p_accept boolean)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_contact public.sx_contacts%rowtype; v_room uuid;
begin
  if v_actor is null then raise exception using errcode = '42501', message = 'Autenticación requerida'; end if;
  if p_accept is null then raise exception using errcode = '22023', message = 'Elige aceptar o rechazar'; end if;
  select * into v_contact from public.sx_contacts where id = p_contact_id;
  if not found or v_contact.recipient_id <> v_actor then
    raise exception using errcode = '42501', message = 'Esta solicitud no está disponible';
  end if;
  perform sx_private.sx_lock_contact_pair(v_contact.requester_id, v_contact.recipient_id);
  select * into v_contact from public.sx_contacts where id = p_contact_id for update;
  if p_accept and sx_private.sx_pair_is_blocked(v_contact.requester_id, v_contact.recipient_id) then
    raise exception using errcode = '42501', message = 'Este contacto no está disponible';
  end if;
  if v_contact.status = 'accepted' then
    if p_accept then return v_contact.room_id; end if;
    raise exception using errcode = '42501', message = 'La solicitud ya está resuelta';
  elsif v_contact.status = 'rejected' then
    if not p_accept then return null; end if;
    raise exception using errcode = '42501', message = 'La solicitud ya está resuelta';
  elsif not p_accept then
    update public.sx_contacts set status = 'rejected' where id = p_contact_id;
    return null;
  end if;
  insert into public.sx_rooms(created_by) values(v_actor) returning id into v_room;
  insert into public.sx_room_members(room_id, user_id)
    values(v_room, v_contact.requester_id), (v_room, v_contact.recipient_id);
  update public.sx_contacts set status = 'accepted', room_id = v_room where id = p_contact_id;
  return v_room;
end $$;

create or replace function sx_private.sx_set_contact_block(p_contact_id uuid, p_blocked boolean)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_contact public.sx_contacts%rowtype;
begin
  if v_actor is null then raise exception using errcode = '42501', message = 'Autenticación requerida'; end if;
  if p_blocked is null then raise exception using errcode = '22023', message = 'Elige bloquear o desbloquear'; end if;
  select * into v_contact from public.sx_contacts where id = p_contact_id;
  if not found or v_actor not in (v_contact.requester_id, v_contact.recipient_id) then
    raise exception using errcode = '42501', message = 'Este contacto no está disponible';
  end if;
  perform sx_private.sx_lock_contact_pair(v_contact.requester_id, v_contact.recipient_id);
  if p_blocked then
    insert into public.sx_contact_blocks(contact_id, blocker_id) values(p_contact_id, v_actor) on conflict do nothing;
  else
    delete from public.sx_contact_blocks where contact_id = p_contact_id and blocker_id = v_actor;
  end if;
  -- Removing my block cannot remove the other person's block.
  return sx_private.sx_pair_is_blocked(v_contact.requester_id, v_contact.recipient_id);
end $$;

create or replace function sx_private.sx_list_contacts()
returns table(id uuid, direction text, counterpart_label text, status text, room_id uuid,
  blocked boolean, blocked_by_me boolean, created_at timestamptz)
language plpgsql volatile security definer set search_path = '' as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception using errcode = '42501', message = 'Autenticación requerida'; end if;
  return query select c.id,
    case when c.recipient_id = v_actor then 'incoming'::text else 'outgoing'::text end,
    case when c.recipient_id = v_actor then c.requester_label else c.recipient_label end,
    c.status, c.room_id,
    exists(select 1 from public.sx_contact_blocks b where b.contact_id = c.id),
    exists(select 1 from public.sx_contact_blocks b where b.contact_id = c.id and b.blocker_id = v_actor),
    c.created_at
  from public.sx_contacts c where v_actor in (c.requester_id, c.recipient_id)
  order by c.created_at desc, c.id;
end $$;

-- Guard EVERY direct INSERT, including legacy clients. Existing SELECT RLS stays:
-- blocking never destroys a participant's history or grants an outsider access.
-- The old create/join paths below cannot add memberships. Acceptance publishes
-- a new room and its two immutable members atomically. No room mutex is needed:
-- all sends/contact mutations use the pair mutex without inverting lock order.
create or replace function sx_private.sx_guard_contact_message()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_other uuid; v_contact public.sx_contacts%rowtype; v_room uuid;
begin
  if v_actor is null or new.sender_id <> v_actor then
    raise exception using errcode = '42501', message = 'No puedes enviar este mensaje';
  end if;
  select id into v_room from public.sx_rooms where id = new.room_id;
  if not found or not exists(select 1 from public.sx_room_members where room_id = new.room_id and user_id = v_actor) then
    raise exception using errcode = '42501', message = 'No puedes enviar en esta conversación';
  end if;
  for v_other in select user_id from public.sx_room_members
    where room_id = new.room_id and user_id <> v_actor order by user_id loop
    perform sx_private.sx_lock_contact_pair(v_actor, v_other);
    if sx_private.sx_pair_is_blocked(v_actor, v_other) then
      raise exception using errcode = '42501', message = 'Este contacto no está disponible';
    end if;
  end loop;
  select * into v_contact from public.sx_contacts where room_id = new.room_id;
  if found and (v_contact.status <> 'accepted'
    or v_actor not in (v_contact.requester_id, v_contact.recipient_id)
    or (select count(*) from public.sx_room_members where room_id = new.room_id) <> 2) then
    raise exception using errcode = '42501', message = 'Esta conversación no está disponible';
  end if;
  return new;
end $$;
drop trigger if exists sx_messages_contact_guard on public.sx_messages;
create trigger sx_messages_contact_guard before insert on public.sx_messages
  for each row execute function sx_private.sx_guard_contact_message();

-- Close the old bearer-code creation/join path. Existing public invokers stay;
-- previous members can recover their old room, but no new member can join it.
create or replace function sx_private.sx_create_chat()
returns uuid language plpgsql volatile security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'Autenticación requerida'; end if;
  raise exception using errcode = '42501', message = 'Las conversaciones nuevas requieren una solicitud aceptada';
end $$;

create or replace function sx_private.sx_join_chat(p_room_id uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_room uuid; v_other uuid;
begin
  if v_actor is null then raise exception using errcode = '42501', message = 'Autenticación requerida'; end if;
  select id into v_room from public.sx_rooms where id = p_room_id;
  if not found or not exists(select 1 from public.sx_room_members where room_id = p_room_id and user_id = v_actor) then
    raise exception using errcode = '42501', message = 'Las conversaciones nuevas requieren una solicitud aceptada';
  end if;
  for v_other in select user_id from public.sx_room_members
    where room_id = p_room_id and user_id <> v_actor order by user_id loop
    perform sx_private.sx_lock_contact_pair(v_actor, v_other);
    if sx_private.sx_pair_is_blocked(v_actor, v_other) then
      raise exception using errcode = '42501', message = 'Este contacto no está disponible';
    end if;
  end loop;
  return true;
end $$;

create or replace function public.sx_contact_invite(p_label text)
returns uuid language sql volatile security invoker set search_path = '' as $$ select sx_private.sx_contact_invite(p_label); $$;
create or replace function public.sx_request_contact(p_invite_code uuid, p_label text)
returns uuid language sql volatile security invoker set search_path = '' as $$ select sx_private.sx_request_contact(p_invite_code, p_label); $$;
create or replace function public.sx_decide_contact(p_contact_id uuid, p_accept boolean)
returns uuid language sql volatile security invoker set search_path = '' as $$ select sx_private.sx_decide_contact(p_contact_id, p_accept); $$;
create or replace function public.sx_set_contact_block(p_contact_id uuid, p_blocked boolean)
returns boolean language sql volatile security invoker set search_path = '' as $$ select sx_private.sx_set_contact_block(p_contact_id, p_blocked); $$;
create or replace function public.sx_list_contacts()
returns table(id uuid, direction text, counterpart_label text, status text, room_id uuid,
  blocked boolean, blocked_by_me boolean, created_at timestamptz)
language sql volatile security invoker set search_path = '' as $$ select * from sx_private.sx_list_contacts(); $$;

revoke all on function sx_private.sx_lock_contact_pair(uuid, uuid), sx_private.sx_pair_is_blocked(uuid, uuid),
  sx_private.sx_guard_contact_message() from public, anon, authenticated;
revoke all on function sx_private.sx_contact_invite(text), sx_private.sx_request_contact(uuid, text),
  sx_private.sx_decide_contact(uuid, boolean), sx_private.sx_set_contact_block(uuid, boolean),
  sx_private.sx_list_contacts(), sx_private.sx_create_chat(), sx_private.sx_join_chat(uuid) from public, anon, authenticated;
grant execute on function sx_private.sx_contact_invite(text), sx_private.sx_request_contact(uuid, text),
  sx_private.sx_decide_contact(uuid, boolean), sx_private.sx_set_contact_block(uuid, boolean),
  sx_private.sx_list_contacts(), sx_private.sx_create_chat(), sx_private.sx_join_chat(uuid) to authenticated;
revoke all on function public.sx_contact_invite(text), public.sx_request_contact(uuid, text),
  public.sx_decide_contact(uuid, boolean), public.sx_set_contact_block(uuid, boolean), public.sx_list_contacts()
  from public, anon, authenticated;
grant execute on function public.sx_contact_invite(text), public.sx_request_contact(uuid, text),
  public.sx_decide_contact(uuid, boolean), public.sx_set_contact_block(uuid, boolean), public.sx_list_contacts()
  to authenticated;

comment on table public.sx_contacts is 'Laboratory contact consent. Rejection is terminal per account pair; blocks are independent and voluntary.';
comment on function public.sx_set_contact_block(uuid, boolean) is 'Sets only the actor block. Returns whether any block remains; list exposes only the actor own block flag.';
comment on function public.sx_contact_invite(text) is 'Stable private owner code permits requesting contact only, never room membership or history access.';
commit;
