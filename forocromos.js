import MarkdownIt from 'markdown-it';
import createDOMPurify from 'dompurify';

// Reuse the maintained Markdown parser and sanitizer, with a deliberately small
// presentation surface: no HTML, media, embeds, automatic links or previews.
export function createMarkdownRenderer(windowRef) {
  const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: true }).disable('image');
  const purifier = createDOMPurify(windowRef);
  return source => {
    const fragment = purifier.sanitize(markdown.render(String(source || '')), {
      ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 's', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'a', 'hr'],
      ALLOWED_ATTR: ['href', 'title'], RETURN_DOM_FRAGMENT: true
    });
    for (const link of fragment.querySelectorAll('a')) {
      let allowed = false;
      try {
        const href = link.getAttribute('href') || '';
        const url = new URL(href);
        allowed = /^https?:$/u.test(url.protocol) && !url.username && !url.password;
      } catch { /* Relative and malformed links remain readable as plain text. */ }
      if (!allowed) {
        link.replaceWith(...link.childNodes);
        continue;
      }
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
      link.setAttribute('referrerpolicy', 'no-referrer');
    }
    return fragment;
  };
}

const api = '/forocromos/v1';
const PAGE_SIZE = 20;
const REPLY_PAGE_SIZE = 50;

function failure(status) {
  if (status === 401) return 'Tu sesión ha terminado. Vuelve a entrar para abrir Forocromos.';
  if (status === 403) return 'Esta cuenta no tiene acceso a este espacio de compañeras.';
  if (status === 404) return 'Esa publicación ya no está disponible. Vuelve a los temas para actualizar.';
  if (status === 409) return 'La publicación ha cambiado o el tema está cerrado. Actualiza antes de continuar; tu borrador se conserva.';
  if (status === 400 || status === 413 || status === 422) return 'Revisa los campos y sus límites. Tu borrador se conserva.';
  if (status === 429 || status === 507) return 'Hemos alcanzado el límite de este ensayo. Inténtalo después; tu borrador se conserva.';
  return 'No hemos podido completar la operación. Puedes reintentar; tu borrador se conserva.';
}

export function mountForocromos({
  getSession = () => window.__sxCofreSession,
  documentRef = document,
  windowRef = window,
  fetchImpl = (...args) => windowRef.fetch(...args),
  uuid = () => windowRef.crypto.randomUUID()
} = {}) {
  const main = documentRef.querySelector('main');
  if (!main || documentRef.getElementById('forocromos-panel')) return null;
  const markdown = createMarkdownRenderer(windowRef);
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
  const field = (form, tag, id, text, maxLength) => {
    const label = element('label', '', text);
    label.htmlFor = id;
    const input = element(tag);
    input.id = id;
    if (maxLength) input.maxLength = maxLength;
    form.append(label, input);
    return input;
  };
  const panel = element('section', 'panel fc-panel');
  panel.id = 'forocromos-panel';
  panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'forocromos-title');
  const heading = element('div', 'section-heading');
  const headingText = element('div');
  headingText.append(element('span', 'eyebrow', 'ENTRE COMPAÑERAS'));
  const title = element('h2', '', 'Forocromos');
  title.id = 'forocromos-title';
  headingText.append(title);
  const refreshButton = button('Actualizar comunidad', 'text-button');
  refreshButton.id = 'fc-refresh';
  heading.append(headingText, refreshButton);
  const intro = element('p', 'fc-intro', 'Un espacio privado para compartir experiencias, hacer preguntas y ayudarse entre compañeras. Tú decides qué publicar.');
  const easyHelp = element('p', 'fc-easy-help', '1. Elige un tema o pulsa Nuevo tema. 2. Lee y responde cuando quieras. 3. Puedes retirar tus publicaciones o avisar a moderación.');
  const status = element('p', 'fc-status help');
  status.id = 'fc-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const identity = element('p', 'help fc-identity');
  identity.id = 'fc-identity';
  const space = element('div', 'fc-space');
  space.hidden = true;
  const toolbar = element('div', 'fc-toolbar');
  const allTopics = button('Temas', 'secondary');
  allTopics.id = 'fc-topics-button';
  const newTopic = button('Nuevo tema', 'primary');
  newTopic.id = 'fc-new-topic';
  const moderationButton = button('Moderación', 'secondary');
  moderationButton.id = 'fc-moderation-button';
  moderationButton.hidden = true;
  toolbar.append(allTopics, newTopic, moderationButton);

  const listView = element('div', 'fc-list-view');
  const searchForm = element('form', 'fc-search');
  searchForm.id = 'fc-search-form';
  const categoryFilter = field(searchForm, 'select', 'fc-category', 'Categoría');
  const searchInput = field(searchForm, 'input', 'fc-search', 'Buscar en los temas', 100);
  searchInput.type = 'search';
  const searchButton = button('Buscar', 'secondary');
  searchButton.type = 'submit';
  searchForm.append(searchButton);
  const list = element('ul', 'fc-topics');
  list.id = 'fc-topics';
  list.setAttribute('aria-label', 'Temas de la comunidad');
  const emptyList = element('p', 'help fc-empty', 'Todavía no hay temas aquí. Puedes empezar una conversación.');
  emptyList.hidden = true;
  const moreTopics = button('Ver más temas', 'secondary');
  moreTopics.id = 'fc-more-topics';
  moreTopics.hidden = true;
  listView.append(searchForm, list, emptyList, moreTopics);

  const composeView = element('div', 'fc-compose-view');
  composeView.hidden = true;
  composeView.append(element('h3', '', 'Empezar una conversación'));
  const composeForm = element('form', 'fc-form');
  composeForm.id = 'fc-topic-form';
  const composeCategory = field(composeForm, 'select', 'fc-topic-category', 'Dónde publicarlo');
  composeCategory.required = true;
  const composeTitle = field(composeForm, 'input', 'fc-topic-title', 'Título · hasta 120 caracteres', 120);
  composeTitle.required = true;
  const composeBody = field(composeForm, 'textarea', 'fc-topic-body', 'Tu publicación · hasta 5.000 caracteres', 5000);
  composeBody.required = true;
  composeBody.rows = 7;
  composeForm.append(element('p', 'help', 'Puedes usar texto, listas, **negrita** y enlaces escritos como [nombre](https://…). Sin imágenes ni vistas previas.'));
  const publishTopic = button('Publicar tema', 'primary');
  publishTopic.type = 'submit';
  publishTopic.id = 'fc-publish-topic';
  const leaveCompose = button('Volver a los temas', 'text-button');
  composeForm.append(publishTopic, leaveCompose);
  composeView.append(composeForm);

  const threadView = element('div', 'fc-thread-view');
  threadView.hidden = true;
  const threadContent = element('div');
  threadContent.id = 'fc-thread';
  const repliesTitle = element('h3', 'fc-replies-heading', 'Respuestas');
  const replies = element('ol', 'fc-replies');
  replies.id = 'fc-replies';
  replies.setAttribute('aria-label', 'Respuestas del tema');
  const moreReplies = button('Ver más respuestas', 'secondary');
  moreReplies.id = 'fc-more-replies';
  moreReplies.hidden = true;
  const replyForm = element('form', 'fc-form');
  replyForm.id = 'fc-reply-form';
  const replyBody = field(replyForm, 'textarea', 'fc-reply-body', 'Tu respuesta · hasta 3.000 caracteres', 3000);
  replyBody.required = true;
  replyBody.rows = 5;
  const publishReply = button('Publicar respuesta', 'primary');
  publishReply.type = 'submit';
  publishReply.id = 'fc-publish-reply';
  replyForm.append(publishReply);
  const threadNotice = element('p', 'help fc-thread-notice');
  threadNotice.id = 'fc-thread-notice';
  threadView.append(threadContent, repliesTitle, replies, moreReplies, threadNotice, replyForm);

  const moderationView = element('div', 'fc-moderation-view');
  moderationView.hidden = true;
  moderationView.append(element('h3', '', 'Avisos pendientes de revisión'), element('p', 'help', 'Estos avisos son confidenciales. Revisa la publicación y el motivo antes de decidir.'));
  const reportList = element('ul', 'fc-reports');
  reportList.id = 'fc-reports';
  reportList.setAttribute('aria-label', 'Avisos para moderación');
  const emptyReports = element('p', 'help fc-empty', 'No hay avisos pendientes.');
  emptyReports.hidden = true;
  const moreReports = button('Ver más avisos', 'secondary');
  moreReports.id = 'fc-more-reports';
  moreReports.hidden = true;
  moderationView.append(reportList, emptyReports, moreReports);
  space.append(identity, toolbar, listView, composeView, threadView, moderationView);
  const localNote = element('p', 'help fc-local-note', 'Ensayo local con cuentas y contenidos ficticios. Los temas y las respuestas se guardan en este equipo. Los contactos externos no acceden a la comunidad.');
  panel.append(heading, intro, easyHelp, status, space, localNote);
  main.append(panel);

  let actor = null;
  let member = null;
  let generation = 0;
  let listSequence = 0;
  let threadSequence = 0;
  let reportsSequence = 0;
  let destroyed = false;
  let view = 'topics';
  let currentTopic = null;
  let topicsOffset = 0;
  let repliesOffset = 0;
  let reportsOffset = 0;
  let topicDraft = { title: '', body: '', category: '', requestId: null };
  const replyDrafts = new Map();
  const reportDrafts = new Map();
  const pendingRequests = new Set();
  const pendingMutations = new Set();

  function say(text, error = false) {
    status.textContent = text;
    status.classList.toggle('fc-error', error);
  }
  function isCurrent(expectedActor, epoch) {
    return !destroyed && actor === expectedActor && generation === epoch && getSession()?.user?.id === expectedActor;
  }
  function currentSession(expectedActor) {
    const session = getSession();
    if (!expectedActor || session?.user?.id !== expectedActor || !session.access_token) throw new Error('FOROCROMOS_SESSION_CHANGED');
    return session;
  }
  async function request(path, options = {}, expectedActor = actor) {
    const session = currentSession(expectedActor);
    const controller = new AbortController();
    pendingRequests.add(controller);
    try {
      const response = await fetchImpl(`${api}${path}`, {
        ...options, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers, Authorization: `Bearer ${session.access_token}`, apikey: session.apikey || '' }
      });
      if (!response.ok) {
        const error = new Error(failure(response.status));
        error.status = response.status;
        throw error;
      }
      return response.status === 204 ? {} : response.json();
    } finally { pendingRequests.delete(controller); }
  }
  function reset() {
    generation++;
    actor = null;
    member = null;
    currentTopic = null;
    topicsOffset = repliesOffset = reportsOffset = 0;
    listSequence++; threadSequence++; reportsSequence++;
    for (const controller of pendingRequests) controller.abort();
    pendingRequests.clear();
    pendingMutations.clear();
    replyDrafts.clear();
    reportDrafts.clear();
    topicDraft = { title: '', body: '', category: '', requestId: null };
    panel.hidden = true;
    space.hidden = true;
    identity.textContent = '';
    list.replaceChildren();
    threadContent.replaceChildren();
    replies.replaceChildren();
    reportList.replaceChildren();
    composeTitle.value = composeBody.value = replyBody.value = searchInput.value = '';
    categoryFilter.replaceChildren(); composeCategory.replaceChildren();
    moreTopics.hidden = moreReplies.hidden = moreReports.hidden = emptyList.hidden = emptyReports.hidden = true;
    moderationButton.hidden = true;
    refreshButton.disabled = false;
    for (const control of composeForm.elements) control.disabled = false;
    for (const control of replyForm.elements) control.disabled = false;
    say('');
    showView('topics');
  }
  function denied(error) {
    // Revoke every request and handler created under the former membership,
    // including requests for the same account that raced the denied response.
    // Refresh can ask /me again, but a stale success cannot reopen the space.
    const formerActor = actor;
    reset();
    actor = formerActor;
    panel.hidden = false;
    say(error.message || failure(error.status), true);
  }
  function showView(next) {
    view = next;
    listView.hidden = next !== 'topics';
    composeView.hidden = next !== 'compose';
    threadView.hidden = next !== 'thread';
    moderationView.hidden = next !== 'moderation';
    allTopics.setAttribute('aria-pressed', String(next === 'topics' || next === 'thread'));
    newTopic.setAttribute('aria-pressed', String(next === 'compose'));
    moderationButton.setAttribute('aria-pressed', String(next === 'moderation'));
  }
  function dateText(value) {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });
  }
  function meta(post) {
    return [post.author?.alias || 'Publicación retirada', dateText(post.created_at)].filter(Boolean).join(' · ');
  }
  function makeBody(value) {
    const body = element('div', 'fc-body');
    body.append(markdown(value));
    return body;
  }
  function renderTopicCard(topic) {
    const expectedActor = actor;
    const epoch = generation;
    const item = element('li', 'fc-topic-card');
    item.dataset.topicId = topic.id;
    const open = button(topic.title || 'Tema', 'fc-topic-open');
    open.addEventListener('click', () => { if (isCurrent(expectedActor, epoch)) void openTopic(topic.id); });
    const labels = [meta(topic), `${Number(topic.reply_count) || 0} respuestas`, topic.locked ? 'Cerrado a respuestas' : ''].filter(Boolean).join(' · ');
    item.append(open, element('p', 'help fc-meta', labels));
    if (topic.snippet && !topic.withdrawn) item.append(element('p', 'fc-snippet', topic.snippet));
    return item;
  }
  function queryTopics(offset) {
    const query = new URLSearchParams({ offset: String(offset), limit: String(PAGE_SIZE) });
    if (categoryFilter.value) query.set('category', categoryFilter.value);
    if (searchInput.value.trim()) query.set('q', searchInput.value.trim());
    return `?${query}`;
  }
  async function loadTopics(append = false) {
    if (!member) return;
    const expectedActor = actor;
    const epoch = generation;
    const sequence = ++listSequence;
    const offset = append ? topicsOffset : 0;
    searchButton.disabled = true; moreTopics.disabled = true;
    list.setAttribute('aria-busy', 'true');
    try {
      const payload = await request(`/topics${queryTopics(offset)}`, {}, expectedActor);
      if (!isCurrent(expectedActor, epoch) || sequence !== listSequence) return;
      if (!Array.isArray(payload.topics)) throw new Error('Invalid topic list');
      if (!append) list.replaceChildren();
      const existing = new Set([...list.children].map(item => item.dataset.topicId));
      for (const topic of payload.topics) if (!existing.has(topic.id)) list.append(renderTopicCard(topic));
      topicsOffset = offset + payload.topics.length;
      moreTopics.hidden = !payload.has_more;
      emptyList.hidden = list.children.length !== 0;
      if (view === 'topics') say('Comunidad actualizada.');
    } catch (error) {
      if (!isCurrent(expectedActor, epoch) || sequence !== listSequence || error.name === 'AbortError') return;
      if (error.status === 401 || error.status === 403) denied(error);
      else say(error.status ? error.message : 'No hemos podido cargar los temas. Pulsa Actualizar comunidad para reintentar.', true);
    } finally {
      if (isCurrent(expectedActor, epoch) && sequence === listSequence) {
        searchButton.disabled = false; moreTopics.disabled = false; list.removeAttribute('aria-busy');
      }
    }
  }
  function confirmation(container, text, confirmText, onConfirm) {
    const expectedActor = actor;
    const epoch = generation;
    // An inline, keyboard-accessible decision avoids browser-only confirm dialogs.
    const box = element('div', 'fc-confirm');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', text);
    box.append(element('p', '', text));
    const yes = button(confirmText, 'secondary');
    const no = button('Cancelar', 'text-button');
    box.append(yes, no);
    container.append(box);
    yes.focus();
    no.addEventListener('click', () => { box.remove(); });
    yes.addEventListener('click', () => { if (isCurrent(expectedActor, epoch)) void onConfirm(box, yes, no); });
    return box;
  }
  async function mutate(key, controls, operation, success) {
    if (!member || pendingMutations.has(key)) return;
    const expectedActor = actor;
    const epoch = generation;
    pendingMutations.add(key);
    for (const control of controls) control.disabled = true;
    try {
      currentSession(expectedActor);
      const payload = await operation(expectedActor);
      if (!isCurrent(expectedActor, epoch)) return;
      await success(payload, () => isCurrent(expectedActor, epoch));
    } catch (error) {
      if (isCurrent(expectedActor, epoch) && error.name !== 'AbortError') {
        if (error.status === 401 || error.status === 403) denied(error);
        else say(error.status ? error.message : failure(0), true);
      }
    } finally {
      // Do not let a late operation from a former actor enable current controls.
      if (isCurrent(expectedActor, epoch)) {
        pendingMutations.delete(key);
        for (const control of controls) control.disabled = false;
      }
    }
  }
  function reportAction(container, topicId, replyId) {
    const expectedActor = actor;
    const epoch = generation;
    const draftKey = replyId || topicId;
    const report = button('Avisar a moderación', 'text-button');
    report.addEventListener('click', () => {
      if (!isCurrent(expectedActor, epoch)) return;
      if (container.querySelector('.fc-report-form')) return;
      const form = element('form', 'fc-form fc-report-form');
      const reasonId = `fc-reason-${replyId || topicId}`;
      const reason = field(form, 'textarea', reasonId, 'Motivo del aviso · solo lo verá moderación', 1000);
      reason.required = true; reason.rows = 3;
      reason.value = reportDrafts.get(draftKey) || '';
      reason.addEventListener('input', () => { if (isCurrent(expectedActor, epoch)) reportDrafts.set(draftKey, reason.value); });
      const send = button('Revisar aviso', 'secondary');
      send.type = 'submit';
      const cancel = button('Cancelar aviso', 'text-button');
      form.append(element('p', 'help', 'Este aviso no se publicará en el tema. No es un servicio de emergencias.'), send, cancel);
      container.append(form);
      reason.focus();
      cancel.addEventListener('click', () => { form.remove(); report.focus(); });
      form.addEventListener('submit', event => {
        event.preventDefault();
        if (!isCurrent(expectedActor, epoch) || !reason.value.trim() || form.querySelector('.fc-confirm')) return;
        const snapshot = reason.value.trim();
        reason.disabled = true; send.disabled = true;
        const box = confirmation(form, '¿Enviar este aviso confidencial a moderación?', 'Sí, enviar aviso', async (_box, yes, no) => {
          await mutate(`report-${replyId || topicId}`, [yes, no, cancel], expected => request('/reports', {
            method: 'POST', body: JSON.stringify({ topic_id: topicId, reply_id: replyId || null, reason: snapshot })
          }, expected), () => { reportDrafts.delete(draftKey); form.remove(); say('Aviso enviado a moderación. No se ha publicado en el tema.'); report.focus(); });
        });
        box.querySelector('.text-button').addEventListener('click', () => { reason.disabled = false; send.disabled = false; reason.focus(); });
      });
    });
    return report;
  }
  function withdrawAction(container, post, topicId, kind) {
    const expectedActor = actor;
    const epoch = generation;
    const withdraw = button('Retirar mi publicación', 'text-button fc-withdraw');
    withdraw.addEventListener('click', () => {
      if (!isCurrent(expectedActor, epoch)) return;
      if (container.querySelector('.fc-withdraw-confirm')) return;
      const box = confirmation(container, '¿Retirar tu publicación? Su texto dejará de mostrarse. Las respuestas de otras compañeras se conservarán.', 'Sí, retirar publicación', async (_box, yes, no) => {
        await mutate(`withdraw-${post.id}`, [yes, no, withdraw], expected => request(`/${kind === 'topic' ? 'topics' : 'replies'}/${encodeURIComponent(post.id)}`, { method: 'DELETE' }, expected), async () => {
          ++listSequence; ++threadSequence;
          say('Tu publicación se ha retirado.');
          if (currentTopic === topicId && view === 'thread') await openTopic(topicId, { preserveStatus: true });
        });
      });
      box.classList.add('fc-withdraw-confirm');
    });
    return withdraw;
  }
  function moderatorTopicActions(container, topic) {
    if (member?.role !== 'moderator') return;
    const expectedActor = actor;
    const epoch = generation;
    for (const action of [topic.locked ? 'unlock' : 'lock', 'hide']) {
      const trigger = button(action === 'hide' ? 'Ocultar tema' : action === 'lock' ? 'Cerrar respuestas' : 'Reabrir respuestas', 'text-button');
      trigger.addEventListener('click', () => {
        if (!isCurrent(expectedActor, epoch)) return;
        if (container.querySelector('.fc-moderation-confirm')) return;
        const message = action === 'hide' ? '¿Ocultar este tema a la comunidad?' : action === 'lock' ? '¿Cerrar este tema a nuevas respuestas?' : '¿Reabrir este tema para recibir respuestas?';
        const box = confirmation(container, message, 'Sí, confirmar decisión', async (_box, yes, no) => {
          await mutate(`moderate-${topic.id}`, [yes, no, trigger], expected => request(`/topics/${encodeURIComponent(topic.id)}/moderation`, { method: 'POST', body: JSON.stringify({ action }) }, expected), async (_payload, stillCurrent) => {
            ++listSequence; ++threadSequence;
            if (action === 'hide') { showView('topics'); currentTopic = null; threadContent.replaceChildren(); replies.replaceChildren(); await loadTopics(); if (stillCurrent()) say('Tema ocultado a la comunidad.'); }
            else { await openTopic(topic.id, { preserveStatus: true }); if (stillCurrent()) say(action === 'lock' ? 'Tema cerrado a nuevas respuestas.' : 'Tema abierto a respuestas.'); }
          });
        });
        box.classList.add('fc-moderation-confirm');
      });
      container.append(trigger);
    }
  }
  function renderPost(post, topicId, kind) {
    const card = element(kind === 'topic' ? 'article' : 'li', 'fc-post');
    card.dataset.postId = post.id;
    if (kind === 'topic') card.append(element('h3', 'fc-thread-title', post.title || 'Tema'));
    card.append(element('p', 'help fc-meta', meta(post)));
    if (post.withdrawn) card.append(element('p', 'fc-tombstone', 'Retirado por su autora.'));
    else {
      card.append(makeBody(post.body));
      const actions = element('div', 'fc-post-actions');
      if (post.author?.id === member?.id) actions.append(withdrawAction(card, post, topicId, kind));
      else actions.append(reportAction(card, topicId, kind === 'reply' ? post.id : null));
      if (kind === 'topic') moderatorTopicActions(actions, post);
      card.append(actions);
    }
    return card;
  }
  function restoreReplyDraft(topicId) {
    replyBody.value = replyDrafts.get(topicId)?.body || '';
    publishReply.disabled = pendingMutations.has(`reply-${topicId}`);
  }
  async function openTopic(topicId, { append = false, preserveStatus = false } = {}) {
    if (!member) return;
    const expectedActor = actor;
    const epoch = generation;
    const sequence = ++threadSequence;
    const offset = append && currentTopic === topicId ? repliesOffset : 0;
    if (currentTopic !== topicId || !append) {
      currentTopic = topicId;
      threadContent.replaceChildren(); replies.replaceChildren(); moreReplies.hidden = true;
      replyForm.hidden = true; threadNotice.textContent = '';
    }
    showView('thread');
    restoreReplyDraft(topicId);
    moreReplies.disabled = true;
    threadView.setAttribute('aria-busy', 'true');
    if (!preserveStatus) say('Abriendo el tema…');
    try {
      const query = new URLSearchParams({ offset: String(offset), limit: String(REPLY_PAGE_SIZE) });
      const payload = await request(`/topics/${encodeURIComponent(topicId)}?${query}`, {}, expectedActor);
      if (!isCurrent(expectedActor, epoch) || sequence !== threadSequence || currentTopic !== topicId) return;
      if (!payload.topic || !Array.isArray(payload.replies)) throw new Error('Invalid thread');
      if (!append) { threadContent.replaceChildren(renderPost(payload.topic, topicId, 'topic')); replies.replaceChildren(); }
      const existing = new Set([...replies.children].map(item => item.dataset.postId));
      for (const reply of payload.replies) if (!existing.has(reply.id)) replies.append(renderPost(reply, topicId, 'reply'));
      repliesOffset = offset + payload.replies.length;
      moreReplies.hidden = !payload.has_more;
      replyForm.hidden = Boolean(payload.topic.locked || payload.topic.withdrawn);
      threadNotice.textContent = payload.topic.withdrawn ? 'La autora ha retirado este tema. Las respuestas anteriores se conservan y no se admiten nuevas respuestas.' : payload.topic.locked ? 'Este tema está cerrado a nuevas respuestas.' : 'Tu respuesta se compartirá con las compañeras de esta comunidad.';
      restoreReplyDraft(topicId);
      if (!preserveStatus) say('Tema abierto.');
    } catch (error) {
      if (!isCurrent(expectedActor, epoch) || sequence !== threadSequence || error.name === 'AbortError') return;
      if (error.status === 401 || error.status === 403) denied(error);
      else {
        if (error.status === 404) { threadContent.replaceChildren(); replies.replaceChildren(); replyForm.hidden = true; moreReplies.hidden = true; }
        say(error.status ? error.message : 'No hemos podido abrir el tema. Tu borrador se conserva; pulsa Actualizar comunidad para reintentar.', true);
      }
    } finally {
      if (isCurrent(expectedActor, epoch) && sequence === threadSequence) { moreReplies.disabled = false; threadView.removeAttribute('aria-busy'); }
    }
  }
  function renderReport(report) {
    const expectedActor = actor;
    const epoch = generation;
    const item = element('li', 'fc-report-card');
    item.dataset.reportId = report.id;
    item.append(element('h4', '', report.target?.title || 'Aviso sobre una respuesta'));
    item.append(element('p', 'help fc-meta', [report.reporter?.alias || 'Compañera', dateText(report.created_at)].filter(Boolean).join(' · ')));
    item.append(element('h4', '', 'Motivo del aviso'), element('p', 'fc-report-reason', report.reason));
    item.append(element('h4', '', 'Publicación comunicada'), element('p', 'help', report.target?.author?.alias || 'Publicación retirada'), makeBody(report.target?.body || 'Retirado por su autora.'));
    const actions = element('div', 'fc-post-actions');
    for (const action of ['dismiss', 'hide']) {
      const trigger = button(action === 'dismiss' ? 'Cerrar aviso sin ocultar' : 'Ocultar publicación', 'secondary small');
      trigger.addEventListener('click', () => {
        if (!isCurrent(expectedActor, epoch)) return;
        if (item.querySelector('.fc-confirm')) return;
        confirmation(item, action === 'hide' ? '¿Ocultar esta publicación y resolver el aviso?' : '¿Resolver este aviso sin ocultar la publicación?', 'Sí, confirmar decisión', async (_box, yes, no) => {
          await mutate(`resolve-${report.id}`, [yes, no, ...actions.querySelectorAll('button')], expected => request(`/reports/${encodeURIComponent(report.id)}/resolve`, { method: 'POST', body: JSON.stringify({ action }) }, expected), async (_payload, stillCurrent) => {
            ++listSequence; ++threadSequence;
            // Resolving changes the offsets of pending reports. Reload from the
            // first page so a pending report cannot be skipped or called absent.
            if (view === 'moderation') await loadReports();
            if (!stillCurrent()) return;
            say(action === 'hide' ? 'Publicación ocultada. Aviso resuelto.' : 'Aviso resuelto sin ocultar la publicación.');
            moderationButton.focus();
          });
        });
      });
      actions.append(trigger);
    }
    item.append(actions);
    return item;
  }
  async function loadReports(append = false) {
    if (member?.role !== 'moderator') return;
    const expectedActor = actor;
    const epoch = generation;
    const sequence = ++reportsSequence;
    const offset = append ? reportsOffset : 0;
    moreReports.disabled = true;
    moderationView.setAttribute('aria-busy', 'true');
    try {
      const query = new URLSearchParams({ offset: String(offset), limit: String(PAGE_SIZE) });
      const payload = await request(`/reports?${query}`, {}, expectedActor);
      if (!isCurrent(expectedActor, epoch) || sequence !== reportsSequence) return;
      if (!Array.isArray(payload.reports)) throw new Error('Invalid reports');
      if (!append) reportList.replaceChildren();
      const existing = new Set([...reportList.children].map(item => item.dataset.reportId));
      for (const report of payload.reports) if (!existing.has(report.id)) reportList.append(renderReport(report));
      reportsOffset = offset + payload.reports.length;
      moreReports.hidden = !payload.has_more;
      emptyReports.hidden = reportList.children.length !== 0;
      say('Avisos pendientes actualizados.');
    } catch (error) {
      if (isCurrent(expectedActor, epoch) && sequence === reportsSequence && error.name !== 'AbortError') {
        if (!append) reportList.replaceChildren();
        if (error.status === 401 || error.status === 403) denied(error);
        else say(error.status ? error.message : 'No hemos podido cargar los avisos. Pulsa Actualizar comunidad para reintentar.', true);
      }
    } finally {
      if (isCurrent(expectedActor, epoch) && sequence === reportsSequence) {
        moreReports.disabled = false;
        moderationView.removeAttribute('aria-busy');
      }
    }
  }
  async function loadMembership() {
    const expectedActor = actor;
    const epoch = generation;
    if (!expectedActor) return;
    refreshButton.disabled = true;
    try {
      const payload = await request('/me', {}, expectedActor);
      if (!isCurrent(expectedActor, epoch)) return;
      if (!payload.member?.id || !payload.member.alias) throw new Error('Invalid member');
      member = payload.member;
      const categories = await request('/categories', {}, expectedActor);
      if (!isCurrent(expectedActor, epoch)) return;
      if (!Array.isArray(categories.categories)) throw new Error('Invalid categories');
      categoryFilter.replaceChildren(); composeCategory.replaceChildren();
      const all = element('option', '', 'Todas las categorías'); all.value = ''; categoryFilter.append(all);
      for (const category of categories.categories) {
        const option = element('option', '', category.name); option.value = category.id;
        categoryFilter.append(option);
        composeCategory.append(option.cloneNode(true));
      }
      if (topicDraft.category) composeCategory.value = topicDraft.category;
      else topicDraft.category = composeCategory.value;
      identity.textContent = `Has entrado como ${member.alias}${member.role === 'moderator' ? ' · moderadora' : ''}.`;
      moderationButton.hidden = member.role !== 'moderator';
      space.hidden = false;
      await loadTopics();
    } catch (error) {
      if (isCurrent(expectedActor, epoch) && error.name !== 'AbortError') {
        if (error.status === 401 || error.status === 403) denied(error);
        else { space.hidden = true; say(error.status ? error.message : 'No hemos podido abrir la comunidad. Pulsa Actualizar comunidad para reintentar.', true); }
      }
    } finally { if (isCurrent(expectedActor, epoch)) refreshButton.disabled = false; }
  }
  async function refresh() {
    if (!actor) return;
    if (!member || space.hidden) return loadMembership();
    if (view === 'thread' && currentTopic) return openTopic(currentTopic);
    if (view === 'moderation') return loadReports();
    return loadTopics();
  }
  function setSession(session) {
    const nextActor = session?.user?.id && session?.access_token ? session.user.id : null;
    if (nextActor && actor === nextActor) return;
    reset();
    if (!nextActor || destroyed) return;
    actor = nextActor;
    panel.hidden = false;
    say('Abriendo la comunidad…');
    void loadMembership();
  }
  function topicChanged() {
    topicDraft = { title: composeTitle.value, body: composeBody.value, category: composeCategory.value, requestId: null };
  }
  for (const control of [composeTitle, composeBody, composeCategory]) control.addEventListener('input', topicChanged);
  composeCategory.addEventListener('change', topicChanged);
  replyBody.addEventListener('input', () => {
    if (currentTopic) replyDrafts.set(currentTopic, { body: replyBody.value, requestId: null });
  });
  allTopics.addEventListener('click', () => { showView('topics'); ++threadSequence; void loadTopics(); });
  leaveCompose.addEventListener('click', () => { showView('topics'); void loadTopics(); });
  newTopic.addEventListener('click', () => {
    if (!member) return;
    showView('compose'); ++threadSequence;
    composeTitle.value = topicDraft.title; composeBody.value = topicDraft.body;
    if (topicDraft.category) composeCategory.value = topicDraft.category;
    composeTitle.focus();
  });
  searchForm.addEventListener('submit', event => { event.preventDefault(); showView('topics'); void loadTopics(); });
  categoryFilter.addEventListener('change', () => { void loadTopics(); });
  moreTopics.addEventListener('click', () => { void loadTopics(true); });
  moreReplies.addEventListener('click', () => { if (currentTopic) void openTopic(currentTopic, { append: true }); });
  moreReports.addEventListener('click', () => { void loadReports(true); });
  moderationButton.addEventListener('click', () => { if (member?.role === 'moderator') { showView('moderation'); ++threadSequence; void loadReports(); } });
  refreshButton.addEventListener('click', () => { void refresh(); });
  composeForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!member || !composeTitle.value.trim() || !composeBody.value.trim()) return;
    // Preserve one operation id for an unchanged retry after a network failure.
    if (!topicDraft.requestId) topicDraft.requestId = uuid();
    const submitted = { category_id: composeCategory.value, title: composeTitle.value.trim(), body: composeBody.value.trim(), client_request_id: topicDraft.requestId };
    void mutate('create-topic', [...composeForm.elements], expected => request('/topics', { method: 'POST', body: JSON.stringify(submitted) }, expected), async (payload, stillCurrent) => {
      topicDraft = { title: '', body: '', category: composeCategory.value, requestId: null };
      composeTitle.value = composeBody.value = '';
      ++listSequence;
      if (view === 'compose') { await openTopic(payload.topic.id, { preserveStatus: true }); if (stillCurrent()) say('Tema publicado.'); }
      else say('Tema publicado. Lo encontrarás en Temas.');
    });
  });
  replyForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!member || !currentTopic || replyForm.hidden || !replyBody.value.trim()) return;
    const topicId = currentTopic;
    const draft = replyDrafts.get(topicId) || { body: replyBody.value, requestId: null };
    if (!draft.requestId) draft.requestId = uuid();
    replyDrafts.set(topicId, draft);
    const submitted = { body: replyBody.value.trim(), client_request_id: draft.requestId };
    void mutate(`reply-${topicId}`, [...replyForm.elements], expected => request(`/topics/${encodeURIComponent(topicId)}/replies`, { method: 'POST', body: JSON.stringify(submitted) }, expected), async (_payload, stillCurrent) => {
      replyDrafts.delete(topicId);
      ++listSequence;
      if (currentTopic === topicId && view === 'thread') { replyBody.value = ''; await openTopic(topicId, { preserveStatus: true }); }
      if (stillCurrent()) say('Respuesta publicada.');
    });
  });
  const onSession = event => setSession(event.detail);
  windowRef.addEventListener('sx:session', onSession);
  setSession(getSession());
  return {
    panel, setSession, refresh, openTopic,
    destroy() { destroyed = true; windowRef.removeEventListener('sx:session', onSession); reset(); panel.remove(); }
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') mountForocromos();
