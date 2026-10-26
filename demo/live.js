import { createClient } from '@supabase/supabase-js';
import { FORUM_CONFIG } from '../forum/config.js';
import { mountPlatform } from '../platform-v11.js';
import { mountStudio } from './studio.js';
import { createLiveProfileView } from './live-profile.js';
import { createLiveMessages } from './live-messages.js';
import { LIVE_NOTICES, LIVE_GUIDES } from './live-notices.js';

export function bootLive({ documentRef = document, windowRef = window, client = null } = {}) {
  const d = documentRef, w = windowRef;
  if (d.body.dataset.liveMounted) return null; d.body.dataset.liveMounted = 'true';
  client ||= createClient(FORUM_CONFIG.url, FORUM_CONFIG.publishableKey, { auth: { storageKey: 'sx-forocromos-live', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  const platform = mountPlatform({ documentRef: d, windowRef: w });
  const savedTheme=d.body.dataset.theme;
  let session = null, generation = 0, authVersion = 0, disposed = false, closing = false, pushSnapshot = null, bindingTask=Promise.resolve(null), messages;
  const errorText = error => error?.message?.includes('Invalid login') ? 'El correo o la contraseña no coinciden.' : error?.message?.includes('Email not confirmed') ? 'Esta cuenta aún necesita confirmación. Consulta con Manel o Walker durante el piloto.' : 'No se pudo entrar. Comprueba la conexión y vuelve a intentarlo.';
  const studio = mountStudio({ platform, documentRef: d, windowRef: w, live: {
    notices: LIVE_NOTICES, guides:LIVE_GUIDES,errorText,
    createProfileView: options => createLiveProfileView({ ...options, client, getSession: () => session, onAuthLost:invalidateAuth }),
    async signIn(email, password) { if (closing) throw new Error('Espera a que termine el cierre de sesión.'); const { error } = await client.auth.signInWithPassword({ email, password }); if (error) throw error; },
    async signOut() {
      if (closing) return; closing = true; const snapshot = pushSnapshot,pendingBinding=bindingTask;
      // Clear all private presentation before awaiting network or worker acknowledgements.
      transition(null);
      try { await clearBinding(snapshot||await pendingBinding); const { error } = await client.auth.signOut({ scope: 'local' }); if (error) throw error; }
      finally { closing = false; }
    }
  } });
  if(['noir','rose','neon'].includes(savedTheme))platform.setTheme(savedTheme);
  d.querySelector('.v11-topbar-actions > .text-button')?.remove();
  const agePrivacy=d.querySelector('#sx-age-gate > .sx-info span');if(agePrivacy)agePrivacy.textContent='Leer privacidad';
  messages = createLiveMessages({ client, documentRef: d, windowRef: w, notify: studio.notify, confirmAction: studio.confirmAction, onProfile: id => studio.profile.openContact?.(id),onAuthLost:invalidateAuth });
  platform.registerPage('messages', messages.element, { title: 'Mensajes' });
  const el = (tag, cls, text) => { const n = d.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const link = (text, href, cls = 'sx-button sx-primary') => { const n = el('a', cls, text); n.href = href; return n; };
  const simplePage = (route, eyebrow, title, text, actions) => { const page = el('section', 'sx-live-community'); page.append(el('p', 'sx-eyebrow', eyebrow), el('h2', '', title), el('p', 'sx-lead', text)); for (const item of actions) page.append(item); platform.registerPage(route, page, { title }); return page; };
  const community = simplePage('community', 'ENTRE NOSOTRAS', 'Foro Cromos', 'Tu comunidad para conversar, preguntar y compartir. El foro guarda sus hilos, respuestas y archivos y mantiene sus propias decisiones de admisión.', [link('Entrar en Foro Cromos', '../foro/')]);
  const art = el('img'); art.src = './assets/v2/portal.webp'; art.alt = ''; community.insertBefore(art, community.lastChild);
  community.append(el('p', 'sx-form-help', 'La sesión se comparte con esta web. Tu perfil y avatar del foro se editan dentro de Foro Cromos.'));
  simplePage('trust', 'TUS DECISIONES', 'Mis límites', 'Desde cada conversación puedes bloquear o desbloquear al contacto. El bloqueo se aplica en el servidor a todas vuestras conversaciones y al perfil compartido; conservas el historial.', [link('Gestionar mis contactos', '#messages'), link('Normas y moderación del foro', '../foro/', 'sx-button')]);
  simplePage('feedback', 'TU VOZ CUENTA', 'Construimos contigo', 'Puedes dejar tus dudas, propuestas y lo que te facilitaría el día en los hilos de la aplicación y de opinión de Foro Cromos. Allí quedan guardadas y podemos responderte.', [link('Abrir el foro y compartir mi idea', '../foro/')]);
  simplePage('care', 'RECORRIDO EN PREPARACIÓN', 'Estoy segura', 'El check-in todavía es una simulación. No envía avisos, no vigila tu situación y no hay asistencia conectada. Puedes explorar su recorrido en la maqueta sin crear una alarma real.', [link('Ver el check-in de demostración', '../demo/#care', 'sx-button')]);
  const cofre = d.querySelector('[data-v11-page=cofre]'); if (cofre) { const scope = el('p', 'sx-live-scope', 'Cofre temporal de esta pestaña: puedes organizar y descargar tus notas y archivos. Se vacía al recargar o cerrar sesión. Todavía no se guarda en Supabase.'); cofre.prepend(scope); }
  const authStatus = d.createElement('p'); authStatus.className = 'sx-field-status'; authStatus.setAttribute('role', 'status'); d.querySelector('.sx-login')?.append(authStatus);
  async function discoverBinding(current) {
    if (!w.navigator.serviceWorker || !w.PushManager || !current.access_token) return null;
    const controller=new w.AbortController(),timer=w.setTimeout(()=>controller.abort(),3500);
    try {
      const registration = await w.navigator.serviceWorker.getRegistration(new URL('../foro/', w.location.href).href);
      const subscription = await registration?.pushManager.getSubscription(); if (!subscription) return null;
      // Use the captured account token, even when a different account is now active.
      const response=await w.fetch(`${FORUM_CONFIG.url}/rest/v1/rpc/sx_push_binding`,{method:'POST',headers:{apikey:FORUM_CONFIG.publishableKey,Authorization:`Bearer ${current.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({p_endpoint:subscription.endpoint}),signal:controller.signal});
      if(!response.ok)return null;const data=await response.json();return data?.id?{registration,id:data.id,uid:current.user.id}:null;
    } catch { return null; }
    finally{w.clearTimeout(timer);}
  }
  async function clearBinding(snapshot) {
    if (!snapshot?.registration?.active || !w.MessageChannel) return;
    await new Promise(resolve => {
      const channel = new w.MessageChannel(), timer = w.setTimeout(() => { channel.port1.close(); resolve(); }, 1800);
      channel.port1.onmessage = () => { w.clearTimeout(timer); channel.port1.close(); resolve(); };
      try{snapshot.registration.active.postMessage({ type: 'FC_SET_PUSH_BINDING', id: null, expected_id: snapshot.id }, [channel.port2]);}catch{w.clearTimeout(timer);channel.port1.close();resolve();}
    });
  }
  function boundedBinding(current){let timer;return Promise.race([discoverBinding(current),new Promise(resolve=>{timer=w.setTimeout(()=>resolve(null),4200);})]).finally(()=>w.clearTimeout(timer));}
  function transition(next) {
    if (disposed) return;
    const changed = session?.user?.id !== next?.user?.id;
    if (changed) { generation++; const old = pushSnapshot,oldTask=bindingTask; pushSnapshot = null; if (old) void clearBinding(old);else void oldTask.then(clearBinding); }
    session = next;
    studio.setSession(next); messages?.setSession(next);
    w.__sxCofreSession = next;
    w.dispatchEvent(new w.CustomEvent('sx:session', { detail: next }));
    if(changed&&!next)platform.navigate('welcome',{replace:true});
    if (next && changed) { const version=generation;bindingTask=boundedBinding(next);void bindingTask.then(value=>{if(generation===version)pushSnapshot=value;});void Promise.resolve().then(()=>studio.profile.refresh()).catch(()=>{}); }
    else if(!next)bindingTask=Promise.resolve(null);
    if (changed) authStatus.textContent = '';
  }
  function invalidateAuth(){transition(null);authStatus.textContent='La sesión ya no es válida. Vuelve a entrar para continuar.';void client.auth.signOut({scope:'local'}).catch(()=>{});}
  const { data: authListener } = client.auth.onAuthStateChange((_event, next) => { authVersion++;if(closing&&next)return;transition(next); });
  const initialVersion = authVersion;
  const ready = client.auth.getSession().then(({ data, error }) => { if (disposed || authVersion !== initialVersion) return; if (error) authStatus.textContent = 'No se pudo recuperar la sesión. Puedes volver a entrar.'; transition(data?.session || null); }).catch(() => { if (!disposed) authStatus.textContent = 'No se pudo comprobar la sesión. Inténtalo de nuevo.'; });
  const easy = d.getElementById('sx-easy-mode'); try { if (easy) { easy.checked = w.localStorage.getItem('sx-live-easy') === 'true'; d.body.classList.toggle('sx-easy', easy.checked); } } catch {}
  const saveEasy = () => { try { w.localStorage.setItem('sx-live-easy', String(easy.checked)); } catch {} }; easy?.addEventListener('change', saveEasy);
  const sharedProfileInvalidation = event => { if (event.detail?.blocked) studio.profile.closeContact?.(); }; w.addEventListener('sx:contact-block', sharedProfileInvalidation);
  return { platform, studio, messages, ready, get session() { return session; },
    destroy() { disposed = true; generation++; authListener?.subscription?.unsubscribe(); messages.destroy(); studio.destroy(); platform.destroy(); easy?.removeEventListener('change', saveEasy); w.removeEventListener('sx:contact-block', sharedProfileInvalidation); delete w.__sxCofreSession; delete d.body.dataset.liveMounted; }
  };
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => bootLive(), { once: true });
  else bootLive();
}
