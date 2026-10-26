import { createClient } from '@supabase/supabase-js';
import { FORUM_CONFIG } from './config.js';
import { CATEGORIES, SEED_TOPICS, PRINCIPLES } from './content.js';
import { DEFAULT_STYLE, normalizeStyle, renderBody as styledBody, attachComposer, PROFILE_STAGES, describeProgress, normalizeAvatar } from './community.js';
import { FILE_ACCEPT, fileSize, uploadReserved, removeReserved, downloadPrivate } from './files.js';
import { createNotifications, notificationTopic } from './notifications.js';
import { createActivity, activityTime } from './activity.js';

export function friendlyError(error) {
  const text = String(error?.message || error || '');
  if (/invalid login/i.test(text)) return 'El correo o la contraseña no coinciden.';
  if (/email not confirmed/i.test(text)) return 'Confirma tu correo antes de entrar.';
  if (/fc_file_too_large/.test(text)) return `Ese archivo supera el límite de ${text.split(':')[1] || '950 KB'}. Reduce su tamaño antes de subirlo.`;
  if (/fc_file_type|mime/i.test(text)) return 'Este tipo de archivo no se admite. Puedes adjuntar imágenes, PDF, texto, audio o vídeo.';
  if (/fc_empty_file/.test(text)) return 'El archivo está vacío. Elige otro.';
  if (/fc_.*(quota|storage|staging|daily)/i.test(text)) return 'Has alcanzado un cupo de archivos. Revisa los archivos sin publicar en Mi perfil o vuelve mañana.';
  if (/fc_.*file/i.test(text)) return 'No se pudo preparar el archivo. Comprueba su tamaño y vuelve a intentarlo.';
  if (/^(Elige una imagen|Este navegador|No se ha podido)/.test(text)) return text;
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
  let savedOnly = false, unreadOnly = false, busy = false, reportTarget = null, authBusy = false, destroyed = false, preview = true;
  let searchTimer, replyPage = 0, replyCount = 0, navigationVersion = 0;
  const drafts = new Map(), moderationPages = { members: 0, reports: 0, topics: 0, replies: 0 };
  const cards = new Map(), cardTimes = new Map(), staged = new Map(), styleDrafts = new Map(), objectUrls = new Map(), avatarLoads = new Map(), uploadsBusy = new Set();
  let visibleFiles = [], uploadPolicy = { attachment_limit: 950000, founder: false }, profileVersion = 0;
  let following = false, pendingNotificationTopic = notificationTopic(win.location.href);
  let pendingReplyId = (()=>{try{const id=new URL(win.location.href).searchParams.get('reply');return /^[0-9a-f-]{36}$/i.test(id||'')?id:null;}catch{return null;}})();
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
  const capture = () => {
    const scope = epoch, actor = session?.user.id;
    return () => { if (destroyed || scope !== epoch || actor !== session?.user.id || !admitted()) throw Object.assign(new Error('session_changed'), { code: 'FC_SESSION_CHANGED' }); };
  };
  const topicComposer = attachComposer({ doc, textarea: $('topic-body-input') });
  const replyComposer = attachComposer({ doc, textarea: $('reply-body'), onStyleChange: value => { if (current) styleDrafts.set(current.id, value); } });
  $('topic-body-input').before(topicComposer.element); $('reply-body').before(replyComposer.element);
  const topicUploads = uploadPanel(() => 'new-topic'), replyUploads = uploadPanel(() => current?.id);
  $('topic-body-input').after(topicUploads.element); $('reply-body').after(replyUploads.element);
  const notices = createNotifications({ doc, win, client, rpc, capture, isActive: admitted, onOpenTopic: id => openTopic({ id }), errorText: friendlyError });
  const activity = createActivity({doc,win,rpc,capture,isActive:admitted,loadAliases,memberLine,memberSignature:ids=>JSON.stringify(ids.map(id=>cards.get(id)||null)),onOpen:item=>openTopic({id:item.topic_id},{replyId:item.reply_id}),errorText:friendlyError});
  $('activity-mount')?.append(activity.element);

  function revokeUrls() {
    for (const value of objectUrls.values()) win.URL.revokeObjectURL(value);
    objectUrls.clear(); avatarLoads.clear();
  }
  function localUrl(id, blob) {
    if (objectUrls.has(id)) win.URL.revokeObjectURL(objectUrls.get(id));
    const url = win.URL.createObjectURL(blob); objectUrls.set(id, url); return url;
  }
  function uploadPanel(key) {
    const element = el('section', 'upload-panel'), label = el('label', 'upload-label', '📎 Adjuntar archivos'), input = el('input');
    input.type = 'file'; input.multiple = true; input.accept = FILE_ACCEPT; input.setAttribute('aria-label', 'Adjuntar archivos'); label.append(input);
    const help = el('p', 'field-help'), list = el('ul', 'staged-files'), status = el('p', 'form-status'); status.setAttribute('role', 'status');
    element.append(label, help, list, status);
    function render() {
      const id = key(), files = staged.get(id) || []; list.replaceChildren();
      help.textContent = `Hasta 3 archivos por mensaje · ${fileSize(uploadPolicy.attachment_limit)} por archivo${uploadPolicy.founder ? ' · acceso fundador' : ''}. Se descargan solo al abrirlos.`;
      input.disabled = uploadsBusy.has(id);
      for (const file of files) { const li = el('li'); li.append(el('span', '', `${file.file_name} · ${fileSize(file.byte_size)}`), button('Quitar', async () => {
        const check = capture(); try { await removeReserved({ file, client, rpc, check }); staged.set(id, (staged.get(id) || []).filter(f => f.id !== file.id)); render(); } catch (error) { if (error.code !== 'FC_SESSION_CHANGED') status.textContent = friendlyError(error); }
      }, 'text-button')); list.append(li); }
    }
    input.addEventListener('change', async () => {
      const id = key(), check = capture(), selected = [...input.files]; input.value = '';
      if (!id || uploadsBusy.has(id)) return;
      if ((staged.get(id)?.length || 0) + selected.length > 3) { status.textContent = 'Puedes adjuntar un máximo de tres archivos por mensaje.'; return; }
      uploadsBusy.add(id); render();
      try {
        for (const file of selected) {
          status.textContent = `Subiendo ${file.name}…`;
          const ready = await uploadReserved({ file, client, rpc, check, limit: uploadPolicy.attachment_limit }); check();
          staged.set(id, [...(staged.get(id) || []), ready]);
        }
        status.textContent = 'Archivos preparados. Se compartirán cuando publiques el mensaje.';
      } catch (error) { if (error.code !== 'FC_SESSION_CHANGED') status.textContent = friendlyError(error); }
      finally { uploadsBusy.delete(id); if (admitted()) render(); }
    });
    return { element, render, clear() { list.replaceChildren(); status.textContent = ''; input.value = ''; } };
  }
  function avatar(card) {
    const node = el('span', 'member-avatar', (card?.alias || 'C').slice(0, 1).toLocaleUpperCase('es')); node.setAttribute('aria-hidden', 'true');
    if (!card?.avatar) return node;
    const file = card.avatar, sessionCheck = capture();
    const check = () => { sessionCheck(); if (card.user_id && cards.get(card.user_id)?.avatar?.id !== file.id) throw Object.assign(new Error('avatar_changed'), { code: 'FC_SESSION_CHANGED' }); };
    const paint = url => { if (!node.isConnected) return; const img = el('img'); img.src = url; img.alt = ''; img.width = 48; img.height = 48; node.replaceChildren(img); };
    if (objectUrls.has(file.id)) win.queueMicrotask(() => paint(objectUrls.get(file.id)));
    else {
      if (!avatarLoads.has(file.id)) avatarLoads.set(file.id, downloadPrivate({ file, client, check }).then(blob => { check(); return localUrl(file.id, blob); }).catch(() => null).finally(() => avatarLoads.delete(file.id)));
      avatarLoads.get(file.id).then(url => { try { check(); if (url) paint(url); } catch {} });
    }
    return node;
  }
  function memberLine(id, { detailed = false } = {}) {
    const card = cards.get(id), line = el('div', detailed ? 'member-line detailed' : 'member-line');
    if (!card) { line.append(el('strong', '', id === session?.user.id ? member?.alias || author(id) : author(id))); return line; }
    const progress = describeProgress(card), info = el('div', 'member-info');
    info.append(button(card.alias, () => showMemberCard(card), 'member-name'));
    const badges = el('div', 'member-badges'); badges.append(el('span', 'member-level', progress.stage.label));
    if (card.role === 'moderator' || card.role === 'helper') badges.append(el('span', 'staff-badge', card.role === 'moderator' ? 'Moderación' : 'Ayudante'));
    info.append(badges);
    if (detailed) { info.append(el('span', 'member-stats', `${card.topic_count || 0} temas · ${card.reply_count || 0} respuestas · ${progress.days} días aquí`)); if (card.tagline) info.append(el('p', 'member-tagline', card.tagline)); }
    line.append(avatar(card), info); return line;
  }
  function renderSelf() {
    const panel = $('my-community-card'); panel.replaceChildren(); show('my-community-card', admitted());
    if (!admitted()) return;
    const card = cards.get(session?.user.id); if (card) panel.append(memberLine(card.user_id, { detailed: true }), button('Editar mi perfil', openProfile, 'text-button'));
  }
  function showMemberCard(card) {
    let d = $('member-dialog'); if (!d) { d = el('dialog', 'forum-dialog'); d.id = 'member-dialog'; doc.body.append(d); }
    d.dataset.userId = card.user_id;
    d.replaceChildren(el('h2', '', 'Una voz de la comunidad'), memberLine(card.user_id, { detailed: true }), el('p', 'field-help', `Se unió el ${date(card.created_at)}. El rango reconoce trayectoria; no garantiza la veracidad de sus mensajes.`), button('Cerrar', () => d.close())); d.showModal();
  }
  function renderFiles(container, records) {
    if (!records.length) return;
    const list = el('ul', 'post-files');
    for (const file of records) {
      const item = el('li'), status = el('span', 'field-help');
      item.append(el('span', 'file-caption', `${file.file_name} · ${fileSize(file.byte_size)}`));
      const isImage = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mime_type);
      const access = button(isImage ? 'Ver imagen' : 'Descargar', async () => {
        const sessionCheck = capture(), origin = current?.id;
        const check = () => { sessionCheck(); if (origin !== current?.id || !visibleFiles.some(f => f.id === file.id)) throw Object.assign(new Error('file_no_longer_visible'), { code: 'FC_SESSION_CHANGED' }); };
        access.disabled = true; status.textContent = 'Abriendo…';
        try {
          const blob = await downloadPrivate({ file, client, check }); check();
          if (isImage) {
            let d = $('media-dialog'); if (!d) { d = el('dialog', 'forum-dialog media-dialog'); d.id = 'media-dialog'; doc.body.append(d); }
            const img = el('img'); img.alt = file.file_name; img.src = localUrl(`media-${file.id}`, blob);
            d.replaceChildren(el('h2', '', file.file_name), img, button('Cerrar imagen', () => { d.close(); const id = `media-${file.id}`; win.URL.revokeObjectURL(objectUrls.get(id)); objectUrls.delete(id); })); d.showModal();
          } else {
            const url = localUrl(`download-${file.id}`, new win.Blob([blob], { type: 'application/octet-stream' })), link = el('a'); link.href = url; link.download = file.file_name; doc.body.append(link); link.click(); link.remove();
            win.setTimeout(() => { if (objectUrls.get(`download-${file.id}`) === url) { win.URL.revokeObjectURL(url); objectUrls.delete(`download-${file.id}`); } }, 1000);
          }
          status.textContent = '';
        } catch (error) { if (error.code !== 'FC_SESSION_CHANGED') status.textContent = friendlyError(error); }
        finally { access.disabled = false; }
      }, 'text-button'); item.append(access);
      if (file.owner_id === session?.user.id) item.append(button('Retirar archivo', async () => {
        if (!win.confirm('¿Retirar este archivo del mensaje?')) return;
        try { await removeReserved({ file, client, rpc, check: capture() }); if (current) await openTopic(current, { quiet: true }); } catch (error) { if (error.code !== 'FC_SESSION_CHANGED') status.textContent = friendlyError(error); }
      }, 'text-button'));
      item.append(status); list.append(item);
    }
    container.append(list);
  }
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
    const controls = [...form.querySelectorAll('button,input,textarea,select')].map(node => [node, node.disabled]); controls.forEach(([node]) => node.disabled = true);
    try { say(status, 'Guardando…'); await operation(); }
    catch (error) { if (error?.code !== 'FC_SESSION_CHANGED') say(status, friendlyError(error)); }
    finally { form.dataset.busy = 'false'; controls.forEach(([node, disabled]) => node.disabled = disabled); }
  }
  function clearPrivate() {
    topics = []; aliases.clear(); saves.clear(); current = null; topicVersion++; listVersion++;
    navigationVersion=0;
    cards.clear(); cardTimes.clear(); staged.clear(); styleDrafts.clear(); visibleFiles = []; profileVersion++; revokeUrls();
    notices.reset(); activity.reset(); following = false;
    uploadPolicy = { attachment_limit: 950000, founder: false }; uploadsBusy.clear(); topicComposer.reset(); replyComposer.reset(); topicUploads.clear(); replyUploads.clear();
    for (const id of ['topics-list', 'topic-posts', 'topic-body', 'topic-controls', 'moderation-list', 'topic-title', 'topic-author', 'topic-category', 'topic-status', 'reply-status', 'report-status']) $(id)?.replaceChildren();
    for (const id of ['topic-title-input', 'topic-body-input', 'reply-body', 'report-body', 'auth-password']) if ($(id)) $(id).value = '';
    for (const id of ['topic-dialog', 'report-dialog']) close(id);
    for (const id of ['edit-dialog', 'profile-dialog', 'recovery-dialog', 'member-dialog', 'media-dialog']) { close(id); $(id)?.remove(); }
    $('my-community-card')?.replaceChildren(); show('my-community-card', false);
    reportTarget = null; savedOnly = false; unreadOnly=false; page = 0;
    drafts.clear(); replyPage = 0; replyCount = 0;
    $('saved-toggle')?.setAttribute('aria-pressed', 'false');
    $('all-topics-filter')?.setAttribute('aria-pressed','true');$('unread-topics-filter')?.setAttribute('aria-pressed','false');
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
    show('notifications-button', active);
    show('my-community-card', active); show('progression-button', active);
    show('activity-filters',active);if(!active)activity.element.hidden=true;
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
      const unread=Number(topic.unread_count)||0;if(unread||topic.topic_unread)row.classList.add('topic-has-unread');
      meta.append(el('span', 'category-tag', catLabel(topic.category)));
      if (topic.pinned) meta.append(el('span', 'topic-badge', 'Fijado'));
      if (topic.closed) meta.append(el('span', 'topic-badge', 'Cerrado'));
      if(topic.topic_unread)meta.append(el('span','topic-unread-badge','Nuevo hilo'));
      if(unread)meta.append(el('span','topic-unread-badge',`${unread} ${unread===1?'respuesta nueva':'respuestas nuevas'}`));
      main.append(meta);
      const heading = el('h3'); heading.append(button(topic.title, () => openTopic(topic,{resume:true}), 'topic-title-button')); main.append(heading);
      main.append(el('p', 'topic-excerpt', topic.body.slice(0, 160).split('\n')[0]));
      const foot = el('div', 'topic-meta'); foot.append(el('span', '', topic.editorial ? 'Apertura del equipo' : author(topic.author_id))); if (topic.created_at) foot.append(el('span', '', date(topic.created_at))); main.append(foot);
      if(admitted()&&topic.last_activity_at){const meta=el('div','topic-activity'),count=Number(topic.reply_count??topic.replies_count)||0,label=activityTime(topic.last_activity_at);meta.append(el('span','topic-reply-count',`${count} ${count===1?'respuesta':'respuestas'}`));const latest=button(`Última: ${topic.last_author_id?author(topic.last_author_id):'Equipo'} · ${label.text}`,()=>openTopic(topic,{replyId:topic.last_reply_id}),'topic-last-post');latest.title=label.absolute;meta.append(latest);main.append(meta);}
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
  async function loadAliases(ids,{expectedAliases=new Map()}={}) {
    const scope = epoch;
    const missing = [...new Set(ids.filter(Boolean))].filter(id => !cards.has(id) || Date.now() - (cardTimes.get(id) || 0) > 60000 || (expectedAliases.has(id)&&expectedAliases.get(id)!==cards.get(id)?.alias));
    if (!missing.length) return;
    const data = await rpc('fc_profile_cards', { p_ids: missing });
    if (scope !== epoch) return;
    const returned = new Set((data || []).map(card => card.user_id));
    for (const id of missing) if (!returned.has(id)) {
      const avatarId = cards.get(id)?.avatar?.id, url = objectUrls.get(avatarId);
      if (url) win.URL.revokeObjectURL(url); objectUrls.delete(avatarId); cards.delete(id); cardTimes.delete(id); aliases.delete(id);
      if ($('member-dialog')?.dataset.userId === id) { close('member-dialog'); $('member-dialog')?.remove(); }
    }
    for (const a of data || []) { aliases.set(a.user_id, a.alias); cards.set(a.user_id, a); cardTimes.set(a.user_id, Date.now()); }
    renderSelf();
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
      const order=$('sort-select')?.value,result=await rpc('fc_topics_page',{p_category:category||null,p_search:search||null,p_saved_only:savedOnly,p_unread_only:unreadOnly,p_order:order==='pinned'?'pinned':order==='newest'?'newest':'activity',p_limit:20,p_offset:page*20});
      if(!Array.isArray(result?.items))throw new Error('fc_invalid_activity_response');
      if (scope !== epoch || version !== listVersion) return;
      await loadAliases(result.items.flatMap(t=>[t.author_id,t.last_author_id]));
      if (scope !== epoch || version !== listVersion) return;
      saves = nextSaves; topics = result.items; count = result.total || 0;
      renderTopics(); say('app-status', win.navigator.onLine === false ? 'Sin conexión.' : 'Conversaciones actualizadas.');if(!current)await activity.sync();
    } catch (error) { if (scope === epoch && version === listVersion) { if (expired(error)) expireAccess(); else say('app-status', friendlyError(error)); } }
  }
  function renderBody(container, text, style) {
    container.replaceChildren(styledBody(doc, text, style));
  }
  function renderTopic(topic, posts = []) {
    if (current?.id !== topic.id) {
      if (current && admitted()) drafts.set(current.id, $('reply-body').value);
      if (current && admitted()) styleDrafts.set(current.id, replyComposer.getStyle());
      $('reply-body').value = drafts.get(topic.id) || '';
      replyComposer.setStyle(styleDrafts.get(topic.id) || cards.get(session?.user.id) || DEFAULT_STYLE);
      say('reply-status', '');
    }
    current = topic; show('list-view', false); show('topic-view', true);activity.element.hidden=true;
    say('topic-category', catLabel(topic.category)); say('topic-title', topic.title);
    $('topic-author').replaceChildren(topic.editorial ? el('span', '', 'Equipo Foro Cromos') : memberLine(topic.author_id, { detailed: true }), el('span', '', activityTime(topic.created_at).absolute||date(topic.created_at)));
    renderBody($('topic-body'), topic.body, topic.style);
    renderFiles($('topic-body'), visibleFiles.filter(f => f.topic_id === topic.id && !f.reply_id));
    const postList = $('topic-posts'); postList.replaceChildren();
    for (const post of posts) {
      const card = el('article', 'post'), header = el('div', 'post-header');card.dataset.replyId=post.id;
      header.append(memberLine(post.author_id, { detailed: true }), el('span', '', activityTime(post.created_at).absolute)); card.append(header);
      const body = el('div', 'post-body'); renderBody(body, post.body, post.style); renderFiles(body, visibleFiles.filter(f => f.reply_id === post.id)); card.append(body);
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
      if (replyPage > 0) pages.append(button('← Respuestas anteriores', () => { replyPage--; openTopic(topic); }));
      pages.append(el('span', '', `Página ${replyPage + 1} de ${Math.ceil(replyCount / 50)}`));
      if ((replyPage + 1) * 50 < replyCount) pages.append(button('Respuestas siguientes →', () => { replyPage++; openTopic(topic); }));
      postList.append(pages);
    }
    const controls = $('topic-controls'); controls.replaceChildren();
    if (admitted()) {
      controls.append(button(saves.has(topic.id) ? 'Quitar de guardados' : 'Guardar hilo', () => toggleSave(topic.id)));
      controls.append(button(following ? 'Siguiendo · silenciar avisos' : 'Seguir este hilo', async () => {
        try {
          const result = await rpc('fc_follow_topic', { p_topic_id: topic.id, p_follow: !following });
          if (current?.id === topic.id) { following = result.following; await openTopic(topic, { quiet: true }); }
        } catch (error) { if (error.code !== 'FC_SESSION_CHANGED') say('app-status', friendlyError(error)); }
      }, 'text-button'));
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
    replyUploads.render();
    say('topic-status', topic.closed ? 'Hilo cerrado. Puedes leerlo y avisar a moderación.' : preview ? 'Apertura editorial. El contenido de la comunidad requiere acceso.' : 'Responde a tu ritmo. Tu alias será visible para la comunidad admitida.');
  }
  async function openTopic(topic, { quiet = false, replyId = null, resume = false } = {}) {
    if(quiet&&navigationVersion)return;
    if (preview) {
      const editorial = SEED_TOPICS.find(t => `opening-${t.slug}` === topic.id);
      if (!editorial) return;
      renderTopic({ ...editorial, id: topic.id, editorial: true }); $('topic-title')?.focus(); return;
    }
    if (current?.id !== topic.id) replyPage = 0;
    const version = ++topicVersion, scope = epoch;
    if(!quiet)navigationVersion=version;
    try {
      const targetReply=replyId||(resume?topic.first_unread_reply_id:null);
      if(targetReply){const location=await rpc('fc_locate_reply',{p_topic_id:topic.id,p_reply_id:targetReply});if(scope!==epoch||version!==topicVersion)return;replyPage=Number(location?.reply_page)||0;}
      const [head, posts] = await Promise.all([
        client.from('fc_topics').select('*').eq('id', topic.id).eq('hidden', false).maybeSingle(),
        client.from('fc_replies').select('*', { count: 'exact' }).eq('topic_id', topic.id).eq('hidden', false).order('created_at').order('id').range(replyPage * 50, replyPage * 50 + 49)
      ]);
      if (head.error) throw head.error; if (posts.error) throw posts.error;
      if (scope !== epoch || version !== topicVersion) return;
      if (!head.data) {
        current = null; visibleFiles = []; close('media-dialog'); $('media-dialog')?.replaceChildren(); revokeUrls();
        for (const id of ['topic-title','topic-author','topic-body','topic-posts','topic-controls']) $(id)?.replaceChildren();
        renderSelf(); show('topic-view', false); show('list-view', true); say('app-status', 'Este hilo ya no está disponible.'); await refreshList(); return;
      }
      await loadAliases([head.data.author_id, ...(posts.data || []).map(p => p.author_id)]);
      if (scope !== epoch || version !== topicVersion) return;
      const replies = (posts.data || []).map(p => p.id);
      const [topicFiles, replyFiles] = await Promise.all([
        client.from('fc_files').select('*').eq('topic_id', topic.id).is('reply_id', null).eq('status', 'linked'),
        replies.length ? client.from('fc_files').select('*').in('reply_id', replies).eq('status', 'linked') : { data: [] }
      ]);
      if (topicFiles.error) throw topicFiles.error; if (replyFiles.error) throw replyFiles.error;
      if (scope !== epoch || version !== topicVersion) return;
      const nextFiles = [...(topicFiles.data || []), ...(replyFiles.data || [])], allowedIds = new Set([...nextFiles.map(f => `media-${f.id}`), ...cards.values()].map(c => typeof c === 'string' ? c : c.avatar?.id).filter(Boolean));
      const nextFollowing = await rpc('fc_is_following', { p_topic_id: topic.id });
      if (scope !== epoch || version !== topicVersion) return;
      for (const [key, url] of objectUrls) if (!key.startsWith('download-') && !allowedIds.has(key)) { win.URL.revokeObjectURL(url); objectUrls.delete(key); if (key.startsWith('media-')) { close('media-dialog'); $('media-dialog')?.replaceChildren(); } }
      visibleFiles = nextFiles; following = nextFollowing;
      const focusedReply=quiet?doc.activeElement?.closest?.('[data-reply-id]')?.dataset.replyId:null;
      replyCount = posts.count || 0; renderTopic(head.data, posts.data || []);
      if(quiet&&focusedReply&&!doc.querySelector('dialog[open]')){const focused=[...$('topic-posts').querySelectorAll('[data-reply-id]')].find(n=>n.dataset.replyId===focusedReply);if(focused){focused.tabIndex=-1;focused.focus({preventScroll:true});}}
      if (!quiet) {
        const target=targetReply?[...$('topic-posts').querySelectorAll('[data-reply-id]')].find(n=>n.dataset.replyId===targetReply):null;
        if(target){target.tabIndex=-1;target.focus();}else $('topic-title')?.focus();
        const href=new URL(win.location.href);href.searchParams.set('topic',topic.id);if(targetReply)href.searchParams.set('reply',targetReply);else href.searchParams.delete('reply');win.history.replaceState(win.history.state,'',href.href);
        await rpc('fc_mark_topic_read',{p_topic_id:topic.id,p_reply_ids:(posts.data||[]).filter(p=>!p.withdrawn_at&&!p.hidden).map(p=>p.id),p_topic_seen:!head.data.withdrawn_at});
        if(scope!==epoch||version!==topicVersion)return;await refreshList({quiet:true});
      }
    } catch (error) { if (scope === epoch && version === topicVersion) { if (expired(error)) expireAccess(); else say('app-status', friendlyError(error)); } }
    finally{if(navigationVersion===version)navigationVersion=0;}
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
    const composer = attachComposer({ doc, textarea: area, style: post.style });
    const submit = el('button', 'button primary', 'Guardar cambios'); submit.type = 'submit'; form.append(heading, composer.element, label, status, submit, button('Cancelar', () => d.close())); d.append(form);
    form.addEventListener('submit', event => { event.preventDefault(); transact(form, 'edit-status', async () => { await rpc('fc_update_post', { p_kind: kind, p_id: post.id, p_body: area.value.trim(), p_style: composer.getStyle() }); d.close(); if (current) await openTopic(current, { quiet: true }); await refreshList(); }); }); d.showModal();
  }
  function openProfile() {
    if (!admitted()) return;
    let d = $('profile-dialog'); if (d?.open) return;
    if (!d) { d = el('dialog', 'forum-dialog wide-dialog'); d.id = 'profile-dialog'; doc.body.append(d); }
    const check = capture(), version = ++profileVersion, card = cards.get(session.user.id) || member;
    let chosenAvatar = card.avatar || null, avatarBusy = false;
    const valid = () => { check(); if (version !== profileVersion || !d.open) throw Object.assign(new Error('profile_closed'), { code: 'FC_SESSION_CHANGED' }); };
    d.replaceChildren(); d.setAttribute('aria-labelledby', 'profile-heading');
    const form = el('form', 'dialog-form stack-form'), heading = el('h2', '', 'Mi perfil de Foro Cromos'); heading.id = 'profile-heading';
    const subtitle = el('p', 'dialog-description', 'Tu identidad aquí es propia del foro. Tú eliges el alias, la imagen y la frase que compartes con las compañeras admitidas.');
    const summary = el('div', 'profile-summary'); summary.append(memberLine(session.user.id, { detailed: true }));
    const aliasLabel = el('label', '', 'Tu alias en el foro'), alias = el('input'); alias.id = 'profile-alias'; alias.value = member.alias; alias.required = true; alias.minLength = 2; alias.maxLength = 36; alias.autocomplete = 'nickname'; aliasLabel.htmlFor = alias.id;
    const phraseLabel = el('label', '', 'Tu frase personal'), phrase = el('input'); phrase.id = 'profile-tagline'; phrase.value = card.tagline || ''; phrase.maxLength = 160; phrase.placeholder = 'Una frase tuya, si te apetece'; phraseLabel.htmlFor = phrase.id;
    const avatarLabel = el('label', '', 'Tu avatar'), input = el('input'); input.id = 'profile-avatar'; input.type = 'file'; input.accept = 'image/jpeg,image/png,image/webp'; avatarLabel.htmlFor = input.id;
    const image = el('div', 'profile-avatar-actions'); image.append(avatar(card));
    const status = el('p', 'form-status'); status.id = 'profile-status'; status.setAttribute('role', 'status');
    const previewLabel = el('label', '', 'Tu estilo de escritura preferido'), area = el('textarea'); area.id = 'profile-preview'; area.rows = 2; area.maxLength = 160; area.value = card.tagline || 'Mi voz, a mi manera. ✨'; previewLabel.htmlFor = area.id;
    const composer = attachComposer({ doc, textarea: area, style: card });
    const save = el('button', 'button primary', 'Guardar mi perfil'); save.type = 'submit';
    image.append(button('Quitar avatar', () => { if (avatarBusy) return; chosenAvatar = null; image.replaceChildren(avatar({ alias: alias.value }), button('Sin imagen · puedes elegir otra arriba', () => input.click(), 'text-button')); }, 'text-button'));
    form.append(heading, subtitle, summary, avatarLabel, input, image, el('p', 'field-help', 'JPEG, PNG o WebP · hasta 950 KB. Guardamos una copia cuadrada de 256 píxeles y retiramos los metadatos de la imagen.'), aliasLabel, alias, phraseLabel, phrase, previewLabel, composer.element, area, status, save, button('Cerrar sin guardar', () => d.close()));
    const unused = el('section', 'unused-files'), unusedStatus = el('p', 'field-help'), unusedList = el('ul', 'staged-files');
    unused.append(el('h3', '', 'Archivos sin publicar'), el('p', 'field-help', 'Aquí puedes eliminar subidas que dejaste a medias y avatares sustituidos. Cancelar una subida no recupera el cupo de reservas del día.'), unusedStatus, unusedList);
    async function loadUnused() {
      try {
        const files = await rpc('fc_my_files'); valid(); unusedList.replaceChildren();
        const candidates = (files || []).filter(file => file.id !== chosenAvatar?.id);
        unusedStatus.textContent = candidates.length ? `${candidates.length} archivos pendientes de limpieza.` : 'No tienes archivos pendientes de limpieza.';
        for (const file of candidates) {
          const row = el('li'); row.append(el('span', '', `${file.file_name} · ${fileSize(file.byte_size)}`), button('Eliminar archivo', async () => {
            try {
              await removeReserved({ file, client, rpc, check: valid }); valid();
              for (const [key, values] of staged) staged.set(key, values.filter(f => f.id !== file.id)); topicUploads.render(); replyUploads.render(); await loadUnused();
            } catch (error) { if (error.code !== 'FC_SESSION_CHANGED') unusedStatus.textContent = friendlyError(error); }
          }, 'text-button')); unusedList.append(row);
        }
      } catch (error) { if (error.code !== 'FC_SESSION_CHANGED') unusedStatus.textContent = friendlyError(error); }
    }
    unused.prepend(button('Revisar archivos pendientes', loadUnused, 'text-button'));
    d.append(form, notices.settingsPanel(), unused); d.addEventListener('close', () => { if (version === profileVersion) profileVersion++; composer.destroy(); }, { once: true }); d.showModal();
    input.addEventListener('change', async () => {
      const file = input.files[0]; input.value = ''; if (!file || avatarBusy) return;
      avatarBusy = true; save.disabled = true; input.disabled = true; status.textContent = 'Preparando tu avatar…';
      try {
        const normalized = await normalizeAvatar(file, { win }); valid();
        const ready = await uploadReserved({ file: normalized, purpose: 'avatar', limit: 950000, client, rpc, check: valid }); valid();
        const previous = chosenAvatar;
        chosenAvatar = { id: ready.id, bucket_id: ready.bucket_id, object_path: ready.object_path };
        image.replaceChildren(avatar({ alias: alias.value, avatar: chosenAvatar }), button('Cambiar imagen', () => input.click(), 'text-button'), button('Quitar avatar', () => { chosenAvatar = null; image.replaceChildren(avatar({ alias: alias.value })); }, 'text-button'));
        status.textContent = 'Avatar preparado. Pulsa Guardar mi perfil para usarlo.';
        if (previous && previous.id !== card.avatar?.id) await removeReserved({ file: previous, client, rpc, check: valid });
      } catch (error) { if (error.code !== 'FC_SESSION_CHANGED') status.textContent = friendlyError(error); }
      finally { avatarBusy = false; if (version === profileVersion) { save.disabled = false; input.disabled = false; } }
    });
    form.addEventListener('submit', event => {
      event.preventDefault(); if (avatarBusy) return;
      transact(form, 'profile-status', async () => {
        const profile = await rpc('fc_profile_details', { p_alias: alias.value.trim(), p_tagline: phrase.value.trim(), p_avatar: chosenAvatar?.id || null, p_font: composer.getStyle().font, p_color: composer.getStyle().color }); valid();
        member = { ...member, alias: profile.alias }; aliases.set(profile.user_id, profile.alias); cards.set(profile.user_id, profile); cardTimes.set(profile.user_id, Date.now());
        if (card.avatar && card.avatar.id !== profile.avatar?.id) { const oldUrl = objectUrls.get(card.avatar.id); if (oldUrl) win.URL.revokeObjectURL(oldUrl); objectUrls.delete(card.avatar.id); removeReserved({ file: card.avatar, client, rpc, check }).catch(() => {}); }
        if (!$('topic-body-input').value) topicComposer.setStyle(profile); if (!$('reply-body').value) replyComposer.setStyle(profile);
        updateGate(); renderSelf(); d.close(); say('app-status', 'Tu perfil de Foro Cromos está guardado.'); await refreshList({ quiet: true }); if (current) await openTopic(current, { quiet: true });
      });
    });
    const progress = describeProgress(card);
    summary.append(el('p', 'field-help', `En la comunidad desde el ${date(card.created_at)}. ${progress.nextStage ? `Siguiente etapa: ${progress.nextStage.label}.` : 'Has alcanzado la etapa veterana.'}`));
    loadUnused();
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
      }));
      if (uploadPolicy.founder && m.status === 'active' && m.user_id !== session.user.id) {
        const label = el('label', '', `Función de ${m.alias}`), select = el('select'); select.setAttribute('aria-label', `Función de ${m.alias}`);
        for (const [value, text] of [['member', 'Compañera'], ['helper', 'Ayudante'], ['moderator', 'Moderación']]) { const option = el('option', '', text); option.value = value; select.append(option); } select.value = m.role; label.append(select);
        row.append(label, button('Aplicar función', async () => {
          if (!win.confirm(`¿Asignar a ${m.alias} la función «${select.selectedOptions[0].textContent}»? La moderación permite revisar avisos confidenciales y gestionar el acceso. Acuerda antes esta responsabilidad con ella.`)) return;
          try { await rpc('fc_assign_role', { p_user_id: m.user_id, p_role: select.value }); cards.delete(m.user_id); await loadModeration(); say('app-status', 'Función actualizada.'); } catch (error) { say('app-status', friendlyError(error)); }
        }, 'text-button'));
      }
      list.append(row);
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
      member = result.data; updateGate();
      if (admitted()) {
        await hydrateSelf(); if (scope !== epoch) return;
      }
      if (changed || !admitted()) await refreshList(); else await refreshList({ quiet: true });
      if (admitted() && pendingNotificationTopic) { const id = pendingNotificationTopic,replyId=pendingReplyId; pendingNotificationTopic = pendingReplyId=null; await openTopic({ id },{replyId}); }
    } catch (error) { if (scope === epoch) { clearPrivate(); updateGate(); await refreshList(); say('join-message', friendlyError(error)); } }
  }
  async function hydrateSelf() {
    const scope = epoch, actor = session.user.id;
    const policy = await rpc('fc_upload_policy'); if (scope !== epoch) return; uploadPolicy = policy;
    await loadAliases([actor]); if (scope !== epoch) return;
    if (!$('topic-body-input').value) topicComposer.setStyle(cards.get(actor));
    if (!$('reply-body').value) replyComposer.setStyle(cards.get(actor));
    topicUploads.render(); replyUploads.render(); renderSelf();
    notices.sync().catch(error => { if (error.code !== 'FC_SESSION_CHANGED') say('app-status', 'El foro está conectado. No se pudo actualizar la campana; se intentará de nuevo.'); });
    notices.restoreDevice();
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
  bind('logout-button', 'click', async () => { notices.detachDevice().catch(() => {}); clearPrivate(); session = null; member = null; epoch++; updateGate(); await refreshList(); await client.auth.signOut({ scope: 'local' }); });
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
  bind('all-topics-filter','click',()=>{unreadOnly=false;page=0;$('all-topics-filter').setAttribute('aria-pressed','true');$('unread-topics-filter').setAttribute('aria-pressed','false');refreshList();});
  bind('unread-topics-filter','click',()=>{unreadOnly=true;page=0;$('all-topics-filter').setAttribute('aria-pressed','false');$('unread-topics-filter').setAttribute('aria-pressed','true');refreshList();});
  bind('saved-toggle', 'click', () => { savedOnly = !savedOnly; $('saved-toggle').setAttribute('aria-pressed', String(savedOnly)); page = 0; refreshList(); });
  bind('new-topic-button', 'click', () => { if (admitted()) { say('topic-form-status', ''); if (!$('topic-body-input').value) topicComposer.setStyle(cards.get(session.user.id)); topicUploads.render(); dialog('topic-dialog'); } });
  bind('topic-form', 'submit', e => { e.preventDefault(); transact(e.currentTarget, 'topic-form-status', async () => {
    if (uploadsBusy.has('new-topic')) throw new Error('fc_file_upload_pending');
    const topic = await rpc('fc_publish', { p_kind: 'topic', p_topic_id: null, p_category: $('topic-category-input').value, p_title: $('topic-title-input').value.trim(), p_body: $('topic-body-input').value.trim(), p_style: topicComposer.getStyle(), p_files: (staged.get('new-topic') || []).map(f => f.id) });
    staged.delete('new-topic'); topicUploads.clear(); cardTimes.delete(session.user.id); $('topic-form').reset(); close('topic-dialog'); page = 0; say('app-status', 'Tu tema está publicado.');
    try { await loadAliases([session.user.id]); } catch (error) { if (error.code === 'FC_SESSION_CHANGED') throw error; say('app-status', 'Tu tema está publicado. No se pudo actualizar el contador; se intentará de nuevo.'); }
    await refreshList(); await openTopic(topic);
  }); });
  bind('reply-form', 'submit', e => { e.preventDefault(); const topic = current, text = $('reply-body').value; transact(e.currentTarget, 'reply-status', async () => {
    if (uploadsBusy.has(topic.id)) throw new Error('fc_file_upload_pending');
    await rpc('fc_publish', { p_kind: 'reply', p_topic_id: topic.id, p_category: null, p_title: null, p_body: text.trim(), p_style: replyComposer.getStyle(), p_files: (staged.get(topic.id) || []).map(f => f.id) }); drafts.delete(topic.id); staged.delete(topic.id); styleDrafts.delete(topic.id); cardTimes.delete(session.user.id); replyUploads.render();
    if (current?.id === topic.id) { if ($('reply-body').value === text) $('reply-body').value = ''; replyPage = Math.floor(replyCount / 50); say('reply-status', 'Tu respuesta está publicada.'); await openTopic(topic, { quiet: true }); }
    else say('app-status', `Tu respuesta está publicada en «${topic.title}».`);
    try { await loadAliases([session.user.id]); } catch (error) { if (error.code === 'FC_SESSION_CHANGED') throw error; say('app-status', 'Tu respuesta está publicada. No se pudo actualizar el contador; se intentará de nuevo.'); }
  }); });
  bind('back-topics', 'click', () => { if (current && admitted()) { drafts.set(current.id, $('reply-body').value); styleDrafts.set(current.id, replyComposer.getStyle()); } $('reply-body').value = ''; current = null; topicVersion++; show('topic-view', false); show('list-view', true); close('media-dialog'); $('media-dialog')?.replaceChildren();const href=new URL(win.location.href);href.searchParams.delete('topic');href.searchParams.delete('reply');win.history.replaceState(win.history.state,'',href.href);refreshList(); });
  bind('report-open', 'click', () => openReport());
  bind('report-form', 'submit', e => { e.preventDefault(); transact(e.currentTarget, 'report-status', async () => { await rpc('fc_report', { p_topic_id: reportTarget?.topicId || null, p_reply_id: reportTarget?.replyId || null, p_body: $('report-body').value.trim() }); $('report-body').value = ''; say('report-status', 'Aviso guardado para moderación. No se ha publicado en el foro.'); }); });
  bind('open-manifesto', 'click', () => dialog('manifesto-dialog'));
  const principles = $('manifesto-list'); principles.replaceChildren();
  for (const p of PRINCIPLES) { const item = el('li', 'principle'); item.append(el('h3', '', p.title), el('p', '', p.body)); principles.append(item); }
  const categorySelect = $('topic-category-input'); categorySelect.replaceChildren(); for (const c of CATEGORIES) { const option = el('option', '', c.label); option.value = c.id; categorySelect.append(option); }
  bind('moderation-button', 'click', () => { if (!$('moderation-panel').hidden) show('moderation-panel', false); else loadModeration(); });
  bind('profile-button', 'click', openProfile);
  bind('progression-button', 'click', () => {
    let d = $('progression-dialog'); if (!d) { d = el('dialog', 'forum-dialog wide-dialog'); d.id = 'progression-dialog'; doc.body.append(d); }
    const list = el('ol', 'progression-list');
    for (const stage of PROFILE_STAGES) { const li = el('li'); li.append(el('h3', '', stage.label), el('p', '', `${stage.minDays} días · ${stage.minContributions} aportaciones${stage.minActiveDays ? ` · participación en ${stage.minActiveDays} días distintos` : ''}`), el('p', 'field-help', stage.description)); list.append(li); }
    d.replaceChildren(el('h2', '', 'Tu trayectoria en Foro Cromos'), el('p', '', 'Desde la admisión puedes publicar, adjuntar archivos, elegir avatar y dar estilo a tus mensajes. Las etapas reconocen tiempo y participación; no conceden autoridad sobre otras personas.'), list, el('p', '', 'Desde los 90 días puedes plantear una ayudantía al equipo mediante Aviso confidencial. Las ayudantes orientan; la moderación se asigna por invitación y acuerdo. Solo los fundadores pueden cambiar estas funciones.'), button('Cerrar', () => d.close())); d.showModal();
  });
  async function poll() {
    if (destroyed || doc.hidden || busy || !session) return;
    busy = true; const scope = epoch;
    try {
      const r = await client.from('fc_members').select('*').eq('user_id', session.user.id).maybeSingle(); if (r.error) throw r.error;
      if (scope !== epoch) return;
      if (r.data?.status !== member?.status || r.data?.role !== member?.role) { epoch++; clearPrivate(); member = r.data; updateGate(); if (admitted()) await hydrateSelf(); }
      else { member = r.data; updateGate(); }
      if (admitted()) {
        await refreshList({ quiet: true }); if (current) await openTopic(current, { quiet: true });
        await notices.sync();
        if (pendingNotificationTopic) { const id = pendingNotificationTopic,replyId=pendingReplyId; pendingNotificationTopic = pendingReplyId=null; await openTopic({ id },{replyId}); }
      } else await refreshList();
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
  return { refreshList, syncSession, openTopic, destroy() { destroyed = true; epoch++; revokeUrls(); notices.destroy(); activity.destroy(); topicComposer.destroy(); replyComposer.destroy(); win.clearInterval(interval); subscription.unsubscribe(); }, getState: () => ({ member, topics, current, preview }) };
}

if (typeof document !== 'undefined' && document.getElementById('auth-form')) {
  const client = createClient(FORUM_CONFIG.url, FORUM_CONFIG.publishableKey, { auth: { storageKey: 'sx-forocromos-live', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  createForum({ client });
}
