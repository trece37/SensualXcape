export function activityTime(value, { now = Date.now(), locale = 'es-ES' } = {}) {
  if(!value)return {text:'',absolute:''};
  const time = new Date(value), stamp = time.getTime();
  if (!Number.isFinite(stamp)) return { text: '', absolute: '' };
  const minutes = Math.max(0, Math.floor((now - stamp) / 60000));
  const text = minutes < 1 ? 'ahora' : minutes < 60 ? `hace ${minutes} min` : minutes < 1440 ? `hace ${Math.floor(minutes / 60)} h` : new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(time);
  return { text, absolute: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(time) };
}

/** Publication activity, never a list of connected people or private visits. */
export function createActivity({ doc, win, rpc, capture, isActive, loadAliases, memberLine, memberSignature=()=>'', onOpen, errorText }) {
  const el = (tag, cls, text) => { const node = doc.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const button = (text, fn, cls = 'text-button') => { const node = el('button', cls, text); node.type = 'button'; node.addEventListener('click', fn); return node; };
  let generation = 0, request = 0, modalRequest = 0, feedSignature = '', peopleSignature = '', modalSignature = '', modalType = null, cursor = null, back = [], nextCursor = null, hasMore = false, disposed = false;
  const element = el('section', 'community-activity surface'); element.id = 'community-activity'; element.hidden = true; element.setAttribute('aria-labelledby', 'activity-heading');
  const heading = el('header', 'activity-heading'), copy = el('div'); copy.append(el('p', 'eyebrow', 'LA COMUNIDAD SE MUEVE')); const title = el('h2', '', 'Lo último, entre nosotras.'); title.id = 'activity-heading'; copy.append(title);
  const updated = el('p', 'activity-updated'); heading.append(copy, updated); element.append(heading);
  const grid = el('div', 'activity-grid'), feed = el('section', 'activity-stream'), people = el('section', 'activity-people');
  const feedHead = el('div', 'activity-section-head'); feedHead.append(el('h3', '', 'Últimos mensajes'), button('Más actividad →', () => void openMore('feed'))); feed.append(feedHead);
  const feedList = el('ol', 'activity-list'); feedList.setAttribute('aria-label', 'Últimas publicaciones'); feed.append(feedList);
  const peopleHead = el('div', 'activity-section-head'); peopleHead.append(el('h3', '', 'Últimas en participar'), button('Ver más →', () => void openMore('people'))); people.append(peopleHead, el('p', 'activity-note', 'Ordenadas por su última publicación.'));
  const peopleList = el('ol', 'activity-people-list'); peopleList.setAttribute('aria-label', 'Últimas personas que han publicado'); people.append(peopleList); grid.append(feed, people); element.append(grid);
  const status = el('p', 'activity-status'); status.setAttribute('role', 'status'); element.append(status);
  const dialog = el('dialog', 'forum-dialog wide-dialog activity-dialog'); dialog.id = 'activity-dialog'; dialog.setAttribute('aria-labelledby', 'activity-dialog-title'); doc.body.append(dialog);
  const guard = () => { const check = capture(), version = generation; return () => { check(); if (disposed || version !== generation) throw Object.assign(new Error('session_changed'), { code: 'FC_SESSION_CHANGED' }); }; };
  function time(value) { const label = activityTime(value), node = el('time', 'activity-time', label.text); node.dateTime = value || ''; node.title = label.absolute; if (label.absolute) node.setAttribute('aria-label', label.absolute); return node; }
  function postLink(item, label, cls) {
    const node = el('a', cls, label), target = new URL(win.location.href); target.search = ''; target.hash = ''; target.searchParams.set('topic', item.topic_id); if (item.reply_id) target.searchParams.set('reply', item.reply_id); node.href = target.href;
    node.addEventListener('click', event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); close(); void onOpen(item); }); return node;
  }
  function renderFeed(host, items) {
    host.replaceChildren();
    for (const item of items) {
      const row = el('li', 'activity-item'), head = el('div', 'activity-item-head'); head.append(postLink(item, item.topic_title, 'activity-topic-link'), time(item.created_at));
      if (item.unread) row.classList.add('activity-unread');
      const excerpt = el('p', 'activity-excerpt', item.excerpt || ''), meta = el('div', 'activity-byline');
      meta.append(item.author_id ? memberLine(item.author_id) : el('span', 'activity-team', 'Equipo Foro Cromos'), el('span', '', item.kind === 'reply' ? 'respondió' : 'abrió el hilo'));
      if (item.unread) meta.append(el('span', 'activity-new', 'Por ver'));
      row.append(head, excerpt, meta); host.append(row);
    }
    if (!items.length) host.append(el('li', 'activity-empty', 'Todavía no hay publicaciones visibles. La conversación empieza contigo.'));
  }
  function renderPeople(host, items) {
    host.replaceChildren();
    for (const item of items) {
      const row = el('li', 'activity-person'); row.append(memberLine(item.user_id));
      const last = el('div', 'activity-person-last'); last.append(time(item.last_post_at || item.last_activity_at || item.created_at)); if (item.topic_id) last.append(postLink(item, 'Ver su aportación ↗', 'activity-person-post')); row.append(last); host.append(row);
    }
    if (!items.length) host.append(el('li', 'activity-empty', 'Las compañeras que publiquen aparecerán aquí.'));
  }
  function validData(data) { return data && Array.isArray(data.items) ? data : { items: [], has_more: false }; }
  async function sync() {
    if (!isActive() || disposed) return;
    const check = guard(), version = ++request;
    element.hidden=false;if(!feedSignature)status.textContent='Cargando la actividad de la comunidad…';
    try {
      const [feedResult, peopleResult] = await Promise.all([rpc('fc_activity_feed', { p_limit: 6 }), rpc('fc_recent_contributors', { p_limit: 5 })]); check(); if (version !== request) return;
      const a = validData(feedResult), b = validData(peopleResult),ids=[...a.items.map(i => i.author_id), ...b.items.map(i => i.user_id)]; await loadAliases(ids,{expectedAliases:new Map([...a.items.map(i=>[i.author_id,i.alias]),...b.items.map(i=>[i.user_id,i.alias])].filter(([id,alias])=>id&&alias))}); check(); if (version !== request) return;
      const first = JSON.stringify(a.items)+memberSignature(a.items.map(i=>i.author_id)), second = JSON.stringify(b.items)+memberSignature(b.items.map(i=>i.user_id));
      if (first !== feedSignature) { renderFeed(feedList, a.items); feedSignature = first; }
      if (second !== peopleSignature) { renderPeople(peopleList, b.items); peopleSignature = second; }
      for (const node of element.querySelectorAll('time')) { const label = activityTime(node.dateTime); node.textContent = label.text; }
      updated.textContent = `Actualizado a las ${new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' }).format(new Date(a.snapshot_at||b.snapshot_at||Date.now()))}`; status.textContent = ''; element.hidden = false;
      if (dialog.open && modalType) await refreshMore();
    } catch (error) { if (error.code !== 'FC_SESSION_CHANGED' && version === request) status.textContent = errorText(error); }
  }
  function close() { modalRequest++; modalType = null; cursor = null; back = []; nextCursor = null; modalSignature = ''; if (dialog.open) dialog.close(); dialog.replaceChildren(); }
  async function openMore(type) { close(); if (!isActive()) return; modalType = type;const title=el('h2','','Cargando…');title.id='activity-dialog-title';dialog.append(title,button('Cerrar',close));dialog.showModal(); await refreshMore(); }
  async function refreshMore() {
    if (!modalType || !isActive() || disposed) return;
    const check = guard(), version = ++modalRequest, type = modalType, args = { p_limit: 20, p_before: cursor?.time || null };
    if (type === 'feed') args.p_before_id = cursor?.id || null; else args.p_before_uid = cursor?.id || null;
    try {
      const data = validData(await rpc(type === 'feed' ? 'fc_activity_feed' : 'fc_recent_contributors', args)); check(); if (version !== modalRequest || type !== modalType) return;
      const ids=data.items.map(i => type === 'feed' ? i.author_id : i.user_id);await loadAliases(ids,{expectedAliases:new Map(data.items.filter(i=>i.alias).map(i=>[type==='feed'?i.author_id:i.user_id,i.alias]))}); check(); if (version !== modalRequest || type !== modalType) return;
      hasMore = !!data.has_more; nextCursor = data.next_before ? { time: data.next_before, id: data.next_before_id || data.next_before_uid } : null;
      const signature = JSON.stringify({ type, cursor, items: data.items, more: hasMore })+memberSignature(ids); if (signature === modalSignature) return; modalSignature = signature;
      dialog.replaceChildren(); const header = el('div', 'activity-modal-head'), heading = el('h2', '', type === 'feed' ? 'La actividad de Foro Cromos' : 'Compañeras que han participado'); heading.id = 'activity-dialog-title'; header.append(heading, button('Cerrar', close)); dialog.append(header);
      const list = el('ol', type === 'feed' ? 'activity-list' : 'activity-people-list'); type === 'feed' ? renderFeed(list, data.items) : renderPeople(list, data.items); dialog.append(list);
      const pager = el('nav', 'forum-pagination'); pager.setAttribute('aria-label', 'Páginas de actividad');
      if (back.length) pager.append(button('← Más reciente', () => { cursor = back.pop(); modalSignature = ''; void refreshMore(); }));
      if (hasMore && nextCursor) pager.append(button('Anterior en el tiempo →', () => { back.push(cursor); cursor = nextCursor; modalSignature = ''; void refreshMore(); })); dialog.append(pager);
    } catch (error) { if (error.code !== 'FC_SESSION_CHANGED' && version === modalRequest) { const heading=el('h2','','No se pudo cargar la actividad');heading.id='activity-dialog-title';dialog.replaceChildren(heading, el('p', 'form-status', errorText(error)), button('Reintentar', () => void refreshMore()), button('Cerrar', close)); } }
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  return { element, sync, reset() { generation++; request++; feedSignature = peopleSignature = ''; close(); feedList.replaceChildren(); peopleList.replaceChildren(); updated.textContent = status.textContent = ''; element.hidden = true; }, destroy() { disposed = true; generation++; request++; close(); element.remove(); dialog.remove(); } };
}
