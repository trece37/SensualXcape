-- SensualXCape Connect / prueba de concepto aislada. Ejecutar EN UN PROYECTO SUPABASE DE PRUEBAS.
-- Nunca sobreescribe otras tablas; objetos prefijados con sx_. No ejecutar en producción sin revisión.
-- Usuarios: 2 cuentas distintas, una sala, mensajes accesibles solo a quienes pertenecen a ella.

begin;

create table if not exists public.sx_rooms (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.sx_room_members (
  room_id uuid not null references public.sx_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key(room_id, user_id)
);
create index if not exists sx_room_members_user_idx on public.sx_room_members(user_id);

create table if not exists public.sx_messages (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.sx_rooms(id) on delete cascade,
  sender_id uuid not null references auth.users(id),
  body text not null check (length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists sx_messages_room_id_idx on public.sx_messages(room_id, id);

alter table public.sx_rooms enable row level security;
alter table public.sx_room_members enable row level security;
alter table public.sx_messages enable row level security;

revoke all on public.sx_rooms, public.sx_room_members, public.sx_messages from anon, authenticated;
grant select on public.sx_rooms, public.sx_room_members to authenticated;
grant select, insert on public.sx_messages to authenticated;
grant usage on sequence public.sx_messages_id_seq to authenticated;

drop policy if exists sx_rooms_member_read on public.sx_rooms;
create policy sx_rooms_member_read on public.sx_rooms for select to authenticated
using (exists (select 1 from public.sx_room_members m where m.room_id = id and m.user_id = (select auth.uid())));

drop policy if exists sx_room_members_self_read on public.sx_room_members;
create policy sx_room_members_self_read on public.sx_room_members for select to authenticated
using (user_id = (select auth.uid()));

drop policy if exists sx_messages_member_read on public.sx_messages;
create policy sx_messages_member_read on public.sx_messages for select to authenticated
using (exists (select 1 from public.sx_room_members m where m.room_id = sx_messages.room_id and m.user_id = (select auth.uid())));

drop policy if exists sx_messages_member_insert on public.sx_messages;
create policy sx_messages_member_insert on public.sx_messages for insert to authenticated
with check (
 sender_id = (select auth.uid())
 and exists (select 1 from public.sx_room_members m where m.room_id = sx_messages.room_id and m.user_id = (select auth.uid()))
);

-- Funciones con privilegios elevados quedan en un esquema NO EXPUESTO por la API.
-- Los RPC públicos son envoltorios SECURITY INVOKER restringidos a usuarios autenticados.
create schema if not exists sx_private;
revoke all on schema sx_private from public, anon, authenticated;
grant usage on schema sx_private to authenticated;

create or replace function sx_private.sx_create_chat()
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_room uuid;
begin
  if v_actor is null then raise exception 'Autenticación requerida'; end if;
  insert into public.sx_rooms(created_by) values (v_actor) returning id into v_room;
  insert into public.sx_room_members(room_id, user_id) values (v_room, v_actor);
  return v_room;
end;
$$;

create or replace function sx_private.sx_join_chat(p_room_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_room uuid; v_count int;
begin
  if v_actor is null then raise exception 'Autenticación requerida'; end if;
  -- Bloqueo por sala para que dos invitaciones simultáneas no añadan 3 participantes.
  select id into v_room from public.sx_rooms where id = p_room_id for update;
  if v_room is null then raise exception 'Sala inexistente o código incorrecto'; end if;
  if exists(select 1 from public.sx_room_members where room_id = p_room_id and user_id = v_actor) then return true; end if;
  select count(*) into v_count from public.sx_room_members where room_id = p_room_id;
  if v_count >= 2 then raise exception 'Esta sala ya tiene dos participantes'; end if;
  insert into public.sx_room_members(room_id,user_id) values(p_room_id,v_actor);
  return true;
end;
$$;

revoke all on function sx_private.sx_create_chat() from public, anon, authenticated;
revoke all on function sx_private.sx_join_chat(uuid) from public, anon, authenticated;
grant execute on function sx_private.sx_create_chat() to authenticated;
grant execute on function sx_private.sx_join_chat(uuid) to authenticated;

create or replace function public.sx_create_chat()
returns uuid language sql security invoker set search_path = '' as $$
  select sx_private.sx_create_chat();
$$;
create or replace function public.sx_join_chat(p_room_id uuid)
returns boolean language sql security invoker set search_path = '' as $$
  select sx_private.sx_join_chat(p_room_id);
$$;
revoke all on function public.sx_create_chat() from public, anon, authenticated;
revoke all on function public.sx_join_chat(uuid) from public, anon, authenticated;
grant execute on function public.sx_create_chat() to authenticated;
grant execute on function public.sx_join_chat(uuid) to authenticated;

commit;

-- Activar cambios en tiempo real para la tabla nueva. La publicación puede estar ya creada.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sx_messages') then
    execute 'alter publication supabase_realtime add table public.sx_messages';
  end if;
end;
$$;
