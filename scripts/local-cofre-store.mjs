import { Server } from '@tus/server';
import { FileStore } from '@tus/file-store';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, lstat, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Readable } from 'node:stream';

// Local fixture storage only. tus-node-server owns the resumable-upload protocol;
// this adapter supplies ownership, bounded resources and authenticated recovery.
export const COFRE_MAX_FILE_SIZE = 10 * 1024 * 1024;
export const COFRE_MAX_TOTAL_SIZE = 100 * 1024 * 1024;
export const COFRE_MAX_FILES = 50;
export const COFRE_PENDING_TTL_MS = 24 * 60 * 60 * 1000;
export const COFRE_TYPES = Object.freeze(['text/plain', 'application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
export const COFRE_UPLOAD_PATH = '/cofre/v1/uploads';
export const COFRE_FILE_PATH = '/cofre/v1/files';
export const COFRE_DEFAULT_DIR = fileURLToPath(new URL('../../local-data/cofre/', import.meta.url));
const ID = /^[0-9a-f]{32}$/;
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const tusFail = (status_code, body) => Object.assign(new Error(body), { status_code, body });
const absent = error => error?.code === 'ENOENT' || error?.status_code === 404 || error?.status_code === 410;
const readyName = id => `.ready-${id}.json`;

function json(response, status, body) {
  response.statusCode = status; response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}
function cleanName(value) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 512) {
    throw tusFail(400, 'El archivo necesita un nombre de hasta 512 bytes.');
  }
  // A name is display metadata, never a filesystem path. Remove controls, bidi
  // overrides and separators while retaining ordinary Unicode names.
  return value.normalize('NFC').replace(/[\p{Cc}\p{Cf}\\/]/gu, '').trim().slice(0, 180) || 'archivo';
}
function hasSupportedSignature(bytes, type) {
  if (type === 'text/plain') {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return !bytes.includes(0); } catch { return false; }
  }
  if (type === 'application/pdf') return bytes.subarray(0, 5).equals(Buffer.from('%PDF-'));
  if (type === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (type === 'image/webp') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

export async function createLocalCofreStore({ directory = COFRE_DEFAULT_DIR, getOwner } = {}) {
  if (typeof getOwner !== 'function') throw new Error('Cofre necesita un resolvedor de sesión.');
  const root = path.resolve(directory);
  const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
  const relative = path.relative(publicDir, root);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('El Cofre no puede guardarse dentro de public.');
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const actors = new Map(); let closed = false;

  async function actorFor(owner) {
    // Stable fixture email is supplied by the server, never by the HTTP body.
    const ownerKey = createHash('sha256').update('sensualxcape-local-cofre-v1\0' + owner).digest('hex');
    if (!actors.has(ownerKey)) {
      const pending = (async () => {
        const directory = path.join(root, ownerKey);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const store = new FileStore({ directory });
        // This demo requires a known length and separate creation/PATCH. Do not
        // advertise unsupported extensions even if FileStore implements them.
        store.extensions = ['creation', 'termination'];
        const actor = { directory, store, queue: Promise.resolve() };
        const tus = new Server({
          path: COFRE_UPLOAD_PATH, datastore: store, maxSize: COFRE_MAX_FILE_SIZE,
          relativeLocation: true, respectForwardedHeaders: false, allowedOrigins: [],
          namingFunction: () => randomBytes(16).toString('hex'),
          getFileIdFromRequest: (_request, id) => ID.test(id || '') ? id : undefined,
          async onUploadCreate(_request, upload) {
            const metadata = upload.metadata || {};
            if (Object.keys(metadata).some(key => !['filename', 'filetype'].includes(key))
              || !COFRE_TYPES.includes(metadata.filetype)) throw tusFail(400, 'Solo TXT, PDF, PNG, JPEG o WEBP; no se admiten metadatos adicionales.');
            const filename = cleanName(metadata.filename);
            if (!Number.isSafeInteger(upload.size) || upload.size < 1 || upload.size > COFRE_MAX_FILE_SIZE) {
              throw tusFail(413, 'Cada archivo debe ocupar entre 1 byte y 10 MiB.');
            }
            const keys = (await store.configstore.list()).filter(id => ID.test(id)); let reserved = 0;
            for (const id of keys) {
              if (!ID.test(id)) continue;
              try { const old = await store.getUpload(id); reserved += old.size ?? COFRE_MAX_FILE_SIZE; }
              catch (error) { if (!absent(error)) throw error; }
            }
            if (keys.length >= COFRE_MAX_FILES || reserved + upload.size > COFRE_MAX_TOTAL_SIZE) {
              throw tusFail(413, 'Cofre local lleno: máximo 50 archivos o 100 MiB, incluidas las subidas pendientes.');
            }
            return { metadata: { filename, filetype: metadata.filetype } };
          },
          async onUploadFinish(_request, upload) {
            const bytes = await readFile(path.join(directory, upload.id));
            if (bytes.length !== upload.size || !hasSupportedSignature(bytes, upload.metadata.filetype)) {
              await store.remove(upload.id);
              throw tusFail(422, 'El contenido no coincide con el tipo permitido o no es texto UTF-8.');
            }
            const metadata = { id: upload.id, name: upload.metadata.filename, type: upload.metadata.filetype,
              size: bytes.length, createdAt: new Date(upload.creation_date).toISOString(),
              sha256: createHash('sha256').update(bytes).digest('hex') };
            const temporary = path.join(directory, `${readyName(upload.id)}.${randomBytes(6).toString('hex')}.tmp`);
            await writeFile(temporary, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
            await rename(temporary, path.join(directory, readyName(upload.id)));
            return {};
          },
          onResponseError: async (_request, error) => ({
            status_code: error.status_code || 500,
            body: error.status_code ? (error.body || 'No se pudo completar la subida local.') : 'No se pudo completar la subida local.'
          })
        });
        actor.tus = tus; return actor;
      })();
      actors.set(ownerKey, pending);
    }
    return actors.get(ownerKey);
  }

  async function readReady(actor, id) {
    try {
      const file = path.join(actor.directory, id);
      if (!(await lstat(file)).isFile()) throw fail(404, 'COFRE_NOT_FOUND', 'Archivo no encontrado.');
      const metadata = JSON.parse(await readFile(path.join(actor.directory, readyName(id)), 'utf8'));
      const upload = await actor.store.getUpload(id);
      if (metadata.id !== id || upload.size !== metadata.size || upload.offset !== upload.size) return null;
      return metadata;
    } catch (error) { if (absent(error)) return null; throw error; }
  }

  async function handle(request, response, url) {
    if (closed) throw fail(503, 'COFRE_CLOSED', 'El servidor local está cerrándose.');
    const owner = getOwner(request);
    if (typeof owner !== 'string' || !owner) throw fail(401, 'COFRE_SESSION', 'Inicia sesión antes de abrir el Cofre.');
    const actor = await actorFor(owner);
    const job = actor.queue.then(async () => {
      if (closed || getOwner(request) !== owner) throw fail(401, 'COFRE_SESSION', 'La sesión ya no está disponible.');
      if (request.destroyed && !request.complete) return;
      // Reclaim abandoned pending uploads when that owner next uses the Cofre.
      // Completed files are never expired automatically.
      for (const id of await actor.store.configstore.list()) {
        if (!ID.test(id)) continue;
        const upload = await actor.store.getUpload(id).catch(error => { if (!absent(error)) throw error; });
        if (upload && Date.now() - new Date(upload.creation_date).getTime() >= COFRE_PENDING_TTL_MS
          && !(await readReady(actor, id))) await actor.store.remove(id);
      }
      if (url.search || /%|\\|\/\//.test(request.url || '')) throw fail(400, 'COFRE_PATH', 'Ruta de Cofre no admitida.');
      if (url.pathname === COFRE_FILE_PATH && request.method === 'GET') {
        const files = [];
        for (const entry of await readdir(actor.directory)) {
          const id = /^\.ready-([0-9a-f]{32})\.json$/.exec(entry)?.[1];
          if (id) { const row = await readReady(actor, id); if (row) files.push({ ...row, downloadUrl: `${COFRE_FILE_PATH}/${id}` }); }
        }
        files.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
        return json(response, 200, { files, limits: { maxFileSize: COFRE_MAX_FILE_SIZE, maxTotalSize: COFRE_MAX_TOTAL_SIZE, maxFiles: COFRE_MAX_FILES } });
      }
      const fileId = new RegExp(`^${COFRE_FILE_PATH}/([0-9a-f]{32})$`).exec(url.pathname)?.[1];
      if (fileId && request.method === 'DELETE') {
        await unlink(path.join(actor.directory, readyName(fileId))).catch(error => { if (!absent(error)) throw error; });
        await actor.store.remove(fileId).catch(error => { if (!absent(error)) throw error; });
        response.statusCode = 204; return response.end();
      }
      if (fileId && request.method === 'GET') {
        const metadata = await readReady(actor, fileId);
        if (!metadata) throw fail(404, 'COFRE_NOT_FOUND', 'Archivo no encontrado.');
        const bytes = await readFile(path.join(actor.directory, fileId));
        if (createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) throw fail(409, 'COFRE_CHANGED', 'El archivo local ha cambiado fuera de la aplicación.');
        response.statusCode = 200; response.setHeader('Content-Type', metadata.type);
        response.setHeader('Content-Length', bytes.length);
        response.setHeader('Content-Disposition', `attachment; filename="archivo"; filename*=UTF-8''${encodeURIComponent(metadata.name).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())}`);
        return response.end(bytes);
      }
      const tusId = new RegExp(`^${COFRE_UPLOAD_PATH}/([0-9a-f]{32})$`).exec(url.pathname)?.[1];
      const tusCollection = url.pathname === COFRE_UPLOAD_PATH;
      if ((!tusCollection && !tusId) || !['POST', 'HEAD', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method)
        || (tusCollection && !['POST', 'OPTIONS'].includes(request.method)) || (tusId && request.method === 'POST')) {
        throw fail(404, 'COFRE_ENDPOINT', 'Archivo o endpoint de Cofre no encontrado.');
      }
      if (Buffer.byteLength(request.headers['upload-metadata'] || '') > 2048) throw fail(400, 'COFRE_METADATA', 'Metadatos demasiado grandes.');
      if (tusCollection && request.method === 'POST' && ((request.headers['content-length'] && request.headers['content-length'] !== '0')
        || request.headers['transfer-encoding'] || request.headers['upload-defer-length'] || request.headers['upload-concat'])) {
        request.resume(); throw fail(400, 'COFRE_CREATION', 'Crea la subida con longitud conocida y envía el contenido por PATCH.');
      }
      // The documented Fetch API keeps protocol handling inside tus. We bridge
      // Node ourselves because srvx 0.11.15's response.end callback can remain
      // pending after the client destroys an uploading connection. Await the
      // protocol result (including FileStore writes), then skip a dead socket.
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      request.once('aborted', onAbort);
      let tusResponse;
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        const hasBody = ['POST', 'PATCH'].includes(request.method);
        const webRequest = new Request(url.href, { method: request.method, headers, signal: controller.signal,
          ...(hasBody ? { body: Readable.toWeb(request), duplex: 'half' } : {}) });
        tusResponse = await actor.tus.handleWeb(webRequest);
      } finally { request.off('aborted', onAbort); }
      if (response.destroyed) return;
      response.statusCode = tusResponse.status;
      for (const [name, value] of tusResponse.headers) response.setHeader(name, value);
      const body = tusResponse.body ? Buffer.from(await tusResponse.arrayBuffer()) : undefined;
      response.end(body);
      if (tusId && request.method === 'DELETE' && response.statusCode >= 200 && response.statusCode < 300) {
        await unlink(path.join(actor.directory, readyName(tusId))).catch(error => { if (!absent(error)) throw error; });
      }
    });
    actor.queue = job.catch(() => {}); return job;
  }
  return { directory: root, handle, async close() {
    closed = true; await Promise.all([...actors.values()].map(async pending => (await pending).queue));
  } };
}
