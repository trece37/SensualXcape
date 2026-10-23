-- Isolated Connect laboratory only. Apply setup.sql, reliable-send.sql and
-- contact-control.sql first. All actors, rooms, messages and contacts roll back.
-- This is sequential role/permission coverage, NOT a two-session race test.
begin isolation level read committed;
do $$
declare
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid();
  invite_a uuid; invite_b uuid; invite_c uuid; contact_ab uuid; contact_ac uuid;
  managed uuid; legacy uuid := gen_random_uuid(); spare_legacy uuid := gen_random_uuid(); retry_key uuid := gen_random_uuid();
  n integer; before_rooms integer; v_result boolean; v_sql text; v_denied boolean;
  view_row record;
begin
  insert into auth.users(id) values(a), (b), (c);
  -- Simulate two pre-migration rooms as fixtures using the test administrator.
  -- The NEW API deliberately cannot create old-style rooms or add their members.
  insert into public.sx_rooms(id, created_by) values(legacy, a), (spare_legacy, a);
  insert into public.sx_room_members(room_id, user_id) values(legacy, a), (legacy, b), (spare_legacy, a);
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', a::text, true);
  invite_a := public.sx_contact_invite('A receptora');
  if invite_a is null or public.sx_contact_invite('A receptora') is distinct from invite_a then raise exception 'QA stable owner invite'; end if;
  insert into public.sx_messages(room_id, sender_id, body) values(legacy, a, 'existing legacy history');
  v_denied := false;
  begin perform public.sx_create_chat(); exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'QA old creation path closed'; end if;
  perform set_config('request.jwt.claim.sub', b::text, true);
  invite_b := public.sx_contact_invite('B solicitante');
  perform public.sx_join_chat(legacy);
  contact_ab := public.sx_request_contact(invite_a, 'B solicitante');
  if contact_ab is null or public.sx_request_contact(invite_a, 'B changed retry') is distinct from contact_ab then raise exception 'QA request retry idempotency'; end if;
  select * into view_row from public.sx_list_contacts() where id = contact_ab;
  if not found or view_row.direction is distinct from 'outgoing' or view_row.counterpart_label is distinct from 'A receptora'
    or view_row.status is distinct from 'pending' or view_row.room_id is not null
    or view_row.blocked is distinct from false or view_row.blocked_by_me is distinct from false then
    raise exception 'QA outgoing pending contract';
  end if;
  select count(*) into n from public.sx_contact_invites where owner_id = a;
  if n <> 0 then raise exception 'QA invitation code is not a directory'; end if;

  -- Neither the requester nor an outsider can decide the recipient's request;
  -- direct writes cannot supply/reassign requester, recipient, status or members.
  foreach v_sql in array array[
    format('select public.sx_decide_contact(%L::uuid,true)', contact_ab),
    format('select public.sx_join_chat(%L::uuid)', spare_legacy),
    format('update public.sx_contacts set recipient_id=%L::uuid where id=%L::uuid', b, contact_ab),
    format('insert into public.sx_contacts(requester_id,recipient_id,requester_label,recipient_label) values(%L::uuid,%L::uuid,''spoof'',''spoof'')', a, b),
    format('insert into public.sx_contact_invites(owner_id,label) values(%L::uuid,''spoof'')', a),
    format('insert into public.sx_room_members(room_id,user_id) values(%L::uuid,%L::uuid)', legacy, c)
  ] loop
    v_denied := false;
    begin execute v_sql; exception when insufficient_privilege then v_denied := true; end;
    if not v_denied then raise exception 'QA requester/direct mutation bypass: %', v_sql; end if;
  end loop;

  perform set_config('request.jwt.claim.sub', a::text, true);
  if public.sx_request_contact(invite_b, 'A reverse request') is distinct from contact_ab then raise exception 'QA unordered pair uniqueness'; end if;
  select * into view_row from public.sx_list_contacts() where id = contact_ab;
  if not found or view_row.direction is distinct from 'incoming' or view_row.counterpart_label is distinct from 'B solicitante'
    or view_row.status is distinct from 'pending' then raise exception 'QA recipient pending contract'; end if;

  -- A second pair demonstrates terminal rejection independently of the accepted pair.
  perform set_config('request.jwt.claim.sub', c::text, true);
  invite_c := public.sx_contact_invite('C ajena');
  contact_ac := public.sx_request_contact(invite_a, 'C ajena');
  select count(*) into n from public.sx_contacts where id = contact_ab;
  if n <> 0 then raise exception 'QA outsider contact read'; end if;
  select count(*) into n from public.sx_list_contacts() where id = contact_ab;
  if n <> 0 then raise exception 'QA outsider contact list'; end if;
  v_denied := false;
  begin perform public.sx_decide_contact(contact_ab, true); exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'QA outsider decision'; end if;
  v_denied := false;
  begin perform public.sx_set_contact_block(contact_ab, true); exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'QA outsider block'; end if;
  perform public.sx_set_contact_block(contact_ac, true);

  perform set_config('request.jwt.claim.sub', a::text, true);
  v_denied := false;
  begin perform public.sx_decide_contact(contact_ac, true); exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'QA block prevents pending acceptance'; end if;
  if public.sx_decide_contact(contact_ac, false) is not null then raise exception 'QA rejection no room'; end if;
  if public.sx_decide_contact(contact_ac, false) is not null then raise exception 'QA rejection retry'; end if;
  v_denied := false;
  begin perform public.sx_decide_contact(contact_ac, true); exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'QA rejection cannot become acceptance'; end if;
  v_denied := false;
  begin perform public.sx_request_contact(invite_c, 'reverse after rejection'); exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'QA reverse request cannot reset rejection'; end if;
  perform set_config('request.jwt.claim.sub', c::text, true);
  if public.sx_set_contact_block(contact_ac, false) is distinct from false then raise exception 'QA rejected pair voluntary unblock'; end if;
  v_denied := false;
  begin perform public.sx_request_contact(invite_a, 'retry rejected'); exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'QA requester cannot reset rejection'; end if;
  v_denied := false;
  begin perform public.sx_join_chat(spare_legacy); exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'QA rejected pair cannot join old bearer-code room'; end if;

  -- Only A accepts; exactly one room and two memberships survive repeat acceptance.
  perform set_config('request.jwt.claim.sub', a::text, true);
  select count(*) into before_rooms from public.sx_rooms;
  managed := public.sx_decide_contact(contact_ab, true);
  if managed is null or public.sx_decide_contact(contact_ab, true) is distinct from managed then raise exception 'QA acceptance retry room'; end if;
  select count(*) into n from public.sx_rooms;
  if n <> before_rooms + 1 then raise exception 'QA acceptance creates one room'; end if;
  select * into view_row from public.sx_list_contacts() where id = contact_ab;
  if not found or view_row.status is distinct from 'accepted' or view_row.room_id is distinct from managed then raise exception 'QA accepted list contract'; end if;
  insert into public.sx_messages(room_id, sender_id, body, client_message_id)
    values(managed, a, 'A accepted message', retry_key);
  v_denied := false;
  begin insert into public.sx_messages(room_id, sender_id, body, client_message_id)
    values(managed, a, 'A accepted message', retry_key);
  exception when unique_violation then v_denied := true; end;
  if not v_denied then raise exception 'QA message retry must not duplicate'; end if;
  select count(*) into n from public.sx_messages where room_id = managed;
  if n <> 1 then raise exception 'QA exactly one retried message'; end if;
  perform set_config('request.jwt.claim.sub', b::text, true);
  v_denied := false;
  begin insert into public.sx_messages(room_id, sender_id, body) values(managed, a, 'member spoof');
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'QA member cannot spoof sender'; end if;
  insert into public.sx_messages(room_id, sender_id, body) values(managed, b, 'B reply');
  select count(*) into n from public.sx_messages where room_id = managed;
  if n <> 2 then raise exception 'QA accepted members read both'; end if;
  select count(*) into n from public.sx_room_members where room_id = managed;
  if n <> 1 then raise exception 'QA still only own membership readable'; end if;

  perform set_config('request.jwt.claim.sub', c::text, true);
  select count(*) into n from public.sx_messages where room_id = managed;
  if n <> 0 then raise exception 'QA outsider managed history'; end if;
  select count(*) into n from public.sx_rooms where id = managed;
  if n <> 0 then raise exception 'QA outsider managed room'; end if;
  select count(*) into n from public.sx_room_members where room_id = managed;
  if n <> 0 then raise exception 'QA outsider managed memberships'; end if;
  foreach v_sql in array array[
    format('select public.sx_join_chat(%L::uuid)', managed),
    format('select public.sx_join_chat(%L::uuid)', legacy),
    format('select public.sx_join_chat(%L::uuid)', spare_legacy),
    'select public.sx_create_chat()',
    format('insert into public.sx_messages(room_id,sender_id,body) values(%L::uuid,%L::uuid,''outsider'')', managed, c),
    format('insert into public.sx_messages(room_id,sender_id,body) values(%L::uuid,%L::uuid,''spoof'')', managed, a)
  ] loop
    v_denied := false;
    begin execute v_sql; exception when insufficient_privilege then v_denied := true; end;
    if not v_denied then raise exception 'QA outsider API/legacy bypass: %', v_sql; end if;
  end loop;

  -- B's voluntary block affects both directions, every old room and new joins.
  perform set_config('request.jwt.claim.sub', b::text, true);
  if public.sx_set_contact_block(contact_ab, true) is distinct from true then raise exception 'QA block aggregate true'; end if;
  if public.sx_set_contact_block(contact_ab, true) is distinct from true then raise exception 'QA block retry'; end if;
  select * into view_row from public.sx_list_contacts() where id = contact_ab;
  if not found or view_row.blocked is distinct from true or view_row.blocked_by_me is distinct from true then raise exception 'QA own block flag'; end if;
  foreach v_sql in array array[
    format('insert into public.sx_messages(room_id,sender_id,body) values(%L::uuid,%L::uuid,''blocked managed'')', managed, b),
    format('insert into public.sx_messages(room_id,sender_id,body) values(%L::uuid,%L::uuid,''blocked old room'')', legacy, b),
    format('select public.sx_request_contact(%L::uuid,''blocked request'')', invite_a),
    format('select public.sx_join_chat(%L::uuid)', spare_legacy)
  ] loop
    v_denied := false;
    begin execute v_sql; exception when insufficient_privilege then v_denied := true; end;
    if not v_denied then raise exception 'QA blocked legacy/direct/request bypass: %', v_sql; end if;
  end loop;
  perform set_config('request.jwt.claim.sub', a::text, true);
  select * into view_row from public.sx_list_contacts() where id = contact_ab;
  if not found or view_row.blocked is distinct from true or view_row.blocked_by_me is distinct from false then raise exception 'QA counterpart sees generic unavailable'; end if;
  select count(*) into n from public.sx_contact_blocks where contact_id = contact_ab;
  if n <> 0 then raise exception 'QA cannot inspect other block ownership'; end if;
  select count(*) into n from public.sx_messages where room_id = managed;
  if n <> 2 then raise exception 'QA block preserves history'; end if;
  if public.sx_set_contact_block(contact_ab, false) is distinct from true then raise exception 'QA cannot remove counterpart block'; end if;
  foreach v_sql in array array[
    format('select public.sx_decide_contact(%L::uuid,true)', contact_ab),
    format('insert into public.sx_messages(room_id,sender_id,body) values(%L::uuid,%L::uuid,''blocked reverse'')', managed, a),
    format('select public.sx_join_chat(%L::uuid)', legacy),
    format('delete from public.sx_contact_blocks where contact_id=%L::uuid', contact_ab),
    format('insert into public.sx_contact_blocks(contact_id,blocker_id) values(%L::uuid,%L::uuid)', contact_ab, b)
  ] loop
    v_denied := false;
    begin execute v_sql; exception when insufficient_privilege then v_denied := true; end;
    if not v_denied then raise exception 'QA counterpart block cannot be bypassed: %', v_sql; end if;
  end loop;
  perform public.sx_set_contact_block(contact_ab, true);
  perform set_config('request.jwt.claim.sub', b::text, true);
  if public.sx_set_contact_block(contact_ab, false) is distinct from true then raise exception 'QA A block survives B unblock'; end if;
  select * into view_row from public.sx_list_contacts() where id = contact_ab;
  if not found or view_row.blocked is distinct from true or view_row.blocked_by_me is distinct from false then raise exception 'QA independent blocks'; end if;
  perform set_config('request.jwt.claim.sub', a::text, true);
  if public.sx_set_contact_block(contact_ab, false) is distinct from false then raise exception 'QA final voluntary unblock'; end if;
  if public.sx_set_contact_block(contact_ab, false) is distinct from false then raise exception 'QA unblock retry'; end if;
  insert into public.sx_messages(room_id, sender_id, body) values(managed, a, 'after voluntary unblock');
  insert into public.sx_messages(room_id, sender_id, body) values(legacy, a, 'legacy resumes');

  -- Empty claims are not authorization, even under the authenticated DB role.
  perform set_config('request.jwt.claim.sub', '', true);
  foreach v_sql in array array[
    'select public.sx_contact_invite(''no actor'')',
    format('select public.sx_request_contact(%L::uuid,''no actor'')', invite_a),
    format('select public.sx_decide_contact(%L::uuid,true)', contact_ab),
    format('select public.sx_set_contact_block(%L::uuid,true)', contact_ab),
    'select * from public.sx_list_contacts()'
  ] loop
    v_denied := false;
    begin execute v_sql; exception when insufficient_privilege then v_denied := true; end;
    if not v_denied then raise exception 'QA null actor RPC: %', v_sql; end if;
  end loop;
  perform set_config('role', 'anon', true);
  foreach v_sql in array array[
    'select public.sx_contact_invite(''anonymous'')',
    format('select public.sx_request_contact(%L::uuid,''anonymous'')', invite_a),
    format('select public.sx_decide_contact(%L::uuid,true)', contact_ab),
    format('select public.sx_set_contact_block(%L::uuid,true)', contact_ab),
    'select * from public.sx_list_contacts()',
    'select * from public.sx_contacts',
    'select * from public.sx_contact_invites',
    'select * from public.sx_contact_blocks',
    format('insert into public.sx_messages(room_id,sender_id,body) values(%L::uuid,%L::uuid,''anonymous'')', managed, a)
  ] loop
    v_denied := false;
    begin execute v_sql; exception when insufficient_privilege then v_denied := true; end;
    if not v_denied then raise exception 'QA anon permission: %', v_sql; end if;
  end loop;
  perform set_config('role', 'none', true);
  select count(*) into n from public.sx_room_members where room_id = managed;
  if n <> 2 then raise exception 'QA physically exactly two accepted members'; end if;
  select count(*) into n from public.sx_contacts
    where least(requester_id, recipient_id) = least(a, b) and greatest(requester_id, recipient_id) = greatest(a, b);
  if n <> 1 then raise exception 'QA physically unique account pair'; end if;
  if exists(select 1 from public.sx_rooms where id = spare_legacy
    and (select count(*) from public.sx_room_members where room_id = spare_legacy) <> 1) then
    raise exception 'QA denied legacy join has no side effects';
  end if;
end $$;
rollback;

-- Mutations fail closed under an isolation mode whose old snapshot could hide a
-- newly committed block even after waiting for the mutex. No persistent fixtures.
begin isolation level repeatable read;
do $$
declare a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); code uuid; denied boolean := false;
begin
  insert into auth.users(id) values(a), (b);
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', a::text, true);
  code := public.sx_contact_invite('isolation fixture');
  perform set_config('request.jwt.claim.sub', b::text, true);
  begin perform public.sx_request_contact(code, 'old snapshot'); exception when sqlstate '25000' then denied := true; end;
  if not denied then raise exception 'QA stale transaction isolation must fail closed'; end if;
  perform set_config('role', 'none', true);
end $$;
rollback;
select 'PASS: contact permissions; all synthetic fixtures rolled back' as result;

-- Concurrency must additionally be exercised using TWO independent authenticated
-- transactions on a separate synthetic pair, with a third observer for commit order:
-- 1. Session A BEGIN; sx_set_contact_block(id,true); keep tx open.
-- 2. Session B direct INSERT into sx_messages for that pair: it must WAIT.
-- 3. A COMMIT; B must resume with 42501 and persist no message.
-- 4. Repeat with B sx_decide_contact(id,true) / sx_request_contact(code,label)
--    / existing-member sx_join_chat(legacy_room). All wait on the same pair mutex
--    and then deny. A nonmember legacy join is denied immediately, without joining.
-- 5. Reverse order: an earlier send may commit before the block completes; after
--    the block transaction confirms, no later send may commit until ALL owners
--    voluntarily remove their own blocks. Concurrent accept repeats create one room.
-- This file does not claim those inter-session scenarios have been executed.
-- The UI sends one message to one pair per transaction. Arbitrary concurrent
-- multi-pair batches that acquire pair locks in opposite orders may deadlock with
-- SQLSTATE 40P01: PostgreSQL aborts one transaction; this is not an authorization
-- bypass. The frontend retains the draft and permits retry with the same client
-- message ID. Multi-pair batching is outside this delivery's client contract.
