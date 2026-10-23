import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Local fixture adapter. SQLite supplies atomic storage and constraints. Session
// validation belongs to the caller; community admission is checked here anew.
export const FOROCROMOS_DEFAULT_DIR = fileURLToPath(new URL('../../local-data/forocromos/', import.meta.url));
export const FOROCROMOS_LIMITS = Object.freeze({ title: 120, body: 5000, reply: 3000, reason: 1000,
  topicsPerMember: 250, repliesPerMember: 2000, reportsPerMember: 100, writesPerMinute: 30 });
const PREFIX = '/forocromos/v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORIES = Object.freeze([{ id: 'entre-companeras', name: 'Entre compañeras' },
  { id: 'vida-practica', name: 'Vida práctica' }, { id: 'ideas', name: 'Ideas para mejorar' }]);
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const missing = () => fail(404, 'FOROCROMOS_NOT_FOUND', 'El contenido no está disponible.');

function json(response, status, body) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}
function object(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) {
    throw fail(400, 'FOROCROMOS_PARAMETERS', 'Parámetros de comunidad no admitidos.');
  }
}
function text(value, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /\u0000/.test(value)) {
    throw fail(400, 'FOROCROMOS_TEXT', `Escribe un texto de entre 1 y ${maximum} caracteres.`);
  }
  return value.trim().normalize('NFC');
}
function requestId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw fail(400, 'FOROCROMOS_REQUEST_ID', 'La operación necesita un identificador válido.');
  return value.toLowerCase();
}
function page(url, allowed, maximum = 50) {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) {
      throw fail(400, 'FOROCROMOS_QUERY', 'Consulta no admitida.');
    }
  }
  function integer(name, fallback, max) {
    const raw = url.searchParams.get(name);
    if (raw === null) return fallback;
    if (!/^\d{1,5}$/.test(raw) || Number(raw) > max || (name === 'limit' && Number(raw) < 1)) {
      throw fail(400, 'FOROCROMOS_PAGE', 'Paginación fuera del límite local.');
    }
    return Number(raw);
  }
  return { offset: integer('offset', 0, 10000), limit: integer('limit', maximum === 100 ? 50 : 20, maximum) };
}
async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    throw fail(415, 'FOROCROMOS_JSON', 'Esta operación requiere JSON.');
  }
  const chunks = []; let bytes = 0;
  if (Number(request.headers['content-length']) > 16384) {
    request.resume(); throw fail(413, 'FOROCROMOS_BODY_LIMIT', 'La petición supera el límite local.');
  }
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 16384) throw fail(413, 'FOROCROMOS_BODY_LIMIT', 'La petición supera el límite local.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail(400, 'FOROCROMOS_JSON', 'JSON no válido.'); }
}

export async function createLocalForocromosStore({ directory = FOROCROMOS_DEFAULT_DIR, getActor } = {}) {
  if (typeof getActor !== 'function') throw new Error('Forocromos necesita un resolvedor de sesión.');
  const root = path.resolve(directory), publicDir = fileURLToPath(new URL('../public/', import.meta.url));
  const relative = path.relative(publicDir, root);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Forocromos no puede guardarse dentro de public.');
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const filename = path.join(root, 'forocromos.sqlite');
  const db = new DatabaseSync(filename);
  await chmod(filename, 0o600).catch(() => {});
  let closed = false;
  try {
    db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, alias TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('member','moderator')),
        status TEXT NOT NULL CHECK(status IN ('active','revoked')));
      CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS topics (
        id TEXT PRIMARY KEY, category_id TEXT NOT NULL REFERENCES categories(id),
        author_id TEXT NOT NULL REFERENCES members(id), title TEXT NOT NULL, body TEXT NOT NULL,
        created_at TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1)),
        withdrawn INTEGER NOT NULL DEFAULT 0 CHECK(withdrawn IN (0,1)), locked INTEGER NOT NULL DEFAULT 0 CHECK(locked IN (0,1)));
      CREATE INDEX IF NOT EXISTS topics_category ON topics(category_id,hidden,created_at);
      CREATE TABLE IF NOT EXISTS replies (
        id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES topics(id), author_id TEXT NOT NULL REFERENCES members(id),
        body TEXT NOT NULL, created_at TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1)),
        withdrawn INTEGER NOT NULL DEFAULT 0 CHECK(withdrawn IN (0,1)));
      CREATE INDEX IF NOT EXISTS replies_topic ON replies(topic_id,hidden,created_at);
      CREATE TABLE IF NOT EXISTS operations (
        member_id TEXT NOT NULL REFERENCES members(id), request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('topic','reply')), result_id TEXT NOT NULL, PRIMARY KEY(member_id,request_id));
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL REFERENCES members(id), topic_id TEXT NOT NULL REFERENCES topics(id),
        reply_id TEXT REFERENCES replies(id), reason TEXT NOT NULL, created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved')),
        resolution TEXT CHECK(resolution IN ('dismiss','hide')), resolved_at TEXT, moderator_id TEXT REFERENCES members(id));
      CREATE UNIQUE INDEX IF NOT EXISTS reports_pending ON reports(reporter_id,topic_id,COALESCE(reply_id,'')) WHERE status = 'pending';
      CREATE TABLE IF NOT EXISTS writes (member_id TEXT NOT NULL REFERENCES members(id), at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS writes_member ON writes(member_id,at);`);
    const seed = db.prepare('INSERT OR IGNORE INTO members(id,email,alias,role,status) VALUES(?,?,?,?,?)');
    seed.run(randomUUID(), 'a@example.invalid', 'Compañera A', 'moderator', 'active');
    seed.run(randomUUID(), 'b@example.invalid', 'Compañera B', 'member', 'active');
    const categorySeed = db.prepare('INSERT OR IGNORE INTO categories(id,name) VALUES(?,?)');
    for (const category of CATEGORIES) categorySeed.run(category.id, category.name);
  } catch (error) { db.close(); throw error; }

  function actor(request) {
    if (closed) throw fail(503, 'FOROCROMOS_CLOSED', 'La comunidad local está cerrándose.');
    const current = getActor(request);
    if (!current || typeof current.email !== 'string' || !current.email.trim()) {
      throw fail(401, 'FOROCROMOS_SESSION', 'Entra antes de abrir la comunidad.');
    }
    const member = db.prepare('SELECT id,alias,role,status FROM members WHERE email=?').get(current.email.trim().toLowerCase());
    if (!member || member.status !== 'active') throw fail(403, 'FOROCROMOS_MEMBERSHIP', 'La comunidad es privada y requiere admisión.');
    return member;
  }
  function author(row) { return row.withdrawn ? null : { id: row.author_id, alias: row.alias }; }
  function topicView(row, detail = true) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM replies WHERE topic_id=? AND hidden=0').get(row.id).n;
    const value = { id: row.id, title: row.withdrawn ? 'Retirado por su autora' : row.title,
      category_id: row.category_id, author: author(row), created_at: row.created_at,
      reply_count: count, locked: Boolean(row.locked || row.withdrawn), withdrawn: Boolean(row.withdrawn) };
    value[detail ? 'body' : 'snippet'] = row.withdrawn ? '' : detail ? row.body : row.body.slice(0, 160);
    return value;
  }
  function replyView(row) { return { id: row.id, topic_id: row.topic_id, body: row.withdrawn ? '' : row.body,
    author: author(row), created_at: row.created_at, withdrawn: Boolean(row.withdrawn) }; }
  function topicRow(id, visible = true) {
    const row = db.prepare(`SELECT t.*,m.alias FROM topics t JOIN members m ON m.id=t.author_id WHERE t.id=?${visible ? ' AND t.hidden=0' : ''}`).get(id);
    if (!row) throw missing();
    return row;
  }
  function replyRow(id, visible = true) {
    const row = db.prepare(`SELECT r.*,m.alias FROM replies r JOIN members m ON m.id=r.author_id JOIN topics t ON t.id=r.topic_id
      WHERE r.id=?${visible ? ' AND r.hidden=0 AND t.hidden=0' : ''}`).get(id);
    if (!row) throw missing();
    return row;
  }
  function moderator(member) {
    if (member.role !== 'moderator') throw fail(403, 'FOROCROMOS_MODERATOR', 'Esta operación corresponde a la moderadora.');
  }
  function transaction(job) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = job(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function rate(member) {
    const now = Date.now();
    db.prepare('DELETE FROM writes WHERE at<?').run(now - 60000);
    if (db.prepare('SELECT COUNT(*) AS n FROM writes WHERE member_id=?').get(member.id).n >= FOROCROMOS_LIMITS.writesPerMinute) {
      throw fail(429, 'FOROCROMOS_RATE', 'Demasiadas operaciones seguidas. Espera un minuto.');
    }
    db.prepare('INSERT INTO writes(member_id,at) VALUES(?,?)').run(member.id, now);
  }
  function quota(table, member, maximum, column = 'author_id') {
    if (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=?`).get(member.id).n >= maximum) {
      throw fail(413, 'FOROCROMOS_QUOTA', 'Has alcanzado el límite de este ensayo local.');
    }
  }
  function operation(member, id, payload, kind, create) {
    const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return transaction(() => {
      const old = db.prepare('SELECT * FROM operations WHERE member_id=? AND request_id=?').get(member.id, id);
      if (old) {
        if (old.fingerprint !== fingerprint || old.kind !== kind) throw fail(409, 'FOROCROMOS_IDEMPOTENCY', 'El identificador ya se usó con otro contenido.');
        return { fresh: false, row: kind === 'topic' ? topicRow(old.result_id) : replyRow(old.result_id) };
      }
      rate(member);
      const row = create();
      db.prepare('INSERT INTO operations(member_id,request_id,fingerprint,kind,result_id) VALUES(?,?,?,?,?)').run(member.id,id,fingerprint,kind,row.id);
      return { fresh: true, row };
    });
  }
  function reportView(row, review = false) {
    const value = { id: row.id, topic_id: row.topic_id, reply_id: row.reply_id, status: row.status, created_at: row.created_at };
    if (review) {
      const target = row.reply_id ? replyRow(row.reply_id, false) : topicRow(row.topic_id, false);
      Object.assign(value, { reason: row.reason, reporter: { id: row.reporter_id, alias: row.reporter_alias },
        target: { type: row.reply_id ? 'reply' : 'topic', id: target.id, topic_id: row.topic_id,
          ...(row.reply_id ? {} : { title: target.withdrawn ? 'Retirado por su autora' : target.title }),
          body: target.withdrawn ? '' : target.body, author: author(target), hidden: Boolean(target.hidden), withdrawn: Boolean(target.withdrawn) } });
    }
    return value;
  }

  async function handle(request, response, url) {
    let member = actor(request);
    if (!url.pathname.startsWith(PREFIX + '/') || /%|\\|\/\//.test(url.pathname)) throw missing();
    const route = url.pathname.slice(PREFIX.length), method = request.method;
    // Body I/O must not preserve an admission or a session that was revoked while
    // waiting. No DB operation occurs between this fresh check and its transaction.
    let body;
    if (method === 'POST') { body = await readJson(request); const fresh = actor(request);
      if (fresh.id !== member.id) throw fail(401, 'FOROCROMOS_SESSION', 'La sesión ha cambiado.'); member = fresh; }
    if (route === '/me' && method === 'GET') {
      page(url, []); return json(response, 200, { member: { id: member.id, alias: member.alias, role: member.role } });
    }
    if (route === '/categories' && method === 'GET') {
      page(url, []); return json(response, 200, { categories: db.prepare('SELECT id,name FROM categories ORDER BY rowid').all() });
    }
    if (route === '/topics' && method === 'GET') {
      const { offset, limit } = page(url, ['offset','limit','category','q']);
      const category = url.searchParams.get('category'), query = url.searchParams.get('q')?.trim() || '';
      if ((category && !CATEGORIES.some(item => item.id === category)) || query.length > 100) throw fail(400, 'FOROCROMOS_SEARCH', 'Filtro de comunidad no válido.');
      let where = 't.hidden=0'; const values = [];
      if (category) { where += ' AND t.category_id=?'; values.push(category); }
      if (query) { where += " AND t.withdrawn=0 AND (t.title LIKE ? ESCAPE '\\' OR t.body LIKE ? ESCAPE '\\')";
        const escaped = '%' + query.replace(/[\\%_]/g, '\\$&') + '%'; values.push(escaped, escaped); }
      const total = db.prepare(`SELECT COUNT(*) AS n FROM topics t WHERE ${where}`).get(...values).n;
      const rows = db.prepare(`SELECT t.*,m.alias FROM topics t JOIN members m ON m.id=t.author_id WHERE ${where}
        ORDER BY t.created_at DESC,t.id DESC LIMIT ? OFFSET ?`).all(...values,limit,offset);
      return json(response, 200, { topics: rows.map(row => topicView(row, false)), total, has_more: offset + rows.length < total });
    }
    if (route === '/topics' && method === 'POST') {
      page(url, []); object(body, ['category_id','title','body','client_request_id']);
      if (!CATEGORIES.some(item => item.id === body.category_id)) throw fail(400, 'FOROCROMOS_CATEGORY', 'Elige una categoría disponible.');
      const title = text(body.title, FOROCROMOS_LIMITS.title), content = text(body.body, FOROCROMOS_LIMITS.body), id = requestId(body.client_request_id);
      const result = operation(member,id,{category:body.category_id,title,body:content},'topic',() => {
        quota('topics',member,FOROCROMOS_LIMITS.topicsPerMember); const topicId = randomUUID();
        db.prepare('INSERT INTO topics(id,category_id,author_id,title,body,created_at) VALUES(?,?,?,?,?,?)')
          .run(topicId,body.category_id,member.id,title,content,new Date().toISOString()); return topicRow(topicId);
      });
      return json(response, result.fresh ? 201 : 200, { topic: topicView(result.row) });
    }
    const topicId = /^\/topics\/([a-f0-9-]{36})$/i.exec(route)?.[1];
    if (topicId && UUID.test(topicId) && method === 'GET') {
      const { offset, limit } = page(url,['offset','limit'],100), topic = topicRow(topicId);
      const total = db.prepare('SELECT COUNT(*) AS n FROM replies WHERE topic_id=? AND hidden=0').get(topicId).n;
      const replies = db.prepare(`SELECT r.*,m.alias FROM replies r JOIN members m ON m.id=r.author_id
        WHERE r.topic_id=? AND r.hidden=0 ORDER BY r.created_at,r.id LIMIT ? OFFSET ?`).all(topicId,limit,offset);
      return json(response, 200, { topic: topicView(topic), replies: replies.map(replyView), total, has_more: offset + replies.length < total });
    }
    if (topicId && UUID.test(topicId) && method === 'DELETE') {
      page(url, []); const topic = topicRow(topicId,false);
      if (topic.author_id !== member.id) { if (topic.hidden) throw missing(); throw fail(403,'FOROCROMOS_OWNER','Solo su autora puede retirar el contenido.'); }
      if (!topic.withdrawn) transaction(() => { rate(member); db.prepare("UPDATE topics SET withdrawn=1,title='',body='',locked=1 WHERE id=? AND author_id=?").run(topicId,member.id); });
      return json(response, 200, { topic: topicView(topicRow(topicId,false)) });
    }
    const repliesTopic = /^\/topics\/([a-f0-9-]{36})\/replies$/i.exec(route)?.[1];
    if (repliesTopic && UUID.test(repliesTopic) && method === 'POST') {
      page(url, []); object(body,['body','client_request_id']); const content = text(body.body,FOROCROMOS_LIMITS.reply), id = requestId(body.client_request_id);
      const result = operation(member,id,{topic:repliesTopic,body:content},'reply',() => {
        const topic = topicRow(repliesTopic); if (topic.locked || topic.withdrawn) throw fail(409,'FOROCROMOS_LOCKED','El hilo está cerrado a nuevas respuestas.');
        quota('replies',member,FOROCROMOS_LIMITS.repliesPerMember); const replyId = randomUUID();
        db.prepare('INSERT INTO replies(id,topic_id,author_id,body,created_at) VALUES(?,?,?,?,?)').run(replyId,repliesTopic,member.id,content,new Date().toISOString());
        return replyRow(replyId);
      });
      return json(response,result.fresh ? 201 : 200,{ reply: replyView(result.row) });
    }
    const replyId = /^\/replies\/([a-f0-9-]{36})$/i.exec(route)?.[1];
    if (replyId && UUID.test(replyId) && method === 'DELETE') {
      page(url, []); const reply = replyRow(replyId,false);
      if (reply.author_id !== member.id) { if (reply.hidden || topicRow(reply.topic_id,false).hidden) throw missing(); throw fail(403,'FOROCROMOS_OWNER','Solo su autora puede retirar el contenido.'); }
      if (!reply.withdrawn) transaction(() => { rate(member); db.prepare("UPDATE replies SET withdrawn=1,body='' WHERE id=? AND author_id=?").run(replyId,member.id); });
      return json(response,200,{reply:replyView(replyRow(replyId,false))});
    }
    if (route === '/reports' && method === 'POST') {
      page(url, []); object(body,['topic_id','reason'],['reply_id']);
      if (typeof body.topic_id !== 'string' || !UUID.test(body.topic_id) || (body.reply_id != null && (typeof body.reply_id !== 'string' || !UUID.test(body.reply_id)))) throw fail(400,'FOROCROMOS_REPORT_TARGET','Selecciona un contenido disponible.');
      const reason = text(body.reason,FOROCROMOS_LIMITS.reason); topicRow(body.topic_id);
      if (body.reply_id && replyRow(body.reply_id).topic_id !== body.topic_id) throw missing();
      const report = transaction(() => {
        if (db.prepare("SELECT id FROM reports WHERE reporter_id=? AND topic_id=? AND COALESCE(reply_id,'')=? AND status='pending'")
          .get(member.id,body.topic_id,body.reply_id || '')) throw fail(409,'FOROCROMOS_ALREADY_REPORTED','Ya has enviado un aviso pendiente sobre este contenido.');
        rate(member); quota('reports',member,FOROCROMOS_LIMITS.reportsPerMember,'reporter_id'); const reportId = randomUUID();
        db.prepare('INSERT INTO reports(id,reporter_id,topic_id,reply_id,reason,created_at) VALUES(?,?,?,?,?,?)')
          .run(reportId,member.id,body.topic_id,body.reply_id || null,reason,new Date().toISOString());
        return db.prepare('SELECT * FROM reports WHERE id=?').get(reportId);
      });
      return json(response,201,{report:reportView(report)});
    }
    if (route === '/reports' && method === 'GET') {
      moderator(member); const { offset,limit } = page(url,['status','offset','limit']);
      const status = url.searchParams.get('status') || 'pending';
      if (!['pending','resolved','all'].includes(status)) throw fail(400,'FOROCROMOS_REPORT_STATUS','Estado de revisión no válido.');
      const where = status === 'all' ? '' : ' WHERE r.status=?', values = status === 'all' ? [] : [status];
      const total = db.prepare('SELECT COUNT(*) AS n FROM reports r' + where).get(...values).n;
      const rows = db.prepare(`SELECT r.*,m.alias AS reporter_alias FROM reports r JOIN members m ON m.id=r.reporter_id${where}
        ORDER BY r.created_at,r.id LIMIT ? OFFSET ?`).all(...values,limit,offset);
      return json(response,200,{reports:rows.map(row => reportView(row,true)),total,has_more:offset + rows.length < total});
    }
    const moderationTopic = /^\/topics\/([a-f0-9-]{36})\/moderation$/i.exec(route)?.[1];
    if (moderationTopic && UUID.test(moderationTopic) && method === 'POST') {
      moderator(member); page(url,[]); object(body,['action']);
      if (!['hide','restore','lock','unlock'].includes(body.action)) throw fail(400,'FOROCROMOS_MODERATION','Acción de revisión no válida.');
      topicRow(moderationTopic,false);
      transaction(() => { rate(member); db.prepare(`UPDATE topics SET ${['hide','restore'].includes(body.action) ? 'hidden' : 'locked'}=? WHERE id=?`)
        .run(['hide','lock'].includes(body.action) ? 1 : 0,moderationTopic); });
      return json(response,200,{topic:{...topicView(topicRow(moderationTopic,false)),hidden:Boolean(topicRow(moderationTopic,false).hidden)}});
    }
    const reportId = /^\/reports\/([a-f0-9-]{36})\/resolve$/i.exec(route)?.[1];
    if (reportId && UUID.test(reportId) && method === 'POST') {
      moderator(member); page(url,[]); object(body,['action']);
      if (!['dismiss','hide'].includes(body.action)) throw fail(400,'FOROCROMOS_MODERATION','Acción de revisión no válida.');
      const report = transaction(() => {
        const row = db.prepare('SELECT * FROM reports WHERE id=?').get(reportId); if (!row) throw missing();
        if (row.status === 'resolved') {
          if (row.resolution !== body.action) throw fail(409,'FOROCROMOS_REPORT_RESOLVED','El aviso ya se resolvió de otra forma.');
          return row;
        }
        rate(member);
        if (body.action === 'hide') db.prepare(`UPDATE ${row.reply_id ? 'replies' : 'topics'} SET hidden=1 WHERE id=?`).run(row.reply_id || row.topic_id);
        db.prepare("UPDATE reports SET status='resolved',resolution=?,resolved_at=?,moderator_id=? WHERE id=?")
          .run(body.action,new Date().toISOString(),member.id,reportId);
        return db.prepare('SELECT * FROM reports WHERE id=?').get(reportId);
      });
      return json(response,200,{report:reportView(report)});
    }
    throw missing();
  }
  // Internal admission hook, deliberately never mounted as an HTTP endpoint.
  function setMembership(email, { alias, role, status } = {}) {
    if (closed) throw fail(503,'FOROCROMOS_CLOSED','La comunidad local está cerrándose.');
    if (typeof email !== 'string' || !email.trim()) throw new Error('Admisión local no válida.');
    const normalized = email.trim().toLowerCase(), old = db.prepare('SELECT * FROM members WHERE email=?').get(normalized);
    role ??= old?.role ?? 'member'; status ??= old?.status ?? 'active';
    if (!['member','moderator'].includes(role) || !['active','revoked'].includes(status)) throw new Error('Admisión local no válida.');
    const display = text(alias ?? old?.alias ?? 'Compañera',60);
    db.prepare(`INSERT INTO members(id,email,alias,role,status) VALUES(?,?,?,?,?)
      ON CONFLICT(email) DO UPDATE SET alias=excluded.alias,role=excluded.role,status=excluded.status`)
      .run(old?.id ?? randomUUID(),normalized,display,role,status);
    return { id: db.prepare('SELECT id FROM members WHERE email=?').get(normalized).id, alias: display, role, status };
  }
  return { directory: root, handle, setMembership, async close() { if (!closed) { closed = true; db.close(); } } };
}
