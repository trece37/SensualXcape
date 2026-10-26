import { House, UserRound, UsersRound, Vault, HeartHandshake, Sparkles, ShieldCheck, MessagesSquare,
  ArrowUpRight, ArrowLeft, ChevronRight, Info, X, Settings2, Eye, Sun, Moon, LogOut, Gem, MessageSquarePlus } from 'lucide';
import { createProfileView } from './profile-studio.js';
import { createCofreView } from './cofre-studio.js';
import { SERVICE_GUIDES, createGuideView } from './guide-studio.js';
import { mountEffects } from './effects/experience.js';

const ART = './assets/v2/';
import { STUDIO_NOTICES } from './notices-studio.js';
export { STUDIO_NOTICES };

export function mountStudio({ platform, documentRef = document, windowRef = window, live = null } = {}) {
  if (!platform || documentRef.getElementById('sx-studio-footer')) return null;
  const d = documentRef, w = windowRef, cleanups = [], main = d.getElementById('v11-workspace');
  const serviceGuides=live?.guides||SERVICE_GUIDES;
  let entered = false, adult = false, sharedProfile = null, pendingRoute = 'home', disposed = false, visualEffects,liveIdentity=null;
  const el = (tag, cls, text) => { const node = d.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const on = (node, type, fn) => { node.addEventListener(type, fn); cleanups.push(() => node.removeEventListener(type, fn)); };
  const icon = (data, cls = '') => { const svg = d.createElementNS('http://www.w3.org/2000/svg', 'svg'); for (const [key, value] of Object.entries({ viewBox:'0 0 24 24', fill:'none', stroke:'currentColor', 'stroke-width':'1.6', 'stroke-linecap':'round', 'stroke-linejoin':'round', 'aria-hidden':'true', class:`sx-icon ${cls}` })) svg.setAttribute(key,value); for (const [tag, attrs] of data) { const child = d.createElementNS(svg.namespaceURI,tag); for (const [key,value] of Object.entries(attrs)) child.setAttribute(key,value); svg.append(child); } return svg; };
  const button = (label, action, cls = 'sx-button', art) => { const node = el('button', cls); node.type = 'button'; if (art) node.append(icon(art)); node.append(el('span', '', label)); on(node,'click',action); return node; };
  const go = (label, route, cls='sx-button', art=ChevronRight) => { const node=button(label,()=>platform.navigate(route),cls,art); node.dataset.sxRoute=route;node.dataset.route=route;return node; };
  const image = (name, alt='', cls='') => { const node=el('img',cls); node.src=ART+name+'.webp'; node.alt=alt; node.decoding='async'; node.width=name==='portal'?1536:1024; node.height=1024; return node; };
  const mark = () => { const node=el('span','sx-wordmark'); node.append(d.createTextNode('Sensual'),el('span','','X'),d.createTextNode('cape')); return node; };
  const smallInfo = (key,label) => button(label||STUDIO_NOTICES[key]?.summary||'Más información',()=>showInfo(key),'sx-info',Info);
  const helpButton = (label,action) => { const node=button('?',action,'sx-help-point');node.setAttribute('aria-label',label);node.title=label;return node; };
  const heading = (eyebrow,title,description) => { const node=el('header','sx-section-heading'); node.append(el('p','sx-eyebrow',eyebrow),el('h2','',title)); if(description) node.append(el('p','sx-lead',description)); return node; };
  const toast=el('p','sx-toast'); toast.id='sx-toast'; toast.setAttribute('role','status'); toast.setAttribute('aria-live','polite'); toast.hidden=true; d.body.append(toast);
  let toastTimer;
  function notify(text) { w.clearTimeout(toastTimer); toast.textContent=text; toast.hidden=false; toastTimer=w.setTimeout(()=>{toast.hidden=true;},6500); }
  const dialog=el('dialog','sx-dialog'); dialog.id='sx-info-dialog'; dialog.setAttribute('aria-labelledby','sx-dialog-title'); d.body.append(dialog);
  let dialogTrigger=null, resolveConfirm=null;
  function closeDialog(answer=false) { const resolve=resolveConfirm;resolveConfirm=null;if(dialog.open)dialog.close();if(resolve)resolve(answer); }
  on(dialog,'close',()=>{ if(resolveConfirm) { const resolve=resolveConfirm; resolveConfirm=null; resolve(false); } dialogTrigger?.isConnected&&dialogTrigger.focus({preventScroll:true}); });
  on(dialog,'cancel',event=>{event.preventDefault();closeDialog(false);});
  on(dialog,'click',event=>{if(event.target===dialog)closeDialog(false);});
  function fillDialog(title,paragraphs) { dialogTrigger=d.activeElement; dialog.replaceChildren(); const head=el('div','sx-dialog-head'); const h=el('h2','',title); h.id='sx-dialog-title'; const close=button('Cerrar',()=>closeDialog(false),'sx-icon-button',X); close.setAttribute('aria-label','Cerrar información'); head.append(h,close); dialog.append(head); for(const text of paragraphs)dialog.append(el('p','',text)); }
  function showInfo(key) { if(key?.startsWith('how-')){showGuide(key.slice(4));return;}const info=live?.notices?.[key]||STUDIO_NOTICES[key]||STUDIO_NOTICES.privacy; if(dialog.open)closeDialog(false); fillDialog(info.title,info.paragraphs); dialog.append(button('Entendido',()=>closeDialog(false),'sx-button sx-primary')); dialog.showModal(); }
  function showGuide(key){const guide=serviceGuides[key];if(!guide)return;if(dialog.open)closeDialog(false);fillDialog(guide.title,[guide.description]);const steps=el('ol','sx-how-steps');for(const step of guide.steps){const item=el('li');item.append(el('h3','',step.title),el('p','',step.text));steps.append(item);}dialog.append(steps,el('p','sx-guide-scope',guide.note));const actions=el('div','sx-actions');actions.append(button('Cerrar guía',()=>closeDialog(false),'sx-button'),button(entered?'Abrir este espacio':'Ver el área profesional',()=>{closeDialog(false);platform.navigate(entered?guide.route:'professional');},'sx-button sx-primary'));dialog.append(actions);dialog.showModal();}
  function confirmAction({title,description,confirmLabel='Eliminar de la prueba',danger=true}) { if(dialog.open)closeDialog(false); fillDialog(title,[description]); return new Promise(resolve=>{ resolveConfirm=resolve; const actions=el('div','sx-actions'); actions.append(button('Conservar',()=>closeDialog(false),'sx-button'),button(confirmLabel,()=>closeDialog(true),`sx-button ${danger?'sx-danger':'sx-primary'}`)); dialog.append(actions); dialog.showModal(); }); }

  d.body.classList.add('sx-studio'); d.title='SensualXcape · Un universo propio';
  platform.setTheme('noir');
  const publicBar=el('header','sx-public-header'); const brand=button('',()=>platform.navigate('welcome'),'sx-brand-button'); brand.append(mark());
  const publicActions=el('div','sx-public-actions');const helpLink=helpButton('Cómo funciona SensualXcape',()=>platform.navigate('guide'));helpLink.classList.add('sx-header-guide');publicActions.append(helpLink,go('Entrar','professional','sx-text-link'),smallInfo('privacy','Privacidad'));
  publicBar.append(brand,publicActions); main.before(publicBar);
  const banner=d.querySelector('.demo-banner'); if(banner) { banner.textContent='SensualXcape V2 · vista de prueba · cambios solo en esta pestaña'; banner.append(smallInfo('privacy','Sobre esta prueba')); }

  const welcome=el('section','sx-welcome');
  const welcomeHero=el('div','sx-landing-hero'); const heroArt=image('portal','','sx-hero-image'); heroArt.loading='eager'; heroArt.fetchPriority='high';
  const heroCopy=el('div','sx-hero-copy'); heroCopy.append(el('p','sx-eyebrow','TU ESPACIO. TUS DECISIONES.'));
  const h=el('h1'); h.append(d.createTextNode('Un universo'),el('br'),el('em','','propio.')); heroCopy.append(h,el('p','sx-lead','Un lugar para presentarte, compartir lo que elijas y tener tus cosas a mano.'));
  const entryActions=el('div','sx-entry-actions'); entryActions.append(go('Área profesional','professional','sx-button sx-primary'),go('Acceso de visitantes','visitors','sx-button sx-glass-button'));
  heroCopy.append(entryActions,el('p','sx-quiet','Una plataforma para personas adultas.')); welcomeHero.append(heroArt,heroCopy); welcome.append(welcomeHero);
  const overview=el('section','sx-overview sx-section'); overview.setAttribute('aria-label','Qué puedes hacer en SensualXcape');overview.append(heading('UN ESPACIO CON PROPÓSITO','Lo que puedes hacer aquí.'));
  const overviewList=el('div','sx-overview-list');
  for(const[key,title,text,art,asset]of[
    ['profile','Tu perfil, tus reglas','Decide qué compartes y con quién.',UserRound,''],
    ['messages','Mensajes con tu permiso','Solicitudes, conversaciones y bloqueo.',MessagesSquare,''],
    ['community','Forocromos','Un espacio entre compañeras para conversar y compartir.',UsersRound,''],
    ['cofre','Mi Cofre','Tus notas y archivos, organizados en tu espacio.',Vault,'cofre'],
    ['care','Estoy segura','Conoce el recorrido de un check-in. Avisos simulados.',ShieldCheck,''],
    ['auralink','AuraLink','Tu imagen, a tu manera. Creación visual en preparación.',Sparkles,'auralink']
  ]){const card=button('',()=>showGuide(key),`sx-overview-card${asset?' sx-overview-illustrated':''}`);card.replaceChildren();const medallion=el('span','sx-overview-icon');medallion.append(icon(art));const copy=el('span','sx-overview-copy');copy.append(el('span','sx-overview-title',title),el('span','sx-overview-description',text));if(asset)card.append(image(asset,'','sx-overview-art'));card.append(medallion,copy,icon(ChevronRight,'sx-overview-arrow'));overviewList.append(card);}
  overview.append(overviewList,go('Conocer todos los servicios','professional','sx-text-link'));welcome.append(overview);
  const promise=el('section','sx-common-promise sx-section'); promise.append(heading('A TU MANERA','Elige cómo quieres entrar.'));
  const paths=el('div','sx-path-grid');
  for(const [eyebrow,title,text,route,art] of [
    ['PARA TI','Tu espacio profesional','Tus fotos, tus palabras, tus conversaciones y tus herramientas. Descubre los servicios antes de entrar.','professional',Sparkles],
    ['PARA CONOCER','Una ventana a los perfiles','Una presentación más clara y sencilla. En esta prueba solo encontrarás perfiles sintéticos y lo que decidas mostrar.','visitors',Eye]
  ]) { const card=el('article','sx-path-card'); card.append(icon(art),el('p','sx-eyebrow',eyebrow),el('h3','',title),el('p','',text),go(route==='professional'?'Conocer mi espacio':'Ver perfiles de prueba',route,'sx-text-link')); paths.append(card); }
  promise.append(paths); welcome.append(promise);
  const principle=el('section','sx-principle sx-section'); principle.append(el('p','sx-eyebrow','BELLEZA CON PROPÓSITO'),el('h2','','Tu información tiene una dueña.'),el('p','sx-lead','Tú decides qué compartes. Las herramientas están para servirte y respetar tus elecciones.'),helpButton('Cómo funciona SensualXcape',()=>platform.navigate('guide')),smallInfo('privacy','Cómo cuidamos tus decisiones')); welcome.append(principle);
  platform.registerPage('welcome',welcome,{title:'SensualXcape'});

  const professional=el('section','sx-professional');
  const proHero=el('section','sx-pro-hero'); proHero.append(image('portal','','sx-pro-hero-art'));
  const proCopy=el('div','sx-pro-copy');const proTitle=el('h1');proTitle.append(d.createTextNode('Tu espacio empieza '),el('em','','contigo.')); proCopy.append(el('p','sx-eyebrow','ÁREA PROFESIONAL'),proTitle,el('p','sx-lead','Organiza tus cosas, conversa entre compañeras y elige cómo quieres mostrarte.'));
  proHero.append(proCopy); professional.append(proHero);
  const login=el('section','sx-login sx-glass'); login.setAttribute('aria-labelledby','sx-login-title');
  login.append(el('p','sx-eyebrow','PRUEBA EL RECORRIDO')); const loginTitle=el('h2','','Entra a tu espacio'); loginTitle.id='sx-login-title';login.append(loginTitle);
  const tabs=el('div','sx-login-tabs'); tabs.setAttribute('role','group'); tabs.setAttribute('aria-label','Acceso de demostración'); let signup=false;
  const loginTab=button('Entrar',()=>setSignup(false),'sx-tab'),signupTab=button('Crear cuenta',()=>setSignup(true),'sx-tab'); tabs.append(loginTab,signupTab);login.append(tabs);
  const loginForm=el('form','sx-login-form'); loginForm.noValidate=true;
  const emailLabel=el('label','','Correo de prueba'); const email=el('input'); email.id='sx-demo-email';email.type='email';email.placeholder='tucuenta@example.invalid';email.autocomplete='off';email.maxLength=120;emailLabel.append(email);
  const passwordLabel=el('label','','Contraseña de prueba');const password=el('input');password.id='sx-demo-password';password.type='password';password.autocomplete='off';password.placeholder='No uses tu contraseña real';password.maxLength=120;passwordLabel.append(password);
  const loginStatus=el('p','sx-field-status');loginStatus.setAttribute('role','status'); const loginSubmit=el('button','sx-button sx-primary','Entrar a mi espacio');loginSubmit.type='submit';
  loginForm.append(emailLabel,passwordLabel,el('p','sx-form-help','Entrada de prueba. No crea una cuenta ni envía tus datos de acceso. Usa datos ficticios.'),loginSubmit,loginStatus);
  login.append(loginForm,button('Explorar con una cuenta de muestra',()=>enter(),'sx-text-link',ArrowUpRight),smallInfo('privacy','Qué ocurre con lo que escribo'));
  professional.append(login);
  function setSignup(next) {signup=next;loginTab.setAttribute('aria-pressed',String(!next));signupTab.setAttribute('aria-pressed',String(next));loginTitle.textContent=next?'Empieza a tu ritmo':'Entra a tu espacio';loginSubmit.textContent=next?'Crear cuenta de demostración':'Entrar a mi espacio';loginStatus.textContent='';}setSignup(false);
  on(loginForm,'submit',event=>{event.preventDefault();if(!email.value.trim()||!password.value){loginStatus.textContent='Completa el correo y la contraseña de prueba, o usa la cuenta de muestra.';return;}password.value='';email.value='';enter();});
  const services=el('section','sx-services sx-section');services.id='sx-services';services.append(heading('MUCHO MÁS QUE UN PERFIL','Lo que puedes hacer aquí.','Herramientas con su propio lugar. Empieza por lo que hoy te sirva.'));
  const serviceData=[
    ['profile','Tu perfil, tus reglas','Prepara tus fotos y tus palabras. Revisa lo que quieres mostrar antes de compartirlo.',UserRound,'01',''],
    ['messages','Mensajes con tu permiso','Acepta o rechaza solicitudes. Conserva el control de tus conversaciones y bloquea contactos.',MessagesSquare,'02',''],
    ['community','Tus compañeras, cerca','Forocromos: conversación, preguntas e ideas en un espacio entre compañeras.',UsersRound,'03',''],
    ['cofre','Tus cosas, en su sitio','Mi Cofre: añade archivos, escribe notas y encuentra lo que has guardado.',Vault,'04','cofre'],
    ['care','Estoy segura','Explora un check-in con tus contactos de confianza. Los avisos de esta demo son simulados.',HeartHandshake,'05',''],
    ['auralink','Una imagen que hable de ti','AuraLink: prepara una vista local de tu imagen. El servicio de creación está en preparación.',Sparkles,'06','auralink']
  ];
  for(const [route,title,text,art,num,asset] of serviceData){const card=el('article',`sx-service-story${asset?' sx-service-illustrated':''}`);if(asset)card.append(image(asset,'','sx-service-art'));const copy=el('div','sx-story-copy');copy.append(icon(art),el('h3','',title),el('p','',text),go(route==='profile'?'Preparar mi perfil':route==='cofre'?'Abrir mi Cofre':'Descubrir este espacio',route,'sx-text-link'),helpButton(`Cómo funciona: ${title}`,()=>showGuide(route)));if(route==='care')copy.append(smallInfo('care','Qué simula el check-in'));if(route==='auralink')copy.append(smallInfo('images','Tu imagen y sus usos'));card.append(copy);services.append(card);}
  const extras=el('div','sx-extras');extras.append(heading('A TU MANERA','También cuenta lo pequeño.','Acceso, invitaciones y herramientas que se explican sin complicarte.'));
  for(const [text,route,art]of[['Mis límites','trust',ShieldCheck],['Modo fácil','settings',Settings2],['Tu voz cuenta','feedback',MessageSquarePlus],['Planes y herramientas','plans',Gem]])extras.append(go(text,route,'sx-extra-link',art));services.append(extras);professional.append(services);
  platform.registerPage('professional',professional,{title:'Área profesional'});
  platform.registerPage('access',el('section'),{title:'Entrar'});

  const dashboard=el('section','sx-dashboard'); dashboard.append(heading('BIENVENIDA A TU ESPACIO','Hoy, a tu manera.','Tu perfil, tus conversaciones y tus cosas. Elige por dónde empezar.'));
  const profileFeature=el('div','sx-profile-feature sx-glass');profileFeature.append(icon(UserRound),el('div',''));profileFeature.lastChild.append(el('p','sx-eyebrow','EMPIEZA POR TI'),el('h3','','Tu perfil merece tu tiempo.'),el('p','','Prepara las fotos, guarda un borrador y decide qué quieres compartir.'));profileFeature.append(go('Preparar mi perfil','profile','sx-button sx-primary'));dashboard.append(profileFeature);
  const shelf=el('details','sx-shelf-panel'),shelfTitle=el('summary','','Tus espacios, a mano');shelf.append(shelfTitle,el('p','sx-shelf-description','Desliza o elige un espacio. El catálogo completo sigue debajo.'));
  const shelfTrack=el('div','sx-shelf-track');shelfTrack.setAttribute('aria-label','Accesos con profundidad');
  for(const[label,route,description,art]of[['Mensajes','messages','Conversaciones que eliges.',MessagesSquare],['Mi Cofre','cofre','Tus notas y archivos.',Vault],['Forocromos','community','Un espacio entre compañeras.',UsersRound]]){const card=go('',route,'sx-shelf-card',art);card.append(el('strong','',label),el('small','',description));shelfTrack.append(card);}shelf.append(shelfTrack);dashboard.append(shelf);
  const dashGrid=el('div','sx-dashboard-grid'); for(const [route,title,text,art,num,asset]of serviceData.slice(1)){const card=button('',()=>platform.navigate(route),'sx-dashboard-card');if(asset)card.append(image(asset,'',''));card.append(icon(art),el('h3','',title),el('p','',text),el('span','sx-quiet','Abrir espacio →'));dashGrid.append(card);}dashboard.append(dashGrid);
  const dashExtras=el('div','sx-extras');for(const [text,route,art]of[['Mis límites','trust',ShieldCheck],['Preferencias','settings',Settings2],['Tu voz cuenta','feedback',MessageSquarePlus],['Planes y herramientas','plans',Gem]])dashExtras.append(go(text,route,'sx-extra-link',art));dashboard.append(dashExtras);platform.registerPage('home',dashboard,{title:'Mi espacio'});

  const profile=(live?.createProfileView || createProfileView)({documentRef:d,windowRef:w,onInfo:showInfo,notify,confirmAction,onPublish:value=>{sharedProfile=value;if(!live)renderVisitors();}});
  const cofre=createCofreView({documentRef:d,windowRef:w,onInfo:showInfo,notify,confirmAction});
  platform.registerPage('profile',profile.element,{title:'Mi perfil'});platform.registerPage('cofre',cofre.element,{title:'Mi Cofre'});
  const guides=createGuideView({documentRef:d,guides:serviceGuides,onOpenGuide:showGuide,onNavigate:route=>platform.navigate(route==='home'&&!entered?'welcome':route)});platform.registerPage('guide',guides.element,{title:'Cómo funciona'});
  for(const key of Object.keys(SERVICE_GUIDES)){const page=main.querySelector(`[data-v11-page="${key}"]`);if(page){const help=el('div','sx-tool-help');help.append(helpButton(`Cómo funciona: ${SERVICE_GUIDES[key].title}`,()=>showGuide(key)));page.prepend(help);}}
  const visitors=el('section','sx-visitors');const visitorHead=heading('VISTAS DE DEMOSTRACIÓN','Cada perfil, una forma de presentarse.','Una selección sintética para probar una lectura más clara. No son personas reales.');
  const visitorControls=el('div','sx-visitor-controls'); visitorControls.append(go('Área profesional','professional','sx-text-link',ArrowLeft));const visitorTheme=button('Cambiar a claro',()=>{const light=visitors.dataset.appearance!=='light';visitors.dataset.appearance=light?'light':'dark';d.body.dataset.visitorAppearance=light?'light':'dark';visitorTheme.replaceChildren(icon(light?Moon:Sun),el('span','',light?'Cambiar a oscuro':'Cambiar a claro'));},'sx-button',Sun);visitorControls.append(visitorTheme);visitors.append(visitorControls,visitorHead);
  const visitorNotice=el('div','sx-visitor-notice');visitorNotice.append(icon(Info),el('p','','Perfiles ficticios y retratos generados. Solo una vista de presentación; no hay reservas, precios ni contacto.'),smallInfo('profile-sharing','Qué se muestra aquí'));visitors.append(visitorNotice);
  const visitorGrid=el('div','sx-visitor-grid');visitors.append(visitorGrid);
  const personas=[{alias:'Luna',bio:'Me gusta encontrar belleza en lo cotidiano. Fotografía, música y conversaciones con tiempo.',art:0},{alias:'Mara',bio:'Creativa y curiosa. Mi espacio para contar quién soy, a mi ritmo.',art:1},{alias:'Noa',bio:'La calma, el diseño y las pequeñas cosas que hacen especial un día.',art:2},{alias:'Vera',bio:'Un poco de arte, libros y una forma propia de mirar el mundo.',art:3}];
  function portrait(index){const node=el('div',`sx-portrait sx-portrait-${index}`);node.setAttribute('role','img');node.setAttribute('aria-label','Retrato sintético de una persona adulta');return node;}
  function renderVisitors(){visitorGrid.replaceChildren();const entries=[...personas];if(sharedProfile)entries.unshift({...sharedProfile,own:true});for(const person of entries){const card=el('article','sx-visitor-card');const cover=person.own&&person.photos?.length?(()=>{const n=el('div','sx-shared-cover');const photo=person.photos[person.coverIndex]||person.photos[0];const img=el('img');img.src=photo.url;img.alt='Foto elegida para la vista de prueba';img.style.objectPosition=`${photo.x??50}% ${photo.y??50}%`;img.style.transform=`scale(${photo.zoom||1})`;n.append(img);return n;})():person.own?el('div','sx-own-placeholder','Tu vista compartida'):portrait(person.art);card.append(cover);const copy=el('div','sx-visitor-copy');copy.append(el('p','sx-eyebrow',person.own?'TU VISTA · SOLO EN ESTA PESTAÑA':'PERFIL SINTÉTICO'),el('h3','',person.alias||'Mi perfil'),el('p','',person.bio||'Sin presentación compartida.'));copy.append(button('Ver presentación',()=>showPresentation(person),'sx-text-link',ArrowUpRight));card.append(copy);visitorGrid.append(card);}}
  function showPresentation(person){fillDialog(person.alias||'Mi perfil',[person.bio||'Sin presentación compartida.',person.own?'Esta es la copia que has elegido mostrar en esta demo. Puedes retirarla desde Mi perfil.':'Persona y fotografía ficticias, creadas únicamente para probar la interfaz.']);if(!person.own)dialog.append(portrait(person.art));else if(person.photos?.length){const gallery=el('div','sx-public-gallery');for(const photo of person.photos){const frame=el('div','sx-public-photo');const picture=el('img');picture.src=photo.url;picture.alt='Foto elegida para esta vista de prueba';picture.style.objectPosition=`${photo.x??50}% ${photo.y??50}%`;picture.style.transform=`scale(${photo.zoom||1})`;frame.append(picture);gallery.append(frame);}dialog.append(gallery);}dialog.append(button('Cerrar presentación',()=>closeDialog(false),'sx-button sx-primary'));dialog.showModal();}
  renderVisitors();platform.registerPage('visitors',visitors,{title:'Visitantes'});

  const settings=el('section','sx-settings');settings.append(heading('A TU MANERA','La misma casa, tu atmósfera.','Cambia el aspecto y el modo de lectura. Tus permisos no cambian con el color.'));
  const themeGrid=el('div','sx-theme-grid');for(const[value,title,text]of[['noir','Noir','Negro, rojo y blanco. La atmósfera principal.'],['rose','Rosa','Luz suave, blanco cálido y rosa.'],['neon','Fucsia','Gráfica más directa y acentos vibrantes.']]){const b=button('',()=>{platform.setTheme(value);notify(`Atmósfera ${title} aplicada.`);},`sx-theme-choice sx-theme-${value}`);b.append(el('span','sx-theme-swatch'),el('h3','',title),el('p','',text));themeGrid.append(b);}settings.append(themeGrid);
  const easy=el('label','sx-preference sx-glass');const easyInput=el('input');easyInput.type='checkbox';easyInput.id='sx-easy-mode';easy.append(easyInput,el('span','','Modo fácil · más espacio y menos adornos'));on(easyInput,'change',()=>{d.body.classList.toggle('sx-easy',easyInput.checked);visualEffects?.refresh();notify(easyInput.checked?'Modo fácil activado.':'Modo habitual activado.');});settings.append(easy);
  const optional=el('label','sx-preference sx-glass');const optionalInput=el('input');optionalInput.type='checkbox';optionalInput.id='sx-feedback-choice';optional.append(optionalInput,el('span','','Ensayar mi preferencia para sugerencias voluntarias'));on(optionalInput,'change',()=>notify(optionalInput.checked?'Elección de prueba activada. No se recoge ni envía información.':'Elección de prueba retirada.'));settings.append(optional,smallInfo('algorithm','Datos y mejora de las herramientas'),smallInfo('privacy','Privacidad de esta prueba'));
    const deleteAll=button('Borrar mis datos de prueba',async()=>{if(await confirmAction({title:'¿Vaciar tus aportaciones de esta prueba?',description:'Se quitarán tu perfil, su vista compartida, archivos, notas, textos de prueba y elecciones de esta pestaña. Se recargará la demo para limpiar también las conversaciones y otros borradores. No se borran originales o descargas del dispositivo.',confirmLabel:'Borrar datos de prueba'})){profile.reset();cofre.reset();sharedProfile=null;renderVisitors();optionalInput.checked=false;easyInput.checked=false;d.body.classList.remove('sx-easy');entered=false;platform.setTheme('noir');platform.navigate('welcome');w.location.reload();}},'sx-button sx-danger');settings.append(el('hr'),deleteAll,smallInfo('deletion','Qué se elimina y qué permanece'));platform.registerPage('settings',settings,{title:'Preferencias'});

  const footer=el('footer','sx-footer');footer.id='sx-studio-footer';footer.append(mark(),el('p','','Tu espacio. Tus decisiones.'),helpButton('Cómo funciona SensualXcape',()=>platform.navigate('guide')));
  const footerLinks=el('nav','sx-footer-links');footerLinks.setAttribute('aria-label','Información y privacidad');for(const[key,text]of[['legal','Aviso legal'],['privacy','Privacidad'],['terms','Condiciones'],['cookies','Cookies y preferencias'],['deletion','Borrado y decisiones'],['algorithm','Datos e IA']])footerLinks.append(button(text,()=>showInfo(key),'sx-text-link'));footer.append(footerLinks,el('small','','SensualXcape · maqueta en desarrollo · sin servicios remotos conectados'));d.getElementById('v11-shell').append(footer);
  const versionLink=el('a','sx-version-link','SensualXcape V1 · abrir la versión anterior');const v2Path=w.location.pathname.match(/^(.*\/)v2(?:\/|$)/);versionLink.href=v2Path?v2Path[1]:'https://trece37.github.io/SensualXcape/';footer.append(versionLink);
  const signOut=button('Salir de la demo',()=>{entered=false;platform.navigate('welcome');notify('Has salido del espacio de prueba. Recargar limpia las aportaciones de la pestaña.');},'sx-session-exit',LogOut);signOut.setAttribute('aria-label','Salir de la demo');d.querySelector('.v11-topbar-actions')?.append(signOut);
  const privateRoutes=new Set(['home','profile','messages','cofre','community','care','trust','auralink','feedback','plans','settings']);
  platform.setRouteGuard(destination=>{if(destination==='access')return entered?'profile':'professional';if(privateRoutes.has(destination)&&!entered){pendingRoute=destination;return 'professional';}return destination;});
  function enter(){entered=true;password.value='';email.value='';const target=pendingRoute==='home'?'home':pendingRoute;pendingRoute='home';platform.navigate(target);if(!live)notify('Espacio de demostración abierto. Tus aportaciones permanecen en esta pestaña.');}
  function routeChanged(){const route=platform.route;const isPublic=!privateRoutes.has(route);d.body.classList.toggle('sx-public',isPublic);d.body.classList.toggle('sx-visitor-mode',route==='visitors');if(route==='visitors')d.body.dataset.visitorAppearance=visitors.dataset.appearance||'dark';signOut.hidden=!entered;const account=d.getElementById('v11-account');if(account){account.setAttribute('aria-label',entered?'Mi perfil':'Entrar');const label=account.querySelector('.v11-account-label');if(label)label.textContent=entered?'Mi perfil':'Entrar';}d.title=`SensualXcape · ${route==='welcome'?'Un universo propio':route==='professional'?'Área profesional':route==='visitors'?'Perfiles de prueba':d.getElementById('v11-page-title')?.textContent||'Tu espacio'}`;}
  on(w,'sx:route',routeChanged);
  const themeSelect=d.getElementById('v11-theme');if(themeSelect){themeSelect.setAttribute('aria-label','Atmósfera visual');themeSelect.replaceChildren();for(const[value,text]of[['noir','Noir'],['rose','Rosa'],['neon','Fucsia']]){const option=el('option','',text);option.value=value;themeSelect.append(option);}themeSelect.value='noir';}
  const nav=d.getElementById('v11-mobile-nav');if(nav){const links=nav.querySelectorAll('button[data-route]');if(links[1]){links[1].dataset.route='profile';links[1].replaceWith(go('Mi perfil','profile','',UserRound));}if(links[2])links[2].replaceWith(go('Mi Cofre','cofre','',Vault));}
  const start=w.location.hash.slice(1);platform.navigate(start&&start!=='home'?start:'welcome',{replace:true,focus:false});routeChanged();

  const age=el('dialog','sx-age-dialog sx-dialog');age.id='sx-age-gate';age.setAttribute('aria-labelledby','sx-age-title');age.append(mark(),el('p','sx-eyebrow','UNA ENTRADA CONSCIENTE'));const ageTitle=el('h2','','Solo para personas adultas');ageTitle.id='sx-age-title';age.append(ageTitle,el('p','','Para explorar SensualXcape, declara que tienes 18 años o más.'),el('p','sx-form-help','Esta es una declaración de edad, no una verificación de identidad. No implica aceptar usos opcionales de tus datos.'));
  const ageEnter=button('Tengo 18 años o más',()=>{adult=true;age.close();main.focus({preventScroll:true});},'sx-button sx-primary');const ageExit=button('Salir',()=>{age.replaceChildren(el('h2','','Has salido de la demostración'),el('p','','Puedes cerrar esta pestaña.'),button('Volver a la entrada',()=>{age.close();age.remove();showAgeAgain();},'sx-button'));},'sx-text-link');age.append(ageEnter,ageExit,smallInfo('privacy','Leer privacidad de la demo'));d.body.append(age);
  on(age,'cancel',event=>event.preventDefault());
  function showAgeAgain(){if(disposed)return;d.body.append(age);age.replaceChildren(mark(),el('h2','','Solo para personas adultas'),el('p','','Para continuar, declara que tienes 18 años o más.'),ageEnter,ageExit);age.showModal();}
  if(!adult)age.showModal();
  visualEffects=mountEffects({documentRef:d,windowRef:w,platform,settings});
  // Real accounts use the same presentation, with no sample-login handler or synthetic profiles.
  if(live){
    d.body.removeAttribute('data-static-demo');d.body.dataset.liveApp='true';
    if(banner){banner.replaceChildren(d.createTextNode('SensualXcape · acceso privado · perfil y conversaciones conectados'));}
    login.querySelector('.sx-eyebrow').textContent='TU CUENTA SENSUALXCAPE';tabs.remove();
    emailLabel.firstChild.textContent='Correo de acceso';email.placeholder='Tu correo';email.autocomplete='username';email.id='sx-live-email';
    passwordLabel.firstChild.textContent='Contraseña';password.placeholder='Tu contraseña';password.autocomplete='current-password';password.id='sx-live-password';
    const realForm=loginForm.cloneNode(true);loginForm.replaceWith(realForm);
    const realEmail=realForm.querySelector('input[type=email]'),realPassword=realForm.querySelector('input[type=password]'),realStatus=realForm.querySelector('[role=status]'),realSubmit=realForm.querySelector('[type=submit]');
    realForm.querySelector('.sx-form-help').textContent='Usa la misma cuenta que en Foro Cromos. Las nuevas altas se preparan por invitación durante esta prueba privada.';
    login.querySelector(':scope > .sx-text-link')?.remove();
    on(realForm,'submit',async event=>{event.preventDefault();if(realSubmit.disabled)return;if(!realEmail.value.trim()||!realPassword.value){realStatus.textContent='Escribe tu correo y contraseña.';return;}realSubmit.disabled=true;realStatus.textContent='Entrando…';try{await live.signIn(realEmail.value.trim(),realPassword.value);realPassword.value='';realStatus.textContent='';}catch(error){realStatus.textContent=live.errorText?.(error)||'No se ha podido entrar. Revisa tus datos e inténtalo de nuevo.';}finally{realSubmit.disabled=false;}});
    signOut.replaceWith(signOut.cloneNode(true));const realExit=d.querySelector('.sx-session-exit');realExit.replaceChildren(d.createTextNode('Salir de mi cuenta'));realExit.setAttribute('aria-label','Salir de mi cuenta');on(realExit,'click',async()=>{realExit.disabled=true;try{await live.signOut();}catch{notify('No se pudo cerrar la sesión. Inténtalo de nuevo.');}finally{realExit.disabled=false;}});
    // The old sample-only preferences never mutate a real profile.
    deleteAll.remove();optional.remove();settings.querySelector('hr')?.remove();
    settings.append(el('p','sx-form-help','La atmósfera y el modo fácil se guardan en este dispositivo. El perfil se gestiona desde Mi perfil.'));
    visitorGrid.replaceChildren();visitorHead.replaceChildren(heading('PRIVACIDAD POR ELECCIÓN','Tu presentación tiene destinatarias.','Durante el acceso privado, tu perfil compartido solo lo ven tus contactos aceptados. No hay un directorio público.'));visitorNotice.replaceChildren(el('p','','Acepta un contacto desde Mensajes para conversar. Desde su conversación podrás abrir su perfil si ha decidido compartirlo.'));
    footer.querySelector('small').textContent='SensualXcape · prueba privada · acceso, mensajes y perfil conectados a Supabase';
    const forumLink=el('a','sx-version-link','Foro Cromos · abrir la comunidad');forumLink.href='../foro/';footer.append(forumLink);
    const demoLink=el('a','sx-version-link','Explorar la maqueta sin cuenta');demoLink.href='../demo/';footer.append(demoLink);
    d.querySelector('.v11-sidebar-foot .v11-badge').textContent='Acceso privado';
    const intro=welcome.querySelector('.sx-path-card:last-child p:not(.sx-eyebrow)');if(intro)intro.textContent='Tu presentación compartida se reserva a tus contactos aceptados. Tú decides cuándo mostrarla y retirarla.';
    welcome.querySelector('.sx-path-card:last-child .sx-text-link')?.querySelector('span')?.replaceChildren(d.createTextNode('Cómo se comparte un perfil'));
    on(w,'sx:route',()=>{realExit.hidden=!entered;});
  }
  return { get entered(){return entered;}, get sharedProfile(){return sharedProfile;}, showInfo, confirmAction, notify, profile,
    setSession(session){if(!live)return;const wasEntered=entered,nextIdentity=session?.user?.id||null;if(nextIdentity!==liveIdentity){cofre.reset();closeDialog(false);sharedProfile=null;liveIdentity=nextIdentity;}entered=!!session?.user;profile.setSession?.(session);if(!entered){profile.reset?.();if(wasEntered)platform.navigate('welcome',{replace:true});}else if(!wasEntered){enter();}routeChanged();const exit=d.querySelector('.sx-session-exit');if(exit)exit.hidden=!entered;if(!entered){const realForm=d.querySelector('.sx-login-form');for(const input of realForm?.querySelectorAll('input')||[])input.value='';}},
    destroy(){disposed=true;visualEffects?.destroy();w.clearTimeout(toastTimer);profile.destroy();cofre.destroy();closeDialog(false);cleanups.splice(0).forEach(fn=>fn());platform.setRouteGuard(null);for(const node of [dialog,age,toast,footer,publicBar,signOut])node.remove();d.body.classList.remove('sx-studio','sx-public','sx-visitor-mode','sx-easy');}
  };
}
