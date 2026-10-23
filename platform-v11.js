import { House, MessagesSquare, UsersRound, Vault, HeartHandshake, UserRound,
  Sparkles, ShieldCheck, Settings2, ArrowUpRight, Menu, X, Gem, MessageSquarePlus } from 'lucide';
import { mountServicePreviews } from './services-v11.js';

export const SERVICES = Object.freeze([
  { route: 'messages', title: 'Mensajes', hint: 'Conversaciones que tú eliges.', icon: MessagesSquare, status: 'Ensayo local', local: true },
  { route: 'community', title: 'Forocromos', hint: 'Un espacio entre compañeras para preguntar y compartir.', icon: UsersRound, status: 'Comunidad local', local: true },
  { route: 'cofre', title: 'Mi Cofre', hint: 'Guarda, recupera y organiza tus archivos personales.', icon: Vault, status: 'Archivos locales', local: true },
  { route: 'care', title: 'Estoy segura', hint: 'Ensaya un check-in con tus contactos de confianza.', icon: HeartHandshake, status: 'Avisos simulados', local: true },
  { route: 'profile', title: 'Mi perfil', hint: 'Elige cómo presentarte y qué quieres mostrar.', icon: UserRound, status: 'Maqueta interactiva' },
  { route: 'trust', title: 'Mis límites', hint: 'Control personal de contactos y un canal de incidencias.', icon: ShieldCheck, status: 'Maqueta interactiva' },
  { route: 'auralink', title: 'AuraLink', hint: 'Imagina una imagen que hable de ti, con tu permiso.', icon: Sparkles, status: 'Maqueta interactiva' },
  { route: 'feedback', title: 'Tu voz cuenta', hint: 'Cuéntanos qué te facilitaría el día.', icon: MessageSquarePlus, status: 'Maqueta interactiva' },
  { route: 'plans', title: 'Herramientas para ti', hint: 'Explora servicios opcionales que aporten valor.', icon: Gem, status: 'Propuesta de servicios' }
]);
const ROUTES = new Set(['home', 'access', 'settings', ...SERVICES.map(item => item.route)]);
const LEGACY = { 'chat-panel': 'messages', 'cofre-panel': 'cofre', 'forocromos-panel': 'community', 'care-panel': 'care' };

/** Presentation only. Modules and server retain authority over their own access. */
export function mountPlatform({ documentRef = document, windowRef = window } = {}) {
  const d = documentRef, w = windowRef, main = d.querySelector('main');
  if (!main || d.getElementById('v11-shell')) return null;
  const cleanups = [], pages = new Map(), routeScroll = new Map(); let actor = '', route = 'home', pending = '', disposed = false, hasNavigated = false;
  const previousScrollRestoration = w.history.scrollRestoration;
  if ('scrollRestoration' in w.history) w.history.scrollRestoration = 'manual';
  const el = (tag, cls, text) => { const n = d.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const listen = (node, event, fn) => { node.addEventListener(event, fn); cleanups.push(() => node.removeEventListener(event, fn)); };
  const viewport = w.visualViewport;
  const viewportProperties = ['--v11-visible-height', '--v11-keyboard-offset'].map(name => [name, d.body.style.getPropertyValue(name)]);
  const updateViewport = () => {
    if (disposed) return;
    const height = viewport?.height || w.innerHeight;
    const zoomed = Math.abs((viewport?.scale || 1) - 1) > .05;
    const offset = zoomed ? 0 : Math.max(0, w.innerHeight - height - (viewport?.offsetTop || 0));
    const field = d.activeElement;
    const editable = !field?.disabled && !field?.readOnly && (field?.matches?.('textarea, [contenteditable]:not([contenteditable="false"])')
      || (field?.tagName === 'INPUT' && !['button', 'submit', 'checkbox', 'radio', 'range', 'color', 'file', 'date', 'time', 'hidden'].includes(field.type)));
    d.body.style.setProperty('--v11-visible-height', `${Math.round(height)}px`);
    d.body.style.setProperty('--v11-keyboard-offset', `${Math.round(offset)}px`);
    if (editable && offset > 120) d.body.setAttribute('data-keyboard-open', 'true'); else d.body.removeAttribute('data-keyboard-open');
  };
  if (viewport) { listen(viewport, 'resize', updateViewport); listen(viewport, 'scroll', updateViewport); }
  listen(w, 'resize', updateViewport); listen(d, 'focusin', updateViewport);
  listen(d, 'focusout', () => w.queueMicrotask(updateViewport));
  updateViewport();
  cleanups.push(() => { for (const [name, value] of viewportProperties) { if (value) d.body.style.setProperty(name, value); else d.body.style.removeProperty(name); } d.body.removeAttribute('data-keyboard-open'); });
  const icon = (nodes, cls = 'v11-icon') => {
    const svg = d.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: cls })) svg.setAttribute(name, value);
    for (const [tag, attrs] of nodes) { const n = d.createElementNS(svg.namespaceURI, tag); for (const [key, value] of Object.entries(attrs)) n.setAttribute(key, value); svg.append(n); }
    return svg;
  };
  const button = (text, fn, cls = 'secondary') => { const n = el('button', cls, text); n.type = 'button'; listen(n, 'click', fn); return n; };
  const goButton = (text, destination, cls = 'secondary', art) => {
    const n = button('', () => navigate(destination), cls); n.dataset.route = destination;
    if (art) n.append(icon(art)); n.append(el('span', 'v11-nav-label', text)); return n;
  };
  const addPage = (key, node) => { node.dataset.v11Page = key; pages.set(key, node); main.append(node); };
  d.body.classList.add('v11-enabled');
  let theme = 'neon'; try { const saved = w.localStorage.getItem('sx-v11-theme'); if (['neon', 'rose', 'noir'].includes(saved)) theme = saved; } catch {}
  d.body.dataset.theme = theme;
  d.title = 'SensualXcape · Tu espacio · V1.1';
  const layout = d.getElementById('app-layout');
  // Keep the original controls and their event handlers, including authentication.
  for (const node of [layout?.querySelector('header.topbar'), main.querySelector('.intro'), layout?.querySelector('footer')]) if (node) node.setAttribute('v11-hidden', '');
  const oldBanner = d.body.querySelector(':scope > aside'); if (oldBanner) oldBanner.setAttribute('v11-hidden', '');
  const shell = el('div'); shell.id = 'v11-shell';
  const skip = el('a', 'v11-skip', 'Saltar al contenido'); skip.href = '#v11-workspace'; shell.append(skip);
  const sidebar = el('aside', 'v11-sidebar'); sidebar.setAttribute('aria-label', 'SensualXcape');
  const brand = el('a', 'v11-brand'); brand.href = '#home'; brand.append(el('span', 'v11-brand-mark', 'Sx'));
  const brandText = el('span'); brandText.append(el('strong', '', 'SensualXcape'), el('small', '', 'TU ESPACIO · TUS REGLAS')); brand.append(brandText); sidebar.append(brand);
  const nav = el('nav', 'v11-nav'); nav.setAttribute('aria-label', 'Servicios');
  nav.append(goButton('Inicio', 'home', '', House), el('p', 'v11-nav-heading', 'TU DÍA A DÍA'));
  for (const service of SERVICES.slice(0, 4)) nav.append(goButton(service.title, service.route, '', service.icon));
  nav.append(el('p', 'v11-nav-heading', 'A TU MANERA'));
  for (const service of SERVICES.slice(4, 7)) nav.append(goButton(service.title, service.route, '', service.icon));
  nav.append(goButton('Preferencias', 'settings', '', Settings2)); sidebar.append(nav);
  const foot = el('div', 'v11-sidebar-foot');
  foot.append(el('span', 'v11-badge', 'V1.1 · prototipo local'), el('p', '', 'Belleza útil. Decisiones tuyas.'), goButton('Tu voz cuenta', 'feedback', 'text-button', MessageSquarePlus)); sidebar.append(foot);
  const top = el('header', 'v11-topbar'), titleBlock = el('div', 'v11-topbar-title');
  titleBlock.append(el('span', '', 'SENSUALXCAPE')); const pageTitle = el('h1', '', 'Inicio'); pageTitle.id = 'v11-page-title'; titleBlock.append(pageTitle);
  const actions = el('div', 'v11-topbar-actions'), themeLabel = el('label', 'sr-only', 'Atmósfera visual'); themeLabel.htmlFor = 'v11-theme';
  const themeSelect = el('select'); themeSelect.id = 'v11-theme';
  for (const [value, text] of [['neon', 'Neón · energía'], ['rose', 'Rosa · luz'], ['noir', 'Noir · calma']]) { const o = el('option', '', text); o.value = value; themeSelect.append(o); }
  themeSelect.value = theme;
  function setTheme(value) { d.body.dataset.theme = value; themeSelect.value = value; try { w.localStorage.setItem('sx-v11-theme', value); } catch {} }
  listen(themeSelect, 'change', () => setTheme(themeSelect.value));
  const account = button('', () => navigate(actor ? 'profile' : 'access'), 'secondary small');
  account.append(icon(UserRound), el('span', 'v11-account-label', 'Entrar al ensayo')); account.id = 'v11-account';
  const signOut = button('Salir', () => d.getElementById('logout-btn')?.click(), 'text-button'); signOut.hidden = true;
  actions.append(themeLabel, themeSelect, account, signOut); top.append(titleBlock, actions);
  main.id = 'v11-workspace'; main.tabIndex = -1; main.setAttribute('aria-labelledby', pageTitle.id); shell.append(sidebar, top, main); layout?.append(shell);
  listen(skip, 'click', event => { event.preventDefault(); main.focus(); });
  const notice = d.getElementById('notice'); if (notice) main.prepend(notice);
  // A single hierarchy for this mockup; defer separate easy/advanced modes.
  d.getElementById('easy-mode')?.setAttribute('v11-hidden', '');

  const home = el('section', 'v11-home'); home.id = 'v11-home';
  const hero = el('div', 'v11-hero'), heroCopy = el('div', 'v11-hero-copy');
  heroCopy.append(el('span', 'v11-eyebrow', 'BIENVENIDA A TU ESPACIO'));
  const headline = el('h2'); headline.append(d.createTextNode('Tu espacio.'), el('br'), el('em', '', 'A tu manera.'));
  heroCopy.append(headline, el('p', '', 'Tus conversaciones, tu comunidad y tus cosas. Siempre a mano. Tú decides.'));
  const heroActions = el('div', 'v11-hero-actions'); heroActions.append(goButton('Abrir mis mensajes', 'messages', 'primary', MessagesSquare), goButton('Estoy segura', 'care', 'secondary', HeartHandshake)); heroCopy.append(heroActions);
  const art = el('div', 'v11-hero-art'), image = el('img'); image.src = '/assets/v11/portal-unicorn.png'; image.alt = ''; image.width = 1536; image.height = 1024; image.decoding = 'async'; art.append(image);
  hero.append(heroCopy, art);
  const quickSection = el('section', 'v11-quick-section'); quickSection.setAttribute('aria-labelledby', 'v11-quick-title');
  const quickHeading = el('div', 'v11-quick-heading'), quickTitle = el('h2', '', 'A mano'); quickTitle.id = 'v11-quick-title';
  quickHeading.append(quickTitle, el('p', '', 'Lo que necesitas, cerca.')); quickSection.append(quickHeading);
  const quick = el('div', 'v11-quick-grid');
  for (const service of SERVICES.slice(0, 4)) {
    const n = button('', () => navigate(service.route), 'v11-quick-card'), art = el('span', 'v11-icon'), text = el('span'); art.append(icon(service.icon));
    text.append(el('strong', '', service.title), el('small', '', service.status)); n.append(art, text); quick.append(n);
  }
  quickSection.append(quick); home.append(quickSection, hero);
  const sectionTitle = el('div', 'v11-section-title'); sectionTitle.append(el('h2', '', 'Un universo que te acompaña'), el('p', '', 'Elige por dónde empezar')); home.append(sectionTitle);
  const grid = el('div', 'v11-service-grid');
  for (const service of SERVICES) {
    const card = button('', () => navigate(service.route), 'v11-service-card'), art = el('span', 'v11-service-icon'); art.append(icon(service.icon));
    const badge = el('span', 'v11-badge', service.status); badge.dataset.status = service.local ? 'local' : 'proposal';
    card.append(art, icon(ArrowUpRight, 'v11-card-arrow'), el('h3', '', service.title), el('p', '', service.hint), badge); grid.append(card);
  }
  home.append(grid, el('p', 'v11-footnote', 'Un laboratorio para construir con vosotras. Mensajes, Cofre y comunidad funcionan en este equipo. Estoy segura ensaya avisos; las otras pantallas son maquetas interactivas.'));
  addPage('home', home);

  const access = el('section', 'v11-access');
  const accessIntro = el('div', 'v11-page-intro'); accessIntro.append(el('span', 'v11-eyebrow', 'ENSAYO LOCAL'), el('h2', '', 'Entra y prueba tu espacio'), el('p', '', 'Usa solo las cuentas ficticias de esta prueba. A y B pertenecen a la comunidad; A modera. C permite comprobar que una cuenta externa no puede entrar en Forocromos.'));
  const accessChoices = el('div', 'v11-hero-actions');
  for (const letter of ['a', 'b', 'c']) accessChoices.append(button(`Preparar cuenta ${letter.toUpperCase()}`, () => {
    const email = d.getElementById('email'), password = d.getElementById('password');
    if (email && password) { email.value = `${letter}@example.invalid`; password.value = '123456'; d.getElementById('login-btn')?.focus(); }
  }));
  accessIntro.append(accessChoices, el('p', 'v11-footnote', 'Contraseña de ensayo: 123456. Las pestañas del mismo perfil comparten cuenta. Usa otro navegador o perfil para probar con dos personas.'));
  access.append(accessIntro);
  for (const id of ['auth-panel', 'recovery-panel']) { const node = d.getElementById(id); if (node) access.append(node); }
  // The local server has no registration or email recovery. Avoid dead paths here.
  for (const node of [access.querySelector('.access-help'), access.querySelector('#recover-btn')]) if (node) node.setAttribute('v11-hidden', '');
  const authIntro = access.querySelector('.access-intro'); if (authIntro) authIntro.textContent = 'Prepara una cuenta de arriba y pulsa Entrar. No hace falta correo de confirmación.';
  addPage('access', access);

  const settings = el('section'); const settingsIntro = el('div', 'v11-page-intro'); settingsIntro.append(el('span', 'v11-eyebrow', 'A TU MANERA'), el('h2', '', 'Un espacio que se siente tuyo'), el('p', '', 'El aspecto cambia; tus permisos y tus datos siguen el mismo recorrido.'));
  const styles = el('div', 'v11-service-grid');
  for (const [value, name, description] of [['neon', 'Neón', 'Fucsia, índigo y un punto de energía.'], ['rose', 'Rosa', 'Luz cálida, superficies claras y acentos suaves.'], ['noir', 'Noir · calma', 'Negro y grafito, rojo profundo y luz blanca en equilibrio.']]) {
    const card = button('', () => setTheme(value), 'v11-service-card'); card.append(icon(Sparkles), el('h3', '', name), el('p', '', description), el('span', 'v11-badge', 'Aplicar atmósfera')); styles.append(card);
  }
  const scope = el('details', 'v11-info-strip'); scope.append(el('summary', '', 'Qué hace este prototipo'), el('p', '', 'Las cuentas y los chats del ensayo se reinician con el servidor. Cofre, comunidad y check-in se guardan en este equipo. El check-in solo registra avisos simulados; no llama ni envía mensajes. Las maquetas se limpian al salir o cambiar de cuenta.'), el('p', '', 'Las opciones adicionales se despliegan donde hacen falta. La interfaz respeta tu preferencia de reducir movimiento. La atmósfera elegida es la única preferencia que guardamos en este navegador.'));
  settings.append(settingsIntro, styles, scope, goButton('Explorar herramientas opcionales', 'plans', 'secondary')); addPage('settings', settings);
  const previews = mountServicePreviews({ documentRef: d, windowRef: w, onNavigate: navigate });
  for (const page of previews.pages) { page.hidden = false; addPage(page.dataset.v11Page, page); }

  const mobile = el('nav'); mobile.id = 'v11-mobile-nav'; mobile.setAttribute('aria-label', 'Accesos principales');
  for (const [destination, label, art] of [['home', 'Inicio', House], ['messages', 'Mensajes', MessagesSquare], ['community', 'Comunidad', UsersRound], ['care', 'Estoy segura', HeartHandshake]]) mobile.append(goButton(label, destination, '', art));
  const drawer = el('dialog'); drawer.id = 'v11-more'; drawer.setAttribute('aria-labelledby', 'v11-more-title');
  const drawerHeader = el('div', 'section-heading'); const moreTitle = el('h2', '', 'Tu espacio completo'); moreTitle.id = 'v11-more-title';
  let returnDrawerFocus = true;
  const closeDrawer = (restoreFocus = true) => { if (drawer.open) { returnDrawerFocus = restoreFocus; drawer.close(); } };
  const closeButton = button('', closeDrawer, 'v11-icon-button'); closeButton.append(icon(X)); closeButton.setAttribute('aria-label', 'Cerrar menú'); drawerHeader.append(moreTitle, closeButton);
  const drawerNav = el('nav', 'v11-nav'); drawerNav.setAttribute('aria-label', 'Todos los servicios');
  for (const service of SERVICES) drawerNav.append(goButton(service.title, service.route, '', service.icon)); drawerNav.append(goButton('Preferencias', 'settings', '', Settings2), goButton('Acceso', 'access', '', UserRound)); drawer.append(drawerHeader, drawerNav);
  const more = button('', () => {
    if (!drawer.open) { returnDrawerFocus = true; drawer.showModal(); more.setAttribute('aria-expanded', 'true'); }
  }, ''); more.append(icon(Menu), el('span', '', 'Más')); more.setAttribute('aria-haspopup', 'dialog'); more.setAttribute('aria-controls', drawer.id); more.setAttribute('aria-expanded', 'false'); mobile.append(more); shell.append(mobile, drawer);
  listen(drawer, 'close', () => { more.setAttribute('aria-expanded', 'false'); if (returnDrawerFocus) more.focus({ preventScroll: true }); });
  listen(drawer, 'click', event => { if (event.target === drawer) closeDrawer(); });
  const moduleMap = { 'chat-panel': 'messages', 'cofre-panel': 'cofre', 'forocromos-panel': 'community', 'care-panel': 'care' };
  function discover() { for (const [id, key] of Object.entries(moduleMap)) { const node = d.getElementById(id); if (node && !pages.has(key)) { node.dataset.v11Page = key; pages.set(key, node); } } }
  function render() {
    if (disposed) return; discover();
    for (const [key, page] of pages) page.toggleAttribute('v11-hidden', key !== route);
    for (const n of shell.querySelectorAll('button[data-route]')) { if (n.dataset.route === route) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current'); }
    pageTitle.textContent = { home: 'Inicio', access: 'Acceso al ensayo', settings: 'Preferencias' }[route] || SERVICES.find(item => item.route === route)?.title || 'Tu espacio';
    const accountLabel = actor ? `Cuenta ${actor.split('@')[0].toUpperCase()}` : 'Entrar al ensayo';
    account.querySelector('.v11-account-label').textContent = accountLabel;
    account.setAttribute('aria-label', accountLabel); account.title = accountLabel;
    more.toggleAttribute('data-current-section', !['home', 'messages', 'community', 'care'].includes(route));
    signOut.hidden = !actor;
  }
  function writeHistory(replace = false) {
    const state = w.history.state && typeof w.history.state === 'object' ? w.history.state : {};
    w.history[replace ? 'replaceState' : 'pushState']({ ...state, sxV11Route: route }, '', `#${route}`);
  }
  function navigate(destination, { hash = true, focus = true, replace = false } = {}) {
    if (!ROUTES.has(destination)) destination = 'home';
    if (['messages', 'community', 'cofre', 'care'].includes(destination) && !actor) { pending = destination; destination = 'access'; }
    const changed = route !== destination;
    if (changed && hasNavigated) routeScroll.set(route, {
      top: Math.max(0, w.scrollY || 0),
      nested: Array.from(pages.get(route)?.querySelectorAll('.messages') || []).map(node => ({
        node, top: node.scrollTop, atEnd: node.clientHeight > 0 && node.scrollHeight - node.scrollTop - node.clientHeight <= 64
      }))
    });
    route = destination;
    if (hash && w.location.hash !== `#${route}`) writeHistory(replace || !hasNavigated);
    closeDrawer(false); render();
    if (focus) main.focus({ preventScroll: true });
    if (changed && hasNavigated) {
      const position = routeScroll.get(route);
      for (const { node, top, atEnd } of position?.nested || []) node.scrollTop = atEnd ? node.scrollHeight : top;
      w.scrollTo?.({ top: position?.top || 0, behavior: 'instant' });
    }
    hasNavigated = true;
  }
  function readHash() {
    const key = w.location.hash.slice(1);
    if (key === 'v11-workspace') { main.focus(); writeHistory(true); return; }
    navigate(LEGACY[key] || key || 'home', { hash: false, focus: hasNavigated && (LEGACY[key] || key || 'home') !== route });
  }
  function sessionChanged(event) {
    const snapshot = event ? event.detail : w.__sxCofreSession;
    const next = snapshot?.user?.id || '';
    // Authorization is performed by modules and server. This identity only labels presentation.
    const nextLabel = snapshot?.user?.email || next;
    const signedOut = identityKey && !next;
    if (next !== identityKey) { previews.reset(); routeScroll.clear(); identityKey = next; }
    actor = nextLabel;
    if (signedOut) { pending = ''; navigate('home', { replace: true }); routeScroll.clear(); }
    else if (next && (pending || route === 'access')) { const target = pending || 'home'; pending = ''; navigate(target, { focus: false, replace: true }); } else render();
  }
  let identityKey = '';
  listen(w, 'hashchange', readHash); listen(w, 'popstate', readHash); listen(w, 'sx:session', sessionChanged);
  // Module scripts are independent ESM entries; observe insertion, not their private states.
  const observer = new w.MutationObserver(() => { discover(); render(); }); observer.observe(main, { childList: true });
  sessionChanged(); readHash();
  return { navigate, setTheme, get route() { return route; }, destroy() { disposed = true; observer.disconnect(); cleanups.splice(0).forEach(fn => fn()); previews.destroy(); if ('scrollRestoration' in w.history) w.history.scrollRestoration = previousScrollRestoration; } };
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mountPlatform(), { once: true });
  else mountPlatform();
}
