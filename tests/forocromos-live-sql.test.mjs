import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const schema = await readFile(new URL('../supabase/forocromos-live.sql', import.meta.url), 'utf8');
const ids = {
  mod: '00000000-0000-4000-8000-000000000001',
  a: '00000000-0000-4000-8000-000000000002',
  b: '00000000-0000-4000-8000-000000000003',
  pending: '00000000-0000-4000-8000-000000000004',
  suspended: '00000000-0000-4000-8000-000000000005',
  outsider: '00000000-0000-4000-8000-000000000006',
};
const missing = '00000000-0000-4000-8000-999999999999';

async function fixture(t) {
  const db = new PGlite();
  t.after(() => { if (!db.closed) return db.close(); });
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
    $$;
    grant usage on schema auth,public to anon,authenticated;
    grant execute on function auth.uid() to anon,authenticated;
    -- Existing application objects are sentinels, never part of this schema.
    create table public.sx_rooms (id integer primary key, label text);
    insert into public.sx_rooms values (1,'existing room');
  `);
  for (const [name, id] of Object.entries(ids)) {
    await db.query('insert into auth.users values ($1,$2)', [id, `${name}@example.invalid`]);
  }
  await db.exec(schema);
  for (const [name, status, role] of [
    ['mod','active','moderator'], ['a','active','member'], ['b','active','member'],
    ['pending','pending','member'], ['suspended','suspended','member'],
  ]) {
    await db.query('insert into fc_members(user_id,alias,status,role) values ($1,$2,$3,$4)',
      [ids[name], `Alias ${name}`, status, role]);
  }
  const as = async (actor, sql, args = []) => {
    await db.exec(`set role ${actor === null ? 'anon' : 'authenticated'}`);
    try {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [actor === null ? '' : (ids[actor] ?? actor)]);
      return await db.query(sql, args);
    } finally {
      await db.exec('reset role');
      await db.query("select set_config('request.jwt.claim.sub','',false)");
    }
  };
  const rpc = async (actor, name, args = []) => {
    assert.match(name, /^fc_[a-z_]+$/);
    const result = await as(actor, `select public.${name}(${args.map((_, index) => `$${index + 1}`).join(',')}) as value`, args);
    return result.rows[0].value;
  };
  const topic = (actor = 'a', extra = {}) => rpc(actor, 'fc_create_topic',
    [extra.category ?? 'cuidado', extra.title ?? 'Una pregunta práctica', extra.body ?? 'Texto de prueba.']);
  const reply = (topicId, actor = 'b', body = 'Respuesta de prueba.') => rpc(actor, 'fc_reply', [topicId, body]);
  return { db, as, rpc, topic, reply };
}

async function denied(promise, message = /permission denied|fc_active_member_required|fc_moderator_required|fc_auth_required|fc_content_unavailable/) {
  await assert.rejects(promise, message);
}

test('live SQL is isolated, repeatable, has five RLS tables and only invoker public RPCs', async t => {
  const { db, as } = await fixture(t);
  await db.exec(schema);
  assert.deepEqual((await db.query('select * from sx_rooms')).rows, [{ id: 1, label: 'existing room' }]);
  const tables = (await db.query("select relname,relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname in ('fc_members','fc_topics','fc_replies','fc_reports','fc_saved')")).rows;
  assert.equal(tables.length, 5);
  assert.ok(tables.every(row => row.relrowsecurity));
  const functions = (await db.query("select proname,prosecdef,proconfig from pg_proc where pronamespace = 'public'::regnamespace and proname like 'fc_%'")).rows;
  assert.equal(functions.length, 10);
  assert.ok(functions.every(row => !row.prosecdef && row.proconfig.includes('search_path=""')));
  const definers = (await db.query("select proname,proconfig from pg_proc where pronamespace = 'fc_private'::regnamespace and prosecdef")).rows;
  assert.equal(definers.length, 2);
  assert.ok(definers.every(row => row.proconfig.includes('search_path=""')));
  for (const table of ['fc_members','fc_topics','fc_replies','fc_reports','fc_saved']) {
    await denied(as(null, `select * from public.${table}`));
    for (const privilege of ['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) {
      const result = await db.query('select has_table_privilege($1,$2,$3) as allowed', ['authenticated', `public.${table}`, privilege]);
      assert.equal(result.rows[0].allowed, false, `${table} ${privilege}`);
    }
  }
});

test('anonymous, external, pending and suspended sessions cannot read or mutate the community', async t => {
  const { as, rpc, topic, reply } = await fixture(t);
  const item = await topic();
  await reply(item.id);
  await rpc('a', 'fc_report', [item.id, null, 'Aviso privado de prueba.']);
  await rpc('a', 'fc_toggle_save', [item.id]);
  const actions = [
    ['fc_create_topic',['cuidado','Título','Texto']], ['fc_reply',[item.id,'Texto']],
    ['fc_report',[null,null,'Aviso']], ['fc_edit',['topic',item.id,'Cambio']],
    ['fc_withdraw',['topic',item.id]], ['fc_toggle_save',[item.id]],
    ['fc_profile',['Otro alias']], ['fc_admit',[ids.b,'active']], ['fc_moderate',['topic_close',item.id]],
  ];
  for (const actor of [null,'outsider','pending','suspended']) {
    for (const table of ['fc_topics','fc_replies','fc_reports','fc_saved']) {
      if (actor === null) await denied(as(actor, `select * from ${table}`));
      else assert.deepEqual((await as(actor, `select * from ${table}`)).rows, [], `${actor}: ${table}`);
    }
    for (const [name,args] of actions) await denied(rpc(actor,name,args));
  }
  await denied(rpc(null, 'fc_join', ['Alias nuevo']));
  await denied(as(null, "select fc_private.mutate('join','{\"alias\":\"Nuevo\"}'::jsonb)"));
  await denied(as(ids.outsider, "select fc_private.mutate('create_topic','{\"author_id\":\"00000000-0000-4000-8000-000000000001\",\"category\":\"cuidado\",\"title\":\"T\",\"body\":\"B\"}')"));
  const visible = (await as('a', 'select * from fc_members')).rows;
  assert.equal(visible.length, 3);
  assert.doesNotMatch(JSON.stringify(visible), /email|example\.invalid/);
  assert.equal((await as('pending', 'select * from fc_members')).rows.length, 1);
});

test('joining is self-only and pending; admission never elevates role or resets suspension', async t => {
  const { db, as, rpc } = await fixture(t);
  const joined = await rpc('outsider','fc_join',['Compañera nueva']);
  assert.equal(joined.user_id,ids.outsider);
  assert.equal(joined.status,'pending');
  assert.equal(joined.role,'member');
  const forged = (await as('outsider', "select fc_private.mutate('join',$1) as value", [{alias:'Cambio',status:'active',role:'moderator',user_id:ids.mod}])).rows[0].value;
  assert.equal(forged.alias,'Compañera nueva');
  assert.equal(forged.status,'pending');
  assert.equal(forged.role,'member');
  await denied(as('a', 'update fc_members set role = $1 where user_id = $2', ['moderator',ids.a]));
  await denied(rpc('a','fc_admit',[ids.outsider,'active']));
  for (const bad of ['moderator','pending','anything']) {
    await assert.rejects(rpc('mod','fc_admit',[ids.outsider,bad]), /fc_invalid_admission/);
  }
  await assert.rejects(rpc('mod','fc_admit',[ids.mod,'suspended']), /fc_invalid_admission/);
  assert.equal((await rpc('mod','fc_admit',[ids.outsider,'active'])).role,'member');
  assert.equal((await rpc('mod','fc_admit',[ids.outsider,'suspended'])).status,'suspended');
  assert.equal((await rpc('outsider','fc_join',['Cambio'])).status,'suspended');
  assert.equal((await db.query('select role from fc_members where user_id=$1',[ids.outsider])).rows[0].role,'member');
  for (const alias of [null,'','x','x'.repeat(37),'private@example.invalid','alias\nextra']) {
    await assert.rejects(rpc('a','fc_profile',[alias]), /fc_invalid_alias/);
  }
});

test('author identity and editorial/moderation flags are immutable; own text alone can be edited', async t => {
  const { db, as, rpc, topic, reply } = await fixture(t);
  const first = await topic();
  assert.equal(first.author_id,ids.a);
  assert.equal(first.editorial,false);
  assert.equal(first.pinned,false);
  assert.equal(first.closed,false);
  assert.equal(first.hidden,false);
  const answer = await reply(first.id);
  for (const change of ['author_id = $2','editorial = true','pinned = true','closed = true','hidden = true','title = $2','category = $2']) {
    await denied(as('a', `update fc_topics set ${change} where id = $1`, change.includes('$2') ? [first.id, change.startsWith('author_id') ? ids.b : 'other'] : [first.id]));
  }
  await denied(as('a','delete from fc_topics where id=$1',[first.id]));
  await denied(as('a',"insert into fc_topics(category,title,body,author_id,editorial) values ('cuidado','T','B',null,true)"));
  await denied(rpc('b','fc_edit',['topic',first.id,'Texto ajeno']));
  await denied(rpc('a','fc_edit',['reply',answer.id,'Texto ajeno']));
  await denied(rpc('mod','fc_edit',['topic',first.id,'Moderación no suplanta autoría']));
  assert.deepEqual(await rpc('a','fc_edit',['topic',first.id,'Texto corregido.']), {ok:true});
  assert.deepEqual(await rpc('b','fc_edit',['reply',answer.id,'Respuesta corregida.']), {ok:true});
  const after = (await as('b','select * from fc_topics where id=$1',[first.id])).rows[0];
  assert.equal(after.body,'Texto corregido.');
  for (const field of ['author_id','editorial','pinned','closed','hidden','title','category']) assert.deepEqual(after[field],first[field]);
  const editorial = (await db.query("insert into fc_topics(category,title,body,editorial) values ('aplicacion','Editorial de prueba','Texto editorial.',true) returning id")).rows[0];
  await denied(rpc('mod','fc_edit',['topic',editorial.id,'No se edita por RPC de miembro']));
  for (const [category,title,body] of [['no-existe','T','B'],['cuidado','','B'],['cuidado','x'.repeat(121),'B'],['cuidado','T','x'.repeat(5001)]]) {
    await assert.rejects(rpc('a','fc_create_topic',[category,title,body]), /fc_invalid_topic/);
  }
  await assert.rejects(rpc('b','fc_reply',[first.id,'x'.repeat(3001)]), /fc_invalid_body/);
  await assert.rejects(rpc('b','fc_edit',['reply',answer.id,'x'.repeat(3001)]), /fc_invalid_body/);
  await assert.rejects(rpc('a','fc_edit',['topic',first.id,'x'.repeat(5001)]), /fc_invalid_body/);
  await denied(rpc('b','fc_reply',[missing,'Texto']));
});

test('moderation, closed threads and author withdrawal are enforced by the database', async t => {
  const { db, as, rpc, topic, reply } = await fixture(t);
  const item = await topic(), answer = await reply(item.id);
  await denied(rpc('a','fc_moderate',['topic_close',item.id]));
  await rpc('mod','fc_moderate',['topic_pin',item.id]);
  await rpc('mod','fc_moderate',['topic_close',item.id]);
  assert.equal((await as('b','select closed,pinned from fc_topics where id=$1',[item.id])).rows[0].closed,true);
  await assert.rejects(reply(item.id), /fc_topic_closed/);
  await assert.rejects(rpc('a','fc_edit',['topic',item.id,'Cambio']), /fc_topic_closed/);
  await assert.rejects(rpc('b','fc_edit',['reply',answer.id,'Cambio']), /fc_topic_closed/);
  await rpc('mod','fc_moderate',['topic_open',item.id]);
  await rpc('mod','fc_moderate',['reply_hide',answer.id]);
  assert.equal((await as('a','select * from fc_replies')).rows.length,0);
  assert.equal((await as('mod','select * from fc_replies')).rows.length,1);
  await rpc('mod','fc_moderate',['reply_show',answer.id]);
  await rpc('mod','fc_moderate',['topic_hide',item.id]);
  assert.equal((await as('a','select * from fc_topics')).rows.length,0);
  assert.equal((await as('a','select * from fc_replies')).rows.length,0);
  await denied(reply(item.id));
  await rpc('mod','fc_moderate',['topic_show',item.id]);
  await denied(rpc('a','fc_withdraw',['reply',answer.id]));
  await rpc('b','fc_withdraw',['reply',answer.id]);
  await assert.rejects(rpc('mod','fc_moderate',['reply_show',answer.id]), /fc_content_withdrawn/);
  await rpc('a','fc_withdraw',['topic',item.id]);
  await assert.rejects(rpc('mod','fc_moderate',['topic_show',item.id]), /fc_content_withdrawn/);
  const withdrawn = (await db.query('select * from fc_topics where id=$1',[item.id])).rows[0];
  assert.equal(withdrawn.title,'Tema retirado');
  assert.equal(withdrawn.body,'Aportación retirada por su autora.');
  assert.ok(withdrawn.withdrawn_at);
  assert.equal((await as('b','select * from fc_topics')).rows.length,0);
  await denied(reply(item.id));
});

test('reports and confidential general notices are isolated, bounded and moderator-resolvable', async t => {
  const { as, rpc, topic, reply } = await fixture(t);
  const item = await topic(), other = await topic('b'), answer = await reply(item.id);
  const report = await rpc('a','fc_report',[item.id,null,'Motivo privado.']);
  assert.deepEqual(await rpc('a','fc_report',[item.id,null,'Reintento.']),report);
  const replyReport = await rpc('a','fc_report',[item.id,answer.id,'Aviso de respuesta.']);
  await rpc('a','fc_report',[null,null,'Aviso general confidencial.']);
  await assert.rejects(rpc('b','fc_report',[other.id,answer.id,'No corresponde.']), /fc_report_target_mismatch/);
  await assert.rejects(rpc('b','fc_report',[null,null,'x'.repeat(1001)]), /fc_invalid_report/);
  await denied(rpc('a','fc_report',[missing,null,'No existe.']));
  assert.equal((await as('a','select * from fc_reports')).rows.length,3);
  assert.equal((await as('b','select * from fc_reports')).rows.length,0);
  assert.equal((await as('mod','select * from fc_reports')).rows.length,3);
  const row = (await as('mod','select * from fc_reports where id=$1',[replyReport.id])).rows[0];
  assert.equal(row.topic_id,null);
  assert.equal(row.reply_id,answer.id);
  await denied(rpc('a','fc_moderate',['report_resolve',report.id]));
  await rpc('mod','fc_moderate',['report_resolve',report.id]);
  assert.equal((await as('a','select status from fc_reports where id=$1',[report.id])).rows[0].status,'resolved');
  await denied(as('a','update fc_reports set reporter_id=$1 where id=$2',[ids.b,report.id]));
});

test('suspension takes effect with the same session and cannot be bypassed by rejoining', async t => {
  const { as, rpc, topic } = await fixture(t);
  const item = await topic();
  assert.equal((await as('a','select * from fc_topics')).rows.length,1);
  await rpc('mod','fc_admit',[ids.a,'suspended']);
  assert.equal((await as('a','select * from fc_topics')).rows.length,0);
  await denied(rpc('a','fc_reply',[item.id,'Nueva respuesta']));
  await denied(rpc('a','fc_edit',['topic',item.id,'Edición']));
  await denied(rpc('a','fc_toggle_save',[item.id]));
  assert.equal((await rpc('a','fc_join',['Reintento'])).status,'suspended');
  await rpc('mod','fc_admit',[ids.a,'active']);
  assert.equal((await as('a','select * from fc_topics')).rows.length,1);
});

test('rate limits count all rows including withdrawals and duplicate requests cannot reset quotas', async t => {
  const { db, rpc, topic, reply } = await fixture(t);
  const item = await topic();
  for (let index = 0; index < 3; index++) await topic();
  await assert.rejects(topic(), /fc_rate_limit/);
  await rpc('a','fc_withdraw',['topic',item.id]);
  await assert.rejects(topic(), /fc_rate_limit/);
  const open = await topic('b');
  for (let index = 0; index < 20; index++) await reply(open.id,'a');
  await assert.rejects(reply(open.id,'a'), /fc_rate_limit/);
  for (let index = 0; index < 10; index++) await rpc('a','fc_report',[null,null,`Aviso ${index}`]);
  await assert.rejects(rpc('a','fc_report',[null,null,'Aviso once']), /fc_rate_limit/);
  await db.query("update fc_topics set created_at = now() - interval '11 minutes' where author_id=$1",[ids.a]);
  await topic();
  await db.query("update fc_topics set created_at = now() - interval '2 hours' where author_id=$1",[ids.a]);
  await db.query("insert into fc_topics(category,title,body,author_id,created_at) select 'cuidado','Prueba de cuota','Texto',$1,now() - interval '2 hours' from generate_series(1,15)",[ids.a]);
  await assert.rejects(topic(), /fc_rate_limit/);
  await db.query("update fc_replies set created_at = now() - interval '2 hours' where author_id=$1",[ids.a]);
  await db.query("insert into fc_replies(topic_id,author_id,body,created_at) select $1,$2,'Prueba de cuota',now() - interval '2 hours' from generate_series(1,80)",[open.id,ids.a]);
  await assert.rejects(reply(open.id,'a'), /fc_rate_limit/);
});

test('saved topics are personal, profiles use aliases and content survives a database restart', async t => {
  const { db, as, rpc, topic, reply } = await fixture(t);
  const item = await topic(), answer = await reply(item.id);
  assert.deepEqual(await rpc('a','fc_toggle_save',[item.id]),{saved:true});
  assert.equal((await as('a','select * from fc_saved')).rows.length,1);
  assert.equal((await as('b','select * from fc_saved')).rows.length,0);
  await rpc('mod','fc_moderate',['topic_hide',item.id]);
  assert.deepEqual(await rpc('a','fc_toggle_save',[item.id]),{saved:false});
  await denied(rpc('a','fc_toggle_save',[item.id]));
  await rpc('mod','fc_moderate',['topic_show',item.id]);
  await rpc('a','fc_toggle_save',[item.id]);
  const profile = await rpc('a','fc_profile',['Luna de prueba']);
  assert.equal(profile.alias,'Luna de prueba');
  assert.equal(profile.role,'member');
  assert.doesNotMatch(JSON.stringify(profile), /email|example\.invalid/);
  const dump = await db.dumpDataDir();
  await db.close();
  const restored = new PGlite({loadDataDir:dump});
  t.after(() => restored.close());
  assert.equal((await restored.query('select body from fc_topics where id=$1',[item.id])).rows[0].body,'Texto de prueba.');
  assert.equal((await restored.query('select body from fc_replies where id=$1',[answer.id])).rows[0].body,'Respuesta de prueba.');
  assert.equal((await restored.query('select count(*)::integer as n from fc_saved')).rows[0].n,1);
  await restored.exec('set role authenticated');
  await restored.query("select set_config('request.jwt.claim.sub',$1,false)",[ids.outsider]);
  assert.equal((await restored.query('select * from fc_topics')).rows.length,0);
  await restored.exec('reset role');
});
