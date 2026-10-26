const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function notificationTopic(href) {
  try { const id = new URL(href).searchParams.get('topic'); return UUID.test(id || '') ? id : null; } catch { return null; }
}
export function decodePublicKey(value, win) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(win.atob(base64 + '='.repeat((4 - base64.length % 4) % 4)), c => c.charCodeAt(0));
}

export function createNotifications({ doc, win, client, rpc, capture, isActive, onOpenTopic, errorText }) {
  const bell = doc.getElementById('notifications-button');
  let generation = 0, request = 0, items = [], unread = 0, cursor = null, hasMore = false, restoring = false;
  let device = null, bindingChanges = Promise.resolve();
  const el = (tag, cls, text) => { const node = doc.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const button = (text, action, cls = 'text-button') => { const node = el('button', cls, text); node.type = 'button'; node.addEventListener('click', action); return node; };
  const guard = () => { const version = generation, check = capture(); return () => { check(); if (version !== generation) throw Object.assign(new Error('session_changed'), { code: 'FC_SESSION_CHANGED' }); }; };
  const supported = () => !!(win.navigator.serviceWorker && win.PushManager && win.Notification && win.MessageChannel);
  const base = () => new URL('./', win.location.href);
  function badge() {
    bell.hidden = !isActive(); bell.replaceChildren(el('span', '', '♧'));
    const count = el('span', 'notification-count', unread > 99 ? '99+' : String(unread)); count.hidden = !unread; bell.append(count);
    bell.setAttribute('aria-label', `Mis avisos${unread ? `, ${unread} sin leer` : ''}`);
  }
  async function registration() { return win.navigator.serviceWorker?.getRegistration(base().href); }
  async function setBinding(id, provided) {
    const operation = bindingChanges.then(async () => {
      const reg = provided || await registration(), worker = reg?.active;
      if (!worker || !win.MessageChannel) return;
      await new Promise((resolve, reject) => {
        const channel = new win.MessageChannel(), timer = win.setTimeout(() => { channel.port1.close(); reject(new Error('No se pudo preparar este dispositivo. Inténtalo de nuevo.')); }, 4000);
        channel.port1.onmessage = () => { win.clearTimeout(timer); channel.port1.close(); resolve(); };
        worker.postMessage({ type: 'FC_SET_PUSH_BINDING', id }, [channel.port2]);
      });
    });
    bindingChanges = operation.catch(() => {}); await operation;
  }
  async function restoreDevice() {
    if (!supported() || restoring) return;
    const check = guard(); restoring = true;
    try {
      const reg = await registration(), subscription = await reg?.pushManager.getSubscription(); check();
      if (!subscription) { await setBinding(null, reg); return; }
      const status = await rpc('fc_push_status', { p_endpoint: subscription.endpoint }); check();
      device = status.registered ? { registration: reg, subscription, id: status.id } : null;
      await setBinding(status.registered ? status.id : null, reg);
    } catch { /* In-app notices remain available when push is unavailable. */ }
    finally { restoring = false; }
  }
  async function sync() {
    if (!isActive()) return;
    const check = guard(), version = ++request;
    const data = await rpc('fc_notifications', { p_limit: 25, p_before: null, p_before_id: null }); check();
    if (version !== request) return;
    unread = data.unread_count; badge();
    if (doc.getElementById('notifications-dialog')?.open && !cursor) { items = data.items; hasMore = data.has_more; await render(); }
  }
  async function open() {
    if (!isActive()) return;
    let dialog = doc.getElementById('notifications-dialog');
    if (!dialog) { dialog = el('dialog', 'forum-dialog wide-dialog'); dialog.id = 'notifications-dialog'; dialog.setAttribute('aria-label', 'Mis avisos'); doc.body.append(dialog); }
    cursor = null; items = []; dialog.replaceChildren(el('h2', '', 'Mis avisos'), el('p', 'form-status', 'Cargando avisos…'), button('Cerrar avisos', () => dialog.close()));
    if (!dialog.open) dialog.showModal();
    try { await sync(); } catch (error) { if (error.code !== 'FC_SESSION_CHANGED' && dialog.open) dialog.replaceChildren(el('p', 'form-status', errorText(error)), button('Cerrar avisos', () => dialog.close())); }
  }
  async function render() {
    const dialog = doc.getElementById('notifications-dialog'); if (!dialog?.open) return;
    const check = guard(), version = request, ids = [...new Set(items.map(n => n.topic_id))];
    const result = ids.length ? await client.from('fc_topics').select('id,title').in('id', ids) : { data: [] }; check();
    if (version !== request || !dialog.open) return;
    const titles = new Map((result.data || []).map(t => [t.id, t.title])), list = el('ul', 'notification-list'), status = el('p', 'form-status'); status.setAttribute('role', 'status');
    for (const item of items) {
      const row = el('li', item.read_at ? 'notification-item' : 'notification-item unread');
      row.append(el('strong', '', titles.get(item.topic_id) || 'Una conversación que sigues'), el('span', 'field-help', new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(item.created_at))));
      row.append(button(item.read_at ? 'Abrir conversación' : 'Nueva respuesta · abrir', async () => {
        const actionCheck = guard();
        try {
          await rpc('fc_read_notifications', { p_ids: [item.id] }); actionCheck();
          if (!dialog.open) return; dialog.close(); await onOpenTopic(item.topic_id); actionCheck(); await sync();
        } catch (error) { if (error.code !== 'FC_SESSION_CHANGED') status.textContent = errorText(error); }
      })); list.append(row);
    }
    if (!items.length) list.append(el('li', 'empty-state', 'Todavía no tienes avisos. Recibirás uno cuando otra compañera responda en un hilo que sigues.'));
    const actions = el('div', 'notification-actions');
    const unreadIds = items.filter(n => !n.read_at).map(n => n.id);
    if (unreadIds.length) actions.append(button('Marcar esta página como leída', async () => {
      try { await rpc('fc_read_notifications', { p_ids: unreadIds }); check(); for (const item of items) if (unreadIds.includes(item.id)) item.read_at = new Date().toISOString(); unread = Math.max(0, unread - unreadIds.length); badge(); await render(); }
      catch (error) { if (error.code !== 'FC_SESSION_CHANGED') status.textContent = errorText(error); }
    }));
    if (hasMore) actions.append(button('Avisos anteriores', async () => {
      const last = items.at(-1); if (!last) return;
      try { const data = await rpc('fc_notifications', { p_limit: 25, p_before: last.created_at, p_before_id: last.id }); check(); cursor = last.id; request++; items = data.items; hasMore = data.has_more; unread = data.unread_count; badge(); await render(); }
      catch (error) { if (error.code !== 'FC_SESSION_CHANGED') status.textContent = errorText(error); }
    }));
    if (cursor) actions.append(button('Volver a los últimos', open));
    dialog.replaceChildren(el('h2', '', 'Mis avisos'), el('p', 'field-help', 'Sigues automáticamente los hilos que abres y en los que participas. Puedes silenciar cada conversación.'), list, status, actions, button('Cerrar avisos', () => dialog.close()));
  }
  function settingsPanel() {
    const section = el('section', 'notification-settings'), check = guard(), status = el('p', 'form-status'); status.setAttribute('role', 'status');
    section.append(el('h3', '', 'Tus avisos'), el('p', 'field-help', 'La campana del foro recoge las respuestas a las conversaciones que sigues. Elige también cómo recibirlas fuera del foro.'), status);
    (async () => {
      try {
        const data = await rpc('fc_notification_settings'); check();
        const email = el('p', 'notification-destination', data.email ? `Correo privado de avisos: ${data.email}` : 'Todavía no tienes un correo de avisos asignado.'), label = el('label', 'checkbox-label'), input = el('input');
        input.type = 'checkbox'; input.checked = data.email_enabled; input.disabled = !data.email_verified; input.id = 'email-notifications-enabled'; label.append(input, el('span', '', 'Recibir respuestas por correo'));
        const mailStatus = el('p', 'field-help', data.deliveryConfigured ? 'Servicio de envío conectado. Los avisos se generan para las respuestas nuevas.' : 'Correo preparado, pendiente de conectar el servicio de envío. Los avisos dentro del foro funcionan.');
        const save = button('Guardar preferencia de correo', async () => {
          input.disabled = true; save.disabled = true;
          try { await rpc('fc_set_notifications', { p_email_enabled: input.checked }); check(); status.textContent = data.deliveryConfigured ? 'Preferencia guardada.' : 'Preferencia guardada. El envío de correo sigue pendiente de activación.'; }
          catch (error) { if (error.code !== 'FC_SESSION_CHANGED') status.textContent = errorText(error); }
          finally { input.disabled = !data.email_verified; save.disabled = false; }
        }); save.disabled = !data.email_verified;
        section.append(email, label, mailStatus, save); await pushPanel(section, check);
      } catch (error) { if (error.code !== 'FC_SESSION_CHANGED') status.textContent = errorText(error); }
    })(); return section;
  }
  async function pushPanel(section, check) {
    const title = el('h4', '', 'Avisos en este dispositivo'), status = el('p', 'field-help'); status.setAttribute('role', 'status'); section.append(title, status);
    if (!supported()) { status.textContent = 'Este navegador no permite estos avisos. Puedes usar la campana del foro. En iPhone o iPad, abre el foro desde una app añadida a la pantalla de inicio.'; return; }
    const config = await rpc('fc_push_settings'); check();
    const reg = await registration(), subscription = await reg?.pushManager.getSubscription(); check();
    const current = subscription ? await rpc('fc_push_status', { p_endpoint: subscription.endpoint }) : { registered: false }; check();
    const enable = button(current.registered ? 'Reactivar avisos del dispositivo' : 'Activar avisos en este dispositivo', async () => {
      enable.disabled = true; let created;
      try {
        const permission = await win.Notification.requestPermission(); check();
        if (permission !== 'granted') { status.textContent = 'No has permitido los avisos. La campana del foro sigue disponible.'; return; }
        const registered = await win.navigator.serviceWorker.register(new URL('sw.js', base()).href, { scope: base().pathname });
        const active = registered.active ? registered : await Promise.race([win.navigator.serviceWorker.ready, new Promise((_, reject) => win.setTimeout(() => reject(new Error('No se pudo preparar este dispositivo. Inténtalo de nuevo.')), 10000))]); check();
        let sub = await active.pushManager.getSubscription(); check();
        if (sub) { const owned = await rpc('fc_push_status', { p_endpoint: sub.endpoint }); check(); if (!owned.registered) { await sub.unsubscribe(); sub = null; } }
        if (!sub) { sub = await active.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodePublicKey(config.public_key, win) }); created = sub; } check();
        const json = sub.toJSON(), result = await rpc('fc_register_push', { p_endpoint: sub.endpoint, p_p256dh: json.keys.p256dh, p_auth: json.keys.auth }); check();
        await setBinding(result.id, active); check(); status.textContent = 'Avisos activados en este dispositivo. Dependen del permiso y de la configuración de tu navegador.';
        device = { registration: active, subscription: sub, id: result.id };
        disable.hidden = false;
      } catch (error) { if (created) created.unsubscribe().catch(() => {}); if (error.code !== 'FC_SESSION_CHANGED') status.textContent = errorText(error); }
      finally { enable.disabled = !config.configured; }
    });
    const disable = button('Desactivar avisos en este dispositivo', async () => {
      disable.disabled = true;
      try { await detachDevice(); check(); status.textContent = 'Avisos desactivados en este dispositivo.'; disable.hidden = true; }
      catch (error) { if (error.code !== 'FC_SESSION_CHANGED') status.textContent = errorText(error); }
      finally { disable.disabled = false; }
    });
    disable.hidden = !current.registered; enable.disabled = !config.configured;
    if (current.registered) device = { registration: reg, subscription, id: current.id };
    status.textContent = !config.configured ? 'El servicio de avisos del dispositivo está pendiente de activación.' : win.Notification.permission === 'denied' ? 'Los avisos están bloqueados en los permisos de este navegador. Puedes cambiarlos desde el candado de la dirección.' : current.registered ? 'Este dispositivo tiene avisos activados.' : 'Actívalos si quieres recibir una notificación aunque no tengas el foro delante.';
    section.append(enable, disable);
  }
  async function detachDevice() {
    if (!supported()) return;
    const snapshot = device; device = null;
    const operations = [setBinding(null, snapshot?.registration)];
    if (snapshot) {
      if (isActive()) operations.push(rpc('fc_unregister_push', { p_endpoint: snapshot.subscription.endpoint }));
      operations.push(snapshot.subscription.unsubscribe());
    }
    const results = await Promise.allSettled(operations);
    const failure = results.find(result => result.status === 'rejected'); if (failure) throw failure.reason;
  }
  const onMessage = event => { const id = event.data?.topic_id; if (event.data?.type === 'FC_OPEN_TOPIC' && event.data.device_id === device?.id && UUID.test(id || '') && isActive()) onOpenTopic(id); };
  bell.addEventListener('click', open); win.navigator.serviceWorker?.addEventListener('message', onMessage);
  badge();
  return {
    sync, open, settingsPanel, restoreDevice, detachDevice,
    reset() { generation++; request++; items = []; unread = 0; cursor = null; restoring = false; device = null; doc.getElementById('notifications-dialog')?.remove(); badge(); if (supported()) setBinding(null).catch(() => {}); },
    destroy() { generation++; bell.removeEventListener('click', open); win.navigator.serviceWorker?.removeEventListener('message', onMessage); },
  };
}
