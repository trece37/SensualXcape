/** Interactive product previews. No network, durable storage or provider calls. */
export function mountServicePreviews({ documentRef = document, windowRef = window, onNavigate = () => {} } = {}) {
  const element = (tag, className, text) => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (text, id, action, className = 'secondary') => {
    const node = element('button', className, text); node.type = 'button'; node.id = id; node.addEventListener('click', action); return node;
  };
  const field = (host, tag, id, labelText, props = {}) => {
    const label = element('label', '', labelText); label.htmlFor = id;
    const input = element(tag); input.id = id; Object.assign(input, props); host.append(label, input); return input;
  };
  const status = (host, id) => { const node = element('p', 'v11-preview-status'); node.id = id; node.setAttribute('role', 'status'); node.setAttribute('aria-live', 'polite'); host.append(node); return node; };
  const pages = [];
  const page = (route, title, intro) => {
    const section = element('section', 'panel v11-detail'); section.dataset.v11Page = route; section.id = `v11-${route}`; section.hidden = true;
    const heading = element('h2', '', title); heading.id = `v11-${route}-title`; section.setAttribute('aria-labelledby', heading.id);
    section.append(element('p', 'eyebrow', 'MAQUETA INTERACTIVA'), heading, element('p', 'v11-service-intro', intro), element('p', 'v11-preview-note', 'Vista de prueba en este navegador. Los cambios se descartan al recargar o cambiar de cuenta; no se envían ni se guardan en el servidor.'));
    pages.push(section); return section;
  };
  let destroyed = false;
  const cleanup = [];

  const profile = page('profile', 'Mi perfil', 'Decide cómo quieres presentarte y quién debería ver tu información. Puedes ensayar tu tarjeta antes de publicar nada.');
  const profileGrid = element('div', 'v11-feature-grid');
  const profileForm = element('form', 'v11-form-grid'); profileForm.id = 'v11-profile-form';
  const alias = field(profileForm, 'input', 'v11-profile-alias', 'Tu alias', { maxLength: 50, placeholder: 'El nombre que tú elijas', required: true });
  const city = field(profileForm, 'input', 'v11-profile-city', 'Ciudad · opcional', { maxLength: 60, placeholder: 'Sin ubicación exacta' });
  const bio = field(profileForm, 'textarea', 'v11-profile-bio', 'Sobre mí · opcional', { maxLength: 500, rows: 4, placeholder: 'Comparte solo lo que quieras' });
  const visibility = field(profileForm, 'select', 'v11-profile-visibility', 'Visibilidad de esta tarjeta');
  for (const [value, text] of [['private', 'Solo yo'], ['companions', 'Compañeras admitidas'], ['accepted', 'Mis contactos aceptados']]) {
    const option = element('option', '', text); option.value = value; visibility.append(option);
  }
  const saveProfile = button('Guardar mi vista de prueba', 'v11-profile-save', () => {}, 'primary'); saveProfile.type = 'submit'; profileForm.append(saveProfile);
  const profilePreview = element('article', 'v11-preview-card'); profilePreview.setAttribute('aria-label', 'Vista previa de tu tarjeta');
  const avatar = element('span', 'v11-avatar', 'T'); avatar.setAttribute('aria-hidden', 'true');
  const previewAlias = element('h3', '', 'Tu alias'); const previewCity = element('p'); const previewBio = element('p'); const previewVisibility = element('p', 'v11-preview-note', 'Vista previa · solo yo');
  profilePreview.append(avatar, previewAlias, previewCity, previewBio, previewVisibility); profileGrid.append(profileForm, profilePreview); profile.append(profileGrid);
  const profileStatus = status(profile, 'v11-profile-status');
  profileForm.addEventListener('submit', event => {
    event.preventDefault(); if (destroyed || !alias.value.trim()) return;
    previewAlias.textContent = alias.value.trim(); avatar.textContent = [...alias.value.trim()][0].toLocaleUpperCase('es');
    previewCity.textContent = city.value.trim() || 'Ciudad sin indicar'; previewBio.textContent = bio.value.trim() || 'Tú decides qué contar.';
    previewVisibility.textContent = `Visibilidad elegida en esta maqueta: ${visibility.selectedOptions[0].textContent}.`;
    profileStatus.textContent = 'Vista de prueba actualizada. Tu perfil no se ha publicado ni compartido.';
  });
  cleanup.push(() => { profileForm.reset(); previewAlias.textContent = 'Tu alias'; avatar.textContent = 'T'; previewCity.textContent = previewBio.textContent = profileStatus.textContent = ''; previewVisibility.textContent = 'Vista previa · solo yo'; });

  const trust = page('trust', 'Mis límites', 'Un bloqueo personal y un aviso a revisión tienen funciones distintas. Aquí puedes ensayar ambas con contactos ficticios.');
  trust.append(element('p', 'v11-preview-note', 'Los bloqueos de esta pantalla son ejemplos. Para gestionar los bloqueos que sí afectan al chat local, abre Mensajes.'));
  trust.append(button('Ir a mis contactos y mensajes', 'v11-trust-messages', () => { if (!destroyed) onNavigate('messages'); }, 'primary'));
  const trustList = element('ul', 'v11-demo-list'); trustList.id = 'v11-trust-list';
  const blocked = new Set();
  function renderTrust() {
    trustList.replaceChildren();
    for (const [id, name] of [['demo-one', 'Contacto de prueba A'], ['demo-two', 'Contacto de prueba B']]) {
      const item = element('li', 'v11-preview-card');
      item.append(element('span', '', name), element('p', 'v11-preview-note', blocked.has(id) ? 'Bloqueado en esta maqueta.' : 'Sin bloqueo en esta maqueta.'));
      item.append(button(blocked.has(id) ? 'Desbloquear ejemplo' : 'Bloquear ejemplo', `v11-trust-${id}`, () => { if (destroyed) return; blocked.has(id) ? blocked.delete(id) : blocked.add(id); renderTrust(); })); trustList.append(item);
    }
  }
  renderTrust(); trust.append(trustList);
  const reportForm = element('form', 'v11-form-grid'); reportForm.id = 'v11-report-form';
  reportForm.append(element('h3', '', 'Preparar un aviso confidencial'));
  const report = field(reportForm, 'textarea', 'v11-report-body', 'Describe un ejemplo ficticio · sin nombres ni datos reales', { rows: 4, maxLength: 1500, required: true });
  const reportButton = button('Ver recibo de prueba', 'v11-report-submit', () => {}, 'secondary'); reportButton.type = 'submit'; reportForm.append(reportButton); trust.append(reportForm);
  const reportStatus = status(trust, 'v11-report-status');
  reportForm.addEventListener('submit', event => { event.preventDefault(); if (destroyed || !report.value.trim()) return; reportStatus.textContent = 'Recibo ficticio: aviso preparado en este navegador. No se ha enviado a moderación ni ha cambiado el estado de ninguna cuenta.'; });
  cleanup.push(() => { blocked.clear(); renderTrust(); reportForm.reset(); reportStatus.textContent = ''; });

  const auralink = page('auralink', 'Factoría Visual · AuraLink', 'Explora un ambiente visual con una imagen tuya o autorizada. En esta maqueta solo se cambia su presentación en pantalla.');
  const visualGrid = element('div', 'v11-feature-grid');
  const visualForm = element('form', 'v11-form-grid'); visualForm.id = 'v11-visual-form';
  const file = field(visualForm, 'input', 'v11-visual-file', 'Tu imagen · JPG, PNG o WebP · hasta 10 MiB', { type: 'file', accept: 'image/jpeg,image/png,image/webp' });
  const consentLabel = element('label', 'v11-checkbox'); const consent = element('input'); consent.type = 'checkbox'; consent.id = 'v11-visual-consent';
  consentLabel.append(consent, element('span', '', 'Es una imagen mía o tengo permiso de las personas adultas representadas para esta prueba.')); visualForm.append(consentLabel);
  const style = field(visualForm, 'select', 'v11-visual-style', 'Ambiente de muestra');
  for (const [value, labelText] of [['editorial', 'Editorial · natural'], ['rose', 'Rosa · cálido'], ['noir', 'Noir · monocromo']]) { const option = element('option', '', labelText); option.value = value; style.append(option); }
  const visualSubmit = button('Ver ambiente de muestra', 'v11-visual-submit', () => {}, 'primary'); visualSubmit.type = 'submit'; visualForm.append(visualSubmit);
  const removeImage = button('Quitar mi imagen', 'v11-visual-remove', () => clearImage()); visualForm.append(removeImage);
  const visualPreview = element('figure', 'v11-visual-preview');
  const image = element('img'); image.id = 'v11-visual-image'; image.alt = 'Vista local de la imagen elegida'; image.hidden = true;
  const visualEmpty = element('p', 'v11-preview-note', 'Tu imagen aparecerá aquí. No se sube al servidor.');
  const caption = element('figcaption', 'v11-preview-note', 'Sin generación de IA, retoque corporal ni exportación. Solo un filtro visual local.'); visualPreview.append(image, visualEmpty, caption);
  visualGrid.append(visualForm, visualPreview); auralink.append(visualGrid);
  const visualStatus = status(auralink, 'v11-visual-status');
  let objectUrl = null, pendingFile = null;
  function clearImage() {
    if (objectUrl) windowRef.URL.revokeObjectURL(objectUrl);
    objectUrl = null; pendingFile = null; image.removeAttribute('src'); image.hidden = true; image.style.filter = ''; visualEmpty.hidden = false; file.value = ''; consent.checked = false; visualStatus.textContent = '';
  }
  file.addEventListener('change', () => {
    if (destroyed) return;
    const selected = file.files?.[0];
    if (objectUrl) { windowRef.URL.revokeObjectURL(objectUrl); objectUrl = null; }
    image.removeAttribute('src'); image.hidden = true; visualEmpty.hidden = false; consent.checked = false; pendingFile = null;
    if (!selected) { visualStatus.textContent = ''; return; }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(selected.type) || selected.size > 10 * 1024 * 1024) { file.value = ''; visualStatus.textContent = 'Elige un JPG, PNG o WebP de hasta 10 MiB. No se ha subido ningún archivo.'; return; }
    pendingFile = selected; visualStatus.textContent = 'Imagen seleccionada en tu navegador. Confirma el permiso antes de verla.';
  });
  visualForm.addEventListener('submit', event => {
    event.preventDefault(); if (destroyed) return;
    if (!pendingFile || !consent.checked) { visualStatus.textContent = 'Elige una imagen autorizada y marca tu permiso para esta prueba.'; return; }
    if (!objectUrl) objectUrl = windowRef.URL.createObjectURL(pendingFile);
    image.src = objectUrl; image.hidden = false; visualEmpty.hidden = true;
    image.style.filter = ({ editorial: 'none', rose: 'sepia(.12) saturate(.9)', noir: 'grayscale(1)' })[style.value] || 'none';
    visualStatus.textContent = 'Ambiente de muestra aplicado en pantalla. Tu imagen sigue en este navegador y no se ha generado una imagen nueva.';
  });
  image.addEventListener('error', () => { clearImage(); if (!destroyed) visualStatus.textContent = 'No podemos mostrar este archivo como imagen. Prueba con otro; no se ha subido nada.'; });
  consent.addEventListener('change', () => { if (!consent.checked) { if (objectUrl) windowRef.URL.revokeObjectURL(objectUrl); objectUrl = null; image.removeAttribute('src'); image.hidden = true; visualEmpty.hidden = false; } });
  cleanup.push(() => { clearImage(); style.value = 'editorial'; });

  const feedback = page('feedback', 'Mejorar SensualXcape', 'Tu experiencia puede cambiar el producto. Comparte una idea cuando te apetezca, sin adjuntar conversaciones personales.');
  const feedbackForm = element('form', 'v11-form-grid'); feedbackForm.id = 'v11-feedback-form';
  const feedbackBody = field(feedbackForm, 'textarea', 'v11-feedback-body', '¿Qué te facilitaría el día? · ejemplo ficticio', { rows: 6, maxLength: 2000, required: true });
  const feedbackSubmit = button('Preparar mi sugerencia', 'v11-feedback-submit', () => {}, 'primary'); feedbackSubmit.type = 'submit'; feedbackForm.append(feedbackSubmit); feedback.append(feedbackForm);
  const feedbackStatus = status(feedback, 'v11-feedback-status');
  feedbackForm.addEventListener('submit', event => { event.preventDefault(); if (destroyed || !feedbackBody.value.trim()) return; feedbackStatus.textContent = 'Sugerencia preparada en esta maqueta. No se ha enviado ni se han leído tus chats, archivos o comunidad.'; });
  cleanup.push(() => { feedbackForm.reset(); feedbackStatus.textContent = ''; });

  const plans = page('plans', 'Herramientas a tu medida', 'Queremos cobrar por utilidad comprensible. Primero contrastamos qué te sirve; los precios y las condiciones aún están por definir.');
  const plansGrid = element('div', 'v11-feature-grid');
  for (const [id, heading, description] of [['daily', 'Tu espacio cotidiano', 'Contactos, comunidad, Cofre y check-in. Prueba sus recorridos locales desde la navegación.'], ['visual', 'Opciones de creación', 'AuraLink y herramientas visuales voluntarias. Su alcance, coste y proveedores siguen por concretar.']]) {
    const card = element('article', 'v11-preview-card'); card.append(element('h3', '', heading), element('p', '', description), element('p', 'v11-preview-note', 'Precio pendiente · sin suscripción ni cobro en esta maqueta'));
    card.append(button('Me interesa explorar esto', `v11-plan-${id}`, () => { if (!destroyed) plansStatus.textContent = `Interés de prueba: ${heading}. No has contratado ni pagado nada; no se ha enviado tu elección.`; })); plansGrid.append(card);
  }
  plans.append(plansGrid); const plansStatus = status(plans, 'v11-plans-status'); cleanup.push(() => { plansStatus.textContent = ''; });

  function reset() { for (const clear of cleanup) clear(); }
  return { pages, reset, destroy() { reset(); destroyed = true; for (const section of pages) section.remove(); } };
}
