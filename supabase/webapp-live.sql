-- SensualXcape Web V2: additive contact consent over the existing Connect data.
-- Existing rooms, memberships and message rows stay intact. No Auth/SMTP/forum changes.
-- Requires the existing sx_* transport schema and READ COMMITTED transactions.
begin;

do $$ begin
  if to_regclass('public.sx_rooms') is null or to_regclass('public.sx_room_members') is null
     or to_regclass('public.sx_messages') is null then
    raise exception 'Apply the Connect laboratory setup first';
  end if;
end $$;

-- Preserve legacy NULL retry keys while making new V2 retries deterministic.
alter table public.sx_messages add column if not exists client_message_id uuid;
create unique index if not exists sx_messages_sender_client_id_key on public.sx_messages(sender_id,client_message_id);
-- Keep historical RLS and Realtime unchanged. Clients cannot alter memberships,
-- author identities, history or consent by writing tables directly.
revoke all on public.sx_rooms,public.sx_room_members,public.sx_messages from public,anon,authenticated;
grant select on public.sx_rooms,public.sx_room_members to authenticated;
grant select,insert on public.sx_messages to authenticated;
grant usage on sequence public.sx_messages_id_seq to authenticated;

create schema if not exists sx_private;

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
do $policy$ begin
  if exists(select 1 from pg_policies where schemaname='public' and tablename='sx_contact_invites' and policyname='sx_contact_invites_owner_read') then
    alter policy sx_contact_invites_owner_read on public.sx_contact_invites to authenticated using (owner_id = (select auth.uid()));
  else
    create policy sx_contact_invites_owner_read on public.sx_contact_invites for select to authenticated using (owner_id = (select auth.uid()));
  end if;
end $policy$;
do $policy$ begin
  if exists(select 1 from pg_policies where schemaname='public' and tablename='sx_contacts' and policyname='sx_contacts_participant_read') then
    alter policy sx_contacts_participant_read on public.sx_contacts to authenticated using (requester_id = (select auth.uid()) or recipient_id = (select auth.uid()));
  else
    create policy sx_contacts_participant_read on public.sx_contacts for select to authenticated using (requester_id = (select auth.uid()) or recipient_id = (select auth.uid()));
  end if;
end $policy$;
do $policy$ begin
  if exists(select 1 from pg_policies where schemaname='public' and tablename='sx_contact_blocks' and policyname='sx_contact_blocks_owner_read') then
    alter policy sx_contact_blocks_owner_read on public.sx_contact_blocks to authenticated using (blocker_id = (select auth.uid()));
  else
    create policy sx_contact_blocks_owner_read on public.sx_contact_blocks for select to authenticated using (blocker_id = (select auth.uid()));
  end if;
end $policy$;

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
declare v_actor uuid := auth.uid(); v_invite public.sx_contact_invites%rowtype; v_contact public.sx_contacts%rowtype; v_room uuid;
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
  -- A two-person legacy history already records consent. Adopt that exact pair
  -- instead of creating a contradictory pending request. The earlier explicit
  -- contact-status branch above always takes precedence (including rejection).
  select r.id into v_room from public.sx_rooms r
   where exists(select 1 from public.sx_room_members x where x.room_id=r.id and x.user_id=v_actor)
    and exists(select 1 from public.sx_room_members x where x.room_id=r.id and x.user_id=v_invite.owner_id)
    and (select count(*) from public.sx_room_members x where x.room_id=r.id)=2
    and not exists(select 1 from public.sx_contacts c where c.room_id=r.id)
   order by r.created_at,r.id limit 1;
  insert into public.sx_contacts(requester_id,recipient_id,requester_label,recipient_label,status,room_id)
    values(v_actor,v_invite.owner_id,btrim(p_label),v_invite.label,case when v_room is null then 'pending' else 'accepted' end,v_room) returning * into v_contact;
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
  -- Reuse an existing two-person history for this exact pair, deterministically.
  -- Other historical rooms are still listed/readable; nothing is merged/deleted.
  select r.id into v_room from public.sx_rooms r
   where exists(select 1 from public.sx_room_members x where x.room_id=r.id and x.user_id=v_contact.requester_id)
    and exists(select 1 from public.sx_room_members x where x.room_id=r.id and x.user_id=v_contact.recipient_id)
    and (select count(*) from public.sx_room_members x where x.room_id=r.id)=2
    and not exists(select 1 from public.sx_contacts c where c.room_id=r.id and c.id<>p_contact_id)
   order by r.created_at,r.id limit 1;
  if v_room is null then
   insert into public.sx_rooms(created_by) values(v_actor) returning id into v_room;
   insert into public.sx_room_members(room_id, user_id)
     values(v_room, v_contact.requester_id), (v_room, v_contact.recipient_id);
  end if;
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
  if (select count(*) from public.sx_room_members where room_id=new.room_id)<>2 then
    raise exception using errcode='42501',message='Esta conversación necesita dos participantes aceptados';
  end if;
  for v_other in select user_id from public.sx_room_members
    where room_id = new.room_id and user_id <> v_actor order by user_id loop
    perform sx_private.sx_lock_contact_pair(v_actor, v_other);
    if sx_private.sx_pair_is_blocked(v_actor, v_other) then
      raise exception using errcode = '42501', message = 'Este contacto no está disponible';
    end if;
    if exists(select 1 from public.sx_contacts c where least(c.requester_id,c.recipient_id)=least(v_actor,v_other)
      and greatest(c.requester_id,c.recipient_id)=greatest(v_actor,v_other) and c.status<>'accepted')then
      raise exception using errcode='42501',message='Esta conversación no está disponible para mensajes nuevos';
    end if;
  end loop;
  select * into v_contact from public.sx_contacts where room_id = new.room_id;
  if found and (v_contact.status <> 'accepted'
    or v_actor not in (v_contact.requester_id, v_contact.recipient_id)
    or (select count(*) from public.sx_room_members where room_id = new.room_id) <> 2) then
    raise exception using errcode = '42501', message = 'Esta conversación no está disponible';
  end if;
  -- Only future INSERTs are stamped; all historical rows remain byte-for-byte.
  new.created_at:=clock_timestamp();
  return new;
end $$;
create or replace trigger sx_messages_contact_guard before insert on public.sx_messages
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

comment on table public.sx_contacts is 'Private contact consent. Rejection is terminal per account pair; blocks are independent and voluntary.';
comment on function public.sx_set_contact_block(uuid, boolean) is 'Sets only the actor block. Returns whether any block remains; list exposes only the actor own block flag.';
comment on function public.sx_contact_invite(text) is 'Stable private owner code permits requesting contact only, never room membership or history access.';

-- Shared with the separate private-profile module. It answers only for the
-- current reader and never grants a forum moderator access to private contacts.
create or replace function sx_private.are_contacts(p_owner uuid,p_reader uuid)
returns boolean language sql volatile security definer set search_path='' as $$
 select auth.uid() is not null and p_reader=auth.uid() and p_owner<>p_reader
  and not sx_private.sx_pair_is_blocked(p_owner,p_reader)
  and coalesce((select c.status='accepted' from public.sx_contacts c
    where least(c.requester_id,c.recipient_id)=least(p_owner,p_reader) and greatest(c.requester_id,c.recipient_id)=greatest(p_owner,p_reader)),
   exists(select 1 from public.sx_room_members a join public.sx_room_members b on b.room_id=a.room_id
    where a.user_id=p_owner and b.user_id=p_reader and (select count(*) from public.sx_room_members x where x.room_id=a.room_id)=2));
$$;
revoke all on function sx_private.are_contacts(uuid,uuid) from public,anon,authenticated;
grant execute on function sx_private.are_contacts(uuid,uuid) to authenticated;

create or replace function sx_private.sx_set_room_block(p_room_id uuid,p_blocked boolean)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare v_actor uuid:=auth.uid();v_other uuid;v_contact uuid;
begin
 if v_actor is null then raise exception using errcode='42501',message='Autenticación requerida';end if;
 if p_blocked is null then raise exception using errcode='22023',message='Elige bloquear o desbloquear';end if;
 if not exists(select 1 from public.sx_room_members where room_id=p_room_id and user_id=v_actor)
  or (select count(*) from public.sx_room_members where room_id=p_room_id)<>2 then
  raise exception using errcode='42501',message='Esta conversación no está disponible';end if;
 select user_id into v_other from public.sx_room_members where room_id=p_room_id and user_id<>v_actor;
 perform sx_private.sx_lock_contact_pair(v_actor,v_other);
 select id into v_contact from public.sx_contacts where least(requester_id,recipient_id)=least(v_actor,v_other)
  and greatest(requester_id,recipient_id)=greatest(v_actor,v_other);
 if not found then
  -- Existing two-person membership is the sole evidence used to adopt legacy
  -- consent. No member is inserted, no guessed UUID creates a relationship.
  insert into public.sx_contacts(requester_id,recipient_id,requester_label,recipient_label,status,room_id)
   values(v_actor,v_other,'Conversación anterior','Conversación anterior','accepted',p_room_id) returning id into v_contact;
 end if;
 return sx_private.sx_set_contact_block(v_contact,p_blocked);
end;$$;

create or replace function sx_private.sx_list_conversations(p_limit integer,p_before timestamptz,p_before_room uuid)
returns table(room_id uuid,contact_id uuid,counterpart_id uuid,counterpart_label text,legacy boolean,
 blocked boolean,blocked_by_me boolean,can_send boolean,created_at timestamptz,last_message_id bigint,last_message_at timestamptz,activity_at timestamptz)
language plpgsql volatile security definer set search_path='' as $$
declare v_actor uuid:=auth.uid();
begin
 if v_actor is null then raise exception using errcode='42501',message='Autenticación requerida';end if;
 if p_limit is null or p_limit not between 1 and 100 or(p_before is null and p_before_room is not null)then
  raise exception using errcode='22023',message='Página de conversaciones no válida';end if;
 return query select q.* from (
  select r.id as room_id,c.id as contact_id,other.user_id as counterpart_id,
   case when c.id is null then 'Conversación anterior'::text when c.requester_id=v_actor then c.recipient_label else c.requester_label end,
   c.room_id is distinct from r.id,
   exists(select 1 from public.sx_contact_blocks b where b.contact_id=c.id),
   exists(select 1 from public.sx_contact_blocks b where b.contact_id=c.id and b.blocker_id=v_actor),
   members.n=2 and(c.id is null or c.status='accepted')and not exists(select 1 from public.sx_contact_blocks b where b.contact_id=c.id),
   r.created_at,last_message.id,last_message.created_at,coalesce(last_message.created_at,r.created_at) as activity_at
  from public.sx_room_members own join public.sx_rooms r on r.id=own.room_id
  cross join lateral(select count(*) n from public.sx_room_members m where m.room_id=r.id)members
  left join lateral(select m.user_id from public.sx_room_members m where m.room_id=r.id and m.user_id<>v_actor and members.n=2 limit 1)other on true
  left join public.sx_contacts c on least(c.requester_id,c.recipient_id)=least(v_actor,other.user_id)
    and greatest(c.requester_id,c.recipient_id)=greatest(v_actor,other.user_id) and other.user_id is not null
  left join lateral(select m.id,m.created_at from public.sx_messages m where m.room_id=r.id order by m.id desc limit 1)last_message on true
  where own.user_id=v_actor
 )q where p_before is null or q.activity_at<p_before or(q.activity_at=p_before and p_before_room is not null and q.room_id<p_before_room)
 order by q.activity_at desc,q.room_id desc limit p_limit;
end;$$;

create or replace function sx_private.sx_send_message(p_room_id uuid,p_body text,p_client_message_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_actor uuid:=auth.uid();m public.sx_messages%rowtype;v_body text:=btrim(p_body);
begin
 if v_actor is null then raise exception using errcode='42501',message='Autenticación requerida';end if;
 if not exists(select 1 from public.sx_room_members where room_id=p_room_id and user_id=v_actor)then raise exception using errcode='42501',message='No puedes enviar en esta conversación';end if;
 if p_client_message_id is null or v_body is null or char_length(v_body)not between 1 and 2000 then raise exception using errcode='22023',message='Mensaje no válido';end if;
 select * into m from public.sx_messages where sender_id=v_actor and client_message_id=p_client_message_id;
 if not found then
  insert into public.sx_messages(room_id,sender_id,body,client_message_id)values(p_room_id,v_actor,v_body,p_client_message_id)
   on conflict(sender_id,client_message_id)do nothing returning * into m;
  if not found then select * into m from public.sx_messages where sender_id=v_actor and client_message_id=p_client_message_id;end if;
 end if;
 if m.room_id is distinct from p_room_id or m.body is distinct from v_body then raise exception using errcode='22023',message='La clave de reintento ya corresponde a otro mensaje';end if;
 return to_jsonb(m);
end;$$;

create or replace function sx_private.sx_messages_page(p_room_id uuid,p_limit integer,p_before_id bigint)
returns setof public.sx_messages language plpgsql volatile security definer set search_path='' as $$
declare v_actor uuid:=auth.uid();
begin
 if v_actor is null or not exists(select 1 from public.sx_room_members where room_id=p_room_id and user_id=v_actor)then raise exception using errcode='42501',message='Esta conversación no está disponible';end if;
 if p_limit is null or p_limit not between 1 and 150 or(p_before_id is not null and p_before_id<=0)then raise exception using errcode='22023',message='Página de mensajes no válida';end if;
 return query select page.* from(select m.* from public.sx_messages m where m.room_id=p_room_id and(p_before_id is null or m.id<p_before_id)order by m.id desc limit p_limit)page order by page.id;
end;$$;

revoke all on function sx_private.sx_set_room_block(uuid,boolean),sx_private.sx_list_conversations(integer,timestamptz,uuid),sx_private.sx_send_message(uuid,text,uuid),sx_private.sx_messages_page(uuid,integer,bigint)from public,anon,authenticated;
grant execute on function sx_private.sx_set_room_block(uuid,boolean),sx_private.sx_list_conversations(integer,timestamptz,uuid),sx_private.sx_send_message(uuid,text,uuid),sx_private.sx_messages_page(uuid,integer,bigint)to authenticated;
create or replace function public.sx_set_room_block(p_room_id uuid,p_blocked boolean)returns boolean language sql volatile security invoker set search_path='' as $$select sx_private.sx_set_room_block(p_room_id,p_blocked);$$;
create or replace function public.sx_list_conversations(p_limit integer default 50,p_before timestamptz default null,p_before_room uuid default null)
returns table(room_id uuid,contact_id uuid,counterpart_id uuid,counterpart_label text,legacy boolean,blocked boolean,blocked_by_me boolean,can_send boolean,created_at timestamptz,last_message_id bigint,last_message_at timestamptz,activity_at timestamptz)
language sql volatile security invoker set search_path='' as $$select * from sx_private.sx_list_conversations(p_limit,p_before,p_before_room);$$;
create or replace function public.sx_send_message(p_room_id uuid,p_body text,p_client_message_id uuid)returns jsonb language sql volatile security invoker set search_path='' as $$select sx_private.sx_send_message(p_room_id,p_body,p_client_message_id);$$;
create or replace function public.sx_messages_page(p_room_id uuid,p_limit integer default 100,p_before_id bigint default null)returns setof public.sx_messages language sql volatile security invoker set search_path='' as $$select * from sx_private.sx_messages_page(p_room_id,p_limit,p_before_id);$$;
revoke all on function public.sx_set_room_block(uuid,boolean),public.sx_list_conversations(integer,timestamptz,uuid),public.sx_send_message(uuid,text,uuid),public.sx_messages_page(uuid,integer,bigint)from public,anon,authenticated;
grant execute on function public.sx_set_room_block(uuid,boolean),public.sx_list_conversations(integer,timestamptz,uuid),public.sx_send_message(uuid,text,uuid),public.sx_messages_page(uuid,integer,bigint)to authenticated;

-- Shared-device logout needs only the opaque binding ID captured for the old
-- Auth session. This neither registers a device nor reveals endpoints/keys, and
-- deliberately remains usable if forum membership was suspended meanwhile.
create or replace function sx_private.sx_push_binding(p_endpoint text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_actor uuid:=auth.uid();v_id uuid;
begin
 if v_actor is null then raise exception using errcode='42501',message='Autenticación requerida';end if;
 if p_endpoint is null or char_length(p_endpoint)>2048 or to_regclass('fc_private.push_subscriptions')is null then return jsonb_build_object('id',null);end if;
 select id into v_id from fc_private.push_subscriptions where user_id=v_actor and endpoint=p_endpoint;
 return jsonb_build_object('id',v_id);
end;$$;
revoke all on function sx_private.sx_push_binding(text)from public,anon,authenticated,service_role;
grant execute on function sx_private.sx_push_binding(text)to authenticated;
create or replace function public.sx_push_binding(p_endpoint text)returns jsonb language sql volatile security invoker set search_path='' as $$select sx_private.sx_push_binding(p_endpoint);$$;
revoke all on function public.sx_push_binding(text)from public,anon,authenticated,service_role;
grant execute on function public.sx_push_binding(text)to authenticated;
commit;
