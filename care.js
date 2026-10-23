const API = '/checkin/v1';
const modes = new Set(['simulation']);

function readableError(status) {
  if (status === 401) return 'Tu sesión ha terminado. Vuelve a entrar para abrir tu check-in.';
  if (status === 409) return 'El estado ha cambiado. Actualiza para verlo; las simulaciones registradas se conservan.';
  if (status === 400 || status === 413 || status === 422) return 'Revisa el tiempo y elige entre uno y tres contactos ficticios.';
  if (status === 429 || status === 507) return 'Este ensayo ha alcanzado su límite. Puedes volver a intentarlo después.';
  return 'No se ha podido completar. Tu selección se conserva para reintentar.';
}

/** A local check-in viewer. Only the server decides deadlines and state changes. */
export function mountCare({
  getSession = () => window.__sxCofreSession,
  documentRef = document,
  windowRef = window,
  fetchImpl = (...args) => windowRef.fetch(...args),
  uuid = () => windowRef.crypto.randomUUID(),
  now = () => Date.now(),
  pollMs = 2000
} = {}) {
  const main = documentRef.querySelector('main');
  if (!main || documentRef.getElementById('care-panel')) return null;
  const el = (tag, className, text) => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const btn = (text, id, className = 'secondary') => {
    const node = el('button', className, text); node.type = 'button';
    if (id) node.id = id;
    return node;
  };
  const field = (host, tag, id, labelText) => {
    const label = el('label', '', labelText); label.htmlFor = id;
    const input = el(tag); input.id = id; host.append(label, input); return input;
  };
  const panel = el('section', 'panel care-panel');
  panel.id = 'care-panel'; panel.hidden = true; panel.setAttribute('aria-labelledby', 'care-title');
  const heading = el('div', 'section-heading');
  const headings = el('div'); headings.append(el('span', 'eyebrow', 'TU TIEMPO · TUS CONTACTOS'));
  const title = el('h2', '', 'Estoy segura'); title.id = 'care-title'; headings.append(title);
  const refreshButton = btn('Actualizar', 'care-refresh', 'text-button'); heading.append(headings, refreshButton);
  const badge = el('p', 'care-simulation', 'Ensayo · avisos simulados'); badge.id = 'care-simulation';
  const intro = el('p', 'care-intro', 'Elige cuándo quieres confirmar que has llegado. Aquí puedes ensayar el recordatorio y ver qué aviso se prepararía para tus contactos de confianza.');
  const localNote = el('p', 'care-local-note', 'No se envía ningún mensaje ni se contacta con nadie. Este ensayo no pide ayuda ni ofrece respuesta de emergencia. Usa solo alias ficticios.');
  const status = el('p', 'care-status'); status.id = 'care-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const content = el('div', 'care-content'); content.hidden = true;

  const current = el('section', 'care-current'); current.id = 'care-current'; current.hidden = true;
  current.setAttribute('aria-labelledby', 'care-current-title');
  const currentTitle = el('h3'); currentTitle.id = 'care-current-title';
  const countdown = el('p', 'care-countdown'); countdown.id = 'care-countdown'; countdown.setAttribute('aria-label', 'Tiempo orientativo restante');
  // Do not announce a moving clock every second. Only state transitions use the live status.
  countdown.setAttribute('aria-live', 'off');
  const deadline = el('p', 'care-deadline'); deadline.id = 'care-deadline';
  const planRecipients = el('p', 'care-recipients'); planRecipients.id = 'care-recipients';
  const stateMessage = el('p', 'care-state-message'); stateMessage.id = 'care-state-message';
  const planActions = el('div', 'care-actions');
  const confirmButton = btn('Ya estoy aquí', 'care-confirm', 'primary');
  const cancelButton = btn('Cancelar check-in', 'care-cancel');
  planActions.append(confirmButton, cancelButton);
  current.append(currentTitle, countdown, deadline, planRecipients, stateMessage, planActions);

  const columns = el('div', 'care-columns');
  const setup = el('section', 'care-setup'); setup.setAttribute('aria-labelledby', 'care-setup-title');
  const setupTitle = el('h3', '', 'Preparar un check-in'); setupTitle.id = 'care-setup-title'; setup.append(setupTitle);
  const planForm = el('form', 'care-form'); planForm.id = 'care-plan-form';
  const duration = field(planForm, 'select', 'care-duration', '¿Cuándo confirmarás?');
  for (const [value, label] of [[15, 'En 15 segundos · prueba rápida'], [30, 'En 30 segundos'], [60, 'En 1 minuto'], [300, 'En 5 minutos']]) {
    const option = el('option', '', label); option.value = String(value); duration.append(option);
  }
  duration.value = '30';
  const recipientsField = el('fieldset', 'care-recipient-fieldset');
  recipientsField.append(el('legend', '', 'Contactos de confianza · elige hasta tres'));
  const recipientChoices = el('div', 'care-contact-choices'); recipientChoices.id = 'care-contact-choices';
  const noChoices = el('p', 'care-help', 'Primero añade un alias ficticio en Contactos.'); noChoices.id = 'care-no-contacts';
  recipientsField.append(recipientChoices, noChoices); planForm.append(recipientsField);
  const advanced = el('details', 'care-details'); advanced.append(el('summary', '', 'Ajustar mi check-in'));
  const label = field(advanced, 'input', 'care-label', 'Nombre para ti · opcional'); label.maxLength = 80; label.placeholder = 'Por ejemplo: vuelta a casa';
  const reminder = field(advanced, 'select', 'care-reminder', 'Recordarme antes de la hora');
  for (const [value, text] of [[5, '5 segundos antes'], [10, '10 segundos antes']]) {
    const option = el('option', '', text); option.value = String(value); reminder.append(option);
  }
  advanced.append(el('p', 'care-help', 'En este ensayo el recordatorio se muestra aquí. El reloj del servidor decide cuándo aparece.'));
  planForm.append(advanced);
  const start = btn('Activar prueba de check-in', 'care-start', 'primary'); start.type = 'submit';
  planForm.append(start, el('p', 'care-help', 'Al vencer sin confirmar, verás avisos simulados para los alias elegidos. No saldrán de este ordenador.'));
  setup.append(planForm);

  const contactsSection = el('section', 'care-contacts-card');
  contactsSection.setAttribute('aria-labelledby', 'care-contacts-title');
  const contactsTitle = el('h3', '', 'Contactos de confianza'); contactsTitle.id = 'care-contacts-title';
  const contactForm = el('form', 'care-form'); contactForm.id = 'care-contact-form';
  const alias = field(contactForm, 'input', 'care-contact-alias', 'Añadir un alias ficticio'); alias.maxLength = 60; alias.required = true; alias.autocomplete = 'off'; alias.placeholder = 'Por ejemplo: Compañera Luna';
  const addContact = btn('Añadir contacto', 'care-add-contact'); addContact.type = 'submit'; contactForm.append(addContact);
  const contactList = el('ul', 'care-contact-list'); contactList.id = 'care-contacts';
  const contactsEmpty = el('p', 'care-help', 'Tu lista empieza vacía. Tú decides a quién añadir.');
  contactsSection.append(contactsTitle, el('p', 'care-help', 'Lista privada de esta cuenta. No uses teléfonos ni correos reales.'), contactList, contactsEmpty, contactForm);
  columns.append(setup, contactsSection);

  const history = el('details', 'care-history care-details');
  history.append(el('summary', '', 'Actividad del ensayo'));
  const events = el('ol', 'care-events'); events.id = 'care-events';
  const historyEmpty = el('p', 'care-help', 'Todavía no hay actividad en esta cuenta.');
  history.append(events, historyEmpty);
  content.append(current, columns, history);
  panel.append(heading, badge, intro, localNote, status, content); main.append(panel);

  let actor = null, epoch = 0, readSequence = 0, destroyed = false, busy = false;
  let state = null, serverOffset = 0, planOperation = null, deleteChoice = null;
  let renderedContactsKey = null, stateRead = null;
  let pollTimer = null, clockTimer = null;
  const selected = new Set();
  const controllers = new Map();

  const say = (message, error = false) => { status.textContent = message; status.classList.toggle('care-error', error); };
  const validActor = (expected, expectedEpoch) => !destroyed && actor === expected && epoch === expectedEpoch && getSession()?.user?.id === expected;
  function sessionFor(expected) {
    const session = getSession();
    if (!expected || session?.user?.id !== expected || !session.access_token) throw new Error('CARE_SESSION_CHANGED');
    return session;
  }
  async function request(path, options = {}, expected = actor, read = false) {
    const session = sessionFor(expected);
    const controller = new AbortController(); controllers.set(controller, read);
    try {
      const response = await fetchImpl(`${API}${path}`, { ...options, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${session.access_token}`, apikey: session.apikey || '' } });
      if (!response.ok) { const error = new Error(readableError(response.status)); error.status = response.status; throw error; }
      return response.status === 204 ? {} : response.json();
    } finally { controllers.delete(controller); }
  }
  function setBusy(value) {
    busy = value;
    for (const control of panel.querySelectorAll('input,select,button')) control.disabled = value;
    if (!value) { start.disabled = !state || !selected.size || Boolean(state.active_plan) || state.scheduler_ok === false; addContact.disabled = !state || (state.contacts?.length || 0) >= 20; }
  }
  const formatDate = value => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit', day: 'numeric', month: 'short' }) : 'Hora no disponible';
  };
  function updateClock() {
    const plan = state?.active_plan;
    if (!plan) return;
    const remaining = Math.max(0, Math.ceil((Date.parse(plan.deadline_at) - (now() + serverOffset)) / 1000));
    countdown.textContent = remaining ? `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}` : 'Actualizando estado…';
    // Reaching zero is a display event. It never creates an alert or declares a plan overdue.
  }
  function currentPlan() { return state?.active_plan || state?.plans?.[0] || null; }
  function renderState() {
    const expected = actor, expectedEpoch = epoch;
    const contacts = state.contacts || [];
    for (const id of selected) if (!contacts.some(contact => contact.id === id)) selected.delete(id);
    const contactsKey = JSON.stringify([contacts.map(contact => [contact.id, contact.alias]), deleteChoice]);
    // Quiet polls must not replace a keyboard user's current checkbox or button.
    if (contactsKey !== renderedContactsKey) {
      recipientChoices.replaceChildren(); contactList.replaceChildren();
      for (const contact of contacts) {
        const choice = el('label', 'care-contact-choice');
        const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.value = contact.id; checkbox.checked = selected.has(contact.id); checkbox.dataset.contactId = contact.id;
        checkbox.addEventListener('change', () => {
          if (!validActor(expected, expectedEpoch)) return;
          if (checkbox.checked && !selected.has(contact.id) && selected.size >= 3) { checkbox.checked = false; say('Puedes elegir hasta tres contactos ficticios.', true); return; }
          if (checkbox.checked) selected.add(contact.id); else selected.delete(contact.id);
          planOperation = null; setBusy(busy);
        });
        choice.append(checkbox, el('span', '', contact.alias)); recipientChoices.append(choice);
        const item = el('li', 'care-contact-item'); item.append(el('span', 'care-contact-name', contact.alias));
        const remove = btn('Retirar', null, 'text-button'); remove.setAttribute('aria-label', `Retirar a ${contact.alias}`);
        remove.addEventListener('click', () => { if (validActor(expected, expectedEpoch) && !busy) { deleteChoice = contact.id; renderState(); } }); item.append(remove);
        if (deleteChoice === contact.id) {
          const confirmation = el('div', 'care-delete-confirm'); confirmation.append(el('p', 'care-help', '¿Retirar este alias de tu lista? Un check-in ya activado conserva los destinatarios que elegiste al crearlo.'));
          const confirmDelete = btn('Sí, retirar', null, 'secondary');
          confirmDelete.dataset.careDelete = contact.id;
          confirmDelete.addEventListener('click', () => {
            if (!validActor(expected, expectedEpoch)) return;
            void mutate(`/contacts/${encodeURIComponent(contact.id)}`, 'DELETE', null, () => { deleteChoice = null; selected.delete(contact.id); planOperation = null; }, 'Alias retirado de tu lista.');
          });
          const keep = btn('Conservar', null, 'text-button'); keep.addEventListener('click', () => { if (validActor(expected, expectedEpoch)) { deleteChoice = null; renderState(); } });
          confirmation.append(confirmDelete, keep); item.append(confirmation);
        }
        contactList.append(item);
      }
      renderedContactsKey = contactsKey;
    }
    noChoices.hidden = contacts.length > 0; contactsEmpty.hidden = contacts.length > 0;
    const plan = currentPlan(); current.hidden = !plan;
    planForm.hidden = Boolean(state.active_plan);
    setupTitle.textContent = state.active_plan ? 'Tu check-in está en marcha' : 'Preparar un check-in';
    if (plan) {
      current.dataset.state = plan.status;
      currentTitle.textContent = plan.label || 'Tu check-in';
      deadline.textContent = `Hora prevista: ${formatDate(plan.deadline_at)} · recordatorio: ${formatDate(plan.reminder_at)}`;
      planRecipients.textContent = `Alias elegidos: ${(plan.recipients || []).map(contact => contact.alias).join(', ') || 'Ninguno'}.`;
      const messages = {
        active: 'En marcha. Confirma antes de la hora prevista o cancela cuando quieras.',
        confirmed: `Llegada confirmada a las ${formatDate(plan.confirmed_at)}. No se prepara ningún aviso para este check-in.`,
        cancelled: 'Check-in cancelado. No se prepararán nuevos recordatorios ni avisos para él.',
        overdue: 'El plazo ha vencido. Los avisos que figuran en la actividad son simulados: nadie los ha recibido.'
      };
      stateMessage.textContent = messages[plan.status] || 'Actualizando estado del ensayo.';
      countdown.hidden = plan.status !== 'active'; planActions.hidden = plan.status !== 'active';
      updateClock();
    }
    events.replaceChildren();
    const eventNames = { created: 'Check-in activado', reminder: 'Recordatorio local', simulated_alert: 'Aviso simulado', confirmed: 'Llegada confirmada', cancelled: 'Check-in cancelado' };
    for (const event of [...(state.events || [])].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 30)) {
      const item = el('li', `care-event care-event-${event.kind}`);
      item.append(el('span', 'care-event-title', `${eventNames[event.kind] || 'Actividad'}${event.contact_alias ? ` · ${event.contact_alias}` : ''}`));
      const time = el('time', 'care-help', formatDate(event.created_at)); time.dateTime = event.created_at; item.append(time);
      if (event.kind === 'simulated_alert') item.append(el('p', 'care-help', 'Simulación registrada · no enviado.'));
      events.append(item);
    }
    historyEmpty.hidden = events.children.length > 0;
    content.hidden = false; setBusy(busy);
  }
  async function refresh({ quiet = false } = {}) {
    if (!actor || destroyed) return;
    if (stateRead) {
      stateRead.again = true;
      stateRead.nextQuiet = stateRead.nextQuiet && quiet;
      return stateRead.promise;
    }
    const expected = actor, expectedEpoch = epoch, sequence = ++readSequence;
    const reading = { again: false, nextQuiet: true, promise: null };
    stateRead = reading;
    reading.promise = (async () => {
      try {
        const payload = await request('/state', {}, expected, true);
        if (!validActor(expected, expectedEpoch) || sequence !== readSequence) return;
        if (!modes.has(payload.mode)) throw new Error('CARE_UNEXPECTED_MODE');
        const previousEvents = new Set((state?.events || []).map(event => event.id));
        const wasLoaded = Boolean(state);
        state = payload; serverOffset = Number.isFinite(Date.parse(payload.server_now)) ? Date.parse(payload.server_now) - now() : 0;
        renderState();
        const newEvent = wasLoaded && [...(state.events || [])].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).find(event => !previousEvents.has(event.id) && ['reminder', 'simulated_alert'].includes(event.kind));
        if (state.scheduler_ok === false) say('El planificador local necesita revisión. No actives otra prueba hasta que se restablezca; puedes confirmar o cancelar la actual.', true);
        else if (newEvent?.kind === 'simulated_alert') say('Plazo vencido: avisos simulados registrados. No se ha enviado ningún mensaje.');
        else if (newEvent?.kind === 'reminder') say('Recordatorio local: se acerca la hora de confirmar.');
        else if (!quiet) say('Tu check-in local está actualizado.');
        return true;
      } catch (error) {
        if (!validActor(expected, expectedEpoch) || sequence !== readSequence || error.name === 'AbortError') return;
        say(error.status ? error.message : 'No podemos actualizar el estado. No presupongas que se ha enviado un aviso; pulsa Actualizar para reintentar.', true);
        if (error.status === 401 || error.message === 'CARE_UNEXPECTED_MODE') { content.hidden = true; state = null; }
        return false;
      } finally {
        if (stateRead === reading) {
          stateRead = null;
          if (reading.again && validActor(expected, expectedEpoch) && !documentRef.hidden) void refresh({ quiet: reading.nextQuiet });
        }
      }
    })();
    return reading.promise;
  }
  function abandonReads() {
    ++readSequence; stateRead = null;
    for (const [controller, read] of controllers) if (read) controller.abort();
  }
  async function mutate(path, method, body, onSuccess, message) {
    if (!actor || busy) return;
    const expected = actor, expectedEpoch = epoch; abandonReads(); setBusy(true);
    try {
      await request(path, { method, ...(body === null ? {} : { body: JSON.stringify(body) }) }, expected);
      if (!validActor(expected, expectedEpoch)) return;
      onSuccess?.(); const refreshed = await refresh({ quiet: true });
      if (validActor(expected, expectedEpoch)) say(refreshed ? message : `${message} No podemos actualizar la vista; pulsa Actualizar.`, !refreshed);
    } catch (error) {
      if (validActor(expected, expectedEpoch) && error.name !== 'AbortError') {
        say(error.status ? error.message : readableError(), true);
        if (error.status === 409) await refresh({ quiet: true });
      }
    } finally { if (validActor(expected, expectedEpoch)) setBusy(false); }
  }
  function stopTimers() {
    if (pollTimer !== null) windowRef.clearInterval(pollTimer);
    if (clockTimer !== null) windowRef.clearInterval(clockTimer);
    pollTimer = clockTimer = null;
  }
  function startTimers() {
    stopTimers();
    if (!actor || documentRef.hidden || destroyed) return;
    pollTimer = windowRef.setInterval(() => { if (!busy) void refresh({ quiet: true }); }, pollMs);
    clockTimer = windowRef.setInterval(updateClock, 1000);
  }
  function reset() {
    ++epoch; ++readSequence; stopTimers();
    for (const controller of controllers.keys()) controller.abort(); controllers.clear();
    actor = null; state = null; busy = false; serverOffset = 0; planOperation = null; deleteChoice = null; selected.clear(); renderedContactsKey = null; stateRead = null;
    alias.value = label.value = ''; duration.value = '30'; reminder.value = '5'; advanced.open = history.open = false;
    contactList.replaceChildren(); recipientChoices.replaceChildren(); events.replaceChildren();
    currentTitle.textContent = countdown.textContent = deadline.textContent = planRecipients.textContent = stateMessage.textContent = '';
    current.hidden = true; content.hidden = true; panel.hidden = true; status.textContent = '';
  }
  function setSession(session) {
    const next = session?.user?.id && session?.access_token ? session.user.id : null;
    if (next && next === actor) return;
    reset();
    if (!next || destroyed) return;
    actor = next; panel.hidden = false; say('Abriendo tu espacio de check-in…');
    startTimers(); void refresh();
  }
  contactForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!alias.value.trim() || !state) return;
    void mutate('/contacts', 'POST', { alias: alias.value.trim() }, () => { alias.value = ''; }, 'Alias ficticio añadido. Ahora puedes elegirlo para tu check-in.');
  });
  planForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!state || state.active_plan || state.scheduler_ok === false || !selected.size || selected.size > 3) return;
    if (!planOperation) planOperation = uuid();
    void mutate('/plans', 'POST', { label: label.value.trim() || 'Mi check-in de prueba', duration_seconds: Number(duration.value), reminder_seconds: Number(reminder.value), contact_ids: [...selected], client_request_id: planOperation }, () => { planOperation = null; }, 'Check-in de prueba activado. Los posibles avisos serán simulados.');
  });
  for (const input of [label, duration, reminder]) input.addEventListener('input', () => { planOperation = null; });
  duration.addEventListener('change', () => { planOperation = null; }); reminder.addEventListener('change', () => { planOperation = null; });
  confirmButton.addEventListener('click', () => { const plan = state?.active_plan; if (plan) void mutate(`/plans/${encodeURIComponent(plan.id)}/confirm`, 'POST', {}, null, 'Llegada confirmada. Check-in finalizado.'); });
  cancelButton.addEventListener('click', () => { const plan = state?.active_plan; if (plan) void mutate(`/plans/${encodeURIComponent(plan.id)}/cancel`, 'POST', {}, null, 'Check-in cancelado.'); });
  refreshButton.addEventListener('click', () => { if (!busy) void refresh(); });
  const onSession = event => setSession(event.detail);
  const onVisibility = () => {
    if (documentRef.hidden) {
      stopTimers(); abandonReads();
    } else if (actor) { startTimers(); if (!busy) void refresh({ quiet: true }); }
  };
  windowRef.addEventListener('sx:session', onSession); documentRef.addEventListener('visibilitychange', onVisibility);
  setSession(getSession());
  return { panel, setSession, refresh, destroy() { destroyed = true; reset(); windowRef.removeEventListener('sx:session', onSession); documentRef.removeEventListener('visibilitychange', onVisibility); panel.remove(); } };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') mountCare();
