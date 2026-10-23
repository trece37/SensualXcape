import Uppy from '@uppy/core';
import Tus from '@uppy/tus';

// Uppy supplies file restrictions, upload state and the Tus transfer protocol.
// This adapter keeps the existing vanilla Connect interface and session contract.
export const COFRE_MAX_FILE_SIZE = 10 * 1024 * 1024;
const MIME_TYPES = ['text/plain', 'application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
const EXTENSIONS = { txt: 'text/plain', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

export function createMemoryUrlStorage() {
  const uploads = new Map();
  let nextKey = 0;
  return {
    async findAllUploads() { return [...uploads.values()]; },
    async findUploadsByFingerprint(fingerprint) { return [...uploads.values()].filter(upload => upload.fingerprint === fingerprint); },
    async addUpload(fingerprint, upload) {
      const key = `cofre-session-${++nextKey}`;
      uploads.set(key, { ...upload, fingerprint, urlStorageKey: key });
      return key;
    },
    async removeUpload(key) { uploads.delete(key); },
    clear() { uploads.clear(); }
  };
}

function readableSize(size) {
  if (size < 1024) return `${Math.max(0, size)} B`;
  return size < 1024 * 1024 ? `${Math.round(size / 1024)} KiB` : `${(size / 1024 / 1024).toLocaleString('es', { maximumFractionDigits: 1 })} MiB`;
}

function authFailure(status) {
  if (status === 401) return 'Tu sesión ha terminado. Vuelve a entrar para abrir tu Cofre.';
  if (status === 403 || status === 404) return 'No se puede acceder a ese archivo desde tu cuenta. Actualiza tu Cofre.';
  if (status === 413) return 'No se puede guardar: revisa el tamaño del archivo (máximo 10 MiB) o el espacio disponible en este ensayo.';
  if (status === 415) return 'Ese formato no está permitido. Elige TXT, PDF, PNG, JPEG o WEBP.';
  if (status === 422) return 'El contenido del archivo no coincide con un formato permitido o está dañado. Elige otro archivo.';
  if (status === 429 || status === 507) return 'El Cofre ha alcanzado el límite de este ensayo. Borra un archivo o inténtalo después.';
  return 'No hemos podido completar la operación. Tu selección se conserva para que puedas reintentar.';
}

function fileMime(file) {
  return file.type || EXTENSIONS[file.name.split('.').at(-1)?.toLowerCase()] || 'application/octet-stream';
}

export function mountCofre({
  getSession = () => window.__sxCofreSession,
  documentRef = document,
  windowRef = window,
  fetchImpl = (...args) => windowRef.fetch(...args),
  UppyClass = Uppy,
  TusClass = Tus
} = {}) {
  const main = documentRef.querySelector('main');
  if (!main || documentRef.getElementById('cofre-panel')) return null;
  const element = (tag, className, text) => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (text, className = 'secondary small') => {
    const node = element('button', className, text);
    node.type = 'button';
    return node;
  };
  const panel = element('section', 'panel cofre-panel');
  panel.id = 'cofre-panel';
  panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'cofre-title');
  const heading = element('div', 'section-heading');
  const headingText = element('div');
  headingText.append(element('span', 'eyebrow', 'SOLO PARA TI'));
  const title = element('h2', '', 'Tu Cofre');
  title.id = 'cofre-title';
  headingText.append(title);
  const refreshButton = button('Actualizar mis archivos', 'text-button');
  refreshButton.id = 'cofre-refresh';
  heading.append(headingText, refreshButton);
  const intro = element('p', 'cofre-intro', 'Guarda tus archivos, recupera el original y bórralos cuando lo decidas. No se comparten con tus contactos.');
  const easyHelp = element('p', 'cofre-easy-help', '1. Elige un archivo. 2. Pulsa Guardar selección. 3. Después podrás descargarlo o borrarlo desde Mis archivos.');
  const label = element('label', 'cofre-file-label', 'Elige archivos (todavía no se enviarán)');
  label.htmlFor = 'cofre-file-input';
  const input = element('input');
  input.type = 'file';
  input.id = 'cofre-file-input';
  input.multiple = true;
  input.accept = '.txt,.pdf,.png,.jpg,.jpeg,.webp';
  input.setAttribute('aria-describedby', 'cofre-restrictions');
  const restrictions = element('p', 'help', 'TXT, PDF, PNG, JPEG o WEBP. Hasta 10 MiB por archivo y 5 archivos por selección. Sin vistas previas automáticas.');
  restrictions.id = 'cofre-restrictions';
  const queue = element('ul', 'cofre-queue');
  queue.id = 'cofre-queue';
  queue.setAttribute('aria-label', 'Tu selección de archivos');
  const saveButton = button('Guardar selección', 'primary');
  saveButton.id = 'cofre-save';
  saveButton.disabled = true;
  const status = element('p', 'cofre-status help');
  status.id = 'cofre-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const filesTitle = element('h3', 'cofre-files-title', 'Mis archivos');
  const filesList = element('ul', 'cofre-files');
  filesList.id = 'cofre-files';
  filesList.setAttribute('aria-label', 'Archivos guardados en tu Cofre');
  const empty = element('p', 'help cofre-empty', 'Todavía no has guardado archivos.');
  empty.hidden = true;
  const localNote = element('p', 'help cofre-local-note', 'Prueba local: los archivos permanecen en este equipo. Usa archivos de prueba. Este ensayo no ofrece cifrado de extremo a extremo.');
  const quota = element('p', 'help cofre-quota', 'En este ensayo puedes guardar hasta 100 MiB y 50 archivos por cuenta.');
  panel.append(heading, intro, easyHelp, label, input, restrictions, queue, saveButton, status, filesTitle, quota, filesList, empty, localNote);
  main.append(panel);
  const navigation = element('nav', 'cofre-navigation');
  navigation.id = 'cofre-navigation';
  navigation.hidden = true;
  navigation.setAttribute('aria-label', 'Tus espacios');
  const messagesLink = element('a', 'cofre-nav-link', 'Mensajes');
  messagesLink.href = '#chat-panel';
  const cofreLink = element('a', 'cofre-nav-link', 'Mi Cofre');
  cofreLink.href = '#cofre-panel';
  const communityLink = element('a', 'cofre-nav-link', 'Forocromos');
  communityLink.href = '#forocromos-panel';
  navigation.append(messagesLink, cofreLink, communityLink);
  main.insertBefore(navigation, documentRef.getElementById('chat-panel') || panel);

  let actor = null;
  let uppy = null;
  let generation = 0;
  let listRequest = 0;
  let selectionBusy = false;
  let urlStorage = null;
  let destroyed = false;
  const pendingRequests = new Set();
  const blobUrls = new Set();
  const queueRows = new Map();
  const cancellingFiles = new Set();

  function currentSession(expectedActor = actor) {
    const session = getSession();
    if (!expectedActor || session?.user?.id !== expectedActor || !session.access_token) throw new Error('COFRE_SESSION_CHANGED');
    return session;
  }
  function isCurrent(expectedActor, epoch) {
    return !destroyed && actor === expectedActor && generation === epoch && getSession()?.user?.id === expectedActor;
  }
  function say(message, isError = false) {
    status.textContent = message;
    status.classList.toggle('cofre-error', isError);
  }
  function revokeDownloads() {
    for (const url of blobUrls) windowRef.URL.revokeObjectURL(url);
    blobUrls.clear();
  }
  async function request(path, options = {}, expectedActor = actor) {
    const session = currentSession(expectedActor);
    const controller = new AbortController();
    pendingRequests.add(controller);
    try {
      const response = await fetchImpl(path, {
        ...options,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
        headers: { ...options.headers, Authorization: `Bearer ${session.access_token}`, apikey: session.apikey || '' }
      });
      if (!response.ok) {
        const error = new Error(authFailure(response.status));
        error.status = response.status;
        throw error;
      }
      return response;
    } finally {
      pendingRequests.delete(controller);
    }
  }
  function stopTransfers() {
    if (!uppy) return;
    const old = uppy;
    uppy = null;
    old.pauseAll(); // Tus aborts in-flight XHR without terminating the upload.
    // @uppy/tus 6.0.0 exposes these transfer event managers. Detach before
    // destroy(), whose cancel-all otherwise issues DELETE after the actor changed.
    // Incomplete server uploads expire independently; never send a new account's
    // credentials to an upload belonging to the previous account.
    const tus = old.getPlugin('Tus');
    for (const manager of Object.values(tus?.uploaderEvents || {})) manager?.remove();
    old.destroy();
    urlStorage?.clear();
    urlStorage = null;
  }
  function reset() {
    generation++;
    actor = null;
    panel.hidden = true;
    navigation.hidden = true;
    filesList.replaceChildren();
    queue.replaceChildren();
    queueRows.clear();
    cancellingFiles.clear();
    input.value = '';
    empty.hidden = true;
    saveButton.disabled = true;
    refreshButton.disabled = false;
    selectionBusy = false;
    say('');
    for (const controller of pendingRequests) controller.abort();
    pendingRequests.clear();
    revokeDownloads();
    stopTransfers();
  }
  function localUploadPath(uploadUrl) {
    const target = new URL(uploadUrl, windowRef.location.origin);
    if (target.origin !== windowRef.location.origin || !target.pathname.startsWith('/cofre/v1/uploads/') || target.pathname.slice('/cofre/v1/uploads/'.length).includes('/')) throw new Error('COFRE_INVALID_UPLOAD_URL');
    return target.pathname;
  }
  async function cancelSelectedFile(id) {
    const instance = uppy;
    const expectedActor = actor;
    const epoch = generation;
    if (!instance || cancellingFiles.has(id)) return;
    let original;
    let uploadUrl;
    try {
      currentSession(expectedActor);
      original = instance.getFile(id);
      if (!original) return;
      const tus = instance.getPlugin('Tus');
      const transfer = tus?.uploaders[id];
      uploadUrl = transfer?.url || original.tus?.uploadUrl;
      if (original.progress.uploadComplete || (!original.progress.uploadStarted && !uploadUrl)) {
        instance.removeFile(id);
        say('Archivo quitado de la selección.');
        return;
      }
      cancellingFiles.add(id);
      if (!original.isPaused) instance.pauseResume(id);
      renderQueue();
      // Own the termination request and await its result. Tus 6.0.0's default
      // file-removed handler does not await abort(true); a failed DELETE would
      // otherwise leave an unhandled rejection and a misleading success message.
      await transfer?.abort(false);
      if (tus) tus.uploaders[id] = null;
      if (uploadUrl) await request(localUploadPath(uploadUrl), { method: 'DELETE', headers: { 'Tus-Resumable': '1.0.0' } }, expectedActor);
      if (!isCurrent(expectedActor, epoch)) return;
      instance.removeFile(id); // Resolves Tus's cancelled transfer without another DELETE.
      say('Subida cancelada.');
    } catch (error) {
      if (!isCurrent(expectedActor, epoch)) return;
      if (original && instance.getFile(id)) {
        // Resolve the paused transfer, then retain the original data and the
        // partial upload reference for explicit cancellation or upload retry.
        const tus = instance.getPlugin('Tus');
        if (tus) tus.uploaders[id] = null;
        instance.removeFile(id);
        const replacementId = instance.addFile({ name: original.name, type: original.type, data: original.data, source: 'cofre-input', meta: original.meta });
        instance.setFileState(replacementId, {
          error: 'No se ha podido completar la cancelación.',
          isPaused: true,
          tus: uploadUrl ? { uploadUrl } : undefined
        });
      }
      say(error.status === 401 || error.status === 403 ? error.message : 'La subida está detenida, pero no hemos podido borrar su parte guardada. Pulsa Cancelar subida para reintentar, o Reintentar para seguir guardando.', true);
    } finally {
      cancellingFiles.delete(id);
      if (isCurrent(expectedActor, epoch)) renderQueue();
    }
  }
  function renderQueue() {
    if (!uppy || !actor) return;
    const files = uppy.getFiles();
    const ids = new Set(files.map(file => file.id));
    for (const [id, row] of queueRows) {
      if (!ids.has(id)) { row.node.remove(); queueRows.delete(id); }
    }
    for (const file of files) {
      let row = queueRows.get(file.id);
      if (!row) {
        const node = element('li', 'cofre-queue-item');
        const text = element('div', 'cofre-file-description');
        const name = element('strong', 'cofre-file-name', file.name);
        const detail = element('span', 'help');
        const progress = element('progress', 'cofre-progress');
        progress.max = 100;
        progress.value = 0;
        progress.setAttribute('aria-label', `Progreso de ${file.name}`);
        text.append(name, detail, progress);
        const actions = element('div', 'cofre-file-actions');
        const retry = button('Reintentar');
        retry.hidden = true;
        retry.setAttribute('aria-label', `Reintentar guardar ${file.name}`);
        retry.addEventListener('click', async () => {
          const instance = uppy;
          const expectedActor = actor;
          const epoch = generation;
          if (!instance || !isCurrent(expectedActor, epoch)) return;
          say('Reintentando guardar el archivo…');
          try { await instance.retryUpload(file.id); }
          catch { if (isCurrent(expectedActor, epoch)) say('No se ha guardado. Puedes reintentar o quitarlo de la selección.', true); }
        });
        const remove = button('Quitar', 'text-button');
        remove.addEventListener('click', () => { void cancelSelectedFile(file.id); });
        actions.append(retry, remove);
        node.append(text, actions);
        queue.append(node);
        row = { node, detail, progress, retry, remove };
        queueRows.set(file.id, row);
      }
      const complete = Boolean(file.progress.uploadComplete);
      const active = Boolean(file.progress.uploadStarted) && !complete && !file.error && !file.isPaused;
      const percent = Math.min(100, Math.max(0, file.progress.percentage || 0));
      row.progress.value = complete ? 100 : percent;
      row.progress.hidden = !file.progress.uploadStarted && !complete;
      row.detail.textContent = `${readableSize(file.size || 0)} · ${complete ? 'Guardado' : cancellingFiles.has(file.id) ? 'Cancelando…' : file.error ? 'No se ha guardado' : active ? `Guardando: ${Math.round(percent)} %` : file.isPaused ? 'Subida detenida' : 'Listo para guardar'}`;
      row.retry.hidden = !file.error;
      row.remove.textContent = !complete && (file.progress.uploadStarted || file.tus?.uploadUrl) ? 'Cancelar subida' : complete ? 'Quitar de selección' : 'Quitar';
      row.remove.disabled = cancellingFiles.has(file.id);
      row.retry.disabled = cancellingFiles.has(file.id);
      row.remove.setAttribute('aria-label', `${row.remove.textContent}: ${file.name}`);
    }
    saveButton.disabled = selectionBusy || !files.some(file => !file.progress.uploadStarted && !file.progress.uploadComplete && !file.error);
  }
  function configureUploader(expectedActor, epoch) {
    urlStorage = createMemoryUrlStorage();
    const instance = new UppyClass({
      id: 'sx-cofre-local', autoProceed: false,
      restrictions: { maxFileSize: COFRE_MAX_FILE_SIZE, maxNumberOfFiles: 5, allowedFileTypes: MIME_TYPES },
      locale: { strings: {
        exceedsSize: '%{file} supera el máximo de %{size}.',
        youCanOnlyUploadFileTypes: 'Elige TXT, PDF, PNG, JPEG o WEBP.',
        youCanOnlyUploadX: 'Puedes seleccionar como máximo %{smart_count} archivos.',
        noDuplicates: 'Ese archivo ya está en tu selección.',
        emptyFolderAdded: 'No se ha añadido ningún archivo.'
      } }
    });
    instance.use(TusClass, {
      endpoint: new URL('/cofre/v1/uploads', windowRef.location.origin).href,
      limit: 2,
      chunkSize: 1024 * 1024,
      retryDelays: [0, 1000, 3000],
      allowedMetaFields: ['filename', 'filetype'],
      removeFingerprintOnSuccess: true,
      storeFingerprintForResuming: true,
      urlStorage,
      withCredentials: false,
      onBeforeRequest(req) {
        if (!isCurrent(expectedActor, epoch)) throw new Error('COFRE_SESSION_CHANGED');
        const session = currentSession(expectedActor);
        const target = new URL(req.getURL(), windowRef.location.origin);
        if (target.origin !== windowRef.location.origin || !(target.pathname === '/cofre/v1/uploads' || target.pathname.startsWith('/cofre/v1/uploads/'))) throw new Error('COFRE_INVALID_UPLOAD_URL');
        req.setHeader('Authorization', `Bearer ${session.access_token}`);
        req.setHeader('apikey', session.apikey || '');
      },
      onShouldRetry(error, attempt, options, next) {
        if (!isCurrent(expectedActor, epoch)) return false;
        const code = error.originalResponse?.getStatus();
        if ([400, 401, 403, 404, 413, 415, 422, 429, 507].includes(code)) return false;
        return next(error);
      }
    });
    const update = () => { if (isCurrent(expectedActor, epoch)) renderQueue(); };
    for (const event of ['file-added', 'file-removed', 'upload-progress', 'upload', 'upload-started', 'upload-error', 'upload-success', 'complete']) instance.on(event, update);
    instance.on('restriction-failed', (_file, error) => {
      if (isCurrent(expectedActor, epoch)) say(error.message || 'Ese archivo no cumple los límites de la selección.', true);
    });
    instance.on('upload-error', (_file, _error, response) => {
      if (isCurrent(expectedActor, epoch)) say(authFailure(response?.status), true);
    });
    instance.on('upload-success', () => {
      if (isCurrent(expectedActor, epoch)) {
        say('Archivo guardado. Puedes recuperarlo desde Mis archivos.');
        void refresh();
      }
    });
    return instance;
  }
  async function refresh() {
    const expectedActor = actor;
    const epoch = generation;
    const sequence = ++listRequest;
    if (!expectedActor) return;
    refreshButton.disabled = true;
    filesList.setAttribute('aria-busy', 'true');
    try {
      const response = await request('/cofre/v1/files', {}, expectedActor);
      const payload = await response.json();
      if (!isCurrent(expectedActor, epoch) || sequence !== listRequest) return;
      if (!Array.isArray(payload.files)) throw new Error('Respuesta de archivos no válida.');
      filesList.replaceChildren();
      for (const file of payload.files) filesList.append(renderStoredFile(file, expectedActor, epoch));
      empty.hidden = payload.files.length !== 0;
      if (!status.textContent || status.textContent === 'Cargando tu Cofre…') say('Tu Cofre está actualizado.');
    } catch (error) {
      if (isCurrent(expectedActor, epoch) && sequence === listRequest && error.name !== 'AbortError') {
        say(error.status ? error.message : 'No hemos podido cargar tus archivos. Pulsa Actualizar mis archivos para reintentar.', true);
        empty.hidden = true;
      }
    } finally {
      if (isCurrent(expectedActor, epoch) && sequence === listRequest) {
        refreshButton.disabled = false;
        filesList.removeAttribute('aria-busy');
      }
    }
  }
  function renderStoredFile(file, expectedActor, epoch) {
    const item = element('li', 'cofre-stored-file');
    const text = element('div', 'cofre-file-description');
    const name = String(file.name || 'Archivo');
    text.append(element('strong', 'cofre-file-name', name));
    const date = new Date(file.createdAt);
    text.append(element('span', 'help', `${readableSize(Number(file.size) || 0)}${Number.isNaN(date.valueOf()) ? '' : ` · ${date.toLocaleDateString('es')}`}`));
    const actions = element('div', 'cofre-file-actions');
    const download = button('Descargar');
    download.setAttribute('aria-label', `Descargar ${name}`);
    const remove = button('Borrar', 'text-button cofre-delete-button');
    remove.setAttribute('aria-label', `Borrar ${name}`);
    const confirmBox = element('div', 'cofre-confirm');
    confirmBox.hidden = true;
    confirmBox.setAttribute('role', 'group');
    confirmBox.setAttribute('aria-label', `Confirmar borrado de ${name}`);
    const confirmText = element('p', '', `¿Borrar “${name}” de tu Cofre? No podrás recuperarlo desde aquí.`);
    const confirm = button('Sí, borrar archivo', 'secondary cofre-delete-button');
    const cancel = button('Conservar archivo', 'text-button');
    confirmBox.append(confirmText, confirm, cancel);
    const path = `/cofre/v1/files/${encodeURIComponent(String(file.id))}`;
    download.addEventListener('click', async () => {
      if (!isCurrent(expectedActor, epoch)) return;
      download.disabled = true;
      try {
        // Construct our own same-origin route; never send a bearer token to a
        // downloadUrl supplied in file metadata.
        const response = await request(path, {}, expectedActor);
        const blob = await response.blob();
        if (!isCurrent(expectedActor, epoch)) return;
        const url = windowRef.URL.createObjectURL(blob);
        blobUrls.add(url);
        const anchor = element('a');
        anchor.href = url;
        anchor.download = name.replace(/[\\/\x00-\x1f\x7f]/g, '_');
        anchor.hidden = true;
        panel.append(anchor);
        anchor.click();
        anchor.remove();
        windowRef.setTimeout(() => { windowRef.URL.revokeObjectURL(url); blobUrls.delete(url); }, 1000);
        say('Descarga preparada con el archivo original.');
      } catch (error) {
        if (isCurrent(expectedActor, epoch) && error.name !== 'AbortError') say(error.status ? error.message : 'No se ha podido descargar. Vuelve a intentarlo.', true);
      } finally {
        if (isCurrent(expectedActor, epoch)) download.disabled = false;
      }
    });
    remove.addEventListener('click', () => {
      if (!isCurrent(expectedActor, epoch)) return;
      confirmBox.hidden = false;
      remove.hidden = true;
      confirm.focus();
    });
    cancel.addEventListener('click', () => { confirmBox.hidden = true; remove.hidden = false; remove.focus(); });
    confirm.addEventListener('click', async () => {
      if (!isCurrent(expectedActor, epoch)) return;
      confirm.disabled = true;
      cancel.disabled = true;
      download.disabled = true;
      try {
        await request(path, { method: 'DELETE' }, expectedActor);
        if (!isCurrent(expectedActor, epoch)) return;
        ++listRequest; // A pre-delete list response must not resurrect this file.
        item.remove();
        empty.hidden = filesList.children.length !== 0;
        say('Archivo borrado de tu Cofre.');
        refreshButton.focus();
        void refresh();
      } catch (error) {
        if (isCurrent(expectedActor, epoch) && error.name !== 'AbortError') {
          say(error.status ? error.message : 'No se ha podido borrar. El archivo sigue en tu lista; puedes reintentar.', true);
          confirm.disabled = false;
          cancel.disabled = false;
          download.disabled = false;
        }
      }
    });
    actions.append(download, remove);
    item.append(text, actions, confirmBox);
    return item;
  }
  function setSession(session) {
    const nextActor = session?.user?.id && session?.access_token ? session.user.id : null;
    if (nextActor && actor === nextActor) return; // Token refresh uses getSession() at each request.
    reset();
    if (!nextActor || destroyed) return;
    actor = nextActor;
    const epoch = generation;
    uppy = configureUploader(actor, epoch);
    panel.hidden = false;
    navigation.hidden = false;
    say('Cargando tu Cofre…');
    void refresh();
  }
  const onSession = event => setSession(event.detail);
  windowRef.addEventListener('sx:session', onSession);
  input.addEventListener('change', () => {
    if (!uppy || !actor) { input.value = ''; return; }
    try { currentSession(); } catch { reset(); return; }
    let added = 0;
    let rejected = false;
    for (const file of input.files || []) {
      try {
        uppy.addFile({ name: file.name, type: fileMime(file), data: file, source: 'cofre-input', meta: { filename: file.name, filetype: fileMime(file) } });
        added++;
      } catch { rejected = true; }
    }
    input.value = '';
    if (added && !rejected) say(`${added === 1 ? 'Archivo preparado' : 'Archivos preparados'}. Pulsa Guardar selección cuando quieras.`);
    renderQueue();
  });
  saveButton.addEventListener('click', async () => {
    if (!uppy || selectionBusy) return;
    const instance = uppy;
    const expectedActor = actor;
    const epoch = generation;
    try { currentSession(expectedActor); } catch { reset(); return; }
    selectionBusy = true;
    saveButton.disabled = true;
    say('Guardando tu selección…');
    try { await instance.upload(); }
    catch {
      if (isCurrent(expectedActor, epoch)) say('No se ha guardado toda la selección. Puedes reintentar los archivos pendientes.', true);
    } finally {
      if (isCurrent(expectedActor, epoch)) { selectionBusy = false; renderQueue(); }
    }
  });
  refreshButton.addEventListener('click', () => { say('Cargando tu Cofre…'); void refresh(); });
  setSession(getSession());
  return {
    panel, setSession, refresh,
    getUploader: () => uppy,
    destroy() {
      destroyed = true;
      windowRef.removeEventListener('sx:session', onSession);
      reset();
      panel.remove();
      navigation.remove();
    }
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') mountCofre();
