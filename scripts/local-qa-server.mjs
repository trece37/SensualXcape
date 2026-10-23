import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { createLocalCofreStore } from './local-cofre-store.mjs';
import { createLocalForocromosStore } from './local-forocromos-store.mjs';
import { createLocalCheckinStore } from './local-checkin-store.mjs';

export const LOCAL_QA_PUBLIC_KEY = 'sb_publishable_local_qa_fictitious_only_20261021';
export const LOCAL_QA_ACCOUNTS = Object.freeze(['a@example.invalid', 'b@example.invalid', 'c@example.invalid']);
export const LOCAL_QA_BODY_LIMIT = 16_384;
const ROOT = new URL('../', import.meta.url);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATIC = new Map([['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/cofre.css', ['cofre.css', 'text/css; charset=utf-8']],
  ['/vendor/cofre-bundle.js', ['local-assets/cofre-bundle.js', 'text/javascript; charset=utf-8']],
  ['/vendor/supabase-client.js', ['local-assets/supabase-client.js', 'text/javascript; charset=utf-8']],
  ['/forocromos.css', ['forocromos.css', 'text/css; charset=utf-8']],
  ['/vendor/forocromos-bundle.js', ['local-assets/forocromos-bundle.js', 'text/javascript; charset=utf-8']],
  ['/care.css', ['care.css', 'text/css; charset=utf-8']],
  ['/platform-v11.css', ['platform-v11.css', 'text/css; charset=utf-8']],
  ['/vendor/care-bundle.js', ['local-assets/care-bundle.js', 'text/javascript; charset=utf-8']],
  ['/vendor/platform-v11-bundle.js', ['local-assets/platform-v11-bundle.js', 'text/javascript; charset=utf-8']],
  ['/assets/v11/portal-unicorn.png', ['assets/v11/portal-unicorn.png', 'image/png']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]]);
const TABLES = {
  sx_room_members: { columns: ['room_id', 'user_id', 'joined_at'], filters: ['room_id', 'user_id'], order: ['joined_at'] },
  sx_messages: { columns: ['id', 'room_id', 'sender_id', 'body', 'created_at', 'client_message_id'],
    filters: ['room_id', 'sender_id', 'client_message_id'], order: ['id'] }
};
const RPCS = {
  sx_contact_invite: [['p_label', 'label']],
  sx_request_contact: [['p_invite_code', 'uuid'], ['p_label', 'label']],
  sx_decide_contact: [['p_contact_id', 'uuid'], ['p_accept', 'boolean']],
  sx_set_contact_block: [['p_contact_id', 'uuid'], ['p_blocked', 'boolean']],
  sx_list_contacts: [], sx_join_chat: [['p_room_id', 'uuid']], sx_create_chat: []
};
const banner = `<aside style="padding:14px 20px;background:#4c1736;color:#fff;border-bottom:2px solid #ffb4d4;font:16px/1.5 system-ui" role="note">
<strong>Local · datos ficticios</strong> — a@example.invalid · b@example.invalid · c@example.invalid. Contraseña de las tres: <strong>123456</strong>.
Usa dos navegadores o perfiles distintos. Las pestañas del mismo perfil comparten cuenta. El chat se borra al cerrar el servidor; el Cofre y Forocromos se conservan en este equipo.
Forocromos: A y B son compañeras admitidas; A modera. C es una cuenta externa sin acceso a la comunidad.
Sin correos ni Realtime: el chat consulta cambios cada cinco segundos.</aside>`;

function problem(status, code, message) { return Object.assign(new Error(message), { status, code }); }
function json(response, status, body) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(body === undefined ? undefined : JSON.stringify(body));
}
function exactObject(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !names.includes(key)) || names.some(key => !Object.hasOwn(value, key))) {
    throw problem(400, 'LOCAL_QA_PARAMETERS', 'Parámetros no admitidos en este ensayo local.');
  }
}
async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    throw problem(415, 'LOCAL_QA_JSON_ONLY', 'Este endpoint requiere JSON.');
  }
  if (Number(request.headers['content-length']) > LOCAL_QA_BODY_LIMIT) {
    request.resume(); throw problem(413, 'LOCAL_QA_BODY_LIMIT', 'Petición demasiado grande.');
  }
  const chunks = []; let size = 0;
  await new Promise((resolve, reject) => {
    request.on('data', chunk => {
      size += chunk.length;
      if (size > LOCAL_QA_BODY_LIMIT) { chunks.length = 0; reject(problem(413, 'LOCAL_QA_BODY_LIMIT', 'Petición demasiado grande.')); }
      else chunks.push(chunk);
    });
    request.on('end', resolve); request.on('error', reject);
    request.on('aborted', () => reject(problem(400, 'LOCAL_QA_ABORTED', 'Petición interrumpida.')));
  });
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw problem(400, 'LOCAL_QA_JSON', 'JSON no válido.'); }
}

/** Isolated in-memory database. No remote client, config.js read, disk data or SQL endpoint. */
export async function createLocalQaServer({ port = 4341, vaultDir, communityDir, checkinDir } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Puerto local no válido.');
  const db = new PGlite();
  const users = LOCAL_QA_ACCOUNTS.map(email => ({ id: randomUUID(), email }));
  const sessions = new Map(), refreshTokens = new Map();
  const signingKey = randomBytes(32);
  let origin = '', queue = Promise.resolve(), closed = false;
  try {
    await db.exec(`create role anon nologin; create role authenticated nologin;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      grant usage on schema auth to anon, authenticated;
      grant execute on function auth.uid() to anon, authenticated;`);
    for (const file of ['supabase/setup.sql', 'supabase/reliable-send.sql', 'supabase/contact-control.sql']) {
      await db.exec(await readFile(new URL(file, ROOT), 'utf8'));
    }
    for (const user of users) await db.query('insert into auth.users(id) values($1)', [user.id]);
  } catch (error) { await db.close(); throw error; }

  function authUser(user) {
    return { ...user, aud: 'authenticated', role: 'authenticated', email_confirmed_at: '2026-10-21T00:00:00Z',
      app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {},
      identities: [], created_at: '2026-10-21T00:00:00Z', updated_at: '2026-10-21T00:00:00Z', is_anonymous: false };
  }
  function removeSession(session) { sessions.delete(session.access_token); refreshTokens.delete(session.refresh_token); }
  function newSession(user) {
    const now = Math.floor(Date.now() / 1000), expires_at = now + 3600;
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user.id, aud: 'authenticated',
      role: 'authenticated', iss: `${origin}/auth/v1`, iat: now, exp: expires_at, jti: randomUUID(), session_id: randomUUID() })}`;
    const access_token = `${unsigned}.${createHmac('sha256', signingKey).update(unsigned).digest('base64url')}`;
    const session = { access_token, refresh_token: randomBytes(32).toString('base64url'), token_type: 'bearer',
      expires_in: 3600, expires_at, user: authUser(user) };
    sessions.set(access_token, session); refreshTokens.set(session.refresh_token, session); return session;
  }
  function requireSession(request) {
    if (closed) throw problem(503, 'LOCAL_QA_CLOSED', 'El servidor local está cerrándose.');
    const token = /^Bearer (\S+)$/i.exec(request.headers.authorization || '')?.[1];
    const session = sessions.get(token);
    if (!session || session.expires_at <= Date.now() / 1000) {
      if (session) removeSession(session);
      throw problem(401, 'bad_jwt', 'Sesión local no válida. Entra con una cuenta ficticia.');
    }
    return session;
  }
  function asActor(actor, job) {
    const run = queue.then(async () => {
      await db.exec('begin isolation level read committed');
      try {
        await db.query("select set_config('role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [actor]);
        const result = await job(db);
        await db.exec('commit'); return result;
      } catch (error) { await db.exec('rollback'); throw error; }
    });
    queue = run.catch(() => {}); return run;
  }
  function checkBoundary(request) {
    if (request.headers.host !== new URL(origin).host
      || (request.headers.origin && request.headers.origin !== origin)
      || (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site']))) {
      throw problem(403, 'LOCAL_QA_ORIGIN', 'Este ensayo solo admite su origen 127.0.0.1.');
    }
    if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw problem(400, 'LOCAL_QA_PATH', 'Ruta no admitida.');
  }
  async function handleAuth(request, response, url) {
    if (url.pathname === '/auth/v1/token' && request.method === 'POST') {
      const body = await readJson(request);
      if (url.searchParams.get('grant_type') === 'password') {
        // SDK may include gotrue_meta_security; it is ignored, never trusted for identity.
        if (!body || Array.isArray(body) || typeof body.email !== 'string' || typeof body.password !== 'string') {
          throw problem(400, 'invalid_credentials', 'Usa una de las tres cuentas ficticias.');
        }
        const user = users.find(item => item.email === body.email.trim().toLowerCase());
        if (!user || body.password !== '123456') throw problem(400, 'invalid_credentials', 'El correo o la contraseña de Connect no coinciden.');
        return json(response, 200, newSession(user));
      }
      if (url.searchParams.get('grant_type') === 'refresh_token') {
        const old = refreshTokens.get(body?.refresh_token);
        if (!old) throw problem(400, 'refresh_token_not_found', 'Vuelve a entrar con una cuenta ficticia.');
        const user = users.find(item => item.id === old.user.id); removeSession(old);
        return json(response, 200, newSession(user));
      }
    }
    if (url.pathname === '/auth/v1/user' && request.method === 'GET') return json(response, 200, requireSession(request).user);
    if (url.pathname === '/auth/v1/logout' && request.method === 'POST') {
      const current = requireSession(request), scope = url.searchParams.get('scope') || 'global';
      if (!['local', 'global', 'others'].includes(scope)) throw problem(400, 'LOCAL_QA_SCOPE', 'Ámbito no admitido.');
      for (const session of sessions.values()) {
        if (session.user.id === current.user.id && (scope === 'global'
          || (scope === 'local' && session === current) || (scope === 'others' && session !== current))) removeSession(session);
      }
      response.statusCode = 204; return response.end();
    }
    throw problem(403, 'LOCAL_QA_AUTH_ONLY', 'Prueba local: usa las tres cuentas preparadas; no hay registro, recuperación ni correos.');
  }
  async function handleRest(request, response, url) {
    const actor = requireSession(request).user.id;
    const rpc = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname)?.[1];
    if (rpc && Object.hasOwn(RPCS, rpc) && request.method === 'POST') {
      const body = await readJson(request), params = RPCS[rpc]; exactObject(body, params.map(([name]) => name));
      const values = params.map(([name, type]) => {
        const value = body[name];
        if ((type === 'uuid' && (typeof value !== 'string' || !UUID.test(value)))
          || (type === 'label' && (typeof value !== 'string' || !value.trim() || value.length > 80))
          || (type === 'boolean' && typeof value !== 'boolean')) throw problem(400, 'LOCAL_QA_PARAMETERS', 'Parámetros de contacto no válidos.');
        return value;
      });
      const placeholders = values.map((_value, index) => `$${index + 1}`).join(',');
      const result = await asActor(actor, connection => connection.query(rpc === 'sx_list_contacts'
        ? 'select * from public.sx_list_contacts()' : `select public.${rpc}(${placeholders}) as value`, values));
      return json(response, 200, rpc === 'sx_list_contacts' ? result.rows : result.rows[0].value);
    }
    const table = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname)?.[1];
    if (!Object.hasOwn(TABLES, table || '')) throw problem(404, 'LOCAL_QA_ENDPOINT', 'Endpoint no disponible en este ensayo.');
    if (request.method === 'GET') {
      const spec = TABLES[table], columnsText = url.searchParams.get('select') || '*';
      const columns = columnsText === '*' ? spec.columns : columnsText.split(',').map(item => item.trim());
      if (!columns.length || columns.some(column => !spec.columns.includes(column))) throw problem(400, 'LOCAL_QA_SELECT', 'Selección no admitida.');
      const filters = [], values = [];
      for (const [key, value] of url.searchParams) {
        if (url.searchParams.getAll(key).length !== 1) throw problem(400, 'LOCAL_QA_QUERY', 'Parámetro duplicado.');
        if (['select', 'order', 'limit'].includes(key)) continue;
        if (!spec.filters.includes(key) || !value.startsWith('eq.') || !UUID.test(value.slice(3))) throw problem(400, 'LOCAL_QA_FILTER', 'Filtro no admitido.');
        values.push(value.slice(3)); filters.push(`${key} = $${values.length}::uuid`);
      }
      let order = '';
      if (url.searchParams.has('order')) {
        const [column, direction, extra] = url.searchParams.get('order').split('.');
        if (!spec.order.includes(column) || !['asc', 'desc'].includes(direction) || extra) throw problem(400, 'LOCAL_QA_ORDER', 'Orden no admitido.');
        order = ` order by ${column} ${direction}`;
      }
      const rawLimit = url.searchParams.get('limit') || '150';
      if (!/^\d{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 150) throw problem(400, 'LOCAL_QA_LIMIT', 'Límite local: entre 1 y 150.');
      values.push(Number(rawLimit));
      const sql = `select ${columns.join(',')} from public.${table}${filters.length ? ` where ${filters.join(' and ')}` : ''}${order} limit $${values.length}`;
      const result = await asActor(actor, connection => connection.query(sql, values));
      if (request.headers.accept?.includes('application/vnd.pgrst.object+json')) {
        if (result.rows.length !== 1) throw problem(406, 'PGRST116', 'No se encontró exactamente una fila.');
        return json(response, 200, result.rows[0]);
      }
      return json(response, 200, result.rows);
    }
    if (table === 'sx_messages' && request.method === 'POST') {
      if ([...url.searchParams.keys()].length) throw problem(400, 'LOCAL_QA_QUERY', 'Este ensayo admite un envío simple por petición.');
      const body = await readJson(request);
      const expected = ['room_id', 'sender_id', 'body', ...(Object.hasOwn(body || {}, 'client_message_id') ? ['client_message_id'] : [])];
      exactObject(body, expected);
      if (!UUID.test(body.room_id) || !UUID.test(body.sender_id) || typeof body.body !== 'string'
        || (body.client_message_id !== undefined && !UUID.test(body.client_message_id))) throw problem(400, 'LOCAL_QA_MESSAGE', 'Mensaje no válido.');
      const result = await asActor(actor, connection => connection.query(`insert into public.sx_messages(room_id,sender_id,body,client_message_id)
        values($1::uuid,$2::uuid,$3,$4::uuid) returning id,room_id,sender_id,body,client_message_id,created_at`,
      [body.room_id, body.sender_id, body.body, body.client_message_id ?? null]));
      if (request.headers.prefer?.includes('return=representation')) return json(response, 201, result.rows);
      response.statusCode = 201; return response.end();
    }
    throw problem(405, 'LOCAL_QA_METHOD', 'Operación no disponible en el ensayo local.');
  }

  const cofre = await createLocalCofreStore({ directory: vaultDir,
    getOwner: request => requireSession(request).user.email }).catch(async error => { await db.close(); throw error; });
  // Port-zero fixtures get their own database unless persistence was explicitly
  // requested. Tests never share the human trial's private community data.
  const temporaryCommunityDir = port === 0 && communityDir === undefined
    ? await mkdtemp(path.join(tmpdir(), 'sx-local-community-')) : null;
  const removeTemporaryCommunity = async () => {
    if (temporaryCommunityDir && path.dirname(temporaryCommunityDir) === path.resolve(tmpdir())
      && path.basename(temporaryCommunityDir).startsWith('sx-local-community-')) {
      await rm(temporaryCommunityDir, { recursive: true, force: true });
    }
  };
  const forocromos = await createLocalForocromosStore({ directory: communityDir ?? temporaryCommunityDir ?? undefined,
    getActor: request => ({ email: requireSession(request).user.email }) }).catch(async error => {
      await cofre.close(); await db.close(); await removeTemporaryCommunity(); throw error;
    });

  const temporaryCheckinDir = port === 0 && checkinDir === undefined
    ? await mkdtemp(path.join(tmpdir(), 'sx-local-checkin-')) : null;
  const removeTemporaryCheckin = async () => {
    if (temporaryCheckinDir && path.dirname(temporaryCheckinDir) === path.resolve(tmpdir())
      && path.basename(temporaryCheckinDir).startsWith('sx-local-checkin-')) {
      await rm(temporaryCheckinDir, { recursive: true, force: true });
    }
  };
  const checkin = await createLocalCheckinStore({ directory: checkinDir ?? temporaryCheckinDir ?? undefined,
    getOwner: request => requireSession(request).user.email }).catch(async error => {
      await cofre.close(); await forocromos.close(); await db.close();
      await removeTemporaryCommunity(); await removeTemporaryCheckin(); throw error;
    });

  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('X-Supabase-Api-Version', '2024-01-01');
    response.setHeader('Content-Security-Policy', `connect-src 'self' ws://${new URL(origin).host}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`);
    try {
      checkBoundary(request);
      const url = new URL(request.url, origin);
      if (url.pathname === '/config.js' && request.method === 'GET') {
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        return response.end(`// LOCAL QA ONLY: generated in memory, never writes real config.js.\nexport const SUPABASE_URL = ${JSON.stringify(origin)};\nexport const SUPABASE_PUBLISHABLE_KEY = ${JSON.stringify(LOCAL_QA_PUBLIC_KEY)};\nexport const COFRE_LOCAL_ENABLED = true;\n`);
      }
      if (STATIC.has(url.pathname) && request.method === 'GET') {
        const [file, type] = STATIC.get(url.pathname);
        if (type.startsWith('image/')) {
          response.setHeader('Content-Type', type); return response.end(await readFile(new URL(file, ROOT)));
        }
        let content = await readFile(new URL(file, ROOT), 'utf8');
        if (file === 'index.html') content = content.replace('<body>', `<body>${banner}`)
          .replace('</head>', '<link rel="stylesheet" href="/cofre.css"><link rel="stylesheet" href="/forocromos.css"><link rel="stylesheet" href="/care.css"><link rel="stylesheet" href="/platform-v11.css"><script type="module" src="/vendor/cofre-bundle.js"></script><script type="module" src="/vendor/forocromos-bundle.js"></script><script type="module" src="/vendor/care-bundle.js"></script><script type="module" src="/vendor/platform-v11-bundle.js"></script></head>');
        if (file === 'app.js') content = content.replace('https://esm.sh/@supabase/supabase-js@2.49.10', '/vendor/supabase-client.js');
        response.setHeader('Content-Type', type); return response.end(content);
      }
      if (url.pathname.startsWith('/realtime/')) throw problem(503, 'LOCAL_QA_NO_REALTIME', 'Sin Realtime local; consulta periódica cada cinco segundos.');
      if (request.headers.apikey !== LOCAL_QA_PUBLIC_KEY) throw problem(401, 'LOCAL_QA_KEY', 'Falta la clave ficticia del ensayo local.');
      if (url.pathname.startsWith('/auth/v1/')) return await handleAuth(request, response, url);
      if (url.pathname.startsWith('/rest/v1/')) return await handleRest(request, response, url);
      if (url.pathname.startsWith('/cofre/')) return await cofre.handle(request, response, url);
      if (url.pathname.startsWith('/forocromos/')) return await forocromos.handle(request, response, url);
      if (url.pathname.startsWith('/checkin/')) return await checkin.handle(request, response, url);
      throw problem(404, 'LOCAL_QA_ENDPOINT', 'Archivo o endpoint no disponible.');
    } catch (error) {
      const status = error.status || (error.code === '42501' ? 403 : error.code === '23505' ? 409
        : /^22|^23/.test(error.code || '') ? 400 : 500);
      if (status === 413) response.setHeader('Connection', 'close');
      const message = status === 500 ? 'No se pudo completar la operación local.' : error.message;
      return json(response, status, { code: error.code || 'LOCAL_QA_ERROR', error_code: error.code || 'LOCAL_QA_ERROR', message, details: null, hint: null });
    }
  });
  server.requestTimeout = 120000; server.headersTimeout = 5000;
  server.on('upgrade', (request, socket) => {
    let status = '503 Service Unavailable';
    try { checkBoundary(request); } catch { status = '403 Forbidden'; }
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
  } catch (error) { await cofre.close(); await forocromos.close(); await checkin.close(); await db.close(); await removeTemporaryCommunity(); await removeTemporaryCheckin(); throw error; }
  return { server, origin, vaultDir: cofre.directory, communityDir: forocromos.directory, checkinDir: checkin.directory,
    forocromosStore: forocromos, checkinStore: checkin, async close() {
    if (closed) return; closed = true;
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections?.(); server.closeAllConnections?.(); });
    await cofre.close(); await forocromos.close(); await checkin.close(); await queue; sessions.clear(); refreshTokens.clear(); await db.close();
    await removeTemporaryCommunity(); await removeTemporaryCheckin();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await createLocalQaServer();
  console.log(`Local · datos ficticios: ${app.origin}\nCuentas: ${LOCAL_QA_ACCOUNTS.join(', ')} · clave 123456\nChats en memoria; Cofre persistente en ${app.vaultDir}; comunidad persistente en ${app.communityDir}. Sin Auth real ni Realtime. Ctrl+C para cerrar.`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
