export const DEFAULT_STYLE = Object.freeze({ font: 'sans', color: 'default' });
const FONTS = Object.freeze([['sans', 'Sencilla'], ['serif', 'Clásica'], ['mono', 'Monoespaciada']]);
const COLORS = Object.freeze([['default', 'Del tema'], ['rose', 'Rosa'], ['violet', 'Violeta'], ['teal', 'Verde agua']]);
const EMOJIS = Object.freeze([
  ['😊', 'Sonrisa'], ['❤️', 'Corazón'], ['💜', 'Corazón violeta'], ['✨', 'Destellos'],
  ['🌸', 'Flor'], ['🤗', 'Abrazo'], ['👏', 'Aplausos'], ['💪', 'Ánimo'],
  ['🙏', 'Gracias'], ['☕', 'Café'], ['🌈', 'Arcoíris'], ['🎉', 'Celebración'],
]);
let composerId = 0;

export function normalizeStyle(value) {
  return {
    font: FONTS.some(([font]) => font === value?.font) ? value.font : DEFAULT_STYLE.font,
    color: COLORS.some(([color]) => color === value?.color) ? value.color : DEFAULT_STYLE.color,
  };
}

function applyStyle(element, value) {
  const style = normalizeStyle(value);
  for (const [font] of FONTS) element.classList.remove(`font-${font}`);
  for (const [color] of COLORS) element.classList.remove(`color-${color}`);
  element.classList.add(`font-${style.font}`, `color-${style.color}`);
  return style;
}

export function renderBody(doc, body, style) {
  const element = doc.createElement('div');
  element.className = 'styled-body';
  applyStyle(element, style);
  for (const part of String(body ?? '').split(/\n\s*\n/)) {
    const paragraph = doc.createElement('p');
    paragraph.textContent = part;
    element.append(paragraph);
  }
  return element;
}

export function attachComposer({ doc, textarea, style = DEFAULT_STYLE, onStyleChange = () => {} }) {
  const id = `forum-composer-${++composerId}`;
  const win = doc.defaultView;
  const element = doc.createElement('div');
  element.className = 'composer-toolbar';
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', 'Aspecto del mensaje y emojis');
  const cleanups = [];
  const listen = (node, event, fn) => { node.addEventListener(event, fn); cleanups.push(() => node.removeEventListener(event, fn)); };
  let current = normalizeStyle(style), destroyed = false;

  function choice(key, title, values) {
    const label = doc.createElement('label'); label.className = 'composer-choice';
    const caption = doc.createElement('span'); caption.textContent = title;
    const select = doc.createElement('select'); select.name = `${id}-${key}`;
    select.setAttribute('aria-label', title);
    for (const [value, text] of values) {
      const option = doc.createElement('option'); option.value = value; option.textContent = text; select.append(option);
    }
    listen(select, 'change', () => {
      if (textarea.disabled || textarea.readOnly) { select.value = current[key]; return; }
      setStyle({ ...current, [key]: select.value });
      onStyleChange({ ...current });
    });
    label.append(caption, select); element.append(label);
    return select;
  }
  const font = choice('font', 'Fuente', FONTS), color = choice('color', 'Color', COLORS);
  const toggle = doc.createElement('button'); toggle.type = 'button'; toggle.className = 'button button-secondary emoji-toggle';
  toggle.textContent = '😊 Emoji'; toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', `${id}-emojis`);
  const picker = doc.createElement('div'); picker.id = `${id}-emojis`; picker.className = 'emoji-picker'; picker.hidden = true;
  picker.setAttribute('role', 'group'); picker.setAttribute('aria-label', 'Elegir un emoji');
  const status = doc.createElement('span'); status.className = 'composer-status field-help'; status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  function closePicker() { picker.hidden = true; toggle.setAttribute('aria-expanded', 'false'); }
  listen(toggle, 'click', () => {
    if (textarea.disabled || textarea.readOnly) return;
    if (!picker.hidden) { closePicker(); return; }
    picker.hidden = false; toggle.setAttribute('aria-expanded', 'true');
    picker.querySelector('button')?.focus();
  });
  listen(element, 'keydown', event => {
    if (event.key === 'Escape' && !picker.hidden) {
      event.preventDefault(); event.stopPropagation(); closePicker(); toggle.focus();
    }
  });
  for (const [emoji, name] of EMOJIS) {
    const button = doc.createElement('button'); button.type = 'button'; button.textContent = emoji;
    button.className = 'emoji-option'; button.setAttribute('aria-label', `Insertar ${name.toLocaleLowerCase('es')}`);
    listen(button, 'click', () => {
      if (textarea.disabled || textarea.readOnly) return;
      const start = textarea.selectionStart, end = textarea.selectionEnd;
      const length = textarea.value.length - (end - start) + emoji.length;
      if (textarea.maxLength >= 0 && length > textarea.maxLength) {
        status.textContent = 'Este emoji no cabe en el límite del mensaje.';
      } else {
        textarea.setRangeText(emoji, start, end, 'end');
        const input = typeof win.InputEvent === 'function'
          ? new win.InputEvent('input', { bubbles: true, inputType: 'insertText', data: emoji })
          : new win.Event('input', { bubbles: true });
        textarea.dispatchEvent(input); status.textContent = '';
      }
      closePicker(); textarea.focus();
    });
    picker.append(button);
  }
  element.append(toggle, picker, status);

  function setStyle(value) {
    if (destroyed) return;
    current = applyStyle(textarea, value); font.value = current.font; color.value = current.color;
  }
  setStyle(current);
  return {
    element,
    getStyle: () => ({ ...current }),
    setStyle,
    reset() { setStyle(DEFAULT_STYLE); closePicker(); status.textContent = ''; },
    destroy() {
      if (destroyed) return;
      destroyed = true; cleanups.forEach(remove => remove()); closePicker(); element.remove();
    },
  };
}

const ACTIVE_PRIVILEGES = Object.freeze([
  'Publicar y responder desde la admisión.',
  'Adjuntar imágenes y elegir avatar desde la admisión.',
  'Elegir fuente y color desde la admisión.',
]);
export const PROFILE_RULES = Object.freeze({
  activePrivileges: ACTIVE_PRIVILEGES,
  badgeNotice: 'Las insignias reconocen una trayectoria. No amplían permisos ni son una clasificación de personas.',
  helperMinDays: 90,
  helperNotice: 'A partir de 90 días puedes presentar tu candidatura a ayudante. El equipo revisa cada candidatura; no es un ascenso automático.',
  moderatorNotice: 'La moderación se ofrece por invitación y aceptación. Ninguna insignia ni antigüedad la concede.',
});
export const PROFILE_STAGES = Object.freeze([
  { id: 'bienvenida', label: 'Bienvenida', minDays: 0, minContributions: 0, minActiveDays: 0, description: 'Tu espacio empieza cuando se acepta tu entrada.' },
  { id: 'vecina', label: 'Vecina', minDays: 7, minContributions: 3, minActiveDays: 0, description: 'Una primera semana compartiendo con la comunidad.' },
  { id: 'habitual', label: 'Habitual', minDays: 30, minContributions: 15, minActiveDays: 5, description: 'Reconoce una presencia que se mantiene en días distintos.' },
  { id: 'referente', label: 'Referente', minDays: 90, minContributions: 50, minActiveDays: 15, description: 'Reconoce una trayectoria compartida; no acredita asesoramiento ni otorga autoridad.' },
  { id: 'veterana', label: 'Veterana', minDays: 180, minContributions: 100, minActiveDays: 30, description: 'Reconoce el tiempo y la participación sostenida, sin poderes de moderación.' },
].map(stage => Object.freeze({ ...stage, privileges: ACTIVE_PRIVILEGES })));

const count = value => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
export function describeProgress(stats = {}, now = Date.now()) {
  stats = stats || {};
  const created = stats.created_at == null || stats.created_at === '' ? NaN : new Date(stats.created_at).getTime(), current = new Date(now).getTime();
  const days = Number.isFinite(created) && Number.isFinite(current) ? Math.max(0, Math.floor((current - created) / 86400000)) : 0;
  const contributions = count(stats.topic_count) + count(stats.reply_count), activeDays = count(stats.active_days);
  const confirmedStage = PROFILE_STAGES.find(stage => stage.id === (stats.stage_id ?? stats.stage));
  const stage = confirmedStage || PROFILE_STAGES.filter(item => days >= item.minDays && contributions >= item.minContributions && activeDays >= item.minActiveDays).at(-1);
  const nextStage = PROFILE_STAGES[PROFILE_STAGES.indexOf(stage) + 1] || null;
  return { stage, nextStage, days, contributions, activeDays, helperEligible: days >= PROFILE_RULES.helperMinDays, helperReviewRequired: true };
}

export async function normalizeAvatar(file, { win = globalThis.window } = {}) {
  const types = ['image/jpeg', 'image/png', 'image/webp'];
  if (!file || !types.includes(file.type) || !Number.isFinite(file.size) || file.size < 1 || file.size > 950000) {
    throw new Error('Elige una imagen JPEG, PNG o WebP de hasta 950 KB.');
  }
  let source, objectUrl, canvas;
  try {
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const starts = signature => signature.every((value, index) => bytes[index] === value);
    const valid = file.type === 'image/jpeg' ? starts([255, 216, 255])
      : file.type === 'image/png' ? starts([137, 80, 78, 71, 13, 10, 26, 10])
        : starts([82, 73, 70, 70]) && [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value);
    if (!valid) throw new Error('No se ha podido leer esta imagen.');
    if (typeof win.createImageBitmap === 'function') source = await win.createImageBitmap(file, { imageOrientation: 'from-image' });
    else {
      objectUrl = win.URL.createObjectURL(file);
      source = new win.Image();
      await new Promise((resolve, reject) => {
        source.onload = resolve;
        source.onerror = () => reject(new Error('No se ha podido leer esta imagen.'));
        source.src = objectUrl;
      });
    }
    const width = source.naturalWidth || source.width, height = source.naturalHeight || source.height;
    if (!width || !height) throw new Error('No se ha podido leer esta imagen.');
    canvas = win.document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Este navegador no puede preparar el avatar.');
    const side = Math.min(width, height);
    context.drawImage(source, (width - side) / 2, (height - side) / 2, side, side, 0, 0, 256, 256);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('No se ha podido preparar el avatar.')), 'image/webp', 0.8));
    if (blob.type !== 'image/webp') throw new Error('Este navegador no puede guardar el avatar en WebP.');
    return new win.File([blob], 'avatar.webp', { type: 'image/webp' });
  } catch (error) {
    if (error instanceof Error && /^(Elige |Este navegador |No se ha podido )/.test(error.message)) throw error;
    throw new Error('No se ha podido leer esta imagen.');
  } finally {
    source?.close?.();
    if (source && 'onload' in source) { source.onload = null; source.onerror = null; source.removeAttribute?.('src'); }
    if (objectUrl) win.URL.revokeObjectURL(objectUrl);
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
