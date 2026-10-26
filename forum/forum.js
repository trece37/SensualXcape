import { createClient } from '@supabase/supabase-js';
import { FORUM_CONFIG } from './config.js';
import { CATEGORIES, SEED_TOPICS, PRINCIPLES } from './content.js';

export function friendlyError(error) {
  const text = String(error?.message || error || '');
  if (/invalid login/i.test(text)) return 'El correo o la contraseña no coinciden.';
  if (/email not confirmed/i.test(text)) return 'Confirma tu correo antes de entrar.';
  if (/rate|limit|too many/i.test(text)) return 'Hay varias peticiones seguidas. Espera un momento y vuelve a intentarlo.';
  if (/invalid_alias/i.test(text)) return 'Elige un alias de 2 a 36 caracteres, sin correo electrónico ni saltos de línea.';
  if (/closed|cerrad/i.test(text)) return 'Este hilo está cerrado a nuevas aportaciones.';
  if (/member|admi|active|permission|denied|42501/i.test(text)) return 'Tu acceso no permite esta acción. Comprueba el estado de tu admisión.';
  if (/network|fetch|offline/i.test(text)) return 'No se pudo conectar. Tu texto sigue aquí; prueba cuando vuelva la conexión.';
  return 'No se pudo completar la acción. Tu texto sigue aquí para que puedas intentarlo de nuevo.';
}

export function createForum({ client, doc = document, win = window }) {
  const $ = id => doc.getElementById(id);
  let session = null, member = null, topics = [], aliases = new Map(), saves = new Set();
  let category = '', page = 0, count = 0, current = null, epoch = 0, listVersion = 0, topicVersion = 0;
  let savedOnly = false, busy = false, reportTarget = null, authBusy = false, destroyed = false, preview = true;
  let searchTimer, replyPage = 0, replyCount = 0;
  const drafts = new Map(), moderationPages = { members: 0, reports: 0, topics: 0, replies: 0 };
  const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const show = (id, yes) => { if ($(id)) $(id).hidden = !yes; };
  const say = (id, text) => { if ($(id)) { $(id).textContent = text; if (id === 'app-status') $(id).hidden = !text; } };
  const catLabel = id => CATEGORIES.find(c => c.id === id)?.label || 'Entre compañeras';
  const date = value => value ? new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value)) : 'Apertura del equipo';
  const author = id => id ? aliases.get(id) || 'Compañera' : 'Equipo Foro Cromos';
  const admitted = () => member?.status === 'active';
  const moderator = () => admitted() && member.role === 'moderator';
  const button = (text, action, cls = 'button secondary') => { const n = el('button', cls, text); n.type = 'button'; n.addEventListener('click', action); return n; };
  const dialog = id => { if ($(id)?.showModal && !$(id).open) $(id).showModal(); };
  const close = id => $(id)?.close();
  const expired = error => ['PGRST301', 'PGRST302', '401'].includes(String(error?.code)) || error?.status === 401 || /jwt.*(expired|invalid)|invalid.*jwt/i.test(String(error?.message || ''));
  function expireAccess() {
    epoch++; clearPrivate(); session = null; member = null; updateGate(); refreshList();
    say('join-message', 'Tu sesión ha caducado. Vuelve a entrar para recuperar el acceso.');
  }
  async function rpc(name, args = {}) {
    const scope = epoch, actor = session?.user.id;
    const { data, error } = await client.rpc(name, args);
    if (scope !== epoch || actor !== session?.user.id) throw Object.assign(new Error('session_changed'), { code: 'FC_SESSION_CHANGED' });
    if (error) { if (expired(error)) expireAccess(); throw error; } return data;
  }
  async function transact(form, status, operation) {
    if (form.dataset.busy === 'true') return;
    form.dataset.busy = 'true';
    const controls = [...form.querySelectorAll('button')]; controls.forEach(c => c.disabled = true);
    try { say(status, 'Guardando…'); await operation(); }
    catch (error) { if (error?.code !== 'FC_SESSION_CHANGED') say(status, friendlyError(error)); }
    finally { form.dataset.busy = 'false'; controls.forEach(c => c.disabled = false); }
  }
  function clearPrivate() {
    topics = []; aliases.clear(); saves.clear(); current = null; topicVersion++; listVersion++;
    for (const id of ['topics-list', 'topic-posts', 'topic-body', 'topic-controls', 'moderation-list', 'topic-title', 'topic-author', 'topic-category', 'topic-status', 'reply-status', 'report-status']) $(id)?.replaceChildren();
    for (const id of ['topic-title-input', 'topic-body-input', 'reply-body', 'report-body', 'auth-password']) if ($(id)) $(id).value = '';
    for (const id of ['topic-dialog', 'report-dialog']) close(id);
    for (const id of ['edit-dialog', 'profile-dialog', 'recovery-dialog']) { close(id); $(id)?.remove(); }
    reportTarget = null; savedOnly = false; page = 0;
    drafts.clear(); replyPage = 0; replyCount = 0;
    $('saved-toggle')?.setAttribute('aria-pressed', 'false');
    show('moderation-panel', false); show('topic-view', false); show('list-view', true);
  }
  function updateGate() {
    const active = admitted(); preview = !active;
    doc.body.classList.toggle('is-admitted', active);
    say('account-label', member ? member.alias : session ? 'Cuenta conectada' : 'Tu espacio entre compañeras');
    show('account-label', !!session);
    show('login-open', !session); show('logout-button', !!session); show('join-panel', !active);
    show('join-form', !!session && !member);
    show('forum-app', true); show('new-topic-button', active); show('moderation-button', moderator());
    show('profile-button', active); show('saved-toggle', active); show('report-open', active);
    if (member?.status === 'pending') say('join-message', 'Tu solicitud está pendiente de admisión. Puedes consultar aquí su estado.');
    else if (member?.status === 'suspended') say('join-message', 'Tu acceso a la comunidad está suspendido. Las conversaciones privadas no están disponibles.');
    else if (!session) say('join-message', 'Entra o crea tu cuenta para solicitar acceso. Los títulos de apertura son del equipo; las conversaciones requieren admisión.');
    else if (!member) say('join-message', 'Elige tu alias para solicitar entrada. Tu correo no aparece como firma en el foro.');
    if ($('live-label')) $('live-label').textContent = active ? 'Comunidad conectada · se actualiza cada 20 s' : 'Temas de apertura · conversaciones con admisión';
  }
  function renderCategories() {
    const nav = $('category-list'); nav.replaceChildren();
    for (const c of [{ id: '', label: 'Todos los temas' }, ...CATEGORIES]) {
      const b = button(c.label, () => { category = c.id; page = 0; renderCategories(); refreshList(); }, 'category-button');
      b.setAttribute('aria-pressed', String(category === c.id));
      nav.append(b);
    }
  }
  function renderTopics() {
    const list = $('topics-list'); list.replaceChildren();
    if (!topics.length) { list.append(el('div', 'empty-state', savedOnly ? 'Todavía no has guardado ningún hilo.' : 'No hay temas que coincidan. Prueba otra búsqueda o abre una conversación.')); }
    for (const topic of topics) {
      const row = el('article', 'topic-row');
      const sigil = el('span', 'topic-sigil', topic.pinned ? '✦' : '◇'); sigil.setAttribute('aria-hidden', 'true');
      const main = el('div', 'topic-main'), meta = el('div', 'topic-meta');
      meta.append(el('span', 'category-tag', catLabel(topic.category)));
      if (topic.pinned) meta.append(el('span', 'topic-badge', 'Fijado'));
      if (topic.closed) meta.append(el('span', 'topic-badge', 'Cerrado'));
      main.append(meta);
      const heading = el('h3'); heading.append(button(topic.title, () => openTopic(topic), 'topic-title-button')); main.append(heading);
      main.append(el('p', 'topic-excerpt', topic.body.slice(0, 160).split('\n')[0]));
      const foot = el('div', 'topic-meta'); foot.append(el('span', '', topic.editorial ? 'Apertura del equipo' : author(topic.author_id))); if (topic.created_at) foot.append(el('span', '', date(topic.created_at))); main.append(foot);
      row.append(sigil, main);
      if (admitted()) row.append(button(saves.has(topic.id) ? 'Guardado' : 'Guardar', () => toggleSave(topic.id), 'save-button'));
      else row.append(el('span', 'topic-arrow', '↗'));
      list.append(row);
    }
    let pager = $('forum-pagination');
    if (!pager) { pager = el('div', 'forum-pagination'); pager.id = 'forum-pagination'; list.after(pager); }
    pager.replaceChildren();
    if (page > 0) pager.append(button('← Anteriores', () => { page--; refreshList(); }));
    if (!preview && (page + 1) * 20 < count) pager.append(button('Más temas →', () => { page++; refreshList(); }));
    say('list-summary', preview ? `${topics.length} temas de apertura del equipo` : `${count} temas${savedOnly ? ' guardados' : ''}`);
  }
  async function loadAliases(ids) {
    const scope = epoch;
    const missing = [...new Set(ids.filter(Boolean))].filter(id => !aliases.has(id));
    if (!missing.length) return;
    const { data, error } = await client.from('fc_members').select('user_id,alias').in('user_id', missing);
    if (error) throw error;
    if (scope !== epoch) return;
    for (const a of data || []) aliases.set(a.user_id, a.alias);
  }
  async function refreshList({ quiet = false } = {}) {
    if (destroyed) return;
    const version = ++listVersion, scope = epoch;
    const search = $('search-input')?.value.trim() || '';
    try {
      if (preview) {
        topics = SEED_TOPICS.filter(t => (!category || t.category === category) && t.title.toLocaleLowerCase('es').includes(search.toLocaleLowerCase('es'))).map(t => ({ ...t, id: `opening-${t.slug}`, editorial: true }));
        if ($('sort-select')?.value === 'pinned') topics.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
        count = topics.length; renderTopics(); return;
      }
      if (!quiet) say('app-status', 'Cargando conversaciones…');
      const savedResult = await client.from('fc_saved').select('topic_id');
      if (savedResult.error) throw savedResult.error;
      const nextSaves = new Set((savedResult.data || []).map(s => s.topic_id));
      let query = client.from('fc_topics').select('*', { count: 'exact' }).eq('hidden', false);
      if (category) query = query.eq('category', category);
      if (search) query = query.ilike('title', `%${search.replace(/[\\%_]/g, '\\$&')}%`);
      if (savedOnly) {
        if (!nextSaves.size) { if (scope === epoch && version === listVersion) { saves = nextSaves; topics = []; count = 0; renderTopics(); say('app-status', ''); } return; }
        query = query.in('id', [...nextSaves]);
      }
      if ($('sort-select')?.value === 'pinned') query = query.order('pinned', { ascending: false });
      const result = await query.order('created_at', { ascending: false }).order('id', { ascending: false }).range(page * 20, page * 20 + 19);
      if (result.error) throw result.error;
      if (scope !== epoch || version !== listVersion) return;
      await loadAliases((result.data || []).map(t => t.author_id));
      if (scope !== epoch || version !== listVersion) return;
      saves = nextSaves; topics = result.data || []; count = result.count || 0;
      renderTopics(); say('app-status', win.navigator.onLine === false ? 'Sin conexión.' : 'Conversaciones actualizadas.');
    } catch (error) { if (scope === epoch && version === listVersion) { if (expired(error)) expireAccess(); else say('app-status', friendlyError(error)); } }
  }
  function renderBody(container, text) {
    container.replaceChildren();
    // Plain text deliberately avoids HTML, embeds and remote preview requests.
    for (const part of String(text || '').split(/\n\s*\n/)) container.append(el('p', '', part));
  }
  function renderTopic(topic, posts = []) {
    if (current?.id !== topic.id) {
      if (current && admitted()) drafts.set(current.id, $('reply-body').value);
      $('reply-body').value = drafts.get(topic.id) || '';
      say('reply-status', '');
    }
    current = topic; show('list-view', false); show('topic-view', true);
    say('topic-category', catLabel(topic.category)); say('topic-title', topic.title);
    say('topic-author', `${topic.editorial ? 'Equipo Foro Cromos' : author(topic.author_id)} · ${date(topic.created_at)}`);
    renderBody($('topic-body'), topic.body);
    const postList = $('topic-posts'); postList.replaceChildren();
    for (const post of posts) {
      const card = el('article', 'post'), header = el('div', 'post-header');
      header.append(el('strong', '', author(post.author_id)), el('span', '', date(post.created_at))); card.append(header);
      const body = el('div', 'post-body'); renderBody(body, post.body); card.append(body);
      const actions = el('div', 'post-actions');
      if (post.author_id === session?.user.id && !post.withdrawn_at) {
        if (!topic.closed) actions.append(button('Editar', () => editText('reply', post), 'text-button'));
        actions.append(button('Retirar', () => withdraw('reply', post.id), 'text-button'));
      }
      actions.append(button('Avisar a moderación', () => openReport(topic.id, post.id), 'text-button'));
      if (moderator()) actions.append(button('Ocultar respuesta', () => moderate('reply_hide', post.id), 'text-button'));
      card.append(actions); postList.append(card);
    }
    if (!posts.length) postList.append(el('p', 'empty-state', preview ? 'Las respuestas de las compañeras se muestran después de entrar y ser admitida.' : 'Esta conversación está esperando su primera respuesta.'));
    if (!preview && replyCount > 50) {
      const pages = el('div', 'forum-pagination');
      if (replyPage > 0) pages.append(button('← Respuestas anteriores', () => { replyPage--; openTopic(topic, { quiet: true }); }));
      pages.append(el('span', '', `Página ${replyPage + 1} de ${Math.ceil(replyCount / 50)}`));
      if ((replyPage + 1) * 50 < replyCount) pages.append(button('Respuestas siguientes →', () => { replyPage++; openTopic(topic, { quiet: true }); }));
      postList.append(pages);
    }
    const controls = $('topic-controls'); controls.replaceChildren();
    if (admitted()) {
      controls.append(button(saves.has(topic.id) ? 'Quitar de guardados' : 'Guardar hilo', () => toggleSave(topic.id)));
      controls.append(button('Avisar a moderación', () => openReport(topic.id, null), 'text-button'));
      if (topic.author_id === session?.user.id && !topic.withdrawn_at) {
        if (!topic.closed) controls.append(button('Editar mi texto', () => editText('topic', topic), 'text-button'));
        controls.append(button('Retirar mi publicación', () => withdraw('topic', topic.id), 'text-button'));
      }
      if (moderator()) {
        controls.append(button(topic.closed ? 'Reabrir hilo' : 'Cerrar respuestas', () => moderate(topic.closed ? 'topic_open' : 'topic_close', topic.id), 'text-button'));
        controls.append(button(topic.pinned ? 'Desfijar' : 'Fijar', () => moderate(topic.pinned ? 'topic_unpin' : 'topic_pin', topic.id), 'text-button'));
        controls.append(button('Ocultar hilo', () => moderate('topic_hide', topic.id), 'text-button'));
      }
    } else controls.append(button('Entrar para participar', () => dialog('auth-dialog'), 'button primary'));
    show('reply-form', admitted() && !topic.closed && !topic.hidden);
    say('topic-status', topic.closed ? 'Hilo cerrado. Puedes leerlo y avisar a moderación.' : preview ? 'Apertura editorial. El contenido de la comunidad requiere acceso.' : 'Responde a tu ritmo. Tu alias será visible para la comunidad admitida.');
  }
  async function openTopic(topic, { quiet = false } = {}) {
    if (preview) {
      const editorial = SEED_TOPICS.find(t => `opening-${t.slug}` === topic.id);
      if (!editorial) return;
      renderTopic({ ...editorial, id: topic.id, editorial: true }); $('topic-title')?.focus(); return;
    }
    if (current?.id !== topic.id) replyPage = 0;
    const version = ++topicVersion, scope = epoch;
    try {
      const [head, posts] = await Promise.all([
        client.from('fc_topics').select('*').eq('id', topic.id).eq('hidden', false).maybeSingle(),
        client.from('fc_replies').select('*', { count: 'exact' }).eq('topic_id', topic.id).eq('hidden', false).order('created_at').order('id').range(replyPage * 50, replyPage * 50 + 49)
      ]);
      if (head.error) throw head.error; if (posts.error) throw posts.error;
      if (scope !== epoch || version !== topicVersion) return;
      if (!head.data) { current = null; show('topic-view', false); show('list-view', true); say('app-status', 'Este hilo ya no está disponible.'); await refreshList(); return; }
      await loadAliases([head.data.author_id, ...(posts.data || []).map(p => p.author_id)]);
      if (scope !== epoch || version !== topicVersion) return;
      replyCount = posts.count || 0; renderTopic(head.data, posts.data || []);
      if (!quiet) $('topic-title')?.focus();
    } catch (error) { if (scope === epoch && version === topicVersion) { if (expired(error)) expireAccess(); else say('app-status', friendlyError(error)); } }
  }
  async function toggleSave(id) {
    try { const result = await rpc('fc_toggle_save', { p_topic_id: id }); result.saved ? saves.add(id) : saves.delete(id); renderTopics(); if (current?.id === id) await openTopic(current, { quiet: true }); }
    catch (error) { say('app-status', friendlyError(error)); }
  }
  async function withdraw(kind, id) {
    if (!win.confirm('¿Retirar tu texto de la comunidad? Las respuestas ajenas se conservan.')) return;
    try { await rpc('fc_withdraw', { p_kind: kind, p_id: id }); if (kind === 'topic') { current = null; show('topic-view', false); show('list-view', true); } else if (current) await openTopic(current, { quiet: true }); await refreshList(); }
    catch (error) { say('app-status', friendlyError(error)); }
  }
  function editText(kind, post) {
    let d = $('edit-dialog');
    if (!d) { d = el('dialog', 'forum-dialog'); d.id = 'edit-dialog'; doc.body.append(d); }
    d.replaceChildren(); const form = el('form', 'dialog-form'), heading = el('h2', '', 'Editar mi texto');
    const label = el('label', '', 'Tu texto'), area = el('textarea'); area.rows = 8; area.required = true; area.maxLength = kind === 'topic' ? 5000 : 3000; area.value = post.body; label.append(area);
    const status = el('p', 'form-status'); status.id = 'edit-status'; status.setAttribute('role', 'status');
    const submit = el('button', 'button primary', 'Guardar cambios'); submit.type = 'submit'; form.append(heading, label, status, submit, button('Cancelar', () => d.close())); d.append(form);
    form.addEventListener('submit', event => { event.preventDefault(); transact(form, 'edit-status', async () => { await rpc('fc_edit', { p_kind: kind, p_id: post.id, p_body: area.value.trim() }); d.close(); if (current) await openTopic(current, { quiet: true }); await refreshList(); }); }); d.showModal();
  }
  function openReport(topicId = null, replyId = null) { reportTarget = { topicId, replyId }; say('report-status', 'Tu aviso solo se muestra a moderación y en su registro. No se publica en el hilo.'); dialog('report-dialog'); }
  async function moderate(action, target) {
    if (/hide/.test(action) && !win.confirm('¿Ocultar esta publicación para la comunidad? Moderación podrá revisarla.')) return;
    try { await rpc('fc_moderate', { p_action: action, p_target_id: target }); await refreshList(); if (current) await openTopic(current, { quiet: true }); if (!$('moderation-panel').hidden) await loadModeration(); }
    catch (error) { say('app-status', friendlyError(error)); }
  }
  async function loadModeration() {
    if (!moderator()) return;
    show('moderation-panel', true); const scope = epoch;
    const [members, reports, hiddenTopics, hiddenReplies] = await Promise.all([
      client.from('fc_members').select('*', { count: 'exact' }).order('created_at', { ascending: false }).order('user_id').range(moderationPages.members * 50, moderationPages.members * 50 + 49),
      client.from('fc_reports').select('*', { count: 'exact' }).eq('status', 'open').order('created_at').order('id').range(moderationPages.reports * 25, moderationPages.reports * 25 + 24),
      client.from('fc_topics').select('*', { count: 'exact' }).eq('hidden', true).is('withdrawn_at', null).order('created_at').order('id').range(moderationPages.topics * 25, moderationPages.topics * 25 + 24),
      client.from('fc_replies').select('*', { count: 'exact' }).eq('hidden', true).is('withdrawn_at', null).order('created_at').order('id').range(moderationPages.replies * 25, moderationPages.replies * 25 + 24)
    ]);
    if (scope !== epoch || !moderator()) return;
    const list = $('moderation-list'); list.replaceChildren();
    const failure = [members, reports, hiddenTopics, hiddenReplies].find(r => r.error); if (failure) { list.append(el('p', 'status-banner', friendlyError(failure.error))); return; }
    const paginate = (key, result, size) => {
      if (!(result.count > size)) return;
      const pager = el('div', 'forum-pagination');
      if (moderationPages[key]) pager.append(button('← Anteriores', () => { moderationPages[key]--; loadModeration(); }));
      pager.append(el('span', '', `Página ${moderationPages[key] + 1} de ${Math.ceil(result.count / size)}`));
      if ((moderationPages[key] + 1) * size < result.count) pager.append(button('Siguientes →', () => { moderationPages[key]++; loadModeration(); }));
      list.append(pager);
    };
    list.append(el('h3', '', 'Admisión y acceso'));
    for (const m of members.data || []) {
      aliases.set(m.user_id, m.alias);
      const row = el('article', 'moderation-row'); row.append(el('strong', '', m.alias), el('span', 'topic-badge', m.status === 'pending' ? 'Pendiente' : m.status === 'active' ? 'Admitida' : 'Suspendida'));
      if (m.user_id !== session.user.id) row.append(button(m.status === 'active' ? 'Suspender acceso' : 'Admitir', async () => {
        try { await rpc('fc_admit', { p_user_id: m.user_id, p_status: m.status === 'active' ? 'suspended' : 'active' }); await loadModeration(); } catch (error) { say('app-status', friendlyError(error)); }
      })); list.append(row);
    }
    paginate('members', members, 50);
    list.append(el('h3', '', 'Avisos confidenciales'));
    if (!reports.data?.length) list.append(el('p', '', 'No hay avisos pendientes.'));
    const replyIds = (reports.data || []).map(r => r.reply_id).filter(Boolean);
    const reportReplies = replyIds.length ? await client.from('fc_replies').select('*').in('id', replyIds) : { data: [] };
    if (scope !== epoch || !moderator()) return;
    if (reportReplies.error) { list.append(el('p', 'status-banner', friendlyError(reportReplies.error))); return; }
    const replyTargets = new Map((reportReplies.data || []).map(r => [r.id, r]));
    const topicIds = [...new Set([...(reports.data || []).map(r => r.topic_id), ...(reportReplies.data || []).map(r => r.topic_id)].filter(Boolean))];
    const reportTopics = topicIds.length ? await client.from('fc_topics').select('*').in('id', topicIds) : { data: [] };
    if (scope !== epoch || !moderator()) return;
    if (reportTopics.error) { list.append(el('p', 'status-banner', friendlyError(reportTopics.error))); return; }
    const topicTargets = new Map((reportTopics.data || []).map(t => [t.id, t]));
    await loadAliases([...(reports.data || []).map(r => r.reporter_id), ...(reportReplies.data || []).map(r => r.author_id)]);
    if (scope !== epoch || !moderator()) return;
    for (const report of reports.data || []) {
      const row = el('article', 'moderation-row'); row.append(el('strong', '', `${author(report.reporter_id)} · ${date(report.created_at)}`), el('p', '', report.body));
      const targetReply = replyTargets.get(report.reply_id), targetTopic = topicTargets.get(report.topic_id || targetReply?.topic_id);
      if (targetTopic) row.append(el('h4', '', targetTopic.title));
      if (targetReply) row.append(el('p', 'report-context', `${author(targetReply.author_id)}: ${targetReply.body}`));
      else if (targetTopic) row.append(el('p', 'report-context', targetTopic.body));
      if (targetTopic && !targetTopic.hidden) row.append(button('Abrir hilo', () => openTopic(targetTopic)));
      if (targetReply && !targetReply.hidden && !targetReply.withdrawn_at) row.append(button('Ocultar respuesta señalada', () => moderate('reply_hide', targetReply.id)));
      else if (targetTopic && !targetTopic.hidden && !targetTopic.withdrawn_at) row.append(button('Ocultar hilo señalado', () => moderate('topic_hide', targetTopic.id)));
      row.append(button('Marcar revisado', () => moderate('report_resolve', report.id))); list.append(row);
    }
    paginate('reports', reports, 25);
    list.append(el('h3', '', 'Contenido oculto'));
    for (const [kind, records] of [['topic', hiddenTopics.data || []], ['reply', hiddenReplies.data || []]]) for (const record of records) {
      const row = el('article', 'moderation-row'); row.append(el('strong', '', record.title || 'Respuesta'), el('p', '', record.body), button('Volver a mostrar', () => moderate(`${kind}_show`, record.id))); list.append(row);
    }
    paginate('topics', hiddenTopics, 25); paginate('replies', hiddenReplies, 25);
  }
  async function syncSession(nextSession) {
    const scope = ++epoch;
    const changed = session?.user.id !== nextSession?.user.id;
    if (changed || !nextSession) clearPrivate();
    session = nextSession; member = null; updateGate();
    if (!session) { await refreshList(); return; }
    try {
      const verified = await client.auth.getUser(); if (verified.error) throw verified.error;
      if (scope !== epoch) return;
      const result = await client.from('fc_members').select('*').eq('user_id', verified.data.user.id).maybeSingle(); if (result.error) throw result.error;
      if (scope !== epoch) return;
      member = result.data; updateGate(); if (changed || !admitted()) await refreshList(); else await refreshList({ quiet: true });
    } catch (error) { if (scope === epoch) { clearPrivate(); updateGate(); await refreshList(); say('join-message', friendlyError(error)); } }
  }
  const bind = (id, event, fn) => $(id)?.addEventListener(event, fn);
  bind('theme-select', 'change', () => { const theme = $('theme-select').value; doc.documentElement.dataset.theme = theme; doc.body.dataset.theme = theme; try { win.localStorage.setItem('sx-forum-theme', theme); } catch {} });
  try { const theme = win.localStorage.getItem('sx-forum-theme'); if (['noir', 'agape', 'eros'].includes(theme)) { doc.documentElement.dataset.theme = theme; doc.body.dataset.theme = theme; $('theme-select').value = theme; } } catch {}
  for (const b of doc.querySelectorAll('[data-close-dialog]')) b.addEventListener('click', () => b.closest('dialog')?.close());
  bind('login-open', 'click', () => dialog('auth-dialog'));
  bind('preview-toggle', 'click', () => { $('forum-app').scrollIntoView?.({ behavior: win.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }); });
  for (const b of doc.querySelectorAll('[data-open-auth]')) b.addEventListener('click', () => dialog('auth-dialog'));
  for (const b of doc.querySelectorAll('[data-trial-email]')) b.addEventListener('click', () => {
    if (authBusy) return;
    $('auth-email').value = b.dataset.trialEmail;
    $('auth-password').value = '';
    $('auth-password').setCustomValidity('');
    say('auth-message', '');
    $('auth-password').focus();
  });
  bind('logout-button', 'click', async () => { clearPrivate(); session = null; member = null; epoch++; updateGate(); await refreshList(); await client.auth.signOut({ scope: 'local' }); });
  async function authenticate(mode) {
    const form = $('auth-form'); if (authBusy) return;
    const email = $('auth-email').value.trim(), password = $('auth-password').value;
    $('auth-password').setCustomValidity(mode === 'signup' && password.length < 8 ? 'Elige una contraseña de al menos ocho caracteres.' : '');
    if (!$('auth-email').reportValidity()) return;
    if (mode !== 'recover' && !$('auth-password').reportValidity()) return;
    authBusy = true;
    await transact(form, 'auth-message', async () => {
      const redirect = new URL('./', win.location.href).href;
      let result;
      if (mode === 'signup') result = await client.auth.signUp({ email, password, options: { emailRedirectTo: redirect } });
      else if (mode === 'recover') result = await client.auth.resetPasswordForEmail(email, { redirectTo: redirect });
      else result = await client.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      if (mode === 'recover') say('auth-message', 'Si existe una cuenta con ese correo, recibirás las instrucciones de recuperación.');
      else if (mode === 'signup' && !result.data.session) say('auth-message', 'Revisa tu correo para confirmar el acceso. Después vuelve aquí y solicita admisión.');
      else { $('auth-password').value = ''; close('auth-dialog'); await syncSession(result.data.session); }
    }); authBusy = false;
  }
  bind('auth-form', 'submit', e => { e.preventDefault(); authenticate('login'); });
  for (const b of doc.querySelectorAll('[data-auth-action]')) if (b.type !== 'submit') b.addEventListener('click', () => authenticate(b.dataset.authAction));
  bind('join-form', 'submit', e => { e.preventDefault(); transact(e.currentTarget, 'join-message', async () => { await rpc('fc_join', { p_alias: $('join-alias').value.trim() }); await syncSession(session); }); });
  bind('search-input', 'input', () => { win.clearTimeout(searchTimer); searchTimer = win.setTimeout(() => { page = 0; refreshList(); }, 260); });
  bind('sort-select', 'change', () => { page = 0; refreshList(); });
  bind('saved-toggle', 'click', () => { savedOnly = !savedOnly; $('saved-toggle').setAttribute('aria-pressed', String(savedOnly)); page = 0; refreshList(); });
  bind('new-topic-button', 'click', () => { say('topic-form-status', ''); dialog('topic-dialog'); });
  bind('topic-form', 'submit', e => { e.preventDefault(); transact(e.currentTarget, 'topic-form-status', async () => {
    const topic = await rpc('fc_create_topic', { p_category: $('topic-category-input').value, p_title: $('topic-title-input').value.trim(), p_body: $('topic-body-input').value.trim() });
    $('topic-form').reset(); close('topic-dialog'); page = 0; await refreshList(); await openTopic(topic);
  }); });
  bind('reply-form', 'submit', e => { e.preventDefault(); const topic = current, text = $('reply-body').value; transact(e.currentTarget, 'reply-status', async () => {
    await rpc('fc_reply', { p_topic_id: topic.id, p_body: text.trim() }); drafts.delete(topic.id);
    if (current?.id === topic.id) { if ($('reply-body').value === text) $('reply-body').value = ''; replyPage = Math.floor(replyCount / 50); say('reply-status', 'Tu respuesta está publicada.'); await openTopic(topic, { quiet: true }); }
    else say('app-status', `Tu respuesta está publicada en «${topic.title}».`);
  }); });
  bind('back-topics', 'click', () => { if (current && admitted()) drafts.set(current.id, $('reply-body').value); $('reply-body').value = ''; current = null; topicVersion++; show('topic-view', false); show('list-view', true); refreshList(); });
  bind('report-open', 'click', () => openReport());
  bind('report-form', 'submit', e => { e.preventDefault(); transact(e.currentTarget, 'report-status', async () => { await rpc('fc_report', { p_topic_id: reportTarget?.topicId || null, p_reply_id: reportTarget?.replyId || null, p_body: $('report-body').value.trim() }); $('report-body').value = ''; say('report-status', 'Aviso guardado para moderación. No se ha publicado en el foro.'); }); });
  bind('open-manifesto', 'click', () => dialog('manifesto-dialog'));
  const principles = $('manifesto-list'); principles.replaceChildren();
  for (const p of PRINCIPLES) { const item = el('li', 'principle'); item.append(el('h3', '', p.title), el('p', '', p.body)); principles.append(item); }
  const categorySelect = $('topic-category-input'); categorySelect.replaceChildren(); for (const c of CATEGORIES) { const option = el('option', '', c.label); option.value = c.id; categorySelect.append(option); }
  bind('moderation-button', 'click', () => { if (!$('moderation-panel').hidden) show('moderation-panel', false); else loadModeration(); });
  bind('profile-button', 'click', () => {
    if (!member) return;
    let d = $('profile-dialog'); if (!d) { d = el('dialog', 'forum-dialog'); d.id = 'profile-dialog'; doc.body.append(d); }
    d.replaceChildren(); const form = el('form', 'dialog-form'), label = el('label', '', 'Tu alias en la comunidad'), input = el('input'); input.value = member.alias; input.required = true; input.minLength = 2; input.maxLength = 36; label.append(input);
    const status = el('p', 'form-status'); status.id = 'profile-status'; const submit = el('button', 'button primary', 'Guardar alias'); submit.type = 'submit'; form.append(el('h2', '', 'Cómo quieres que te llamen'), label, status, submit, button('Cancelar', () => d.close())); d.append(form);
    form.addEventListener('submit', event => { event.preventDefault(); transact(form, 'profile-status', async () => { member = await rpc('fc_profile', { p_alias: input.value.trim() }); aliases.clear(); updateGate(); d.close(); await refreshList(); if (current) await openTopic(current, { quiet: true }); }); }); d.showModal();
  });
  async function poll() {
    if (destroyed || doc.hidden || busy || !session) return;
    busy = true; const scope = epoch;
    try {
      const r = await client.from('fc_members').select('*').eq('user_id', session.user.id).maybeSingle(); if (r.error) throw r.error;
      if (scope !== epoch) return;
      if (r.data?.status !== member?.status || r.data?.role !== member?.role) { epoch++; clearPrivate(); member = r.data; updateGate(); }
      else { member = r.data; updateGate(); }
      if (admitted()) { await refreshList({ quiet: true }); if (current) await openTopic(current, { quiet: true }); } else await refreshList();
    } catch (error) { if (scope === epoch) { if (expired(error)) expireAccess(); else say('app-status', friendlyError(error)); } } finally { busy = false; }
  }
  win.addEventListener('offline', () => say('app-status', 'Sin conexión. Conserva tu texto y vuelve a intentar cuando recuperes Internet.'));
  win.addEventListener('online', poll); doc.addEventListener('visibilitychange', () => { if (!doc.hidden) poll(); });
  renderCategories(); updateGate(); refreshList();
  const subscription = client.auth.onAuthStateChange((event, nextSession) => {
    if (event === 'PASSWORD_RECOVERY') { win.setTimeout(() => showPasswordRecovery(), 0); return; }
    if (event === 'TOKEN_REFRESHED' && session?.user.id === nextSession?.user.id) { session = nextSession; return; }
    win.queueMicrotask(() => syncSession(nextSession));
  }).data.subscription;
  function showPasswordRecovery() {
    let d = $('recovery-dialog'); if (!d) { d = el('dialog', 'forum-dialog'); d.id = 'recovery-dialog'; doc.body.append(d); }
    const form = el('form', 'dialog-form'), label = el('label', '', 'Nueva contraseña'), input = el('input'); input.type = 'password'; input.minLength = 8; input.maxLength = 128; input.required = true; input.autocomplete = 'new-password'; label.append(input);
    const status = el('p', 'form-status'); status.id = 'recovery-status'; const submit = el('button', 'button primary', 'Guardar contraseña'); submit.type = 'submit'; form.append(el('h2', '', 'Recuperar tu cuenta'), label, status, submit); d.replaceChildren(form);
    form.addEventListener('submit', e => { e.preventDefault(); transact(form, 'recovery-status', async () => { const r = await client.auth.updateUser({ password: input.value }); if (r.error) throw r.error; d.close(); const next = await client.auth.getSession(); await syncSession(next.data.session); }); }); d.showModal();
  }
  const interval = win.setInterval(poll, 20000);
  client.auth.getSession().then(({ data, error }) => { if (error) say('app-status', friendlyError(error)); else if (data.session && !session) syncSession(data.session); });
  return { refreshList, syncSession, openTopic, destroy() { destroyed = true; epoch++; win.clearInterval(interval); subscription.unsubscribe(); }, getState: () => ({ member, topics, current, preview }) };
}

if (typeof document !== 'undefined' && document.getElementById('auth-form')) {
  const client = createClient(FORUM_CONFIG.url, FORUM_CONFIG.publishableKey, { auth: { storageKey: 'sx-forocromos-live', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  createForum({ client });
}
