import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.10';

const $ = (id) => document.getElementById(id);
const notice = $('notice');
let user = null;
let activeRoom = null;
let realtimeChannel = null;
let pollTimer = null;
let latestView = '';
let viewVersion = 0;
let authVersion = 0;
let authEventVersion = 0;
let pendingRead = null;
let pendingAttempt = null;
let sending = null;
let recoveryMode = false;
let recoveryShown = false;
let channelState = '';
let readFailed = false;
let lastSync = '';
let contacts = [];
let contactsEpoch = 0;
let contactsRead = null;
let contactsTimer = null;
let contactBusy = false;
let easyMode = false;
let latestContactsView = '';
let contactsRevision = 0;
let navigationVersion = 0;
let cofreSessionVersion = 0;

function publishCofreSnapshot(session) {
  if (config?.COFRE_LOCAL_ENABLED !== true) return;
  window.__sxCofreSession = session;
  if (typeof window.dispatchEvent === 'function' && typeof window.CustomEvent === 'function') {
    window.dispatchEvent(new window.CustomEvent('sx:session', { detail: session }));
  }
}
async function syncCofreSession(nextUser) {
  if (config?.COFRE_LOCAL_ENABLED !== true) return;
  const version = ++cofreSessionVersion;
  if (!nextUser || recoveryMode) { publishCofreSnapshot(null); return; }
  if (window.__sxCofreSession?.user?.id !== nextUser.id) publishCofreSnapshot(null);
  try {
    // Forward credentials only; the local server authorizes every file operation.
    const { data, error } = await sb.auth.getSession();
    if (version !== cofreSessionVersion || user?.id !== nextUser.id || recoveryMode) return;
    const session = data?.session;
    publishCofreSnapshot(!error && session?.user?.id === nextUser.id && session.access_token
      ? { user: nextUser, access_token: session.access_token, apikey: config.SUPABASE_PUBLISHABLE_KEY } : null);
  } catch { if (version === cofreSessionVersion) publishCofreSnapshot(null); }
}

function readSetting(key) { try { return localStorage.getItem(key); } catch { return null; } }
function writeSetting(key, value) { try { localStorage.setItem(key, value); } catch { /* Optional setting. */ } }
function contactCurrent(epoch, actor) { return contactsEpoch === epoch && user?.id === actor && !recoveryMode; }
function activeContact() { return activeRoom ? contacts.find(contact => contact.room_id === activeRoom) : undefined; }
function syncActiveContact() {
  const contact = activeContact();
  $('active-contact-title').textContent = contact ? `Conversación con ${contact.counterpart_label}` : 'Tu conversación';
  $('active-block').hidden = !contact;
  $('active-block').textContent = contact?.blocked_by_me ? 'Desbloquear' : 'Bloquear';
  $('active-block').disabled = contactBusy;
  $('active-contact-status').textContent = contact?.blocked_by_me ? 'Has bloqueado este contacto. El historial sigue disponible; no se pueden enviar mensajes nuevos.'
    : contact?.blocked ? 'Este contacto no está disponible para mensajes nuevos. Puedes consultar el historial.' : '';
  $('body').disabled = Boolean(contact?.blocked);
  $('send-form').querySelector('button').disabled = Boolean(contact?.blocked || sending);
  $('copy-code').hidden = Boolean(contact);
  $('room-code').hidden = Boolean(contact);
}
function setEasyMode(enabled) {
  easyMode = enabled;
  $('app-layout').className = `layout${enabled ? ' easy-mode' : ''}`;
  $('easy-mode').setAttribute('aria-pressed', String(enabled));
  $('easy-mode').textContent = `Modo fácil: ${enabled ? 'activado' : 'desactivado'}`;
  $('easy-help').hidden = !enabled;
  $('legacy-room-options').hidden = enabled;
  if (enabled) document.querySelector?.('.invitation-tools')?.setAttribute('open', '');
  writeSetting('sx_easy_mode', String(enabled));
}
function resetContacts() {
  contactsEpoch += 1; contactsRead = null; contacts = []; contactBusy = false; latestContactsView = ''; contactsRevision = 0;
  if (contactsTimer !== null) clearInterval(contactsTimer);
  contactsTimer = null;
  $('contacts-list').replaceChildren();
  $('contacts-status').textContent = 'Cargando tu espacio…';
  $('contact-label').value = ''; $('contact-code').value = ''; $('invite-code').value = '';
  $('invite-result').hidden = true;
  for (const id of ['create-invite', 'request-contact']) setPending($(id), false);
  syncActiveContact();
}
function contactButton(label, action, primary = false) {
  const button = document.createElement('button'); button.type = 'button';
  button.className = primary ? 'primary small' : 'secondary small';
  button.textContent = label; button.disabled = contactBusy;
  button.addEventListener('click', action); return button;
}
function renderContacts() {
  const list = $('contacts-list'); list.replaceChildren();
  for (const contact of contacts) {
    const item = document.createElement('li'); item.className = 'contact-card';
    const title = document.createElement('h4'); title.textContent = contact.counterpart_label;
    const status = document.createElement('p'); status.className = 'contact-state';
    status.textContent = contact.blocked_by_me ? 'Bloqueado por ti' : contact.blocked ? 'Contacto no disponible'
      : contact.status === 'accepted' ? 'Conversación aceptada' : contact.status === 'rejected' ? 'Solicitud rechazada'
      : contact.direction === 'incoming' ? 'Quiere conversar contigo' : 'Esperando su decisión';
    const actions = document.createElement('div'); actions.className = 'contact-actions';
    if (contact.status === 'pending' && contact.direction === 'incoming' && !contact.blocked) {
      actions.append(contactButton('Aceptar', () => decideContact(contact, true), true), contactButton('Rechazar', () => decideContact(contact, false)));
    }
    if (contact.status === 'accepted' && contact.room_id) {
      actions.append(contactButton(contact.blocked ? 'Ver historial' : 'Abrir conversación', () => { navigationVersion += 1; clearNotice(); return activateRoom(contact.room_id); }, !contact.blocked));
    }
    actions.append(contactButton(contact.blocked_by_me ? 'Desbloquear' : 'Bloquear', () => changeContactBlock(contact)));
    item.append(title, status, actions); list.append(item);
  }
  syncActiveContact();
}
function refreshContacts(fresh = false) {
  if (!user || recoveryMode) return Promise.resolve();
  if (contactsRead) {
    const existing = contactsRead;
    return fresh ? existing.promise.then(() => contactCurrent(existing.epoch, existing.actor) ? refreshContacts() : undefined) : existing.promise;
  }
  const epoch = contactsEpoch; const actor = user.id;
  const read = { epoch, actor, revision: contactsRevision, promise: null }; contactsRead = read;
  read.promise = (async () => {
    try {
      const { data, error } = await sb.rpc('sx_list_contacts');
      if (!contactCurrent(epoch, actor)) return;
      if (read.revision !== contactsRevision) return;
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error('Invalid contacts response');
      contacts = data;
      const fingerprint = JSON.stringify(data);
      if (fingerprint !== latestContactsView) { latestContactsView = fingerprint; renderContacts(); }
      else syncActiveContact();
      const summary = contacts.length ? `${contacts.length} ${contacts.length === 1 ? 'contacto' : 'contactos'} · Tú eliges con quién conversar.`
        : 'Todavía no tienes solicitudes. Puedes compartir tu invitación o utilizar una que te hayan dado.';
      if ($('contacts-status').textContent !== summary) $('contacts-status').textContent = summary;
    } catch {
      if (contactCurrent(epoch, actor)) $('contacts-status').textContent = 'No se han podido actualizar tus contactos. Pulsa «Actualizar contactos» para reintentar.';
    } finally { if (contactsRead === read) contactsRead = null; }
  })();
  return read.promise;
}
async function contactAction(job) {
  if (!user || recoveryMode || contactBusy) return;
  const epoch = contactsEpoch; const actor = user.id;
  clearNotice(); contactBusy = true; contactsRevision += 1; renderContacts();
  for (const id of ['create-invite', 'request-contact']) setPending($(id), true);
  try {
    const result = await job(() => contactCurrent(epoch, actor));
    if (!contactCurrent(epoch, actor)) return;
    await refreshContacts(true);
    if (contactCurrent(epoch, actor) && result) showNotice(result, 'success');
  } catch (error) { if (contactCurrent(epoch, actor)) { safeError(error); await refreshContacts(true); } }
  finally {
    if (contactCurrent(epoch, actor)) {
      contactBusy = false; renderContacts();
      for (const id of ['create-invite', 'request-contact']) setPending($(id), false);
    }
  }
}
function contactLabel() {
  const label = $('contact-label').value.trim();
  if (!label || label.length > 50) throw new Error('Introduce un nombre o seudónimo de hasta 50 caracteres.');
  return label;
}
function decideContact(contact, accept) {
  const navigation = navigationVersion;
  return contactAction(async current => {
    const { data, error } = await sb.rpc('sx_decide_contact', { p_contact_id: contact.id, p_accept: accept });
    if (error) throw error;
    if (!current()) return;
    contactsRevision += 1;
    if (accept && data) {
      if (navigationVersion !== navigation) return 'Solicitud aceptada. Puedes abrirla desde tus contactos cuando quieras.';
      const opened = await activateRoom(data);
      if (!current()) return;
      if (!opened && navigationVersion !== navigation) return 'Solicitud aceptada. Puedes abrirla desde tus contactos cuando quieras.';
      if (!opened) throw new Error('La solicitud está aceptada, pero no se ha podido abrir el chat. Vuelve a intentarlo desde tus contactos.');
    }
    return accept ? 'Has aceptado la solicitud. La conversación está disponible.' : 'Solicitud rechazada. No se ha abierto una conversación.';
  });
}
function changeContactBlock(contact) {
  return contactAction(async current => {
    const blocking = !contact.blocked_by_me;
    const { data, error } = await sb.rpc('sx_set_contact_block', { p_contact_id: contact.id, p_blocked: blocking });
    if (error) throw error;
    if (!current()) return;
    contactsRevision += 1;
    contacts = contacts.map(row => row.id === contact.id ? { ...row, blocked_by_me: blocking, blocked: Boolean(data) } : row);
    renderContacts();
    return blocking ? 'Contacto bloqueado. Se detienen los mensajes nuevos; el historial se conserva.'
      : data ? 'Has retirado tu bloqueo. El contacto sigue sin estar disponible.' : 'Has retirado tu bloqueo. Las solicitudes rechazadas no se reabren.';
  });
}

function showNotice(message, type = '') {
  notice.textContent = message;
  notice.className = `notice ${type}`;
  notice.hidden = false;
}
function clearNotice() { notice.textContent = ''; notice.hidden = true; }
function friendlyError(err) {
  const code = err?.code || '';
  const message = err?.message || '';
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(message)) return 'El correo o la contraseña de Connect no coinciden. Revisa ambos o usa «He olvidado mi contraseña».';
  if (code === 'email_not_confirmed') return 'Falta confirmar este correo. Revisa el último enlace recibido; si ya tenías un acceso preparado, usa esa cuenta.';
  if (err?.status === 429 || /rate.?limit/i.test(code)) return 'Se han hecho demasiados intentos. Espera unos minutos antes de volver a intentarlo.';
  if (code === 'email_address_not_authorized' || /not authorized.*email|email.*not authorized/i.test(message)) return 'Este laboratorio todavía no puede enviar a ese correo. Necesita configurar el servicio de correo antes de ampliar los accesos.';
  if (/fetch|network|offline|abort|timeout|connection/i.test(message) || err?.name === 'AbortError') return 'No hemos podido conectar. Comprueba internet y vuelve a intentarlo; tu mensaje no se borra.';
  if (/^[A-ZÁÉÍÓÚ¡¿].*[áéíóúñ]|^(Tu cuenta|Esta sala|Sala inexistente|Introduce|Las contraseñas|Usa al menos)/.test(message)) return message;
  return 'No hemos podido completar la operación. Vuelve a intentarlo; si se repite, anota en qué paso ocurre.';
}
function safeError(err) { console.error('Connect:', err?.code || 'request_failed'); showNotice(friendlyError(err), 'error'); }
function setPending(button, pending) { button.disabled = pending; button.setAttribute('aria-busy', String(pending)); }
function setAuthPending(pending) { for (const id of ['login-btn', 'signup-btn', 'recover-btn']) setPending($(id), pending); }
function storageGet(key) { try { return sessionStorage.getItem(key); } catch { return null; } }
function storageSet(key, value) { try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); } catch { /* In-memory drafts still work when storage is unavailable. */ } }
function cachedRoom(actor) { try { return localStorage.getItem(`sx_connect_room:${actor}`); } catch { return null; } }
function cacheRoom(actor, room) { try { if (room) localStorage.setItem(`sx_connect_room:${actor}`, room); else localStorage.removeItem(`sx_connect_room:${actor}`); } catch { /* Membership discovery works without a browser cache. */ } }
function draftKey(actor = user?.id, room = activeRoom) { return `sx_draft:${actor}:${room}`; }
function saveDraft() {
  if (user && activeRoom) storageSet(draftKey(), JSON.stringify({ draft: $('body').value, attempt: pendingAttempt }));
}
function restoreDraft() {
  try {
    const saved = JSON.parse(storageGet(draftKey()) || '{}');
    $('body').value = typeof saved.draft === 'string' ? saved.draft.slice(0, 2000) : '';
    pendingAttempt = saved.attempt?.room_id === activeRoom && saved.attempt?.sender_id === user.id
      && /^[0-9a-f-]{36}$/i.test(saved.attempt.client_message_id) && typeof saved.attempt.body === 'string' ? saved.attempt : null;
    if (pendingAttempt) $('send-status').textContent = 'Envío pendiente de confirmar. Puedes reintentar el mismo mensaje sin duplicarlo.';
  } catch { pendingAttempt = null; }
}
function renderConnection() {
  $('connection-status').textContent = navigator.onLine === false ? 'Sin conexión · Conservamos tu borrador en esta pestaña'
    : readFailed ? 'No se pudo actualizar · Reintentando al recuperar la conexión'
    : lastSync ? `${channelState === 'SUBSCRIBED' ? 'Canal en directo' : 'Consulta periódica'} · Última actualización ${lastSync}`
    : 'Conectando al canal de mensajes…';
}
async function boundedFetch(input, init = {}) {
  const controller = new AbortController();
  const originalSignal = init.signal || input?.signal;
  const abort = () => controller.abort();
  if (originalSignal?.aborted) abort(); else originalSignal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 15000);
  try { return await fetch(input, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timer); originalSignal?.removeEventListener('abort', abort); }
}

let config;
try { config = await import('./config.js'); }
catch {
  showNotice('Falta config.js. Copia config.example.js y configura los datos públicos del laboratorio.', 'error');
  setAuthPending(true);
  throw new Error('Configuración de Supabase pendiente');
}
const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = config;
// The isolated QA server supplies this config dynamically; production builds
// still accept HTTPS only and never include local accounts or a local backend.
const localQA = /^http:\/\/127\.0\.0\.1:[0-9]+$/.test(SUPABASE_URL) && window.location.origin === SUPABASE_URL;
if (typeof SUPABASE_URL !== 'string' || (!SUPABASE_URL.startsWith('https://') && !localQA) || SUPABASE_URL.includes('TU-PROYECTO')
  || typeof SUPABASE_PUBLISHABLE_KEY !== 'string' || !SUPABASE_PUBLISHABLE_KEY || SUPABASE_PUBLISHABLE_KEY.includes('REEMPLAZAR')) {
  showNotice('Configura config.js usando config.example.js antes de abrir esta página.', 'error');
  setAuthPending(true);
  throw new Error('Configuración de Supabase pendiente');
}
const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { global: { fetch: boundedFetch } });
const emailReturnUrl = window.location.origin + window.location.pathname;
const recoveryKey = `sx_recovery:${SUPABASE_URL}`;
const callbackError = new URLSearchParams(window.location.hash.slice(1));
if (callbackError.has('error')) {
  showNotice('El enlace de correo ha caducado o no es válido. Si tu cuenta ya está confirmada, pulsa Entrar. Para recuperar la contraseña, solicita un enlace nuevo.', 'error');
  window.history.replaceState(null, '', emailReturnUrl);
}

function isCurrent(version, actor) { return viewVersion === version && user?.id === actor; }
function displayRoomSetup() {
  $('setup-room').hidden = false;
  $('active-chat').hidden = true;
  $('chat-panel').setAttribute('data-conversation-open', 'false');
  $('room-id').value = '';
}
// Invalidate pending reads synchronously, before waiting for socket removal.
function resetRoom(discardDraft = false) {
  if (discardDraft && user && activeRoom) storageSet(draftKey(), null); else saveDraft();
  viewVersion += 1;
  pendingRead = null;
  activeRoom = null;
  pendingAttempt = null;
  sending = null;
  channelState = ''; readFailed = false; lastSync = '';
  latestView = '';
  $('messages').replaceChildren();
  $('body').value = '';
  $('room-code').textContent = '';
  $('connection-status').textContent = '';
  $('send-status').textContent = '';
  setPending($('send-form').querySelector('button'), false);
  displayRoomSetup();
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = null;
  const previous = realtimeChannel;
  realtimeChannel = null;
  if (previous) void Promise.resolve(sb.removeChannel(previous)).catch(error => console.error('Canal anterior:', error));
}
async function showAuthenticated(nextUser) {
  if (recoveryMode) return;
  authVersion += 1;
  resetContacts();
  resetRoom(user?.id !== nextUser.id);
  user = nextUser;
  void syncCofreSession(nextUser);
  $('auth-panel').hidden = true;
  $('chat-panel').hidden = false;
  $('recovery-panel').hidden = true;
  $('identity').textContent = user.email || 'Cuenta autenticada';
  $('contact-label').value = readSetting(`sx_contact_label:${user.id}`) || '';
  void refreshContacts();
  contactsTimer = setInterval(() => { if (!document.hidden && user?.id === nextUser.id) void refreshContacts(); }, 5000);
  const authentication = authVersion;
  const last = cachedRoom(user.id);
  if (last) {
    if (await activateRoom(last, true)) return;
    if (authVersion !== authentication || user?.id !== nextUser.id || cachedRoom(nextUser.id)) return;
  }
  {
    // A fresh phone can discover a room this account already belongs to.
    const actor = user.id;
    const version = viewVersion;
    try {
      const { data, error } = await sb.from('sx_room_members').select('room_id')
        .eq('user_id', actor).order('joined_at', { ascending: false }).limit(1);
      if (!isCurrent(version, actor)) return;
      if (error) throw error;
      if (data?.[0]?.room_id) await activateRoom(data[0].room_id, true);
    } catch (error) { if (isCurrent(version, actor)) safeError(error); }
  }
}
function showSignedOut() {
  authEventVersion += 1;
  authVersion += 1;
  resetRoom(true);
  resetContacts();
  user = null;
  void syncCofreSession(null);
  recoveryMode = false;
  recoveryShown = false;
  storageSet(recoveryKey, null);
  $('identity').textContent = '';
  $('chat-panel').hidden = true;
  $('auth-panel').hidden = false;
  $('recovery-panel').hidden = true;
  $('password').value = '';
  $('password').type = 'password'; $('show-password').textContent = 'Mostrar'; $('show-password').setAttribute('aria-pressed', 'false');
  $('new-password').value = ''; $('repeat-password').value = '';
}
async function refreshAuth() {
  const version = authVersion;
  const { data, error } = await sb.auth.getUser();
  if (version !== authVersion || recoveryMode) return;
  if (error) { if (error.status === 401 || error.status === 403) showSignedOut(); safeError(error); }
  else if (!data?.user) showSignedOut();
  else if (storageGet(recoveryKey) === data.user.id) showRecovery(data.user);
  else if (!user || user.id !== data.user.id) await showAuthenticated(data.user);
}
function showRecovery(nextUser) {
  recoveryMode = true; recoveryShown = true; authVersion += 1;
  void syncCofreSession(null);
  resetRoom(true); resetContacts(); user = nextUser;
  storageSet(recoveryKey, nextUser.id);
  $('auth-panel').hidden = true; $('chat-panel').hidden = true; $('recovery-panel').hidden = false;
  $('recovery-email').textContent = nextUser.email || '';
}

$('auth-form').addEventListener('submit', async event => {
  event.preventDefault(); clearNotice(); setAuthPending(true);
  try {
    const { error } = await sb.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value });
    if (error) throw error;
    await refreshAuth();
  } catch (error) { safeError(error); }
  finally { setAuthPending(false); }
});
$('signup-btn').addEventListener('click', async () => {
  if (!$('email').reportValidity()) return;
  if ($('password').value.length < 6) { showNotice('Usa al menos 6 caracteres para crear una contraseña nueva de Connect.', 'error'); return; }
  clearNotice(); setAuthPending(true);
  try {
    const { data, error } = await sb.auth.signUp({ email: $('email').value.trim(), password: $('password').value, options: { emailRedirectTo: emailReturnUrl } });
    if (error) throw error;
    if (data.session) await refreshAuth();
    else showNotice('Solicitud recibida. Si este correo admite registro, recibirás una confirmación. Si ya tienes cuenta, pulsa Entrar con tu contraseña anterior: repetir el registro no la cambia. El correo del laboratorio puede demorarse o estar limitado.', 'success');
  } catch (error) { safeError(error); }
  finally { setAuthPending(false); }
});
$('show-password').addEventListener('click', () => {
  const visible = $('password').type === 'password';
  $('password').type = visible ? 'text' : 'password';
  $('show-password').textContent = visible ? 'Ocultar' : 'Mostrar';
  $('show-password').setAttribute('aria-pressed', String(visible));
});
$('recover-btn').addEventListener('click', async () => {
  if (!$('email').reportValidity()) return;
  clearNotice(); setAuthPending(true);
  try {
    const { error } = await sb.auth.resetPasswordForEmail($('email').value.trim(), { redirectTo: emailReturnUrl });
    if (error) throw error;
    showNotice('Si esta dirección permite recuperar el acceso, recibirás un enlace para elegir una contraseña nueva. Revisa spam y usa el correo más reciente. El envío del laboratorio es limitado; no repitas la solicitud de inmediato.', 'success');
  } catch (error) { safeError(error); }
  finally { setAuthPending(false); }
});
$('recovery-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!recoveryMode || !user) return;
  if ($('new-password').value.length < 6) { showNotice('Usa al menos 6 caracteres.', 'error'); return; }
  if ($('new-password').value !== $('repeat-password').value) { showNotice('Las contraseñas no coinciden. Escríbelas de nuevo.', 'error'); return; }
  const version = authVersion;
  setPending($('save-password'), true);
  try {
    const { error } = await sb.auth.updateUser({ password: $('new-password').value });
    if (version !== authVersion || !recoveryMode) return;
    if (error) throw error;
    recoveryMode = false; storageSet(recoveryKey, null); $('new-password').value = ''; $('repeat-password').value = '';
    await showAuthenticated(user);
    showNotice('Contraseña de Connect actualizada.', 'success');
  } catch (error) { if (version === authVersion) safeError(error); }
  finally { setPending($('save-password'), false); }
});
$('cancel-recovery').addEventListener('click', async () => {
  showSignedOut();
  try { const { error } = await sb.auth.signOut(); if (error) throw error; } catch (error) { safeError(error); }
});
$('logout-btn').addEventListener('click', async () => {
  clearNotice();
  const button = $('logout-btn'); setPending(button, true);
  // Hide account content immediately, even if signOut has to wait for the network.
  showSignedOut();
  setAuthPending(true);
  try {
    const { error } = await sb.auth.signOut();
    if (error) throw error;
  } catch (error) {
    await refreshAuth();
    safeError(error);
  } finally { setPending(button, false); setAuthPending(false); }
});

async function activateRoom(id, fromCache = false) {
  if (!user) return false;
  resetRoom();
  const version = viewVersion;
  const actor = user.id;
  try {
    const { data: membership, error } = await sb.from('sx_room_members').select('room_id').eq('room_id', id).eq('user_id', actor).maybeSingle();
    if (!isCurrent(version, actor)) return false;
    if (error) throw error;
    if (!membership) {
      if (fromCache) { cacheRoom(actor, null); return false; }
      throw new Error('Tu cuenta no pertenece a esta sala. Únete con el código primero.');
    }
    activeRoom = id;
    syncActiveContact();
    restoreDraft();
    cacheRoom(actor, id);
    $('room-code').textContent = id;
    $('setup-room').hidden = true;
    $('active-chat').hidden = false;
    $('chat-panel').setAttribute('data-conversation-open', 'true');
    // Keep restored sessions quiet; a deliberate opening gets a clear focus target.
    if (!fromCache) {
      $('active-contact-title').setAttribute('tabindex', '-1'); $('active-contact-title').focus({ preventScroll: true });
      $('active-chat').scrollIntoView?.({ block: 'start', behavior: 'instant' });
    }
    $('connection-status').textContent = 'Conectando al canal de mensajes…';
    await readMessages();
    if (!isCurrent(version, actor)) return false;
    realtimeChannel = sb.channel(`sx-messages-${id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sx_messages', filter: `room_id=eq.${id}` }, () => {
        if (isCurrent(version, actor)) void readMessages();
      })
      .subscribe(status => {
        if (!isCurrent(version, actor)) return;
        channelState = status; renderConnection();
        // Catch inserts occurring between initial fetch and subscription readiness.
        if (status === 'SUBSCRIBED') void readMessages();
      });
    pollTimer = setInterval(() => { if (!document.hidden && isCurrent(version, actor)) void readMessages(); }, 5000);
    return true;
  } catch (error) {
    if (isCurrent(version, actor)) {
      resetRoom();
      safeError(error);
    }
    return false;
  }
}
function readMessages() {
  if (!activeRoom || !user) return Promise.resolve();
  if (pendingRead) {
    pendingRead.queued = true;
    return pendingRead.promise;
  }
  const version = viewVersion;
  const actor = user.id;
  const room = activeRoom;
  const request = { queued: false, promise: null };
  pendingRead = request;
  request.promise = fetchMessages(version, actor, room).finally(() => {
    if (pendingRead !== request) return;
    pendingRead = null;
    // Coalesce events received during the fetch into one following refresh.
    // Always render each completed fetch, even if another poll is already due.
    if (request.queued && isCurrent(version, actor)) void readMessages();
  });
  return request.promise;
}
async function fetchMessages(version, actor, room) {
  try {
    const { data, error } = await sb.from('sx_messages')
      .select('id, room_id, sender_id, body, created_at')
      .eq('room_id', room).order('id', { ascending: false }).limit(150);
    if (!isCurrent(version, actor)) return;
    if (error) throw error;
    readFailed = false;
    lastSync = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    renderConnection();
    // Limit on descending IDs selects the newest page; display oldest to newest.
    const entries = [...(data || [])].reverse();
    const fingerprint = JSON.stringify(entries);
    if (fingerprint === latestView) return;
    const list = $('messages'), previousScrollTop = list.scrollTop || 0;
    const followLatest = !latestView || (list.clientHeight > 0 && list.scrollHeight - previousScrollTop - list.clientHeight <= 64)
      || Boolean(sending && sending.room_id === room && sending.sender_id === actor);
    // Save a visible message, so trimming the oldest of the 150 entries does not
    // pull somebody away from the passage they are reading.
    let anchor;
    if (!followLatest && list.getBoundingClientRect) {
      const top = list.getBoundingClientRect().top;
      const item = Array.from(list.children).find(node => node.getBoundingClientRect?.().bottom > top);
      if (item?.getAttribute('data-message-id')) anchor = { id: item.getAttribute('data-message-id'), top: item.getBoundingClientRect().top };
    }
    latestView = fingerprint;
    list.replaceChildren();
    if (!entries.length) {
      const item = document.createElement('li'); item.className = 'empty';
      item.textContent = 'Todavía no hay mensajes. Escribe el primero.';
      list.appendChild(item);
    }
    for (const entry of entries) {
      const mine = entry.sender_id === actor;
      const li = document.createElement('li'); li.className = `msg ${mine ? 'mine' : ''}`;
      li.setAttribute('data-message-id', String(entry.id));
      const who = document.createElement('span'); who.className = 'who'; who.textContent = mine ? 'Tú' : 'La otra persona';
      const p = document.createElement('p'); p.className = 'body'; p.textContent = entry.body;
      const time = document.createElement('time'); time.dateTime = entry.created_at;
      time.textContent = new Date(entry.created_at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
      li.append(who, p, time); list.appendChild(li);
    }
    if (followLatest) list.scrollTop = list.scrollHeight;
    else {
      const item = anchor && Array.from(list.children).find(node => node.getAttribute?.('data-message-id') === anchor.id);
      list.scrollTop = item ? Math.max(0, (list.scrollTop || 0) + item.getBoundingClientRect().top - anchor.top) : previousScrollTop;
    }
  } catch (error) { if (isCurrent(version, actor)) { readFailed = true; renderConnection(); } }
}
function roomPending(pending) {
  setPending($('create-room'), pending);
  setPending($('join-form').querySelector('button'), pending);
}
$('create-room').addEventListener('click', async () => {
  if (!user) return;
  navigationVersion += 1;
  clearNotice(); roomPending(true);
  const version = viewVersion; const actor = user.id;
  try {
    const { data, error } = await sb.rpc('sx_create_chat');
    if (!isCurrent(version, actor)) return;
    if (error) throw error;
    if (await activateRoom(data)) showNotice('Sala creada. Copia el código y compártelo con la otra persona para la primera prueba.', 'success');
  } catch (error) { if (isCurrent(version, actor)) safeError(error); }
  finally { roomPending(false); }
});
$('join-form').addEventListener('submit', async event => {
  event.preventDefault(); clearNotice();
  if (!user) return;
  const id = $('room-id').value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    showNotice('Introduce un código de conversación válido.', 'error'); return;
  }
  navigationVersion += 1;
  roomPending(true);
  const version = viewVersion; const actor = user.id;
  try {
    const { error } = await sb.rpc('sx_join_chat', { p_room_id: id });
    if (!isCurrent(version, actor)) return;
    if (error) throw error;
    if (await activateRoom(id)) showNotice('Ya estáis en la misma sala. ¡A probar los mensajes!', 'success');
  } catch (error) { if (isCurrent(version, actor)) safeError(error); }
  finally { roomPending(false); }
});
const backToContacts = $('leave-room');
backToContacts.textContent = '← Volver a contactos';
backToContacts.className = 'text-button v11-back-contacts';
backToContacts.setAttribute('aria-controls', 'contacts-list');
$('active-chat').prepend?.(backToContacts);
backToContacts.addEventListener('click', () => {
  navigationVersion += 1;
  clearNotice();
  if (user) cacheRoom(user.id, null);
  resetRoom();
  $('contacts-title').setAttribute('tabindex', '-1');
  $('contacts-title').focus({ preventScroll: true });
  $('contacts-title').scrollIntoView?.({ block: 'start', behavior: 'instant' });
});
$('copy-code').addEventListener('click', async () => {
  if (!activeRoom || !user) return;
  const version = viewVersion; const actor = user.id; const room = activeRoom;
  try {
    await navigator.clipboard.writeText(room);
    if (isCurrent(version, actor)) showNotice('Código de sala copiado. Solo permite recuperar el acceso de quien ya pertenece a ella.', 'success');
  } catch { if (isCurrent(version, actor)) showNotice('Selecciona y copia el código de sala manualmente.', 'error'); }
});
$('send-form').addEventListener('submit', async event => {
  event.preventDefault(); clearNotice();
  const draft = $('body').value;
  const body = draft.trim();
  if (!body || !activeRoom || !user || sending) return;
  if (activeContact()?.blocked) { showNotice('Este contacto no está disponible para mensajes nuevos. Tu borrador se conserva.', 'error'); return; }
  if (navigator.onLine === false) { saveDraft(); showNotice('Estás sin conexión. Tu borrador sigue aquí; podrás enviarlo cuando vuelva internet.', 'error'); return; }
  const version = viewVersion; const actor = user.id; const room = activeRoom;
  const attempt = pendingAttempt?.body === body ? pendingAttempt : { room_id: room, sender_id: actor, body, client_message_id: crypto.randomUUID() };
  pendingAttempt = attempt; sending = attempt; saveDraft();
  $('send-status').textContent = 'Enviando…';
  const button = $('send-form').querySelector('button'); setPending(button, true);
  try {
    const { error } = await sb.from('sx_messages').insert(attempt);
    if (!isCurrent(version, actor)) return;
    if (error) {
      // A lost acknowledgement may still have committed. Confirm the same ID before retrying.
      const { data: stored, error: lookupError } = await sb.from('sx_messages').select('id, body').eq('room_id', room).eq('sender_id', actor).eq('client_message_id', attempt.client_message_id).maybeSingle();
      if (!isCurrent(version, actor)) return;
      if (lookupError || !stored || stored.body !== body) throw error;
    }
    pendingAttempt = null;
    if ($('body').value === draft) $('body').value = '';
    saveDraft();
    $('send-status').textContent = 'Guardado en la conversación. La recepción por la otra persona todavía no se confirma.';
    await readMessages();
  } catch (error) { if (isCurrent(version, actor)) { saveDraft(); $('send-status').textContent = 'Envío sin confirmar. Tu borrador se conserva.'; safeError(error); void refreshContacts(true); } }
  finally {
    if (sending === attempt) { sending = null; setPending(button, false); }
    if (isCurrent(version, actor)) { syncActiveContact(); $('body').focus(); }
  }
});
$('body').addEventListener('input', saveDraft);
$('retry-room').addEventListener('click', () => { if (user) { clearNotice(); void showAuthenticated(user); } });
$('refresh-messages').addEventListener('click', () => { if (activeRoom) void readMessages(); });
$('refresh-contacts').addEventListener('click', () => { void refreshContacts(true); });
$('easy-mode').addEventListener('click', () => setEasyMode(!easyMode));
$('active-block').addEventListener('click', () => { const contact = activeContact(); if (contact) return changeContactBlock(contact); });
$('contact-label').addEventListener('input', () => { if (user) writeSetting(`sx_contact_label:${user.id}`, $('contact-label').value); });
$('create-invite').addEventListener('click', () => contactAction(async current => {
  const { data, error } = await sb.rpc('sx_contact_invite', { p_label: contactLabel() });
  if (error) throw error;
  if (!current()) return;
  contactsRevision += 1;
  $('invite-code').value = data; $('invite-result').hidden = false;
  return 'Invitación preparada. Quien tenga este código puede solicitarte una conversación; tú decides si la aceptas.';
}));
$('copy-invite').addEventListener('click', async () => {
  const epoch = contactsEpoch; const actor = user?.id; const code = $('invite-code').value;
  if (!code || !actor) return;
  try { await navigator.clipboard.writeText(code); if (contactCurrent(epoch, actor)) showNotice('Invitación copiada.', 'success'); }
  catch { if (contactCurrent(epoch, actor)) showNotice('Puedes seleccionar y copiar el código manualmente.', 'error'); }
});
$('request-contact-form').addEventListener('submit', event => {
  event.preventDefault();
  return contactAction(async current => {
    const code = $('contact-code').value.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(code)) throw new Error('Introduce un código de invitación válido.');
    const { error } = await sb.rpc('sx_request_contact', { p_invite_code: code, p_label: contactLabel() });
    if (error) throw error;
    if (!current()) return;
    contactsRevision += 1;
    $('contact-code').value = '';
    return 'Solicitud registrada. Puedes ver su estado en tus contactos. Repetirla no abre otra conversación.';
  });
});
setEasyMode(readSetting('sx_easy_mode') === 'true');

document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (activeRoom) void readMessages(); void refreshContacts(); } });
window.addEventListener('online', () => { renderConnection(); if (activeRoom) void readMessages(); void refreshContacts(); });
window.addEventListener('offline', renderConnection);
sb.auth.onAuthStateChange((event, session) => {
  // INITIAL_SESSION may only describe a cached user/token. The startup getUser()
  // below verifies it with Auth before exposing account UI or module credentials.
  // A cached callback must not invalidate that check or a newer real sign-in.
  if (event === 'INITIAL_SESSION') return;
  if (event === 'PASSWORD_RECOVERY' && session?.user) { recoveryMode = true; recoveryShown = false; }
  const eventVersion = ++authEventVersion;
  setTimeout(() => {
    if (eventVersion !== authEventVersion) return;
    if (session?.user) {
      if (recoveryMode && !recoveryShown) {
        showRecovery(session.user);
      } else if (!recoveryMode && (!user || user.id !== session.user.id)) void showAuthenticated(session.user);
      else if (!recoveryMode) void syncCofreSession(session.user);
    } else if (user) showSignedOut();
  }, 0);
});
await refreshAuth();
