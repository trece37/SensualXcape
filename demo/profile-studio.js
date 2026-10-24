import { UserRound, ImagePlus, Images, Eye, ShieldCheck, Info, ChevronUp, ChevronDown, Star, Trash2, SlidersHorizontal, X, Share2 } from 'lucide';

let instance = 0;
const MAX_PHOTOS = 6, MAX_BYTES = 8 * 1024 * 1024;
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** A memory-only studio. The only external disclosure is an explicit onPublish snapshot. */
export function createProfileView({ documentRef = document, windowRef = window, onInfo = () => {}, notify = () => {}, onPublish = () => {}, confirmAction = async () => false } = {}) {
  const d = documentRef, w = windowRef, prefix = `sx-profile-${++instance}`;
  const cleanup = []; let photos = [], activeId = '', coverId = '', sequence = 0, published = null, savedTexts = null, destroyed = false, confirming = false, stateVersion = 0;
  const el = (tag, cls, text) => { const node = d.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const icon = nodes => {
    const svg = d.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key, value);
    for (const [tag, attrs] of nodes) { const child = d.createElementNS(svg.namespaceURI, tag); for (const [key, value] of Object.entries(attrs)) child.setAttribute(key, value); svg.append(child); } return svg;
  };
  const listen = (node, type, action, options) => { node.addEventListener(type, action, options); cleanup.push(() => node.removeEventListener(type, action, options)); };
  const button = (text, art, cls = 'sx-profile-button') => { const node = el('button', cls); node.type = 'button'; if (art) node.append(icon(art)); node.append(el('span', '', text)); return node; };
  const element = el('section', 'sx-profile-page'); element.dataset.v11Page = 'profile';
  const heading = el('header', 'sx-profile-heading'), headingIcon = el('span', 'sx-profile-emblem'); headingIcon.append(icon(UserRound));
  const headingCopy = el('div'); headingCopy.append(el('p', 'sx-profile-kicker', 'TU ESPACIO · TU DECISIÓN'), el('h2', '', 'Tu perfil, a tu manera.'), el('p', 'sx-profile-intro', 'Prepara cómo quieres presentarte. Tú eliges qué se queda contigo y qué compartes en esta demo.'));
  heading.append(headingIcon, headingCopy); element.append(heading);
  const memoryNote = el('p', 'sx-profile-memory'); memoryNote.append(icon(ShieldCheck), el('span', '', 'Este perfil dura mientras esta página siga abierta y se borra al recargar. No hay una cuenta real ni se envía nada.')); element.append(memoryNote);
  const layout = el('div', 'sx-profile-layout'), editor = el('div', 'sx-profile-editor'); element.append(layout); layout.append(editor);
  const panel = (title, eyebrow) => { const node = el('section', 'sx-profile-panel'); node.append(el('p', 'sx-profile-kicker', eyebrow), el('h3', '', title)); editor.append(node); return node; };
  const field = (host, key, labelText, tag = 'input', maxLength = 50) => {
    const wrap = el('div', 'sx-profile-field'), label = el('label', '', labelText), input = el(tag); input.id = `${prefix}-${key}`; input.dataset.field = key; label.htmlFor = input.id; input.maxLength = maxLength;
    if (tag === 'textarea') input.rows = 4; else { input.type = 'text'; input.autocomplete = 'off'; }
    wrap.append(label, input); host.append(wrap); return input;
  };
  const privatePanel = panel('Un espacio solo para ti', '01 · PRIVADO');
  privatePanel.append(el('p', 'sx-profile-description', 'Este alias y estas notas no forman parte de la vista compartida.'));
  const privateAlias = field(privatePanel, 'private-alias', 'Alias de tu espacio privado'); privateAlias.placeholder = 'Como quieras llamar a tu espacio';
  const privateBio = field(privatePanel, 'private-bio', 'Sobre ti · notas privadas', 'textarea', 1000); privateBio.placeholder = 'Un texto de muestra que solo verás aquí';
  const publicPanel = panel('Cómo quieres presentarte', '02 · TU PRESENTACIÓN');
  publicPanel.append(el('p', 'sx-profile-description', 'Escribe un ejemplo para compartir. No se muestra fuera del editor hasta que tú lo decidas.'));
  const publicAlias = field(publicPanel, 'public-alias', 'Alias para la vista compartida'); publicAlias.placeholder = 'El alias que tú elijas';
  const publicBio = field(publicPanel, 'public-bio', 'Presentación para la vista compartida', 'textarea', 600); publicBio.placeholder = 'Cuenta lo que quieras, sin datos personales reales';
  const sharingInfo = button('Sobre la privacidad de tu perfil', Info, 'sx-profile-link'); listen(sharingInfo, 'click', () => onInfo('profile-sharing')); publicPanel.append(sharingInfo);
  const textDraft = el('section', 'sx-profile-text-draft');
  textDraft.append(el('h4', '', 'Tus textos, a mano'), el('p', 'sx-profile-description', 'Guarda una versión del alias privado, las notas, el alias para compartir y la presentación. Recuperarla devuelve esos cuatro textos a como estaban; las fotos no cambian.'));
  const textActions = el('div', 'sx-profile-text-actions'), saveTexts = button('Guardar textos del borrador', null), recoverTexts = button('Recuperar textos guardados', null);
  saveTexts.dataset.action = 'save-texts'; recoverTexts.dataset.action = 'recover-texts'; recoverTexts.disabled = true; textActions.append(saveTexts, recoverTexts);
  const textStatus = el('p', 'sx-profile-status', 'Todavía no has guardado una versión de tus textos.'); textStatus.dataset.role = 'text-draft-status'; textStatus.setAttribute('role', 'status');
  textDraft.append(textActions, el('p', 'sx-profile-draft-duration', 'Hasta que recargues o cierres esta página'), textStatus); publicPanel.append(textDraft);
  listen(saveTexts, 'click', () => {
    if (destroyed) return;
    savedTexts = { privateAlias: privateAlias.value, privateBio: privateBio.value, publicAlias: publicAlias.value, publicBio: publicBio.value };
    recoverTexts.disabled = false; textStatus.textContent = 'Textos del borrador guardados en esta página. No se han compartido ni se han guardado fotos.';
  });
  listen(recoverTexts, 'click', () => {
    if (destroyed || !savedTexts) return;
    privateAlias.value = savedTexts.privateAlias; privateBio.value = savedTexts.privateBio; publicAlias.value = savedTexts.publicAlias; publicBio.value = savedTexts.publicBio;
    updatePreview(); markChanged(); textStatus.textContent = 'Textos recuperados. Las fotos y la última versión que hayas compartido siguen igual.';
  });

  const photoPanel = panel('Tus imágenes, con intención', '03 · FOTOS LOCALES');
  photoPanel.append(el('p', 'sx-profile-description', 'Hasta 6 fotos · JPG, PNG o WebP · máximo 8 MB cada una. Puedes verlas aquí; no se suben ni se cambia el archivo original.'));
  const photoTools = el('div', 'sx-profile-photo-tools'), addPhotos = button('Elegir fotos del dispositivo', ImagePlus, 'sx-profile-button sx-profile-button-primary');
  const fileInput = el('input'); fileInput.type = 'file'; fileInput.multiple = true; fileInput.accept = 'image/jpeg,image/png,image/webp'; fileInput.hidden = true; fileInput.dataset.field = 'photos';
  const imageInfo = button('Sobre tus imágenes', Info, 'sx-profile-link'); listen(imageInfo, 'click', () => onInfo('images')); listen(addPhotos, 'click', () => fileInput.click());
  const photoCount = el('p', 'sx-profile-count', '0 de 6 fotos'); photoCount.setAttribute('aria-live', 'polite'); photoTools.append(addPhotos, fileInput, imageInfo, photoCount); photoPanel.append(photoTools);
  const photoStatus = el('p', 'sx-profile-status'); photoStatus.setAttribute('role', 'status'); photoStatus.dataset.role = 'photo-status'; photoPanel.append(photoStatus);
  const photoList = el('ul', 'sx-profile-photo-list'); photoList.setAttribute('aria-label', 'Fotos de tu borrador y su orden'); photoList.dataset.role = 'photo-list'; photoPanel.append(photoList);
  const emptyPhotos = el('div', 'sx-profile-photo-empty'); emptyPhotos.append(icon(Images), el('p', '', 'Aquí empieza tu selección.'), el('small', '', 'Puedes explorar el perfil sin añadir fotos.')); photoPanel.append(emptyPhotos);
  const frameEditor = el('section', 'sx-profile-frame-editor'); frameEditor.hidden = true;
  const frameHeading = el('h4', '', 'Ajusta cómo se verá'); frameHeading.tabIndex = -1; const frameCopy = el('p', 'sx-profile-description', 'Acerca y mueve la foto hasta que quede como quieras. Solo cambia esta vista; tu foto original sigue igual.');
  const frame = el('div', 'sx-profile-frame'), frameImage = el('img'); frameImage.alt = 'Vista del encuadre elegido'; frame.append(frameImage);
  const sliders = el('div', 'sx-profile-sliders'), sliderInputs = {};
  for (const [key, labelText, min, max, step, initial] of [['zoom', 'Acercar', 1, 2.5, .05, 1], ['x', 'Posición horizontal', 0, 100, 1, 50], ['y', 'Posición vertical', 0, 100, 1, 50]]) {
    const row = el('div', 'sx-profile-range'), label = el('label', '', labelText), output = el('output'), input = el('input'); input.type = 'range'; input.id = `${prefix}-${key}`; input.min = min; input.max = max; input.step = step; input.value = initial; input.dataset.adjustment = key; label.htmlFor = input.id; output.htmlFor = input.id;
    const line = el('div', 'sx-profile-range-label'); line.append(label, output); row.append(line, input); sliders.append(row); sliderInputs[key] = { input, output };
    listen(input, 'input', () => { const photo = photos.find(item => item.id === activeId); if (!photo) return; photo[key] = Number(input.value); updateFrame(); updateThumbnails(); updatePreview(); markChanged(); });
  }
  const resetFrame = button('Restablecer encuadre', SlidersHorizontal, 'sx-profile-link'); listen(resetFrame, 'click', () => { const photo = photos.find(item => item.id === activeId); if (!photo) return; Object.assign(photo, { zoom: 1, x: 50, y: 50 }); updateFrame(); updateThumbnails(); updatePreview(); markChanged(); });
  const frameControls = el('div', 'sx-profile-frame-controls'); frameControls.append(frameHeading, frameCopy, sliders, resetFrame); frameEditor.append(frame, frameControls); photoPanel.append(frameEditor);

  const decisionPanel = panel('Elige qué quieres compartir', '04 · SOLO CUANDO TÚ QUIERAS');
  decisionPanel.append(el('p', 'sx-profile-description', 'Compartir muestra el perfil solo en esta demo, mientras esta página siga abierta. No lo publica en Internet ni envía información a otras personas.'));
  const checkbox = (key, title, description) => { const label = el('label', 'sx-profile-checkbox'), input = el('input'); input.type = 'checkbox'; input.dataset.include = key; const copy = el('span'); copy.append(el('strong', '', title), el('small', '', description)); label.append(input, copy); decisionPanel.append(label); return input; };
  const includeInfo = checkbox('information', 'Incluir mi presentación', 'Solo el alias y el texto de la sección 02. Tus notas privadas quedan fuera.');
  const includePhotos = checkbox('photos', 'Incluir las fotos elegidas', 'Solo las imágenes de este borrador, con su orden y su encuadre.');
  const share = button('Compartir en esta demo', Share2, 'sx-profile-button sx-profile-button-primary'); share.dataset.action = 'share';
  const withdraw = button('Retirar de la demo', X); withdraw.dataset.action = 'withdraw'; withdraw.hidden = true;
  const decisions = el('div', 'sx-profile-actions'); decisions.append(share, withdraw); decisionPanel.append(decisions);
  const status = el('p', 'sx-profile-status', 'Todavía no has compartido este perfil.'); status.setAttribute('role', 'status'); status.dataset.role = 'sharing-status'; decisionPanel.append(status);
  const deletePanel = el('section', 'sx-profile-delete'); deletePanel.append(el('div', '', '¿Prefieres empezar de nuevo?'));
  const deleteButton = button('Borrar el perfil de esta demo', Trash2, 'sx-profile-link sx-profile-danger'); deleteButton.dataset.action = 'delete'; deletePanel.append(deleteButton, el('p', '', 'Borra el borrador y retira su vista compartida. Los archivos originales de tu dispositivo no se borran.')); editor.append(deletePanel);

  const preview = el('aside', 'sx-profile-preview'); preview.setAttribute('aria-label', 'Vista previa antes de compartir');
  const previewHeading = el('div', 'sx-profile-preview-heading'); previewHeading.append(icon(Eye), el('div', '', 'Vista previa'));
  const previewNote = el('p', 'sx-profile-description', 'Así se vería tu selección actual. Mirarla no la comparte.');
  const previewContent = el('div', 'sx-profile-preview-content'); previewContent.dataset.role = 'public-preview'; preview.append(previewHeading, previewNote, previewContent); layout.append(preview);

  const snapshotCopy = profile => profile ? { alias: profile.alias, bio: profile.bio, photos: profile.photos.map(photo => ({ ...photo })), coverIndex: profile.coverIndex } : null;
  const draftSnapshot = () => {
    const selected = includePhotos.checked ? photos : [];
    return { alias: includeInfo.checked ? publicAlias.value.trim().slice(0, 50) : '', bio: includeInfo.checked ? publicBio.value.trim().slice(0, 600) : '', photos: selected.map(({ url, zoom, x, y }) => ({ url, zoom, x, y })), coverIndex: selected.length ? Math.max(0, selected.findIndex(photo => photo.id === coverId)) : -1 };
  };
  function styleImage(image, photo) { image.style.objectPosition = `${photo.x}% ${photo.y}%`; image.style.transform = `scale(${photo.zoom})`; }
  function updatePreview() {
    const profile = draftSnapshot(); previewContent.replaceChildren();
    const imageWrap = el('div', 'sx-profile-preview-cover');
    if (profile.photos.length) { const image = el('img'); image.src = profile.photos[profile.coverIndex].url; image.alt = 'Portada de la vista previa'; image.dataset.photoId = photos[profile.coverIndex]?.id || ''; styleImage(image, profile.photos[profile.coverIndex]); imageWrap.append(image); }
    else { imageWrap.classList.add('sx-profile-preview-placeholder'); imageWrap.append(icon(UserRound), el('span', '', 'Sin fotos incluidas')); }
    const copy = el('div', 'sx-profile-preview-copy'); copy.append(el('p', 'sx-profile-kicker', 'VISTA DE DEMO'), el('h3', '', profile.alias || (includeInfo.checked ? 'Tu alias para compartir' : 'Sin presentación incluida')), el('p', 'sx-profile-preview-bio', profile.bio || (includeInfo.checked ? 'Tu presentación aparecerá aquí.' : 'La información de tu espacio privado no aparece en esta vista.')));
    previewContent.append(imageWrap, copy);
    if (profile.photos.length > 1) { const more = el('div', 'sx-profile-preview-strip'); profile.photos.forEach((photo, index) => { const box = el('div'); const image = el('img'); image.src = photo.url; image.alt = `Foto ${index + 1} de la selección para compartir`; styleImage(image, photo); box.append(image); more.append(box); }); previewContent.append(more); }
    previewContent.append(el('p', 'sx-profile-preview-scope', 'Si lo compartes, se verá solo en esta demo mientras la página siga abierta.'));
  }
  function markChanged() { if (published) status.textContent = 'Hay cambios sin compartir. La demo conserva tu última versión compartida hasta que decidas actualizarla.'; }
  function withdrawPublication(message = 'Has retirado el perfil de esta demo.') { published = null; withdraw.hidden = true; onPublish(null); status.textContent = message; }
  function updateFrame() {
    const photo = photos.find(item => item.id === activeId); frameEditor.hidden = !photo; if (!photo) { frameImage.removeAttribute('src'); return; }
    if (frameImage.getAttribute('src') !== photo.url) frameImage.src = photo.url;
    frameImage.dataset.photoId = photo.id; styleImage(frameImage, photo);
    for (const key of ['zoom', 'x', 'y']) { sliderInputs[key].input.value = photo[key]; sliderInputs[key].output.value = key === 'zoom' ? `${photo.zoom.toFixed(2)}×` : `${photo[key]} %`; }
  }
  function updateThumbnails() { for (const image of photoList.querySelectorAll('img[data-photo-id]')) { const photo = photos.find(item => item.id === image.dataset.photoId); if (photo) styleImage(image, photo); } }
  function renderPhotos({ focusId = '', action = '' } = {}) {
    photoList.replaceChildren(); emptyPhotos.hidden = Boolean(photos.length); photoCount.textContent = `${photos.length} de ${MAX_PHOTOS} fotos`; addPhotos.disabled = photos.length >= MAX_PHOTOS;
    for (const [index, photo] of photos.entries()) {
      const item = el('li', 'sx-profile-photo'); item.dataset.photoId = photo.id;
      const select = button('', null, 'sx-profile-photo-select'); select.dataset.action = 'adjust'; select.setAttribute('aria-label', `Ajustar foto ${index + 1}`); select.setAttribute('aria-pressed', String(photo.id === activeId));
      const thumb = el('span', 'sx-profile-thumbnail'), image = el('img'); image.src = photo.url; image.alt = ''; image.dataset.photoId = photo.id; styleImage(image, photo); thumb.append(image);
      const title = el('span', 'sx-profile-photo-title', `Foto ${index + 1}`); select.append(thumb, title); item.append(select);
      if (photo.id === coverId) { const cover = el('span', 'sx-profile-cover-badge'); cover.append(icon(Star), el('span', '', 'Portada')); item.append(cover); }
      const actions = el('div', 'sx-profile-photo-actions');
      for (const [key, label, art, disabled] of [['cover', 'Usar como portada', Star, photo.id === coverId], ['earlier', 'Mover antes', ChevronUp, index === 0], ['later', 'Mover después', ChevronDown, index === photos.length - 1], ['remove', 'Quitar foto', Trash2, false]]) {
        const control = button(label, art, 'sx-profile-photo-action'); control.dataset.action = key; control.disabled = disabled; control.setAttribute('aria-label', `${label} ${index + 1}`); actions.append(control);
      }
      item.append(actions); photoList.append(item);
    }
    updateFrame(); updatePreview();
    if (focusId) photoList.querySelector(`[data-photo-id="${focusId}"] button[data-action="${action}"]`)?.focus({ preventScroll: true });
  }
  function removePhoto(photo, fromError = false) {
    if (published?.photos.some(item => item.url === photo.url)) withdrawPublication('La publicación se ha retirado antes de quitar una de sus fotos.');
    const index = photos.indexOf(photo); if (index < 0) return;
    photos.splice(index, 1); if (coverId === photo.id) coverId = photos[0]?.id || ''; if (activeId === photo.id) activeId = photos[Math.min(index, photos.length - 1)]?.id || '';
    w.URL.revokeObjectURL(photo.url); renderPhotos(); markChanged();
    if (!fromError) { photoStatus.textContent = 'Foto quitada del borrador. El archivo de tu dispositivo sigue intacto.'; if (activeId) photoList.querySelector(`[data-photo-id="${activeId}"] button`)?.focus({ preventScroll: true }); else addPhotos.focus(); }
  }
  listen(fileInput, 'change', () => {
    if (destroyed) return; const errors = []; let added = 0;
    for (const file of Array.from(fileInput.files || [])) {
      if (!TYPES.has(file.type)) { errors.push('Usa fotos JPG, PNG o WebP.'); continue; }
      if (!file.size || file.size > MAX_BYTES) { errors.push('Cada foto debe tener contenido y ocupar como máximo 8 MB.'); continue; }
      if (photos.length >= MAX_PHOTOS) { errors.push('Puedes preparar un máximo de 6 fotos.'); continue; }
      try { const photo = { id: `photo-${++sequence}`, url: w.URL.createObjectURL(file), zoom: 1, x: 50, y: 50 }; photos.push(photo); activeId = photo.id; if (!coverId) coverId = photo.id; added++; }
      catch { errors.push('Este navegador no ha podido mostrar esa foto aquí.'); }
    }
    fileInput.value = ''; renderPhotos(); if (added) markChanged();
    photoStatus.textContent = [added ? `${added} ${added === 1 ? 'foto preparada' : 'fotos preparadas'} solo en este navegador.` : '', ...new Set(errors)].filter(Boolean).join(' ');
    if (errors.length) notify(photoStatus.textContent);
  });
  listen(photoList, 'click', event => {
    const control = event.target.closest('button[data-action]'), item = control?.closest('li[data-photo-id]'); if (!item || control.disabled) return;
    const photo = photos.find(entry => entry.id === item.dataset.photoId); if (!photo) return;
    const action = control.dataset.action, index = photos.indexOf(photo);
    if (action === 'remove') { removePhoto(photo); return; }
    if (action === 'adjust') { activeId = photo.id; renderPhotos({ focusId: photo.id, action }); return; }
    if (action === 'cover') coverId = photo.id;
    if (action === 'earlier' && index > 0) [photos[index - 1], photos[index]] = [photos[index], photos[index - 1]];
    if (action === 'later' && index < photos.length - 1) [photos[index + 1], photos[index]] = [photos[index], photos[index + 1]];
    renderPhotos({ focusId: photo.id, action: 'adjust' }); markChanged();
  });
  listen(element, 'error', event => {
    const photo = photos.find(item => item.id === event.target.dataset?.photoId); if (destroyed || !photo || event.target.getAttribute('src') !== photo.url) return;
    removePhoto(photo, true); photoStatus.textContent = 'No podemos mostrar esa foto. Se ha quitado de la selección sin subir ningún archivo.'; notify(photoStatus.textContent);
  }, true);
  for (const input of [publicAlias, publicBio]) listen(input, 'input', () => { updatePreview(); markChanged(); });
  for (const input of [includeInfo, includePhotos]) listen(input, 'change', () => { if (!input.checked && published) withdrawPublication('Has cambiado qué quieres incluir. La publicación anterior se ha retirado; comparte de nuevo solo si lo deseas.'); updatePreview(); markChanged(); });
  listen(share, 'click', () => {
    if (destroyed) return;
    if (!includeInfo.checked && !includePhotos.checked) { status.textContent = 'Elige si quieres incluir tu presentación, tus fotos o ambas.'; includeInfo.focus(); return; }
    if (includeInfo.checked && !publicAlias.value.trim()) { status.textContent = 'Escribe un alias para la vista compartida. Tu alias privado no se usará.'; publicAlias.focus(); return; }
    if (includePhotos.checked && !photos.length) { status.textContent = 'Elige al menos una foto o desmarca la inclusión de fotos.'; addPhotos.focus(); return; }
    published = snapshotCopy(draftSnapshot()); onPublish(snapshotCopy(published)); withdraw.hidden = false;
    status.textContent = 'Perfil compartido en esta demo mientras la página siga abierta. No se ha publicado en Internet ni enviado a otras personas.'; notify('Tu perfil está compartido en esta demo.');
  });
  listen(withdraw, 'click', () => { withdrawPublication(); share.focus({ preventScroll: true }); });
  function clearState({ render = true } = {}) {
    stateVersion++;
    published = null; onPublish(null);
    const previous = photos; photos = []; savedTexts = null; activeId = coverId = ''; privateAlias.value = privateBio.value = publicAlias.value = publicBio.value = ''; includeInfo.checked = includePhotos.checked = false; fileInput.value = '';
    recoverTexts.disabled = true; textStatus.textContent = 'Todavía no has guardado una versión de tus textos.';
    frameImage.removeAttribute('src'); previewContent.replaceChildren(); photoList.replaceChildren();
    for (const photo of previous) w.URL.revokeObjectURL(photo.url);
    if (render) { withdraw.hidden = true; photoStatus.textContent = ''; status.textContent = 'Perfil vacío. No hay ninguna vista compartida en esta demo.'; renderPhotos(); }
  }
  function reset() { if (!destroyed) clearState(); }
  listen(deleteButton, 'click', async () => {
    if (destroyed || confirming) return; confirming = true; deleteButton.disabled = true; deleteButton.setAttribute('aria-busy', 'true');
    const version = stateVersion;
    try { const accepted = await confirmAction({ title: 'Borrar el perfil de esta demo', description: 'Se retirará el perfil compartido y se borrarán los textos, las notas privadas y las vistas previas de las fotos de esta demo. Los archivos originales de tu dispositivo no se borrarán.', confirmLabel: 'Borrar perfil de la demo', danger: true }); if (accepted && !destroyed && version === stateVersion) { reset(); notify('El perfil de esta demo se ha borrado. Tus archivos originales siguen en tu dispositivo.'); } }
    catch { if (!destroyed) notify('No se ha podido confirmar el borrado. El perfil sigue como estaba.'); }
    finally { confirming = false; if (!destroyed) { deleteButton.disabled = false; deleteButton.removeAttribute('aria-busy'); } }
  });
  renderPhotos();
  return { element, reset, getPublicProfile: () => snapshotCopy(published), destroy() { if (destroyed) return; destroyed = true; cleanup.splice(0).forEach(remove => remove()); clearState({ render: false }); element.remove(); } };
}
