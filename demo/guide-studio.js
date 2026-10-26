import { UserRound, MessagesSquare, UsersRound, Vault, HeartHandshake, Sparkles, ShieldCheck, MessageSquarePlus, Gem, ArrowUpRight, ArrowLeft, Compass } from 'lucide';

/** Product explanations for the current demonstration, not promises of connected services. */
export const SERVICE_GUIDES = Object.freeze({
  profile: {
    title: 'Tu perfil', eyebrow: 'PRESENTARTE A TU MANERA', route: 'profile',
    description: 'Prepara tu presentación y tus fotos, distinguiendo lo que es privado de lo que eliges compartir.',
    steps: [
      { title: 'Empieza por tu espacio privado', text: 'Puedes poner un alias y escribir notas para ti. Por ejemplo, una idea para tu presentación. Este texto no pasa a la vista compartida.' },
      { title: 'Elige cómo quieres presentarte', text: 'Prepara otro alias y un texto para mostrar. Si añades fotos, puedes ordenarlas, elegir una portada y ajustar cómo se ven sin cambiar los archivos originales.' },
      { title: 'Revisa antes de compartir', text: 'Marca por separado si quieres incluir tu presentación y tus fotos. Mira la vista previa y pulsa «Compartir en esta demo». Puedes retirarla cuando quieras.' }
    ],
    note: 'El perfil solo se comparte dentro de esta página mientras siga abierta. Se borra al recargar; no se publica en Internet ni se envía a otras personas.'
  },
  messages: {
    title: 'Mensajes', eyebrow: 'CONVERSACIONES QUE TÚ ELIGES', route: 'messages',
    description: 'Entiende las solicitudes, abre una conversación y prueba cómo detener un contacto.',
    steps: [
      { title: 'Decide ante una solicitud', text: 'En la lista verás personas de muestra. Puedes aceptar una solicitud para abrir la conversación o rechazarla sin abrirla.' },
      { title: 'Prueba una conversación', text: 'Abre un contacto aceptado y escribe algo inventado, por ejemplo: «¿Compartimos ideas para organizarnos?». Volver a contactos conserva tu borrador mientras la página siga abierta.' },
      { title: 'Conserva el control', text: 'Bloquear el ejemplo desactiva la escritura y conserva su historial de muestra. Puedes revisar lo anterior y retirar tu bloqueo si lo deseas.' }
    ],
    note: 'Los nombres y las conversaciones son ficticios. Añadir un mensaje aquí no se lo envía a nadie.'
  },
  community: {
    title: 'Forocromos', eyebrow: 'CONOCIMIENTO ENTRE COMPAÑERAS', route: 'community',
    description: 'Encuentra ideas, lee un tema y ensaya una respuesta en un espacio de conversación entre compañeras.',
    steps: [
      { title: 'Busca algo que te interese', text: 'Explora los temas de ejemplo o escribe una palabra en el buscador, como «organizar». Así puedes encontrar una conversación sin recorrer toda la lista.' },
      { title: 'Lee y aporta a tu ritmo', text: 'Abre un tema para leer sus respuestas. Puedes añadir una idea inventada y volver después a la lista.' }
    ],
    note: 'Los temas son de muestra y las respuestas que escribas se quedan en esta página. Todavía no hay una comunidad conectada a esta vista.'
  },
  cofre: {
    title: 'Mi Cofre', eyebrow: 'TUS COSAS, A MANO', route: 'cofre',
    description: 'Organiza notas y archivos en un espacio personal que puedes recorrer sin compartirlo.',
    steps: [
      { title: 'Empieza con algo sencillo', text: 'Prueba con una nota, por ejemplo «Ideas para esta semana», o elige un archivo que tengas permiso para utilizar. Usa contenido de muestra mientras exploras.' },
      { title: 'Encuentra y revisa tus cosas', text: 'Abre un elemento para leerlo o verlo. Una nota breve y un nombre claro te ayudan a reconocerlo cuando vuelvas a la lista.' },
      { title: 'Quita lo que ya no quieras aquí', text: 'Puedes retirar un elemento del Cofre de esta página. La confirmación te explica qué se borra; los archivos originales de tu dispositivo permanecen allí.' }
    ],
    note: 'Las notas y los archivos de esta prueba duran mientras la página siga abierta. No se suben a una nube ni se comparten con otras personas.'
  },
  care: {
    title: 'Estoy segura', eyebrow: 'UN CHECK-IN QUE TÚ ELIGES', route: 'care',
    description: 'Conoce el recorrido de un check-in: elegir un plazo, confirmar que estás bien o cancelarlo.',
    steps: [
      { title: 'Elige un plazo de muestra', text: 'Selecciona una duración, por ejemplo 30 minutos, y activa el ensayo. La pantalla muestra su estado y las acciones disponibles.' },
      { title: 'Prueba qué ocurre después', text: 'Puedes confirmar «Estoy bien», cancelar o simular que termina el plazo. El tiempo no avanza por sí solo en esta prueba.' }
    ],
    note: 'No se envían avisos ni hay una persona atendiendo detrás de esta pantalla. Este ensayo no sirve para pedir ayuda.'
  },
  auralink: {
    title: 'AuraLink', eyebrow: 'EXPLORAR TU IMAGEN', route: 'auralink',
    description: 'Prueba un ambiente visual sobre una imagen propia o autorizada, manteniendo la elección en tus manos.',
    steps: [
      { title: 'Elige una imagen autorizada', text: 'Selecciona una foto tuya o que tengas permiso para usar. Antes de verla, confirma que puedes hacer esta prueba con las personas adultas representadas.' },
      { title: 'Prueba un ambiente y decide', text: 'Elige una presentación de muestra y mira cómo cambia en pantalla. Puedes cambiar de ambiente o quitar la imagen cuando quieras.' }
    ],
    note: 'Aquí solo cambia la presentación de la foto en tu navegador. No hay generación de IA, retoque corporal ni un archivo nuevo; la imagen no se envía a un proveedor.'
  },
  trust: {
    title: 'Mis límites', eyebrow: 'ELEGIR Y PONER LÍMITES', route: 'trust',
    description: 'Distingue entre bloquear un contacto y preparar un aviso para revisión: son decisiones diferentes.',
    steps: [
      { title: 'Explora un bloqueo personal', text: 'Prueba bloquear y desbloquear los contactos ficticios de esta pantalla. Para ver qué ocurre en una conversación, abre Mensajes y utiliza sus propios ejemplos.' },
      { title: 'Prepara un aviso de ejemplo', text: 'Escribe una situación inventada, sin nombres ni datos reales. El recibo de prueba muestra que un aviso y un bloqueo no son la misma acción.' }
    ],
    note: 'Los bloqueos de esta pantalla son ejemplos. Los avisos no se envían a revisión ni hay un equipo recibiéndolos desde esta vista.'
  },
  feedback: {
    title: 'Tu voz cuenta', eyebrow: 'AYUDARNOS A MEJORAR', route: 'feedback',
    description: 'Pon en palabras qué te facilitaría el día, sin tener que mostrar tus conversaciones o tus archivos.',
    steps: [
      { title: 'Cuenta una necesidad concreta', text: 'Puedes probar con una idea como «Me ayudaría encontrar mis notas más rápido». No necesitas aportar datos personales para explicar lo que te serviría.' },
      { title: 'Prepara tu sugerencia', text: 'Revisa lo que has escrito y pulsa «Preparar mi sugerencia». Verás un mensaje que explica qué ha ocurrido con ese texto.' }
    ],
    note: 'La sugerencia se prepara solo en esta página; todavía no se envía a ningún equipo. No se leen tus chats ni tus archivos para completarla.'
  },
  plans: {
    title: 'Herramientas para ti', eyebrow: 'VALOR QUE PUEDES ENTENDER', route: 'plans',
    description: 'Explora las herramientas opcionales y qué utilidad podrían aportarte, antes de decidir si te interesan.',
    steps: [
      { title: 'Conoce las propuestas', text: 'Lee qué incluye cada grupo de herramientas y para qué se plantea. Por ejemplo, organizar tu espacio cotidiano o explorar opciones de creación visual.' },
      { title: 'Señala lo que quieres explorar', text: 'El botón de interés permite ensayar una elección. No te suscribe ni realiza un pago.' }
    ],
    note: 'Los precios y las condiciones están por definir. Las elecciones de esta vista no se envían ni crean un contrato.'
  }
});

const ICONS = { profile: UserRound, messages: MessagesSquare, community: UsersRound, cofre: Vault, care: HeartHandshake, auralink: Sparkles, trust: ShieldCheck, feedback: MessageSquarePlus, plans: Gem };

export function createGuideView({ documentRef = document, onOpenGuide = () => {}, onNavigate = () => {}, guides = SERVICE_GUIDES } = {}) {
  const d = documentRef;
  const el = (tag, cls, text) => { const node = d.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const icon = nodes => {
    const svg = d.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key, value);
    for (const [tag, attributes] of nodes) { const child = d.createElementNS(svg.namespaceURI, tag); for (const [key, value] of Object.entries(attributes)) child.setAttribute(key, value); svg.append(child); } return svg;
  };
  const element = el('section', 'sx-guide-page'); element.dataset.v11Page = 'guide';
  const heading = el('header', 'sx-guide-heading'), headingIcon = el('span', 'sx-guide-emblem'); headingIcon.append(icon(Compass));
  const copy = el('div'); copy.append(el('p', 'sx-guide-kicker', 'A TU RITMO'), el('h2', '', 'Encuentra tu forma de usarlo'), el('p', 'sx-guide-intro', 'Cada herramienta tiene su propósito. Elige la que te interese y descubre sus pasos antes de empezar.'));
  heading.append(headingIcon, copy); element.append(heading);
  const grid = el('div', 'sx-guide-grid');
  for (const [key, guide] of Object.entries(guides)) {
    const card = el('article', 'sx-guide-card'), mark = el('span', 'sx-guide-icon'); mark.append(icon(ICONS[key]));
    card.append(mark, el('p', 'sx-guide-kicker', guide.eyebrow), el('h3', '', guide.title), el('p', 'sx-guide-description', guide.description));
    const open = el('button', 'sx-guide-button sx-help-point'); open.type = 'button'; open.dataset.guide = key; open.setAttribute('aria-label', `Cómo funciona: ${guide.title}`); open.title = `Cómo funciona: ${guide.title}`; open.append(el('span', '', '?')); open.addEventListener('click', () => onOpenGuide(key)); card.append(open); grid.append(card);
  }
  element.append(grid);
  const footer = el('footer', 'sx-guide-footer'); footer.append(el('p', '', 'No hace falta hacerlo todo. Puedes explorar, volver a Inicio y elegir por dónde seguir.'));
  const home = el('button', 'sx-guide-home'); home.type = 'button'; home.append(icon(ArrowLeft), el('span', '', 'Volver a Inicio')); home.addEventListener('click', () => onNavigate('home')); footer.append(home); element.append(footer);
  return { element };
}
