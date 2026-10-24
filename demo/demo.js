import { mountPlatform } from '../platform-v11.js';
import { mountStudio } from './studio.js';

/** Static demonstration only: no SDK, account, API, timer or durable user data. */
export function mountDemo({ documentRef = document, windowRef = window } = {}) {
  const d = documentRef, w = windowRef;
  const $ = id => d.getElementById(id);
  const cleanups = [], draft = new Map(), memory = new Map();
  const listen = (node, type, action) => { node.addEventListener(type, action); cleanups.push(() => node.removeEventListener(type, action)); };
  const el = (tag, cls, text) => { const node = d.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const button = (text, action, cls = 'secondary small') => { const node = el('button', cls, text); node.type = 'button'; listen(node, 'click', action); return node; };
  const storage = { getItem: key => memory.get(String(key)) ?? null, setItem: (key, value) => memory.set(String(key), String(value)), removeItem: key => memory.delete(String(key)), clear: () => memory.clear(), key: index => [...memory.keys()][index] ?? null, get length() { return memory.size; } };
  // The shared shell can keep its theme API without touching browser storage.
  const demoWindow = new Proxy(w, { get(target, key) {
    if (key === 'localStorage' || key === 'sessionStorage') return storage;
    if (key === '__sxCofreSession') return null;
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' && typeof key === 'string' && /^[a-z]/.test(key) ? value.bind(target) : value;
  } });
  const platform = mountPlatform({ documentRef: d, windowRef: demoWindow });
  if (!platform) throw new Error('The demo needs its original V1.1 shell and document.');
  d.title = 'SensualXcape · Demo interactiva';
  const badge = d.querySelector('.v11-sidebar-foot .v11-badge'); if (badge) badge.textContent = 'Demo · datos ficticios';
  const homeNote = d.querySelector('.v11-home .v11-footnote');
  if (homeNote) homeNote.textContent = 'Explora los servicios con ejemplos inventados. Esta demo no crea cuentas, envía mensajes, sube archivos ni avisa a nadie. Los cambios y borradores desaparecen al recargar.';
  for (const node of d.querySelectorAll('.v11-badge, .v11-quick-card small')) {
    if (['Ensayo local', 'Comunidad local', 'Archivos locales', 'Avisos simulados'].includes(node.textContent)) node.textContent = 'Demo interactiva';
  }
  for (const node of d.querySelectorAll('.v11-preview-note, .v11-service-intro, .v11-preview-card p')) {
    if (node.textContent.includes('bloqueos que sí afectan al chat local')) node.textContent = 'Los bloqueos de esta pantalla son ejemplos independientes. En Mensajes también puedes ensayar el bloqueo de un contacto ficticio.';
    if (node.textContent.includes('recorridos locales')) node.textContent = 'Contactos, comunidad, Cofre y check-in. Explora sus recorridos ficticios desde la navegación.';
  }
  const scope = d.querySelector('.v11-info-strip');
  if (scope) { const summary = scope.querySelector('summary'); scope.replaceChildren(summary, el('p', '', 'Demo estática con datos ficticios. Todo cambia solo en memoria de esta página y se borra al recargar. No hay cuenta, backend, pagos, notificaciones ni mensajes a otras personas.'), el('p', '', 'El selector conserva las tres atmósferas de V1.1. Su elección también se descarta al recargar. AuraLink permite una vista local voluntaria; las imágenes no se suben.')); }
  const access = d.querySelector('[data-v11-page="access"]');
  if (access) { access.replaceChildren(el('div', 'v11-page-intro')); const intro = access.firstElementChild;
    intro.append(el('span', 'v11-eyebrow', 'DEMO INTERACTIVA'), el('h2', '', 'Entra a explorar, sin cuenta'), el('p', '', 'Esta versión muestra recorridos con datos ficticios. No necesitas correo ni contraseña. No introduzcas información real; nada de esta demo se envía a otra persona.'), button('Explorar los servicios', () => platform.navigate('home'), 'primary'));
  }

  let contacts, active = null;
  const histories = new Map();
  const initialContacts = () => [{ id: 'marina', name: 'Marina · ejemplo', status: 'accepted', blocked: false }, { id: 'lua', name: 'Lúa · ejemplo', status: 'pending', blocked: false }];
  function resetContacts() {
    contacts = initialContacts(); histories.clear(); draft.clear();
    histories.set('marina', [{ mine: false, body: '¿Compartimos ideas para organizar la semana?' }, { mine: true, body: 'Sí, cada una a su ritmo. Me viene bien tenerlo todo a mano.' }, { mine: false, body: 'Este es un ejemplo de conversación. Aquí tú eliges con quién hablar.' }]);
    active = null; $('active-chat').hidden = true; $('chat-panel').setAttribute('data-conversation-open', 'false');
    $('body').value = ''; $('demo-contacts-status').textContent = 'Ejemplos listos. No existe ninguna cuenta detrás de estos nombres.'; renderContacts();
  }
  function renderContacts() {
    $('contacts-list').replaceChildren();
    for (const contact of contacts) {
      const card = el('li', 'contact-card'), actions = el('div', 'contact-actions');
      card.append(el('h4', '', contact.name), el('p', 'contact-state', contact.blocked ? 'Bloqueado en esta demo' : { pending: 'Solicitud ficticia por decidir', accepted: 'Conversación de muestra aceptada', rejected: 'Solicitud rechazada en esta demo' }[contact.status]));
      if (contact.status === 'pending' && !contact.blocked) {
        actions.append(button('Aceptar ejemplo', () => { contact.status = 'accepted'; histories.set(contact.id, [{ mine: false, body: 'Has aceptado esta solicitud ficticia. Ahora puedes probar la conversación.' }]); renderContacts(); openConversation(contact); }, 'primary small'), button('Rechazar ejemplo', () => { contact.status = 'rejected'; $('demo-contacts-status').textContent = 'Solicitud ficticia rechazada. No se ha abierto una conversación.'; renderContacts(); }));
      }
      if (contact.status === 'accepted') actions.append(button(contact.blocked ? 'Ver historial' : 'Abrir conversación', () => openConversation(contact), contact.blocked ? 'secondary small' : 'primary small'));
      actions.append(button(contact.blocked ? 'Desbloquear ejemplo' : 'Bloquear ejemplo', () => { contact.blocked = !contact.blocked; renderContacts(); if (active === contact) syncConversation(); }));
      card.append(actions); $('contacts-list').append(card);
    }
  }
  function syncConversation() {
    $('active-contact-title').textContent = active.name;
    $('active-block').textContent = active.blocked ? 'Desbloquear ejemplo' : 'Bloquear ejemplo';
    $('active-contact-status').textContent = active.blocked ? 'Bloqueo de muestra activo. Puedes leer el historial; añadir mensajes está desactivado.' : 'Conversación ficticia. Nada de lo que escribas aquí se envía.';
    $('body').disabled = active.blocked; $('send-form').querySelector('button').disabled = active.blocked;
  }
  function renderMessages() {
    const list = $('messages'); list.replaceChildren();
    for (const entry of histories.get(active.id) || []) { const item = el('li', `msg${entry.mine ? ' mine' : ''}`); item.append(el('span', 'who', entry.mine ? 'Tú · ejemplo' : active.name), el('p', 'body', entry.body)); list.append(item); }
    list.scrollTop = list.scrollHeight;
  }
  function openConversation(contact) {
    if (active) draft.set(active.id, $('body').value);
    active = contact; $('body').value = draft.get(contact.id) || '';
    $('active-chat').hidden = false; $('chat-panel').setAttribute('data-conversation-open', 'true');
    syncConversation(); renderMessages(); $('active-contact-title').focus({ preventScroll: true }); $('active-chat').scrollIntoView?.({ block: 'start', behavior: 'instant' });
  }
  listen($('demo-reset-contacts'), 'click', resetContacts);
  listen($('leave-room'), 'click', () => { if (active) draft.set(active.id, $('body').value); active = null; $('active-chat').hidden = true; $('chat-panel').setAttribute('data-conversation-open', 'false'); $('contacts-title').focus({ preventScroll: true }); $('contacts-title').scrollIntoView?.({ block: 'start', behavior: 'instant' }); });
  listen($('active-block'), 'click', () => { if (!active) return; active.blocked = !active.blocked; syncConversation(); renderContacts(); });
  listen($('body'), 'input', () => { if (active) draft.set(active.id, $('body').value); });
  listen($('send-form'), 'submit', event => { event.preventDefault(); const text = $('body').value.trim(); if (!active || active.blocked || !text) return; histories.get(active.id).push({ mine: true, body: text.slice(0, 2000) }); $('body').value = ''; draft.set(active.id, ''); renderMessages(); $('send-status').textContent = 'Ejemplo añadido solo a esta página. No se ha enviado ni entregado a nadie.'; $('body').focus(); });
  resetContacts();

  let fileSequence = 2, previewTrigger = null;
  const files = [{ id: 1, name: 'Ideas de muestra.txt', content: 'Este archivo es ficticio.\n\nUna lista de ideas que tú eliges organizar en tu espacio.' }, { id: 2, name: 'Guía de ejemplo.txt', content: 'Cofre de demostración.\n\nNo hay un archivo subido, una nube conectada ni contenido personal almacenado.' }];
  function renderFiles() {
    $('demo-files').replaceChildren();
    if (!files.length) $('demo-files').append(el('li', 'v11-preview-note', 'No quedan ejemplos. Puedes añadir otro archivo ficticio.'));
    for (const file of files) {
      const row = el('li'), actions = el('div', 'demo-file-actions'); row.append(el('strong', '', file.name));
      const view = button('Ver muestra', () => { previewTrigger = view; $('demo-file-title').textContent = file.name; $('demo-file-content').textContent = file.content; $('demo-file-preview').hidden = false; $('demo-file-title').focus(); });
      const remove = button('Retirar ejemplo', () => { files.splice(files.indexOf(file), 1); $('demo-file-preview').hidden = true; $('demo-file-status').textContent = 'Ejemplo retirado de esta página. No se ha borrado ningún archivo real.'; renderFiles(); });
      actions.append(view, remove); row.append(actions); $('demo-files').append(row);
    }
  }
  listen($('demo-add-file'), 'click', () => { const id = ++fileSequence; files.push({ id, name: `Nota ficticia ${id}.txt`, content: 'Archivo de ejemplo creado en memoria. Desaparece al recargar la página.' }); renderFiles(); $('demo-file-status').textContent = 'Archivo ficticio añadido. No se ha seleccionado ni subido ningún archivo de tu dispositivo.'; });
  listen($('demo-close-file'), 'click', () => { $('demo-file-preview').hidden = true; if (previewTrigger?.isConnected) previewTrigger.focus(); }); renderFiles();

  const topics = [{ title: 'Organizarnos sin prisas', body: '¿Qué os ayuda a tener las tareas de la semana claras?', replies: ['A mí me sirve apuntar solo tres cosas importantes cada día.'] }, { title: 'Un espacio para compartir ideas', body: 'Este tema ficticio muestra cómo leer y responder entre compañeras.', replies: ['Cada una decide qué contar y cuándo participar.'] }];
  let selectedTopic = null, topicTrigger = null;
  function renderTopics() {
    const query = $('demo-topic-search').value.trim().toLocaleLowerCase('es'); $('demo-topics').replaceChildren();
    const visible = topics.filter(topic => `${topic.title} ${topic.body}`.toLocaleLowerCase('es').includes(query));
    for (const topic of visible) { const card = button('', () => { selectedTopic = topic; topicTrigger = card; $('demo-topics-view').hidden = true; $('demo-topic-view').hidden = false; $('demo-topic-title').textContent = topic.title; renderPosts(); $('demo-topic-title').focus(); }, 'fc-topic-card'); card.append(el('h3', '', topic.title), el('p', '', topic.body), el('span', 'v11-badge', `${topic.replies.length} respuesta de ejemplo`)); $('demo-topics').append(card); }
    if (!visible.length) $('demo-topics').append(el('p', 'v11-preview-note', 'No hay temas de muestra con esa búsqueda.'));
  }
  function renderPosts() { $('demo-topic-posts').replaceChildren(); for (const [index, text] of [selectedTopic.body, ...selectedTopic.replies].entries()) { const post = el('article', 'fc-post'); post.append(el('strong', '', index === 0 ? 'Autora de ejemplo' : 'Respuesta ficticia'), el('p', 'fc-body', text)); $('demo-topic-posts').append(post); } }
  listen($('demo-topic-search'), 'input', renderTopics);
  listen($('demo-back-topics'), 'click', () => { $('demo-topic-view').hidden = true; $('demo-topics-view').hidden = false; $('demo-reply').value = ''; if (topicTrigger?.isConnected) topicTrigger.focus(); });
  listen($('demo-reply-form'), 'submit', event => { event.preventDefault(); const text = $('demo-reply').value.trim(); if (!selectedTopic || !text) return; selectedTopic.replies.push(text.slice(0, 2000)); $('demo-reply').value = ''; renderPosts(); $('demo-community-status').textContent = 'Respuesta añadida solo a esta demo. No se ha publicado en una comunidad.'; }); renderTopics();

  let checkinActive = false;
  const checkinControls = () => { for (const id of ['demo-checkin-confirm', 'demo-checkin-expire', 'demo-checkin-cancel']) $(id).hidden = !checkinActive; $('demo-checkin-start').disabled = checkinActive; };
  listen($('demo-checkin-form'), 'submit', event => { event.preventDefault(); if (checkinActive) return; checkinActive = true; $('demo-checkin-state').textContent = `Ensayo activo: plazo ficticio de ${$('demo-checkin-duration').value} minutos. El tiempo no avanza; puedes simular el final manualmente. No se enviará ningún aviso.`; checkinControls(); });
  listen($('demo-checkin-confirm'), 'click', () => { checkinActive = false; $('demo-checkin-state').textContent = 'Confirmación ficticia: estoy bien. Ensayo finalizado. Nadie ha recibido un aviso.'; checkinControls(); });
  listen($('demo-checkin-expire'), 'click', () => { if (!checkinActive) return; $('demo-checkin-state').textContent = 'Fin del plazo simulado. Aquí se mostraría un aviso pendiente; esta demo no envía nada ni solicita ayuda.'; $('demo-checkin-expire').hidden = true; });
  listen($('demo-checkin-cancel'), 'click', () => { checkinActive = false; $('demo-checkin-state').textContent = 'Ensayo cancelado. No se ha comunicado con nadie.'; checkinControls(); });

  return { platform, destroy() { platform.destroy(); cleanups.splice(0).forEach(clean => clean()); memory.clear(); draft.clear(); histories.clear(); } };
}

export function bootStudio({ documentRef = document, windowRef = window } = {}) {
  const demo = mountDemo({ documentRef, windowRef });
  const studio = mountStudio({ platform: demo.platform, documentRef, windowRef });
  return { ...demo, studio, destroy() { studio?.destroy(); demo.destroy(); } };
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => bootStudio(), { once: true });
  else bootStudio();
}
