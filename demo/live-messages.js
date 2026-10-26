const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createLiveMessages({ client, documentRef = document, windowRef = window, notify = () => {}, confirmAction = async () => false, onProfile = () => {}, onAuthLost = () => {} } = {}) {
  const d = documentRef, w = windowRef, listeners = [], drafts = new Map(), attempts = new Map();
  let session = null, generation = 0, listVersion = 0, messageVersion = 0, rows = [], active = null, messages = [], sending = null, isSending = false, poll = null, channel = null, disposed = false, busy = false;
  const el = (tag, cls, text) => { const n = d.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const listen = (n, event, fn) => { n.addEventListener(event, fn); listeners.push(() => n.removeEventListener(event, fn)); };
  const button = (text, fn, cls = 'sx-button') => { const n = el('button', cls, text); n.type = 'button'; listen(n, 'click', fn); return n; };
  const status = el('p', 'sx-field-status'); status.setAttribute('role', 'status');
  const element = el('section', 'sx-live-messages'); element.append(el('p', 'sx-eyebrow', 'TÚ DECIDES'), el('h2', '', 'Tus conversaciones'), el('p', 'sx-lead', 'Invita a quien tú elijas. Una solicitud necesita aceptación antes de abrir una conversación.'), status);
  const connection = el('p', 'sx-live-connection'); connection.setAttribute('role', 'status'); element.append(connection);
  const listing = el('div', 'sx-live-contacts');
  const invite = el('details', 'sx-glass sx-live-invite'); invite.append(el('summary', '', 'Invitar o añadir un contacto'));
  const inviteForm = el('form', 'sx-live-form'), nameLabel = el('label', '', 'Cómo quieres presentarte a este contacto'), alias = el('input'); alias.maxLength = 80; alias.required = true; alias.autocomplete = 'nickname'; nameLabel.append(alias);
  const create = el('button', 'sx-button sx-primary', 'Preparar mi invitación'); create.type = 'submit'; const code = el('output', 'sx-invite-code'); code.setAttribute('aria-label', 'Mi código de invitación');
  const copy = button('Copiar código', async () => { try { await w.navigator.clipboard.writeText(code.textContent); notify('Código copiado. Compártelo solo con quien quieras invitar.'); } catch { notify('Selecciona y copia el código que aparece aquí.'); } }); copy.hidden = true;
  inviteForm.append(nameLabel, create, code, copy, el('p', 'sx-form-help', 'El código permite solicitarte contacto. No permite ver tu perfil ni enviarte mensajes sin tu aceptación.'));
  const requestForm = el('form', 'sx-live-form'), requestLabel = el('label', '', 'Código que te han compartido'), requestCode = el('input'); requestCode.required = true; requestCode.maxLength = 36; requestCode.autocomplete = 'off'; requestLabel.append(requestCode);
  const requestSubmit = el('button', 'sx-button', 'Solicitar contacto'); requestSubmit.type = 'submit'; requestForm.append(requestLabel, requestSubmit); invite.append(inviteForm, requestForm); listing.append(invite);
  const refresh = button('Actualizar contactos', () => void load(true), 'sx-text-link'); listing.append(refresh, el('h3', '', 'Solicitudes'), el('p', 'sx-form-help', 'Aceptar abre una conversación privada. Rechazar no concede acceso.'));
  const requests = el('ul', 'contacts-list'); listing.append(requests, el('h3', '', 'Conversaciones')); const conversations = el('ul', 'contacts-list'); listing.append(conversations); element.append(listing);
  const conversation = el('section', 'sx-live-conversation'); conversation.hidden = true;
  const back = button('← Volver a contactos', () => { saveDraft(); active = null; messageVersion++; messages = []; conversation.hidden = true; listing.hidden = false; history.replaceChildren(); });
  const head = el('div', 'sx-live-chat-head'), title = el('h3'), openProfile = button('Ver perfil', () => active && onProfile(active.counterpart_id)), block = button('Bloquear', () => void blockActive(), 'sx-button sx-danger'); head.append(title, openProfile, block);
  const chatStatus = el('p', 'sx-field-status'); chatStatus.setAttribute('role', 'status');
  const earlier = button('Cargar mensajes anteriores', () => void read(true), 'sx-text-link'); earlier.hidden = true;
  const history = el('ol', 'messages sx-live-history'); history.setAttribute('aria-label', 'Mensajes de esta conversación');
  const compose = el('form', 'composer sx-live-compose'), label = el('label', 'sr-only', 'Tu mensaje'), body = el('textarea'); body.id = 'sx-live-message'; body.maxLength = 2000; body.rows = 2; body.required = true; body.placeholder = 'Escribe con tranquilidad…'; label.htmlFor = body.id;
  const send = el('button', 'sx-button sx-primary', 'Enviar'); send.type = 'submit'; compose.append(label, body, send); conversation.append(back, head, chatStatus, earlier, history, compose); element.append(conversation);
  function errorText(error) { if (!w.navigator.onLine) return 'No hay conexión. Tu borrador sigue aquí mientras mantengas abierta esta sesión.'; if (error?.code === 'SESSION_CHANGED') return ''; return error?.code === '42501' ? 'Esta acción no está permitida. Actualiza para comprobar el acceso o el bloqueo.' : 'No se pudo completar la acción. Puedes volver a intentarlo.'; }
  const capture = () => { const version = generation, actor = session?.user?.id; if (!actor) throw new Error('Inicia sesión para continuar.'); return () => { if (disposed || version !== generation || session?.user?.id !== actor) throw Object.assign(new Error('session_changed'), { code: 'SESSION_CHANGED' }); }; };
  async function rpc(name, args = {}) { const check = capture(); const { data, error, status: httpStatus } = await client.rpc(name, args); check(); if (error) { if(httpStatus===401 || error.status===401 || ['PGRST301','PGRST302','PGRST303'].includes(error.code)){onAuthLost();throw Object.assign(new Error('session_changed'),{code:'SESSION_CHANGED'});}throw error; } return data; }
  function saveDraft() { if (active) drafts.set(active.room_id, body.value); }
  function renderConnection() { connection.textContent = w.navigator.onLine ? 'Conectado · actualización automática mientras esta pestaña esté visible' : 'Sin conexión · vuelve a intentarlo cuando tengas Internet'; }
  function drawRequests(contacts) {
    requests.replaceChildren();
    for (const contact of contacts.filter(c => c.status !== 'accepted')) {
      const row = el('li', 'sx-live-contact'), copy = el('div'); copy.append(el('strong', '', contact.counterpart_label), el('p', '', contact.status === 'rejected' ? 'Solicitud rechazada' : contact.direction === 'incoming' ? 'Quiere conversar contigo' : 'Tu solicitud está pendiente de respuesta')); row.append(copy);
      if (contact.status === 'pending' && contact.direction === 'incoming') {
        row.append(button('Aceptar', () => void act(async () => { await rpc('sx_decide_contact', { p_contact_id: contact.id, p_accept: true }); })), button('Rechazar', () => void act(async () => { await rpc('sx_decide_contact', { p_contact_id: contact.id, p_accept: false }); }), 'sx-button sx-danger'));
      }
      requests.append(row);
    }
    if (!requests.children.length) requests.append(el('li', 'sx-quiet', 'No tienes solicitudes pendientes.'));
  }
  function drawRooms() {
    conversations.replaceChildren();
    for (const row of rows) {
      const item = el('li', 'sx-live-contact'), copy = el('div'); copy.append(el('strong', '', row.counterpart_label || 'Contacto'), el('p', '', row.blocked ? (row.blocked_by_me ? 'Has bloqueado este contacto' : 'Conversación bloqueada') : row.legacy ? 'Conversación conservada de Connect' : 'Contacto aceptado'));
      item.append(copy, button('Abrir conversación', () => void open(row), 'sx-button')); conversations.append(item);
    }
    if (!rows.length) conversations.append(el('li', 'sx-quiet', 'Cuando aceptes una solicitud, tu conversación aparecerá aquí.'));
  }
  async function load(showStatus = false) {
    if (!session || disposed) return;
    const version = ++listVersion, check = capture();
    if (showStatus) status.textContent = 'Actualizando…';
    try {
      const [contacts, rooms] = await Promise.all([rpc('sx_list_contacts'), rpc('sx_list_conversations', { p_limit: 100 })]); check(); if (version !== listVersion) return;
      rows = rooms || []; drawRequests(contacts || []); drawRooms();
      if (active) { const fresh = rows.find(r => r.room_id === active.room_id); if (!fresh) { active = null; conversation.hidden = true; listing.hidden = false; body.value = ''; history.replaceChildren(); } else { active = fresh; renderActive(); } }
      if (showStatus) status.textContent = 'Contactos actualizados.';
    } catch (error) { if (error.code !== 'SESSION_CHANGED' && version === listVersion) status.textContent = errorText(error); }
  }
  async function act(action) { if (busy) return; const check = capture(), version = generation; busy = true; try { await action(); check(); await load(); check(); status.textContent = 'Cambio guardado.'; } catch (error) { if (error.code !== 'SESSION_CHANGED') status.textContent = errorText(error); } finally { if(version === generation)busy = false; } }
  function renderActive() {
    if (!active) return; title.textContent = active.counterpart_label || 'Contacto'; block.textContent = active.blocked_by_me ? 'Desbloquear' : 'Bloquear'; openProfile.disabled = active.blocked || active.can_send === false; body.disabled = send.disabled = active.blocked || active.can_send === false || isSending;
    chatStatus.textContent = active.blocked ? 'El bloqueo impide nuevos mensajes y el acceso al perfil compartido. El historial sigue disponible.' : active.can_send === false ? 'Puedes consultar el historial. Esta conversación no admite mensajes nuevos.' : 'Solo quienes participan pueden leer esta conversación. Los borradores duran esta sesión.';
  }
  function drawMessages() {
    const atEnd = history.scrollHeight - history.scrollTop - history.clientHeight < 80;
    history.replaceChildren(); for (const item of messages) { const row = el('li', item.sender_id === session?.user?.id ? 'message mine' : 'message'); const text = el('p', '', item.body), date = new Date(item.created_at); row.append(el('span', 'sx-message-author', item.sender_id === session?.user?.id ? 'Tú' : active?.counterpart_label || 'Contacto'), text, el('time', '', Number.isNaN(date.getTime()) ? '' : date.toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' }))); history.append(row); }
    if (atEnd) history.scrollTop = history.scrollHeight;
  }
  async function open(row) { saveDraft(); active = row; messages = []; sending = attempts.get(row.room_id)||null; body.value = drafts.get(row.room_id) || ''; listing.hidden = true; conversation.hidden = false; history.replaceChildren(); earlier.hidden = true; renderActive(); title.tabIndex = -1; title.focus({ preventScroll: true }); await read(); }
  async function read(older = false) {
    if (!active || !session || disposed) return; const room = active.room_id, version = ++messageVersion, check = capture();
    try { const data = await rpc('sx_messages_page', { p_room_id: room, p_limit: 100, p_before_id: older ? messages[0]?.id || null : null }); check(); if (version !== messageVersion || active?.room_id !== room) return;
      const page = data || []; if (older) messages = [...page, ...messages]; else { const first = page[0]?.id; messages = [...messages.filter(m => first && BigInt(m.id) < BigInt(first)), ...page]; }
      messages = [...new Map(messages.map(m => [String(m.id), m])).values()]; earlier.hidden = page.length < 100; drawMessages();
    } catch (error) { if (error.code !== 'SESSION_CHANGED' && version === messageVersion) chatStatus.textContent = errorText(error); }
  }
  async function blockActive() {
    if (!active || busy) return; const check=capture(), room = active, next = !room.blocked_by_me;
    if (next && !await confirmAction({ title: '¿Bloquear este contacto?', description: 'Se detienen los mensajes nuevos en todas vuestras conversaciones y el acceso al perfil compartido. Conservas tu historial.', confirmLabel: 'Bloquear contacto' })) return;
    try{check();}catch{return;}
    await act(async () => { await rpc('sx_set_room_block', { p_room_id: room.room_id, p_blocked: next }); w.dispatchEvent(new w.CustomEvent('sx:contact-block',{detail:{blocked:next}})); });
  }
  listen(inviteForm, 'submit', event => { event.preventDefault(); if (!alias.value.trim()) return; void act(async () => { const id = await rpc('sx_contact_invite', { p_label: alias.value.trim() }); code.textContent = id; copy.hidden = false; }); });
  listen(requestForm, 'submit', event => { event.preventDefault(); if (!UUID.test(requestCode.value.trim())) { status.textContent = 'Pega el código completo de invitación.'; return; } if (!alias.value.trim()) { status.textContent = 'Escribe primero cómo quieres presentarte.'; alias.focus(); return; } void act(async () => { await rpc('sx_request_contact', { p_invite_code: requestCode.value.trim(), p_label: alias.value.trim() }); requestCode.value = ''; }); });
  listen(body, 'input', () => { saveDraft(); if (sending && sending.text !== body.value.trim()) {if(active)attempts.delete(active.room_id);sending = null;} });
  listen(compose, 'submit', async event => {
    event.preventDefault(); if (!active || active.blocked || active.can_send === false || send.disabled || !body.value.trim()) return;
    const check = capture(), room = active.room_id, text = body.value.trim();
    const prior=attempts.get(room),retry = prior?.text === text ? prior : { id: w.crypto.randomUUID(), room, text }; sending = retry; attempts.set(room,retry); isSending = true; send.disabled = true; body.disabled = true; chatStatus.textContent = 'Enviando…';
    try { const result = await rpc('sx_send_message', { p_room_id: room, p_body: text, p_client_message_id: retry.id }); check(); attempts.delete(room); drafts.delete(room);if (active?.room_id !== room) return; body.value = ''; sending = null; if (!messages.some(m => String(m.id) === String(result.id))) messages.push(result); drawMessages(); chatStatus.textContent = 'Mensaje enviado.'; void load(); }
    catch (error) { if (error.code !== 'SESSION_CHANGED' && active?.room_id === room) chatStatus.textContent = errorText(error) + ' Si reintentas el mismo mensaje no se duplica.'; }
    finally { try{check();isSending=false;if(active)body.disabled=send.disabled=active.blocked||active.can_send===false;}catch{} }
  });
  const tick = () => { if (session && !d.hidden && w.navigator.onLine) { void load(); if (active) void read(); } };
  listen(w, 'online', () => { renderConnection(); tick(); }); listen(w, 'offline', renderConnection); listen(d, 'visibilitychange', tick); renderConnection();
  return { element, refresh: load,
    setSession(next) {
      if (next?.user?.id === session?.user?.id) { session = next; return; }
      generation++; listVersion++; messageVersion++; session = next; active = null; messages = []; rows = []; sending = null; isSending=false; busy = false; drafts.clear();attempts.clear(); body.value = alias.value = requestCode.value = code.textContent = ''; copy.hidden = true; requests.replaceChildren(); conversations.replaceChildren(); history.replaceChildren(); status.textContent = ''; conversation.hidden = true; listing.hidden = false;
      if (channel) { void client.removeChannel(channel); channel = null; } w.clearInterval(poll); poll = null;
      if (session) { void load(true); poll = w.setInterval(tick, 15000); channel = client.channel(`sx-v2-messages-${session.user.id}`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sx_messages' }, tick).subscribe(); }
    },
    destroy() { disposed = true; generation++; w.clearInterval(poll); if (channel) void client.removeChannel(channel); listeners.splice(0).forEach(fn => fn()); drafts.clear(); element.remove(); }
  };
}
