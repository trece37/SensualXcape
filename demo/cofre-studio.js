import { Vault, Upload, Plus, FileText, File as FileIcon, Image as ImageIcon, Search, Trash2, X, Download, Pencil, Info } from 'lucide';

export const COFRE_STUDIO_LIMITS = Object.freeze({ files: 12, fileBytes: 8 * 1024 * 1024, totalBytes: 30 * 1024 * 1024 });
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/bmp']);
const UNSAFE_EXTENSION = /\.(?:html?|xhtml|svgz?|m?js|cjs|jsx|tsx?|php\d*|phtml|py[co]?|rb|pl|lua|sh|bash|zsh|fish|ps1|psm1|bat|cmd|exe|com|dll|scr|vbs|wsf|jar|msi|lnk|url)(?:\.|$)/i;
const UNSAFE_TYPE = /(?:html|svg|javascript|ecmascript|x-executable|x-msdownload|x-sh|x-powershell)/i;
let instance = 0;

function safeName(value) {
  let name = String(value || '').normalize('NFKC').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').split(/[\\/]/).pop().replace(/[<>:"|?*]/g, '_').trim();
  if (!name || /^\.+$/.test(name)) name = 'Archivo sin nombre';
  return name.length > 160 ? `${name.slice(0, 140)}…${name.slice(-16)}` : name;
}
function bytesLabel(value) {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toLocaleString('es', { maximumFractionDigits: 1 })} MB`;
  if (value >= 1024) return `${Math.ceil(value / 1024).toLocaleString('es')} KB`;
  return `${value} B`;
}

/** A voluntary, temporary workspace. Nothing is uploaded or written to browser storage. */
export function createCofreView({ documentRef = document, windowRef = window, onInfo = () => {}, notify = () => {}, confirmAction = async () => false } = {}) {
  const d = documentRef, w = windowRef, prefix = `sx-cofre-${++instance}`;
  const listeners = [], readers = new Set(), downloadUrls = new Map(), deleting = new Set();
  let entries = [], sequence = 0, epoch = 0, revision = 0, disposed = false, previewId = null, previewUrl = null, previewVersion = 0, editingId = null, clearing = false;
  const el = (tag, cls, text) => { const node = d.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const listen = (node, type, action) => { node.addEventListener(type, action); listeners.push(() => node.removeEventListener(type, action)); };
  const icon = (nodes, cls = '') => {
    const svg = d.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: `sx-cofre-icon ${cls}`.trim() })) svg.setAttribute(key, value);
    for (const [tag, attributes] of nodes) { const child = d.createElementNS(svg.namespaceURI, tag); for (const [key, value] of Object.entries(attributes)) child.setAttribute(key, value); svg.append(child); }
    return svg;
  };
  const button = (text, action, art, cls = '') => {
    const node = el('button', `sx-cofre-button ${cls}`.trim()); node.type = 'button';
    if (art) node.append(icon(art)); node.append(el('span', '', text));
    // Item buttons are replaced while filtering. Do not retain detached cards in
    // the view-wide listener cleanup list; their listeners travel with the node.
    if (action) node.addEventListener('click', event => { if (!disposed) action(event); }); return node;
  };
  const totalBytes = () => entries.reduce((sum, entry) => sum + entry.size, 0);
  const report = (message, error = false) => { if (disposed) return; status.textContent = message; status.dataset.tone = error ? 'error' : 'normal'; notify(message); };
  const element = el('section', 'sx-cofre-page'); element.dataset.v11Page = 'cofre'; element.setAttribute('aria-labelledby', `${prefix}-title`);
  const hero = el('header', 'sx-cofre-hero'), heroCopy = el('div', 'sx-cofre-hero-copy');
  heroCopy.append(el('p', 'sx-cofre-eyebrow', 'TU ESPACIO PERSONAL'));
  const title = el('h2', 'sx-cofre-title', 'Un lugar para lo tuyo.'); title.id = `${prefix}-title`;
  heroCopy.append(title, el('p', 'sx-cofre-intro', 'Tus fotos, documentos y pequeñas ideas, a mano y a tu manera.'));
  const heroActions = el('div', 'sx-cofre-actions');
  const fileInput = el('input', 'sx-cofre-file-input'); fileInput.type = 'file'; fileInput.multiple = true; fileInput.id = `${prefix}-files`; fileInput.tabIndex = -1; fileInput.setAttribute('aria-label', 'Seleccionar archivos para el Cofre temporal');
  const chooseFiles = () => { if (!disposed) fileInput.click(); };
  const addFileButton = button('Añadir archivos', chooseFiles, Plus, 'sx-cofre-button-primary'); addFileButton.setAttribute('aria-controls', fileInput.id);
  const newNoteButton = button('Escribir una nota', () => openEditor(), Pencil, 'sx-cofre-button-soft');
  heroActions.append(addFileButton, newNoteButton); heroCopy.append(heroActions);
  const heroArt = el('div', 'sx-cofre-hero-art'), heroImage = el('img'); heroImage.src = './assets/v2/cofre.webp'; heroImage.alt = ''; heroImage.width = 1000; heroImage.height = 900; heroImage.decoding = 'async';
  const artFallback = el('span', 'sx-cofre-art-fallback'); artFallback.append(icon(Vault)); heroArt.append(artFallback, heroImage);
  listen(heroImage, 'error', () => { heroImage.hidden = true; }); hero.append(heroCopy, heroArt); element.append(hero, fileInput);

  const note = el('div', 'sx-cofre-session-note'); note.append(icon(Info), el('p', '', 'Solo en esta pestaña. Se vacía al recargar o cerrar: descarga lo que quieras conservar.'));
  note.append(button('Dónde se guardan tus cosas', () => onInfo('cofre'), undefined, 'sx-cofre-button-link')); element.append(note);
  const workspace = el('div', 'sx-cofre-workspace');
  const dropZone = button('', chooseFiles, undefined, 'sx-cofre-dropzone'); dropZone.setAttribute('aria-controls', fileInput.id);
  dropZone.append(icon(Upload), el('strong', '', 'Suelta aquí lo que quieras guardar'), el('span', '', 'O pulsa para elegir en tu dispositivo'), el('small', '', 'Hasta 12 elementos · 8 MB por archivo · 30 MB en total'));
  listen(dropZone, 'keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); if (!event.repeat) chooseFiles(); } });
  for (const type of ['dragenter', 'dragover']) listen(dropZone, type, event => { event.preventDefault(); dropZone.dataset.dragging = 'true'; });
  listen(dropZone, 'dragleave', event => { if (!dropZone.contains(event.relatedTarget)) delete dropZone.dataset.dragging; });
  listen(dropZone, 'drop', event => { event.preventDefault(); delete dropZone.dataset.dragging; addFiles(event.dataTransfer?.files || []); });
  listen(fileInput, 'change', () => { addFiles(fileInput.files || []); fileInput.value = ''; });
  workspace.append(dropZone);

  const editor = el('section', 'sx-cofre-editor'); editor.hidden = true; editor.setAttribute('aria-labelledby', `${prefix}-editor-title`);
  const editorHeading = el('h3', '', 'Una idea para después'); editorHeading.id = `${prefix}-editor-title`;
  const noteForm = el('form', 'sx-cofre-note-form');
  const titleLabel = el('label', '', 'Título de la nota'), noteTitle = el('input'); noteTitle.id = `${prefix}-note-title`; noteTitle.maxLength = 90; noteTitle.required = true; noteTitle.placeholder = 'Ponle un nombre para encontrarla'; titleLabel.htmlFor = noteTitle.id;
  const textLabel = el('label', '', 'Tu nota'), noteText = el('textarea'); noteText.id = `${prefix}-note-text`; noteText.maxLength = 12000; noteText.rows = 6; noteText.required = true; noteText.placeholder = 'Una idea, una lista, algo que quieres recordar…'; textLabel.htmlFor = noteText.id;
  const saveNote = button('Guardar nota', undefined, FileText, 'sx-cofre-button-primary'); saveNote.type = 'submit';
  const editorActions = el('div', 'sx-cofre-actions'); editorActions.append(saveNote, button('Cancelar edición', () => closeEditor(), X, 'sx-cofre-button-quiet'));
  noteForm.append(titleLabel, noteTitle, textLabel, noteText, el('p', 'sx-cofre-hint', 'Hasta 12.000 caracteres. Descarga la nota antes de recargar o cerrar esta página para conservar su texto.'), editorActions); editor.append(editorHeading, noteForm); workspace.append(editor);

  const library = el('section', 'sx-cofre-library'); library.setAttribute('aria-labelledby', `${prefix}-library-title`);
  const libraryHeading = el('div', 'sx-cofre-library-heading'), libraryTitle = el('h3', '', 'Dentro de tu Cofre'); libraryTitle.id = `${prefix}-library-title`;
  const counter = el('p', 'sx-cofre-counter'); libraryHeading.append(libraryTitle, counter);
  const toolbar = el('div', 'sx-cofre-toolbar'), searchField = el('div', 'sx-cofre-search'), searchLabel = el('label', 'sx-cofre-sr-only', 'Buscar por nombre o título'), search = el('input'); search.type = 'search'; search.id = `${prefix}-search`; search.placeholder = 'Buscar en tu Cofre'; searchLabel.htmlFor = search.id; searchField.append(searchLabel, icon(Search), search);
  const typeField = el('div', 'sx-cofre-type'), typeLabel = el('label', 'sx-cofre-sr-only', 'Filtrar por tipo'), typeFilter = el('select'); typeFilter.id = `${prefix}-type`; typeLabel.htmlFor = typeFilter.id;
  for (const [value, text] of [['all', 'Todos los tipos'], ['image', 'Imágenes'], ['note', 'Notas'], ['text', 'Archivos de texto'], ['file', 'Otros archivos']]) { const option = el('option', '', text); option.value = value; typeFilter.append(option); }
  typeField.append(typeLabel, typeFilter); toolbar.append(searchField, typeField);
  const list = el('ul', 'sx-cofre-list'); list.setAttribute('aria-label', 'Contenido de tu Cofre temporal');
  const empty = el('div', 'sx-cofre-empty'); empty.append(icon(Vault)); const emptyTitle = el('h4'), emptyText = el('p'); empty.append(emptyTitle, emptyText);
  const resetFilters = button('Ver todo', () => { search.value = ''; typeFilter.value = 'all'; renderList(); search.focus(); }, undefined, 'sx-cofre-button-soft'); empty.append(resetFilters);
  const libraryFoot = el('div', 'sx-cofre-library-foot');
  const clearAllButton = button('Vaciar el Cofre', clearAll, Trash2, 'sx-cofre-button-quiet');
  libraryFoot.append(button('Qué ocurre al borrar', () => onInfo('deletion'), Info, 'sx-cofre-button-link'), clearAllButton);
  library.append(libraryHeading, toolbar, list, empty, libraryFoot); workspace.append(library);

  const preview = el('section', 'sx-cofre-preview'); preview.hidden = true; preview.setAttribute('aria-labelledby', `${prefix}-preview-title`);
  const previewHeading = el('div', 'sx-cofre-preview-heading'), previewTitle = el('h3'); previewTitle.id = `${prefix}-preview-title`; previewTitle.tabIndex = -1;
  previewHeading.append(previewTitle, button('Cerrar vista previa', () => closePreview(true), X, 'sx-cofre-button-quiet'));
  const previewContent = el('div', 'sx-cofre-preview-content'); preview.append(previewHeading, previewContent); workspace.append(preview);
  const status = el('p', 'sx-cofre-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  element.append(workspace, status);
  listen(search, 'input', renderList); listen(typeFilter, 'change', renderList);

  function addFiles(files) {
    if (disposed) return;
    let added = 0; const errors = [];
    for (const file of Array.from(files)) {
      const originalName = String(file?.name || '').normalize('NFKC').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '');
      const name = safeName(originalName), type = String(file?.type || '').toLowerCase();
      if (!file || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.slice !== 'function') { errors.push('No hemos podido leer uno de los archivos.'); continue; }
      if (UNSAFE_EXTENSION.test(originalName) || UNSAFE_TYPE.test(type)) { errors.push(`${name}: este tipo de archivo no se admite. Elige otro formato.`); continue; }
      if (file.size > COFRE_STUDIO_LIMITS.fileBytes) { errors.push(`${name}: supera los 8 MB por archivo.`); continue; }
      if (entries.length >= COFRE_STUDIO_LIMITS.files) { errors.push('Tu Cofre admite hasta 12 elementos, incluidas las notas.'); break; }
      if (totalBytes() + file.size > COFRE_STUDIO_LIMITS.totalBytes) { errors.push(`${name}: no cabe en los 30 MB disponibles.`); continue; }
      const kind = IMAGE_TYPES.has(type) ? 'image' : type === 'text/plain' || /\.txt$/i.test(name) ? 'text' : 'file';
      entries.push({ id: ++sequence, name, kind, blob: file, size: file.size }); added++; revision++;
    }
    renderList();
    const summary = added ? `${added === 1 ? 'Archivo añadido' : `${added} archivos añadidos`} al Cofre. Estará${added === 1 ? '' : 'n'} aquí hasta que recargues o cierres la página.` : '';
    report([summary, ...new Set(errors)].filter(Boolean).join(' ') || 'No has seleccionado ningún archivo.', Boolean(errors.length));
  }
  function renderList() {
    if (disposed) return;
    const query = search.value.trim().toLocaleLowerCase('es');
    const matches = entries.filter(entry => (!query || entry.name.toLocaleLowerCase('es').includes(query)) && (typeFilter.value === 'all' || entry.kind === typeFilter.value));
    list.replaceChildren();
    counter.textContent = `${entries.length} de 12 elementos · ${bytesLabel(totalBytes())} de 30 MB`;
    clearAllButton.disabled = !entries.length || clearing;
    empty.hidden = Boolean(matches.length); list.hidden = !matches.length;
    emptyTitle.textContent = entries.length ? 'No encontramos ese nombre por aquí.' : 'Lo importante empieza contigo.';
    emptyText.textContent = entries.length ? 'Prueba otra búsqueda o cambia el tipo de contenido.' : 'Añade un archivo o escribe tu primera nota. Podrás consultarlos mientras esta página esté abierta.';
    resetFilters.hidden = !entries.length;
    for (const entry of matches) {
      const item = el('li', 'sx-cofre-item'); item.dataset.entryId = String(entry.id);
      const mark = el('span', `sx-cofre-item-mark sx-cofre-item-mark-${entry.kind}`); mark.append(icon(entry.kind === 'image' ? ImageIcon : entry.kind === 'file' ? FileIcon : FileText));
      const info = el('div', 'sx-cofre-item-info'), name = el('h4', '', entry.name);
      info.append(name, el('p', 'sx-cofre-meta', `${{ image: 'Imagen', text: 'Texto', note: 'Nota', file: 'Archivo' }[entry.kind]} · ${bytesLabel(entry.size)}`));
      const actions = el('div', 'sx-cofre-item-actions');
      const view = button(entry.kind === 'file' ? 'Detalles' : 'Abrir', () => openPreview(entry), entry.kind === 'file' ? Info : undefined, 'sx-cofre-button-soft'); view.dataset.previewEntry = String(entry.id); view.setAttribute('aria-label', `${entry.kind === 'file' ? 'Ver detalles de' : 'Abrir'} ${entry.name}`); actions.append(view);
      if (entry.kind === 'note') { const edit = button('Editar', () => openEditor(entry), Pencil, 'sx-cofre-button-quiet'); edit.setAttribute('aria-label', `Editar ${entry.name}`); actions.append(edit); }
      const download = button('Descargar', () => downloadEntry(entry), Download, 'sx-cofre-button-quiet'); download.setAttribute('aria-label', `Descargar ${entry.name}`);
      const remove = button('Quitar', () => deleteEntry(entry), Trash2, 'sx-cofre-button-quiet sx-cofre-delete'); remove.disabled = deleting.has(entry.id); remove.setAttribute('aria-label', `Quitar ${entry.name}`);
      actions.append(download, remove); item.append(mark, info, actions); list.append(item);
    }
  }
  function closeEditor() { editingId = null; editor.hidden = true; noteForm.reset(); newNoteButton.focus({ preventScroll: true }); }
  function openEditor(entry = null) {
    if (disposed) return;
    editingId = entry?.id ?? null; editor.hidden = false; editorHeading.textContent = entry ? 'Dale otra vuelta a tu nota.' : 'Una idea para después';
    noteTitle.value = entry?.name || ''; noteText.value = entry?.text || ''; saveNote.querySelector('span').textContent = entry ? 'Guardar cambios' : 'Guardar nota'; noteTitle.focus();
  }
  listen(noteForm, 'submit', event => {
    event.preventDefault(); if (disposed || editor.hidden) return;
    const name = safeName(noteTitle.value.trim()), text = noteText.value;
    if (!noteTitle.value.trim() || !text.trim()) { report('Pon un título y escribe algo antes de guardar.', true); return; }
    if (text.length > 12000) { report('La nota admite hasta 12.000 caracteres. Tus cambios siguen aquí.', true); return; }
    const previous = entries.find(entry => entry.id === editingId), blob = new w.Blob([text], { type: 'text/plain;charset=utf-8' });
    if (!previous && entries.length >= COFRE_STUDIO_LIMITS.files) { report('Ya hay 12 elementos. Quita uno para guardar esta nota; el texto sigue aquí.', true); return; }
    if (totalBytes() - (previous?.size || 0) + blob.size > COFRE_STUDIO_LIMITS.totalBytes) { report('La nota supera el espacio disponible. Tus cambios siguen aquí.', true); return; }
    const entry = { id: previous?.id ?? ++sequence, kind: 'note', name, text, blob, size: blob.size };
    if (previous) entries.splice(entries.indexOf(previous), 1, entry); else entries.push(entry);
    revision++; const wasPreviewed = previewId === entry.id; closeEditor(); renderList(); if (wasPreviewed) void openPreview(entry);
    report(previous ? 'Cambios guardados en esta página. Descarga la nota si quieres conservarlos.' : 'Nota añadida al Cofre. Descárgala antes de recargar o cerrar la página para conservar su texto.');
  });
  function clearPreview() {
    previewVersion++; previewId = null; preview.hidden = true;
    for (const image of previewContent.querySelectorAll('img')) image.removeAttribute('src');
    previewContent.replaceChildren();
    // Remove all consumers before revoking their local URL.
    if (previewUrl) { const old = previewUrl; previewUrl = null; w.URL.revokeObjectURL(old); }
    for (const reader of readers) { if (reader.readyState === 1) reader.abort(); } readers.clear();
  }
  function closePreview(restoreFocus = false) {
    const previous = previewId; clearPreview();
    if (restoreFocus) list.querySelector(`[data-preview-entry="${previous}"]`)?.focus({ preventScroll: true });
  }
  function readText(blob) {
    if (typeof blob.text === 'function') return blob.text();
    return new Promise((resolve, reject) => {
      const reader = new w.FileReader(); readers.add(reader);
      reader.onload = () => { readers.delete(reader); resolve(String(reader.result || '')); };
      reader.onerror = () => { readers.delete(reader); reject(new Error('read_failed')); };
      reader.onabort = () => { readers.delete(reader); reject(new Error('read_cancelled')); };
      reader.readAsText(blob);
    });
  }
  async function openPreview(entry) {
    if (disposed || !entries.includes(entry)) return;
    clearPreview(); previewId = entry.id; const version = previewVersion, session = epoch;
    preview.hidden = false; previewTitle.textContent = entry.name; previewTitle.focus({ preventScroll: true });
    if (entry.kind === 'image') {
      try {
        previewUrl = w.URL.createObjectURL(entry.blob);
        const image = el('img', 'sx-cofre-preview-image'); image.alt = `Vista previa de ${entry.name}`; image.src = previewUrl;
        image.addEventListener('error', () => { if (!disposed && previewId === entry.id && version === previewVersion) { clearPreview(); report('No podemos mostrar esta imagen. Puedes descargarla y abrirla en tu dispositivo.', true); } }, { once: true });
        previewContent.append(image);
      } catch { clearPreview(); report('No hemos podido abrir la vista previa. El archivo sigue disponible para descargar.', true); }
    } else if (entry.kind === 'note' || entry.kind === 'text') {
      const content = el('pre', 'sx-cofre-preview-text', 'Leyendo el texto…'); previewContent.append(content);
      try {
        const text = entry.kind === 'note' ? entry.text : await readText(entry.blob.slice(0, 200000));
        if (disposed || session !== epoch || version !== previewVersion) return;
        content.textContent = text || 'Este archivo de texto está vacío.';
        if (entry.kind === 'text' && entry.size > 200000) previewContent.append(el('p', 'sx-cofre-hint', 'Mostramos el comienzo del texto. Descarga el archivo para leerlo completo.'));
      } catch { if (!disposed && session === epoch && version === previewVersion) content.textContent = 'No hemos podido leer el texto. Puedes descargarlo y abrirlo en tu dispositivo.'; }
    } else previewContent.append(icon(FileIcon), el('p', '', 'Puedes descargar este archivo para abrirlo con una aplicación de tu dispositivo.'));
    if (!preview.hidden) previewContent.append(button('Descargar archivo', () => downloadEntry(entry), Download, 'sx-cofre-button-soft'));
  }
  function releaseDownload(url) {
    const timer = downloadUrls.get(url); if (timer !== undefined) w.clearTimeout(timer);
    if (downloadUrls.delete(url)) w.URL.revokeObjectURL(url);
  }
  function downloadEntry(entry) {
    if (disposed || !entries.includes(entry)) return;
    let url;
    try {
      // Force download bytes rather than making an active document in this origin.
      const blob = entry.blob.slice(0, entry.size, 'application/octet-stream'); url = w.URL.createObjectURL(blob);
      const link = el('a'); link.href = url; link.download = safeName(entry.kind === 'note' && !/\.txt$/i.test(entry.name) ? `${entry.name}.txt` : entry.name); link.rel = 'noopener'; link.hidden = true;
      downloadUrls.set(url, w.setTimeout(() => releaseDownload(url), 1000));
      d.body.append(link); try { link.click(); } finally { link.remove(); }
      report('Descarga preparada. Elige guardarla en tu dispositivo para conservar una copia.');
    } catch { if (url) releaseDownload(url); report('No hemos podido preparar la descarga. Vuelve a intentarlo.', true); }
  }
  async function deleteEntry(entry) {
    if (disposed || deleting.has(entry.id) || !entries.includes(entry)) return;
    const session = epoch; deleting.add(entry.id); renderList();
    try {
      const description = entry.kind === 'note'
        ? `«${entry.name}» se quitará del Cofre. Si no has descargado la nota, su texto se perderá. Las copias descargadas no se borran.`
        : `«${entry.name}» se quitará del Cofre. El archivo original de tu dispositivo y las copias que hayas descargado no se borran.`;
      const accepted = await confirmAction({ title: '¿Quitar este elemento del Cofre?', description, confirmLabel: 'Quitar del Cofre', danger: true });
      if (!accepted || disposed || session !== epoch || !entries.includes(entry)) return;
      if (previewId === entry.id) clearPreview(); if (editingId === entry.id) closeEditor();
      entries.splice(entries.indexOf(entry), 1); revision++; report(entry.kind === 'note' ? 'Nota quitada del Cofre. Las copias que hayas descargado no se borran.' : 'Archivo quitado del Cofre. El original de tu dispositivo no se ha borrado.');
    } catch { if (!disposed && session === epoch) report('No se ha quitado el elemento. Puedes intentarlo de nuevo.', true); }
    finally { deleting.delete(entry.id); if (!disposed && session === epoch) renderList(); }
  }
  async function clearAll() {
    if (disposed || !entries.length || clearing) return;
    const session = epoch, contentRevision = revision; clearing = true; renderList();
    try {
      const accepted = await confirmAction({ title: '¿Vaciar el Cofre?', description: 'Se quitarán todos los archivos y notas del Cofre. Perderás el texto de las notas que no hayas descargado. No se borrarán originales de tu dispositivo ni copias descargadas. Descarga antes lo que quieras conservar.', confirmLabel: 'Vaciar el Cofre', danger: true });
      if (!accepted || disposed || session !== epoch) return;
      if (revision !== contentRevision) { report('El contenido del Cofre ha cambiado. Revísalo y vuelve a confirmar si quieres vaciarlo.'); return; }
      reset(); report('El Cofre está vacío. Los archivos originales de tu dispositivo no se han borrado.');
    } catch { if (!disposed && session === epoch) report('No se ha vaciado el Cofre. Tu contenido sigue aquí.', true); }
    finally { clearing = false; if (!disposed) renderList(); }
  }
  function reset() {
    if (disposed) return;
    epoch++; revision++; clearPreview(); for (const url of Array.from(downloadUrls.keys())) releaseDownload(url);
    entries = []; deleting.clear(); clearing = false; editingId = null; editor.hidden = true; noteForm.reset(); fileInput.value = ''; search.value = ''; typeFilter.value = 'all'; delete dropZone.dataset.dragging; status.textContent = ''; renderList();
  }
  function destroy() {
    if (disposed) return;
    reset(); disposed = true; listeners.splice(0).forEach(clean => clean()); element.remove();
  }
  renderList();
  return { element, reset, destroy };
}
