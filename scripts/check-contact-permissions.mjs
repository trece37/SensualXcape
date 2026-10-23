import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
const db = new PGlite();
const checks = [];
let stage = 'local bootstrap';
try {
  await db.exec(`create role anon nologin; create role authenticated nologin;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to anon,authenticated;
    grant execute on function auth.uid() to anon,authenticated;`);
  for (const file of ['supabase/setup.sql','supabase/reliable-send.sql',
    'supabase/contact-control.sql','supabase/contact-control.sql','tests/contact-permissions.sql']) {
    stage = file;
    const sql = await readFile(new URL(file, root), 'utf8');
    await db.exec(sql);
    checks.push({ file, sha256: createHash('sha256').update(sql).digest('hex'), pass: true });
  }
  const counts = (await db.query(`select (select count(*) from auth.users) users,
    (select count(*) from public.sx_rooms) rooms,(select count(*) from public.sx_contacts) contacts`)).rows[0];
  if (Object.values(counts).some(value => Number(value) !== 0)) throw new Error('Fixtures remained after rollback');
  console.log(JSON.stringify({ pass: true, engine: 'PGlite 0.5.10', checks, rollbackCounts: counts,
    limits: 'In-memory SQL/roles/RLS/sequential contract only; not Auth, Realtime or concurrent sessions' }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ pass: false, stage, code: error.code, message: error.message }, null, 2));
  process.exitCode = 1;
} finally { await db.close(); }
