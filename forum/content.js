/* Editorial opening material. These are invitations to talk, not user accounts or testimonials. */
export const CATEGORIES = [
  { id: 'cuidado', label: 'Avisos y cuidados', icon: '◇', description: 'Criterio compartido y avisos que requieren revisión privada.' },
  { id: 'zaragoza', label: 'Zaragoza', icon: '⌖', description: 'La ciudad, desde la experiencia de las compañeras.' },
  { id: 'rutas', label: 'De ruta', icon: '↗', description: 'Moverse, organizarse y preguntar antes de viajar.' },
  { id: 'oficio', label: 'El oficio', icon: '✦', description: 'Empezar, poner límites y organizar el día a día.' },
  { id: 'bienestar', label: 'Vida propia', icon: '☾', description: 'Descanso, salud y todo lo que somos fuera del trabajo.' },
  { id: 'aplicacion', label: 'SensualXcape', icon: '∞', description: 'Dudas, propuestas y decisiones sobre este espacio.' },
];

export const SEED_TOPICS = [
  {
    slug: 'lista-negra', category: 'cuidado', title: 'Lista negra de hijos de puta', pinned: true,
    body: 'Hay comportamientos que merece la pena advertir entre compañeras. Este hilo es para hablar de señales, límites y formas de actuar con criterio. ¿Qué necesita una compañera para que un aviso le resulte útil?\n\nLos avisos concretos se tratan por un canal restringido: utiliza «Reportar en privado» para trasladar el hecho al equipo de moderación. No publiques aquí nombres, teléfonos, fotografías, direcciones ni otros datos que identifiquen a una persona. Un reporte se revisa; no se convierte automáticamente en una advertencia para la comunidad.',
  },
  {
    slug: 'lugares-zaragoza', category: 'zaragoza', title: 'Lugares seguros en Zaragoza', pinned: false,
    body: 'Preguntar a una compañera que conoce la ciudad puede ahorrarte muchas vueltas. Abrimos sitio para intercambiar experiencias sobre zonas y espacios de Zaragoza. ¿Sobre qué zona o tipo de lugar te gustaría preguntar?\n\nUna experiencia no garantiza que un lugar sea seguro ahora ni para todas. Ayuda contar cuándo fue y qué pudiste comprobar. El equipo todavía no ha verificado recomendaciones para este hilo.',
  },
  {
    slug: 'ruta-espana', category: 'rutas', title: 'De ruta por España', pinned: false,
    body: 'Moverse de ciudad trae preguntas muy concretas: desplazamientos, alojamiento, gastos y cómo organizar los días. Aquí podemos preguntar antes de viajar y compartir lo que hayamos comprobado.\n\n¿Qué información te habría ahorrado tiempo en tu último viaje? Una ciudad, una duda y la experiencia de otra compañera pueden ser un buen comienzo.',
  },
  {
    slug: 'dudas-sensualxcape', category: 'aplicacion', title: 'Dudas sobre SensualXcape', pinned: true,
    body: '¿Dónde está esa opción? ¿Cómo funciona la admisión? ¿Por qué aparece ese mensaje? Aquí puedes preguntar sobre SensualXcape y conversar con el equipo, además de con las compañeras. El equipo puede leer y responder; no hay una respuesta automática ni un plazo de atención garantizado.\n\nSi algo falla, cuenta qué intentabas hacer y qué mensaje apareció. Una pregunta que parece pequeña también merece una explicación clara.',
  },
  {
    slug: 'tu-opinion-importa', category: 'aplicacion', title: 'Tu opinión importa. ¿Qué cambiarías?', pinned: false,
    body: '¿Qué haría este espacio más útil en tu día a día? Puedes decir qué te ayuda, qué estorba o qué necesidad sigue sin resolverse. También puedes discrepar de una decisión del equipo.\n\nNo hace falta preparar una propuesta: basta con contar qué querías hacer y qué te lo impidió. Compartir una idea abre una conversación con el equipo; no implica que se vaya a construir. Queremos que puedas conocer qué se decide y por qué.',
  },
  {
    slug: 'empezar-profesion', category: 'oficio', title: 'Empezar: preguntas sin tener que justificarse', pinned: false,
    body: 'Al empezar aparecen dudas que no siempre tienen dónde plantearse. Este hilo abre sitio para preguntar y para el conocimiento de quienes llevan más tiempo. No tienes que contar tu historia para participar.\n\n¿Qué te habría gustado poder preguntar al principio? Lo que le sirvió a una puede orientar a otra, dejando espacio para que cada una decida a su manera.',
  },
  {
    slug: 'limites-trato', category: 'oficio', title: 'Mis límites se respetan. El trato también cuenta', pinned: false,
    body: 'Poner un límite, mantenerlo y cambiar de opinión forman parte de decidir por una misma. Aquí podemos hablar de cómo comunicamos lo que aceptamos, lo que no y el trato que esperamos.\n\n¿Qué manera de expresar un límite te resulta más clara? No tienes que justificar el tuyo para que cuente.',
  },
  {
    slug: 'dinero-organizacion', category: 'oficio', title: 'Dinero y organización, con los pies en el suelo', pinned: false,
    body: 'Llevar las cuentas, separar gastos o reservar un rato para organizar la semana: cada una encuentra su manera. ¿Qué sistema sencillo te ayuda a tener las cosas claras?\n\nPodemos intercambiar hábitos y herramientas sin compartir cifras personales. Una libreta, una plantilla o un método que te funcione ya puede abrir una conversación útil.',
  },
  {
    slug: 'salud-descanso', category: 'bienestar', title: 'Salud y descanso: espacio para hablarlo', pinned: false,
    body: 'Dormir, comer con calma, parar un momento, tener la cabeza en otra cosa. ¿De qué manera consigues hacer sitio al descanso? Podemos hablar de hábitos y de cómo nos encontramos, compartiendo solo lo que apetezca.\n\nLa conversación acompaña; los diagnósticos y tratamientos corresponden a una atención sanitaria que pueda valorar a cada persona.',
  },
  {
    slug: 'vida-propia', category: 'bienestar', title: 'Desconectar. Hay vida fuera del trabajo', pinned: false,
    body: 'Una película, una afición, una tarde sin planes o hablar de cualquier otra cosa. Este espacio también puede ser eso.\n\n¿Qué te está ayudando a desconectar últimamente? No todo tiene que girar alrededor del trabajo.',
  },
  {
    slug: 'bienvenida', category: 'aplicacion', title: 'Si te apetece, pasa y saluda', pinned: false,
    body: 'Puedes empezar con un hola, tu alias y un tema del que te gustaría hablar. O quedarte leyendo hasta encontrar tu momento. Presentarse es una invitación, no un requisito.\n\nNo hace falta contar tu vida para formar parte de una conversación. ¿Qué te gustaría encontrar aquí?',
  },
  {
    slug: 'pedir-una-mano', category: 'cuidado', title: '¿Me echas una mano con esto?', pinned: false,
    body: 'A veces no hace falta un gran tema: basta con una duda práctica que otra compañera sabe resolver. Ordenar una tarea, entender una opción o encontrar por dónde empezar.\n\n¿Qué estás intentando hacer y en qué punto te has atascado? Puedes preguntar aquí o abrir un tema propio para que sea más fácil seguir las respuestas.',
  },
  {
    slug: 'fotos-anuncios-material', category: 'oficio', title: 'Fotos, anuncios y material propio', pinned: false,
    body: 'Elegir una foto, redactar un anuncio, ordenar archivos o explicar lo que quieres ofrecer también lleva trabajo. Aquí podemos compartir métodos, herramientas y preguntas sobre nuestro propio material.\n\n¿Qué parte te cuesta más o qué recurso te ha ahorrado tiempo? Cualquier foto o texto que compartas debe ser tuyo o contar con permiso para ese uso.',
  },
  {
    slug: 'cambiar-etapa', category: 'bienestar', title: 'Cambiar de etapa, a tu ritmo', pinned: false,
    body: 'Cambiar una rutina, aprender algo, hacer una pausa, continuar con otras condiciones o pensar en otro trabajo. Cada una decide qué quiere mover y cuándo.\n\n¿Hay algo que te gustaría explorar o preparar? Podemos conversar y compartir experiencias sin dar por hecho que todas queremos el mismo camino.',
  },
];

export const PRINCIPLES = [
  { number: 1, title: 'La pasión no es negociable.', body: 'Cuidamos los detalles para que este espacio merezca tu tiempo. La ambición se demuestra en cómo funciona y en el trato que recibes.' },
  { number: 2, title: 'Recordamos quiénes somos.', body: 'Un espacio para mujeres adultas que ejercen la prostitución. Conservamos ese propósito sin reducir a todas a una misma historia.' },
  { number: 3, title: 'Construimos para nosotros mismos.', body: 'Exigimos la utilidad y el respeto que querríamos recibir. Escuchar a las compañeras puede cambiar lo que pensábamos construir.' },
  { number: 4, title: 'Inventamos el mañana, no revivimos el ayer.', body: 'Aprendemos de lo que funciona para mejorar lo cotidiano. Una novedad tiene que aportar algo, no complicar lo que ya era sencillo.' },
  { number: 5, title: 'Somos cazadores de talento.', body: 'Reconocemos las aportaciones y a quien las hace. La experiencia vivida también es conocimiento y talento.' },
  { number: 6, title: 'Resolvemos problemas reales.', body: 'Partimos de necesidades que existen. Queremos sostener este proyecto aportando utilidad, sin fabricar obstáculos ni dependencia para vender su solución.' },
  { number: 7, title: 'Abrazamos la asociación inteligente.', body: 'Colaboramos con personas y herramientas que aportan valor. Los costes y las responsabilidades tienen que poder entenderse.' },
  { number: 8, title: 'Actuamos con integridad y transparencia.', body: 'Explicamos qué funciona, qué falta y qué límites hay. Reconocemos los errores; una propuesta no se presenta como un resultado probado.' },
  { number: 9, title: 'Nunca dejamos de aprender.', body: 'Escuchamos, probamos y corregimos. La evidencia puede cambiar una decisión sin que perdamos el propósito.' },
  { number: 10, title: 'Creamos recuerdos que trascienden.', body: 'Queremos que recuerdes haber sido escuchada y haber podido resolver algo que te importaba. Tú conservas la elección sobre tu vida y tu trabajo.' },
];
