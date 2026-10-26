import { createProfileView } from './profile-studio.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKET = 'sx-profile-photos', MAX_BYTES = 8 * 1024 * 1024;
const changed = () => Object.assign(new Error('La sesión ha cambiado.'), { code: 'SX_PROFILE_SESSION_CHANGED' });
const revisionConflict = () => Object.assign(new Error('sx_profile_revision_conflict'),{code:'40001'});
const authLost = error => Number(error?.status || error?.statusCode) === 401 || ['PGRST301','PGRST302','PGRST303'].includes(error?.code) || /jwt.*expired|expired.*jwt/i.test(error?.message || '');

/** Raster-only, orientation-aware re-encoding. Canvas strips EXIF and other source metadata. */
export async function prepareProfilePhoto(file, { windowRef = window } = {}) {
  const w = windowRef;
  if (!file || !['image/jpeg','image/png','image/webp'].includes(file.type) || !file.size || file.size > MAX_BYTES) throw new Error('Usa fotos JPG, PNG o WebP de hasta 8 MB.');
  let image, url, canvas;
  try {
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const starts = values => values.every((value, i) => bytes[i] === value);
    const valid = file.type === 'image/jpeg' ? starts([255,216,255]) : file.type === 'image/png' ? starts([137,80,78,71,13,10,26,10]) : starts([82,73,70,70]) && [87,69,66,80].every((value,i) => bytes[i+8] === value);
    if (!valid) throw new Error('No se ha podido leer esta foto.');
    if (typeof w.createImageBitmap === 'function') image = await w.createImageBitmap(file, { imageOrientation: 'from-image' });
    else {
      image = new w.Image(); url = w.URL.createObjectURL(file);
      await new Promise((resolve,reject) => { image.onload = resolve; image.onerror = () => reject(new Error('No se ha podido leer esta foto.')); image.src = url; });
    }
    const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
    if (!width || !height) throw new Error('No se ha podido leer esta foto.');
    canvas = w.document.createElement('canvas');
    const context = canvas.getContext('2d'); if (!context) throw new Error('Este navegador no puede preparar la foto.');
    for (const size of [2048,1600,1200,900,640]) {
      const scale = Math.min(1,size / Math.max(width,height)); canvas.width = Math.max(1,Math.round(width*scale)); canvas.height = Math.max(1,Math.round(height*scale));
      context.drawImage(image,0,0,canvas.width,canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve,'image/webp',.82));
      if (!blob || blob.type !== 'image/webp') throw new Error('Este navegador no puede preparar la foto en WebP.');
      if (blob.size <= 950000) return new w.File([blob],'foto.webp',{type:'image/webp'});
    }
    throw new Error('No se ha podido reducir la foto al límite de 950 KB.');
  } finally {
    image?.close?.(); if (image && 'onload' in image) { image.onload = image.onerror = null; image.removeAttribute?.('src'); }
    if (url) w.URL.revokeObjectURL(url); if (canvas) canvas.width = canvas.height = 0;
  }
}

/** Owns authenticated blobs only. setSession must run on every account change. */
export function createProfileAdapter({ client, getSession, windowRef = window, preparePhoto = prepareProfilePhoto, onReset = () => {}, onAuthLost = () => {}, notify = () => {} }) {
  const w = windowRef; let actor = null, epoch = 0, state = null, draftRevision = null, destroyed = false, uploaded = new WeakMap();
  const urls = new Map(), downloads = new Map(); let sharedVersion = 0;
  const revoke = key => { const value = urls.get(key); if (value) { w.URL.revokeObjectURL(value.url); urls.delete(key); } };
  const clearShared = () => { sharedVersion++; for (const key of [...urls.keys()]) if (key.startsWith('contact:')) revoke(key); for (const key of [...downloads.keys()]) if (key.startsWith('contact:')) downloads.delete(key); };
  function clear() { epoch++; sharedVersion++; state = null; draftRevision = null; uploaded = new WeakMap(); downloads.clear(); for (const key of [...urls.keys()]) revoke(key); onReset(); }
  function setSession(session) { const id = session?.user?.id || null; if (id !== actor) { clear(); actor = id; } }
  function capture() {
    if (getSession) setSession(getSession());
    if (destroyed || !actor || !UUID.test(actor)) throw changed();
    const version = epoch, user = actor;
    return () => {
      const current = getSession ? getSession()?.user?.id || null : actor;
      if (current !== actor) setSession(current ? { user: { id: current } } : null);
      if (destroyed || version !== epoch || user !== actor) throw changed();
      return user;
    };
  }
  function fail(error) { if (authLost(error)) { clear(); actor = null; try { onAuthLost(); } catch {} throw changed(); } throw error; }
  async function rpc(name, args, check) { check(); const result = await client.rpc(name,args); check(); if (result.error) fail(result.error); return result.data; }
  function acceptMutation(next, delta = 1) { draftRevision = draftRevision !== null && next.revision === draftRevision + delta ? next.revision : null; state = next; }
  function fileRecord(file, owner) {
    if (!file || !UUID.test(file.id) || file.owner_id !== owner || file.bucket_id !== BUCKET || file.object_path !== `${owner}/${file.id}.webp`
      || file.mime_type !== 'image/webp' || !Number.isFinite(Number(file.byte_size)) || Number(file.byte_size) < 1 || Number(file.byte_size) > 950000) throw new Error('Archivo de perfil no válido.');
    return file;
  }
  async function photoUrl(file, owner, scope, check) {
    fileRecord(file,owner); const key = `${scope}:${owner}:${file.id}`;
    if (urls.has(key)) return urls.get(key).url;
    if (downloads.has(key)) return downloads.get(key);
    const pending = (async () => {
      const result = await client.storage.from(BUCKET).download(file.object_path); check(); if (result.error) fail(result.error);
      if (!result.data || result.data.size !== Number(file.byte_size)) throw new Error('No se ha podido descargar la foto completa.');
      const url = w.URL.createObjectURL(result.data); urls.set(key,{url,id:file.id,owner}); return url;
    })();
    downloads.set(key,pending);
    try { return await pending; } finally { if (downloads.get(key) === pending) downloads.delete(key); }
  }
  async function hydrate(raw, owner, scope, check) {
    const files = new Map((raw.files || []).map(file => [file.id,file]));
    const paint = async photo => {
      if (!photo || !UUID.test(photo.id) || !Number.isFinite(photo.zoom) || photo.zoom < 1 || photo.zoom > 2.5
        || !Number.isFinite(photo.x) || photo.x < 0 || photo.x > 100 || !Number.isFinite(photo.y) || photo.y < 0 || photo.y > 100) throw new Error('Encuadre de perfil no válido.');
      const file = files.get(photo.id); if (!file || file.status !== 'ready') throw new Error('Foto no disponible.');
      return { id:photo.id, url:await photoUrl(file,owner,scope,check), zoom:photo.zoom, x:photo.x, y:photo.y, managed:true };
    };
    const result = { revision:raw.revision, publication:null };
    if (raw.draft) result.draft = { ...raw.draft, photos:await Promise.all(raw.draft.photos.map(paint)) };
    if (raw.publication) result.publication = { alias:String(raw.publication.alias || ''),bio:String(raw.publication.bio || ''),coverIndex:raw.publication.coverIndex,photos:await Promise.all(raw.publication.photos.map(paint)) };
    check();
    const used = new Set([...(raw.draft?.photos || []),...(raw.publication?.photos || [])].map(photo => photo.id));
    for (const [key,value] of urls) if (key.startsWith(`${scope}:${owner}:`) && !used.has(value.id)) revoke(key);
    return result;
  }
  async function load() { const check = capture(), owner = check(); const result = await rpc('sx_profile_state',{},check); if (state && result.revision < state.revision) throw changed(); state = result; draftRevision = result.revision; return hydrate(result,owner,'own',check); }
  async function removeBytes(file, check) {
    check(); const result = await client.storage.from(BUCKET).remove([file.object_path]); check();
    if (result.error) { if (authLost(result.error)) fail(result.error); notify('El acceso a la foto ya está retirado. La limpieza del archivo queda pendiente de reintento.'); return false; } return true;
  }
  async function upload(file, check) {
    if (uploaded.has(file)) return uploaded.get(file);
    const owner = check(), prepared = await preparePhoto(file,{windowRef:w}); check();
    if (prepared.type !== 'image/webp' || prepared.size < 1 || prepared.size > 950000) throw new Error('La foto preparada supera el límite.');
    const reserved = fileRecord(await rpc('sx_profile_reserve_photo',{p_bytes:prepared.size},check),owner);
    try {
      const bytes = await prepared.arrayBuffer(); check();
      const result = await client.storage.from(BUCKET).upload(reserved.object_path,bytes,{contentType:'image/webp',upsert:false,cacheControl:'0'}); check(); if (result.error) fail(result.error);
      const ready = fileRecord(await rpc('sx_profile_finish_photo',{p_id:reserved.id},check),owner); uploaded.set(file,ready); return ready;
    } catch (error) {
      try { check(); const removed = await rpc('sx_profile_remove_photo',{p_id:reserved.id},check); acceptMutation(removed.state); await removeBytes(reserved,check); } catch {}
      throw error;
    }
  }
  function wireDraft(draft, photos, coverId) {
    const result = {};
    for (const [key,limit] of [['privateAlias',50],['privateBio',1000],['publicAlias',50],['publicBio',600]]) {
      if (typeof draft[key] !== 'string' || [...draft[key]].length > limit) throw new Error('Uno de los textos supera el límite del perfil.'); result[key] = draft[key];
    }
    result.photos = photos; result.coverId = coverId;
    return result;
  }
  async function saveDraft(draft) {
    const check = capture(), owner = check();
    if (!state || draftRevision === null) throw revisionConflict(); check();
    if (!Array.isArray(draft.photos) || draft.photos.length > 6) throw new Error('Puedes guardar hasta seis fotos.');
    const mapped = new Map(), photos = [], newFiles = [];
    try {
      for (const photo of draft.photos) {
        const existed = photo.file && uploaded.has(photo.file);
        const file = photo.file ? await upload(photo.file,check) : (state.files || []).find(file => file.id === photo.id && file.status === 'ready');
        if (!file) throw new Error('Recupera la galería guardada antes de guardar estos cambios.'); fileRecord(file,owner);
        if (photo.file && !existed) newFiles.push({file,source:photo.file});
        mapped.set(photo.id,file.id); photos.push({id:file.id,zoom:photo.zoom,x:photo.x,y:photo.y});
      }
      const coverId = photos.length ? mapped.get(draft.coverId) || photos[0].id : null;
      const payload = wireDraft(draft,photos,coverId);
      const result = await rpc('sx_profile_save',{p_expected_revision:draftRevision,p_draft:payload},check); state = result; draftRevision = result.revision;
      return hydrate(result,owner,'own',check);
    } catch (error) {
      // A lost save response may still mean the draft committed. Discard only through an
      // atomic server check that refuses to remove a photo already used by either version.
      for (const {file,source} of newFiles) try {
        check(); const discarded = await rpc('sx_profile_discard_photo',{p_id:file.id},check); acceptMutation(discarded.state,0);
        if (discarded.discarded) { uploaded.delete(source); await removeBytes(file,check); }
      } catch {}
      throw error;
    }
  }
  async function publish(draft, include) {
    const check = capture(), owner = check(); await saveDraft(draft); check();
    const result = await rpc('sx_profile_publish',{p_expected_revision:draftRevision,p_include_information:include.information === true,p_include_photos:include.photos === true},check); state = result; draftRevision = result.revision;
    return hydrate(result,owner,'own',check);
  }
  async function withdraw() { const check = capture(), owner = check(); const result = await rpc('sx_profile_withdraw',{},check); acceptMutation(result); clearShared(); return hydrate(result,owner,'own',check); }
  async function removePhoto(id) {
    const check = capture(), owner = check(); const result = await rpc('sx_profile_remove_photo',{p_id:id},check); acceptMutation(result.state);
    fileRecord(result.file,owner); for (const [key,value] of urls) if (value.id === id) revoke(key);
    await removeBytes(result.file,check); return hydrate(state,owner,'own',check);
  }
  async function deleteProfile() {
    const check = capture(), owner = check(); const result = await rpc('sx_profile_delete',{},check); state = result.state; draftRevision = state.revision;
    for (const key of [...urls.keys()]) revoke(key); uploaded = new WeakMap();
    for (const file of result.files) { fileRecord(file,owner); await removeBytes(file,check); }
    return hydrate(state,owner,'own',check);
  }
  async function readShared(owner) {
    if (!UUID.test(owner)) throw new Error('Contacto no válido.');
    const accountCheck = capture(), version = sharedVersion;
    const check = () => { const actor = accountCheck(); if (version !== sharedVersion) throw changed(); return actor; };
    const result = await rpc('sx_profile_shared',{p_owner_id:owner},check);
    if (!result) { clearShared(); return null; }
    return hydrate(result,owner,'contact',check);
  }
  return { load,saveDraft,publish,withdraw,removePhoto,deleteProfile,readShared,clearShared,setSession,clear,
    destroy() { if (destroyed) return; clear(); destroyed = true; },
  };
}

/** Same artistic studio, with persistence explicitly opted in. The local demo stays unchanged. */
export function createLiveProfileView({ client,getSession,documentRef = document,windowRef = window,confirmAction,notify = () => {},onPublish = () => {},onInfo = () => {},onAuthLost = () => {},preparePhoto } = {}) {
  const d = documentRef, w = windowRef; let view, disposed = false, contactDialog = null, contactOwner = null, contactEpoch = 0, loadingContact = false;
  const lock = value => { if (view) { for (const node of view.element.querySelectorAll('input,textarea,button')) node.disabled = value; view.element.setAttribute('aria-busy',String(value)); } };
  const adapter = createProfileAdapter({client,getSession,windowRef:w,preparePhoto,notify,onAuthLost,onReset:() => { view?.reset(); lock(true); closeContact(); }});
  view = createProfileView({documentRef:d,windowRef:w,confirmAction,notify,onPublish,onInfo,persistence:adapter});
  lock(true);
  function closeContact() { contactEpoch++; contactOwner = null; contactDialog?.close(); contactDialog?.remove(); contactDialog = null; adapter.clearShared(); }
  function renderContact(data) {
    if (!contactDialog) { contactDialog = d.createElement('dialog'); contactDialog.className = 'sx-dialog'; contactDialog.setAttribute('aria-label','Presentación compartida por tu contacto'); contactDialog.addEventListener('cancel',event => { event.preventDefault(); closeContact(); }); d.body.append(contactDialog); }
    const profile = data.publication, heading = d.createElement('h2'), bio = d.createElement('p'), scope = d.createElement('p'); heading.textContent = profile.alias || 'Presentación de tu contacto'; bio.textContent = profile.bio; scope.textContent = 'Versión compartida sólo con contactos aceptados y sin bloqueos.';
    const gallery = d.createElement('div'); gallery.className = 'sx-public-gallery';
    for (const photo of profile.photos) { const frame = d.createElement('div'); frame.className = 'sx-public-photo'; const image = d.createElement('img'); image.src = photo.url; image.alt = 'Foto incluida por tu contacto en esta versión'; image.style.objectPosition = `${photo.x}% ${photo.y}%`; image.style.transform = `scale(${photo.zoom})`; frame.append(image); gallery.append(frame); }
    const close = d.createElement('button'); close.type = 'button'; close.className = 'sx-button sx-primary'; close.textContent = 'Cerrar presentación'; close.addEventListener('click',closeContact);
    contactDialog.replaceChildren(heading,bio,scope,gallery,close); if (!contactDialog.open) contactDialog.showModal();
  }
  async function openContact(owner) {
    closeContact(); contactOwner = owner; const version = contactEpoch;
    try { const data = await adapter.readShared(owner); if (disposed || version !== contactEpoch) return; if (!data) { closeContact(); notify('Este contacto no tiene una presentación compartida disponible.'); return; } renderContact(data); }
    catch (error) { if (version === contactEpoch) { closeContact(); if (error?.code !== 'SX_PROFILE_SESSION_CHANGED') notify('No se ha podido abrir la presentación de este contacto.'); } }
  }
  async function refreshContact() {
    if (disposed || !contactOwner || d.hidden || loadingContact) return;
    const owner = contactOwner, version = contactEpoch; loadingContact = true;
    try { const data = await adapter.readShared(owner); if (version !== contactEpoch) return; if (!data) closeContact(); else renderContact(data); }
    catch { if (version === contactEpoch) closeContact(); } finally { loadingContact = false; }
  }
  w.addEventListener('focus',refreshContact); d.addEventListener('visibilitychange',refreshContact); const timer = w.setInterval(refreshContact,20000);
  function setSession(session) { adapter.setSession(session); }
  async function refresh() { lock(true); const result = await adapter.load(); if (!disposed) { lock(false); view.restoreDraft(result,{resetChoices:true}); } return result; }
  return { element:view.element,setSession,refresh,openContact,closeContact,refreshContact,getPublicProfile:view.getPublicProfile,
    reset() { closeContact(); adapter.clear(); },
    destroy() { if (disposed) return; disposed = true; w.clearInterval(timer); w.removeEventListener('focus',refreshContact); d.removeEventListener('visibilitychange',refreshContact); closeContact(); adapter.destroy(); view.destroy(); },
  };
}
