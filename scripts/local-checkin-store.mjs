import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, chmod, realpath, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Cron } from 'croner';

// Croner supplies the wake-up mechanism. SQLite, rather than a browser tab or an
// in-memory timer, owns the deadlines and the exactly-once simulated event log.
// This module has no delivery adapter and never sends an external notification.
export const CHECKIN_DEFAULT_DIR = fileURLToPath(new URL('../../local-data/checkin/', import.meta.url));
export const CHECKIN_LIMITS = Object.freeze({ contacts: 20, recipients: 3, durationMin: 15,
  durationMax: 86400, plans: 1000, writesPerMinute: 30, bodyBytes: 8192 });
const PREFIX = '/checkin/v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const missing = () => fail(404, 'CHECKIN_NOT_FOUND', 'Este elemento no está disponible.');
const envelope = body => ({ mode: 'simulation', delivered: false, ...body });
function json(response, status, body) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(envelope(body)));
}
function object(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || fields.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !fields.includes(key))) {
    throw fail(400, 'CHECKIN_PARAMETERS', 'Parámetros de check-in no admitidos.');
  }
}
function cleanText(value, maximum, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw fail(400, 'CHECKIN_TEXT', `${name} necesita entre 1 y ${maximum} caracteres, sin controles.`);
  }
  return value.trim().normalize('NFC');
}
function id(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw fail(400, 'CHECKIN_ID', 'Identificador no válido.');
  return value.toLowerCase();
}
async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    throw fail(415, 'CHECKIN_JSON', 'Esta operación requiere JSON.');
  }
  if (Number(request.headers['content-length']) > CHECKIN_LIMITS.bodyBytes) {
    request.resume(); throw fail(413, 'CHECKIN_BODY_LIMIT', 'La petición supera el límite local.');
  }
  const chunks = []; let bytes = 0, settled = false;
  await new Promise((resolve, reject) => {
    request.on('data', chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > CHECKIN_LIMITS.bodyBytes) {
        settled = true; chunks.length = 0; request.resume();
        reject(fail(413, 'CHECKIN_BODY_LIMIT', 'La petición supera el límite local.'));
      } else chunks.push(chunk);
    });
    request.on('end', () => { if (!settled) { settled = true; resolve(); } });
    request.on('error', error => { if (!settled) { settled = true; reject(error); } });
    request.on('aborted', () => { if (!settled) { settled = true; reject(fail(400, 'CHECKIN_ABORTED', 'Petición interrumpida.')); } });
  });
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail(400, 'CHECKIN_JSON', 'JSON no válido.'); }
}
function inside(directory, parent) {
  const relative = path.relative(parent, directory);
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

export async function createLocalCheckinStore({ directory = CHECKIN_DEFAULT_DIR, getOwner, clock = Date.now } = {}) {
  if (typeof getOwner !== 'function' || typeof clock !== 'function') throw new Error('Estoy segura necesita sesión y reloj válidos.');
  let root = path.resolve(directory);
  const publicDir = await realpath(fileURLToPath(new URL('../public/', import.meta.url)));
  if (inside(root, publicDir)) throw new Error('Los check-ins no pueden guardarse dentro de public.');
  await mkdir(root, { recursive: true, mode: 0o700 });
  root = await realpath(root);
  if (inside(root, publicDir)) throw new Error('Los check-ins no pueden guardarse dentro de public.');
  const filename = path.join(root, 'checkin.sqlite');
  const oldFile = await lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (oldFile?.isSymbolicLink() || (oldFile && !oldFile.isFile())) throw new Error('El almacén local necesita un archivo regular.');
  const db = new DatabaseSync(filename);
  await chmod(filename, 0o600).catch(() => {});
  let closed = false, scheduler, schedulerError = null;
  function now() {
    const milliseconds = Number(clock());
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0
      || milliseconds > 8.64e15 - CHECKIN_LIMITS.durationMax * 1000) throw new Error('Reloj local no válido.');
    return milliseconds;
  }
  function open() { if (closed) throw fail(503, 'CHECKIN_CLOSED', 'El check-in local está cerrándose.'); }
  function transaction(job) {
    open(); db.exec('BEGIN IMMEDIATE');
    try { const value = job(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  try {
    db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, alias TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS contacts_owner ON contacts(owner);
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, label TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','confirmed','cancelled','overdue')),
        created_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL, reminder_at INTEGER NOT NULL,
        recipients TEXT NOT NULL, confirmed_at INTEGER, cancelled_at INTEGER);
      CREATE INDEX IF NOT EXISTS plans_owner ON plans(owner,created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS plans_one_active ON plans(owner) WHERE status='active';
      CREATE TABLE IF NOT EXISTS operations (
        owner TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        plan_id TEXT NOT NULL REFERENCES plans(id), PRIMARY KEY(owner,request_id));
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, plan_id TEXT NOT NULL REFERENCES plans(id),
        kind TEXT NOT NULL CHECK(kind IN ('created','reminder','simulated_alert','confirmed','cancelled')),
        created_at INTEGER NOT NULL, scheduled_at INTEGER NOT NULL, recipient_id TEXT NOT NULL DEFAULT '',
        contact_alias TEXT, message TEXT NOT NULL, UNIQUE(plan_id,kind,recipient_id));
      CREATE INDEX IF NOT EXISTS events_owner ON events(owner,created_at);
      CREATE TABLE IF NOT EXISTS writes (owner TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS writes_owner ON writes(owner,at);`);
  } catch (error) { db.close(); throw error; }

  const iso = value => value === null ? null : new Date(value).toISOString();
  function planView(row) {
    return { id: row.id, label: row.label, status: row.status, created_at: iso(row.created_at),
      deadline_at: iso(row.deadline_at), reminder_at: iso(row.reminder_at),
      confirmed_at: iso(row.confirmed_at), cancelled_at: iso(row.cancelled_at), recipients: JSON.parse(row.recipients) };
  }
  function contactView(row) { return { id: row.id, alias: row.alias, created_at: iso(row.created_at) }; }
  function eventView(row) {
    return envelope({ id: row.id, kind: row.kind, plan_id: row.plan_id, created_at: iso(row.created_at),
      scheduled_at: iso(row.scheduled_at), contact_alias: row.contact_alias, message: row.message });
  }
  function event(row, kind, at, scheduledAt = at, recipient = null) {
    const messages = {
      created: 'Check-in local programado. No se contactará con nadie.',
      reminder: 'Recordatorio local: queda poco para la hora de confirmación.',
      simulated_alert: 'AVISO SIMULADO: venció el plazo sin confirmación. No se ha enviado a nadie.',
      confirmed: 'La titular confirmó su check-in. No se ha enviado ningún aviso.',
      cancelled: 'La titular canceló su check-in. No se enviará ningún aviso.'
    };
    db.prepare(`INSERT OR IGNORE INTO events(id,owner,plan_id,kind,created_at,scheduled_at,recipient_id,contact_alias,message)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(randomUUID(), row.owner, row.id, kind, at, scheduledAt, recipient?.id || '', recipient?.alias || null, messages[kind]);
  }
  function expire(plan, at) {
    db.prepare("UPDATE plans SET status='overdue' WHERE id=? AND status='active'").run(plan.id);
    for (const recipient of JSON.parse(plan.recipients)) event(plan, 'simulated_alert', at, plan.deadline_at, recipient);
  }
  // Synchronous transaction: due reconciliation and user actions cannot interleave.
  // On restart, a late event records both its original deadline and actual creation.
  function processDue() {
    return transaction(() => {
      const at = now(), due = db.prepare("SELECT * FROM plans WHERE status='active' AND reminder_at<=?").all(at);
      let overdue = 0, reminders = 0;
      for (const plan of due) {
        if (at >= plan.deadline_at) {
          expire(plan, at);
          overdue++;
        } else {
          const previous = db.prepare("SELECT 1 FROM events WHERE plan_id=? AND kind='reminder'").get(plan.id);
          if (!previous) { event(plan, 'reminder', at, plan.reminder_at); reminders++; }
        }
      }
      db.prepare('DELETE FROM writes WHERE at<?').run(at - 60000);
      schedulerError = null;
      return { overdue, reminders };
    });
  }
  function rate(owner, at = now()) {
    if (db.prepare('SELECT COUNT(*) AS n FROM writes WHERE owner=? AND at>?').get(owner, at - 60000).n >= CHECKIN_LIMITS.writesPerMinute) {
      throw fail(429, 'CHECKIN_RATE', 'Demasiados cambios seguidos. Espera un momento.');
    }
    db.prepare('INSERT INTO writes(owner,at) VALUES(?,?)').run(owner, at);
  }
  async function actor(request) {
    open(); const supplied = await getOwner(request); open();
    if (typeof supplied !== 'string' || !supplied.trim() || supplied.length > 254) {
      throw fail(401, 'CHECKIN_SESSION', 'Entra con una cuenta ficticia para usar tu check-in.');
    }
    return createHash('sha256').update('sensualxcape-local-checkin-v1\0' + supplied.trim().toLowerCase()).digest('hex');
  }
  function ownedPlan(owner, planId) {
    const row = db.prepare('SELECT * FROM plans WHERE owner=? AND id=?').get(owner, planId);
    if (!row) throw missing(); return row;
  }
  async function handle(request, response, url) {
    let owner = await actor(request);
    if (!url.pathname.startsWith(PREFIX + '/') || /%|\\|\/\//.test(url.pathname)) throw missing();
    if ([...url.searchParams].length) throw fail(400, 'CHECKIN_QUERY', 'Este ensayo no admite parámetros de consulta.');
    const route = url.pathname.slice(PREFIX.length), method = request.method;
    let body;
    if (method === 'POST') {
      body = await readJson(request);
      const fresh = await actor(request);
      if (fresh !== owner) throw fail(401, 'CHECKIN_SESSION_CHANGED', 'La sesión ha cambiado.');
      owner = fresh;
    }
    processDue();
    if (method === 'GET' && route === '/state') {
      const plans = db.prepare('SELECT * FROM plans WHERE owner=? ORDER BY created_at DESC,rowid DESC LIMIT 50').all(owner).map(planView);
      const active = db.prepare("SELECT * FROM plans WHERE owner=? AND status='active'").get(owner);
      return json(response, 200, { contacts: db.prepare('SELECT * FROM contacts WHERE owner=? ORDER BY created_at,rowid').all(owner).map(contactView),
        active_plan: active ? planView(active) : null, plans,
        events: db.prepare('SELECT * FROM events WHERE owner=? ORDER BY created_at DESC,rowid DESC LIMIT 100').all(owner).map(eventView),
        server_now: iso(now()), scheduler_ok: !schedulerError,
        limits: CHECKIN_LIMITS });
    }
    if (method === 'POST' && route === '/contacts') {
      object(body, ['alias']); const alias = cleanText(body.alias, 60, 'El alias');
      // Fixture-only: no addresses, URLs or telephone-like strings in this demo.
      if (/@|https?:|www\.|\+?\d[\d\s().-]{5,}\d/i.test(alias)) throw fail(400, 'CHECKIN_FICTITIOUS_ONLY', 'Usa solo un alias ficticio, sin correo ni teléfono.');
      const contact = transaction(() => {
        if (db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE owner=?').get(owner).n >= CHECKIN_LIMITS.contacts) {
          throw fail(409, 'CHECKIN_CONTACT_LIMIT', 'El ensayo admite hasta veinte contactos ficticios.');
        }
        rate(owner); const row = { id: randomUUID(), owner, alias, created_at: now() };
        db.prepare('INSERT INTO contacts(id,owner,alias,created_at) VALUES(?,?,?,?)').run(row.id, owner, alias, row.created_at);
        return row;
      });
      return json(response, 201, { contact: contactView(contact) });
    }
    const contactMatch = /^\/contacts\/([^/]+)$/.exec(route);
    if (method === 'DELETE' && contactMatch) {
      const contactId = id(contactMatch[1]);
      transaction(() => {
        if (!db.prepare('SELECT 1 FROM contacts WHERE owner=? AND id=?').get(owner, contactId)) throw missing();
        rate(owner); db.prepare('DELETE FROM contacts WHERE owner=? AND id=?').run(owner, contactId);
      });
      return json(response, 200, { deleted: true });
    }
    if (method === 'POST' && route === '/plans') {
      object(body, ['label', 'duration_seconds', 'reminder_seconds', 'contact_ids', 'client_request_id']);
      const label = cleanText(body.label, 120, 'El nombre'), requestId = id(body.client_request_id);
      const duration = body.duration_seconds, reminder = body.reminder_seconds;
      if (!Number.isSafeInteger(duration) || duration < CHECKIN_LIMITS.durationMin || duration > CHECKIN_LIMITS.durationMax
        || !Number.isSafeInteger(reminder) || reminder < 1 || reminder >= duration) {
        throw fail(400, 'CHECKIN_DURATION', 'Duración de 15 segundos a 24 horas; recordatorio antes del vencimiento.');
      }
      if (!Array.isArray(body.contact_ids) || body.contact_ids.length < 1 || body.contact_ids.length > CHECKIN_LIMITS.recipients) {
        throw fail(400, 'CHECKIN_RECIPIENTS', 'Elige de uno a tres contactos ficticios propios.');
      }
      const contactIds = body.contact_ids.map(id).sort();
      if (new Set(contactIds).size !== contactIds.length) throw fail(400, 'CHECKIN_RECIPIENTS', 'No repitas destinatarios.');
      const fingerprint = createHash('sha256').update(JSON.stringify([label, duration, reminder, contactIds])).digest('hex');
      const result = transaction(() => {
        const old = db.prepare('SELECT * FROM operations WHERE owner=? AND request_id=?').get(owner, requestId);
        if (old) {
          if (old.fingerprint !== fingerprint) throw fail(409, 'CHECKIN_REQUEST_REUSED', 'Esta operación ya tiene otro contenido.');
          return { fresh: false, row: ownedPlan(owner, old.plan_id) };
        }
        if (db.prepare("SELECT 1 FROM plans WHERE owner=? AND status='active'").get(owner)) throw fail(409, 'CHECKIN_ACTIVE_PLAN', 'Ya tienes un check-in activo.');
        if (db.prepare('SELECT COUNT(*) AS n FROM plans WHERE owner=?').get(owner).n >= CHECKIN_LIMITS.plans) throw fail(409, 'CHECKIN_PLAN_LIMIT', 'Se alcanzó el límite de historial de este ensayo.');
        const recipients = contactIds.map(contactId => {
          const row = db.prepare('SELECT id,alias FROM contacts WHERE owner=? AND id=?').get(owner, contactId);
          if (!row) throw missing(); return { id: row.id, alias: row.alias };
        });
        rate(owner); const at = now(), planId = randomUUID();
        db.prepare(`INSERT INTO plans(id,owner,label,status,created_at,deadline_at,reminder_at,recipients)
          VALUES(?,?,?,'active',?,?,?,?)`).run(planId, owner, label, at, at + duration * 1000, at + (duration - reminder) * 1000, JSON.stringify(recipients));
        db.prepare('INSERT INTO operations(owner,request_id,fingerprint,plan_id) VALUES(?,?,?,?)').run(owner, requestId, fingerprint, planId);
        const row = ownedPlan(owner, planId); event(row, 'created', at);
        return { fresh: true, row };
      });
      return json(response, result.fresh ? 201 : 200, { plan: planView(result.row) });
    }
    const action = /^\/plans\/([^/]+)\/(confirm|cancel)$/.exec(route);
    if (method === 'POST' && action) {
      object(body, []); const planId = id(action[1]), target = action[2] === 'confirm' ? 'confirmed' : 'cancelled';
      const result = transaction(() => {
        const row = ownedPlan(owner, planId);
        if (row.status === target) return { row };
        // A deadline can pass between the earlier sweep and this decision.
        // Commit the expiry event, then return 409 outside the transaction;
        // throwing inside here would roll that important event back.
        const at = now();
        if (row.status === 'active' && at >= row.deadline_at) { expire(row, at); return { expired: true }; }
        if (row.status !== 'active') throw fail(409, 'CHECKIN_FINISHED', row.status === 'overdue'
          ? 'El plazo venció y el aviso simulado ya está registrado. No se borra al confirmar o cancelar después.'
          : 'Este check-in ya terminó de otra forma.');
        rate(owner, at);
        db.prepare(`UPDATE plans SET status=?,${target === 'confirmed' ? 'confirmed_at' : 'cancelled_at'}=? WHERE owner=? AND id=?`)
          .run(target, at, owner, planId);
        event(row, target, at); return { row: ownedPlan(owner, planId) };
      });
      if (result.expired) throw fail(409, 'CHECKIN_FINISHED', 'El plazo acaba de vencer; el aviso simulado queda registrado y no se ha enviado a nadie.');
      return json(response, 200, { plan: planView(result.row) });
    }
    throw missing();
  }
  try {
    processDue();
    scheduler = new Cron('* * * * * *', { protect: true, unref: true, catch: () => { schedulerError = true; } }, processDue);
  } catch (error) { db.close(); throw error; }
  return { directory: root, handle, processDue,
    async close() { if (!closed) { closed = true; scheduler.stop(); db.close(); } } };
}
