const bindingCache = 'fc-push-binding-v1';
const bindingUrl = new URL('__device_binding', self.registration.scope).href;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let bindingWrites = Promise.resolve();
function enqueue(operation) { const result = bindingWrites.then(operation); bindingWrites = result.catch(() => {}); return result; }
async function binding() {
  const response = await (await caches.open(bindingCache)).match(bindingUrl);
  return response ? response.text() : '';
}
async function clearCards() { for (const notification of await self.registration.getNotifications()) notification.close(); }
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  if (event.data?.type !== 'FC_SET_PUSH_BINDING') return;
  const id = event.data.id;
  if (id !== null && (typeof id !== 'string' || !uuid.test(id))) return;
  let source;try{source=new URL(event.source?.url);}catch{return;}
  const scope=new URL(self.registration.scope),outsideForum=!source.href.startsWith(scope.href);
  const app=new URL('../v2/',scope);
  // The connected web may clear its own previous binding, never install a new one.
  if(source.origin!==scope.origin || (outsideForum && (!source.pathname.startsWith(app.pathname) || id!==null || !uuid.test(event.data.expected_id||''))))return;
  event.waitUntil(enqueue(async () => {
    if(event.data.expected_id && await binding()!==event.data.expected_id){event.ports?.[0]?.postMessage({ok:true});return;}
    if ((await binding()) !== (id || '')) await clearCards();
    // Only an opaque device id is retained. No session, email or forum text is cached.
    await (await caches.open(bindingCache)).put(bindingUrl, new Response(id || ''));
    event.ports?.[0]?.postMessage({ ok: true });
  }));
});
self.addEventListener('push', event => {
  event.waitUntil(enqueue(async () => {
    let data; try { data = event.data?.json(); } catch { return; }
    if (!data || !uuid.test(data.device_id || '') || await binding() !== data.device_id) return;
    let url; try { url = new URL(data.url); } catch { return; }
    const base = new URL(self.registration.scope), topic = url.searchParams.get('topic');
    if (url.origin !== base.origin || url.pathname !== base.pathname || !uuid.test(topic || '')) return;
    await self.registration.showNotification('Nueva respuesta', {
      body: 'Tienes una respuesta en una conversación que sigues.',
      icon: new URL('assets/cofre.webp', base).href,
      tag: typeof data.tag === 'string' ? data.tag.slice(0, 80) : `fc-topic-${topic}`,
      renotify: false,
      data: { url: new URL(`?topic=${topic}`, base).href, device_id: data.device_id, topic_id: topic },
    });
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(enqueue(async () => {
    const data = event.notification.data;
    if (!data || await binding() !== data.device_id || !uuid.test(data.topic_id || '')) return;
    const url = new URL(`?topic=${data.topic_id}`, self.registration.scope).href;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows.find(item => item.url.startsWith(self.registration.scope));
    if (client) { await client.focus(); client.postMessage({ type: 'FC_OPEN_TOPIC', topic_id: data.topic_id, device_id: data.device_id }); }
    else await self.clients.openWindow(url);
  }));
});
self.addEventListener('pushsubscriptionchange', event => event.waitUntil(enqueue(async () => {
  await (await caches.open(bindingCache)).put(bindingUrl, new Response(''));
  await clearCards();
})));
