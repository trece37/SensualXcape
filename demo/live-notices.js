import { SERVICE_GUIDES } from './guide-studio.js';
const notice = (title, paragraphs) => ({ title, summary: paragraphs[0], paragraphs });
const guide=(key,description,steps,note)=>({...SERVICE_GUIDES[key],description,steps:steps.map(([title,text])=>({title,text})),note});
export const LIVE_GUIDES={...SERVICE_GUIDES,
  profile:guide('profile','Tu borrador privado y tu presentación compartida son cosas distintas.',[
    ['Prepara y guarda','Elige alias, presentación y hasta seis fotos. Guardar conserva tu borrador privado en Supabase para volver desde otro dispositivo.'],
    ['Comparte por elección','Confirma qué texto y qué fotos quieres mostrar. Solo tus contactos aceptados y sin bloqueo podrán abrir esa copia desde la conversación.'],
    ['Revisa o retira','Editar el borrador no sustituye lo compartido. Puedes compartir otra versión, retirar la presentación o borrar tu perfil.']
  ],'No hay un directorio público. Retirar el perfil impide nuevas lecturas; las capturas y descargas de otras personas permanecen fuera de nuestro control.'),
  messages:guide('messages','Solicitudes y conversaciones privadas con tu cuenta real.',[
    ['Comparte tu invitación','Prepara un código con el alias que quieras. Compártelo con quien elijas o pega el código que te hayan dado.'],
    ['Decide antes de conversar','La receptora acepta o rechaza la solicitud. Las conversaciones conservadas de Connect siguen disponibles.'],
    ['Conserva el control','Los mensajes se guardan en Supabase. Un bloqueo detiene mensajes nuevos en todas las conversaciones de ese par y el acceso al perfil compartido. El historial sigue legible.']
  ],'Los mensajes que envías son reales. Los borradores sin enviar se conservan solo durante esta sesión de la pestaña.'),
  community:guide('community','Foro Cromos es la comunidad conectada de SensualXcape.',[
    ['Abre la comunidad','Pulsa Entrar en Foro Cromos. Se usa la misma cuenta de acceso; la admisión al foro se gestiona por separado.'],
    ['Conversa a tu ritmo','Lee, crea hilos, responde y adjunta archivos. Tu perfil, avatar y avisos del foro se configuran allí.']
  ],'Los hilos y respuestas se guardan. Los avisos dentro del foro están disponibles; el correo saliente sigue pendiente de configurar.'),
  trust:guide('trust','Tus decisiones de contacto se aplican en el servidor.',[
    ['Gestiona desde Mensajes','Abre una conversación y pulsa Bloquear. Puedes retirar tu propio bloqueo más adelante.'],
    ['Distingue el foro','Los reportes y la moderación de Foro Cromos tienen sus propios controles dentro de la comunidad.']
  ],'Desbloquear no revoca el bloqueo que haya puesto la otra persona ni convierte una solicitud rechazada en aceptada.'),
  feedback:guide('feedback','Cuéntanos qué te facilitaría el día en la comunidad.',[
    ['Explica lo que necesitas','Entra en los hilos de la aplicación o de opinión de Foro Cromos y deja tu propuesta.'],
    ['Continúa la conversación','Tu aportación queda guardada y podemos contestarte en ese hilo. Evita publicar datos de terceras personas.']
  ],'Necesitas estar admitida en el foro para publicar allí. No se leen tus conversaciones privadas ni tu Cofre para completar una sugerencia.')
};
export const LIVE_NOTICES = {
  privacy: notice('Tu espacio privado', [
    'Las cuentas, solicitudes, conversaciones y el perfil guardado se alojan en Supabase. La web se entrega desde GitHub Pages. El acceso a esos datos se comprueba en el servidor con tu sesión.',
    'Tu borrador de perfil es privado. Compartirlo requiere una decisión explícita y solo da acceso a tus contactos aceptados mientras no exista un bloqueo. El foro tiene su propia admisión y un perfil independiente.',
    'El Cofre y el check-in siguen siendo herramientas de prueba en esta pestaña. No guardan archivos en la nube ni envían avisos de seguridad. El proyecto está en acceso privado; la información del responsable y las condiciones de apertura pública siguen pendientes.'
  ]),
  images: notice('Tus imágenes, con tu permiso', ['Al guardar fotos en Mi perfil se preparan copias WebP de hasta 950 KB para Supabase. Los originales de tu dispositivo no cambian.', 'Guardar un borrador y compartirlo son acciones distintas. Usa imágenes propias o que tengas permiso para utilizar. AuraLink sigue siendo una preparación local y no envía fotos a un proveedor de IA.']),
  'profile-sharing': notice('Compartir con tus contactos', ['Tu borrador solo lo ves tú. La presentación que confirmes compartir es una copia separada, visible para tus contactos aceptados.', 'Editar el borrador no modifica automáticamente esa presentación. Puedes retirarla. Un bloqueo impide nuevas lecturas, pero no borra descargas o capturas ya guardadas por otra persona.']),
  deletion: notice('Borrar y retirar', ['Desde Mi perfil puedes retirar la presentación o borrar tu perfil y sus fotos guardadas. Esto no borra los originales del dispositivo ni cancela tu cuenta.', 'El Cofre de esta pestaña se vacía al recargar, cerrar sesión o borrar sus elementos. Las conversaciones y las aportaciones al foro tienen recorridos separados; no se borran al cerrar sesión.', 'Para gestionar la cuenta durante el piloto, contacta con Manel o Walker por el canal que ya utilicéis. No hay una cancelación automática de cuenta disponible todavía.']),
  cookies: notice('Sesión y preferencias del dispositivo', ['El navegador guarda la sesión de acceso para poder abrir la web y el foro con tu cuenta. Puedes cerrarla con Salir de mi cuenta.', 'La atmósfera y el modo fácil se recuerdan en este dispositivo. No añadimos cookies de publicidad ni analítica a esta web.']),
  algorithm: notice('Tus datos y la IA', ['Esta web no conecta un modelo de IA ni envía por defecto tus fotos, mensajes o archivos para entrenarlo. AuraLink sigue en preparación. Las sugerencias para mejorar la plataforma se pueden conversar en el hilo del foro dedicado a la aplicación.']),
  terms: notice('Acceso privado de SensualXcape', ['El acceso, las solicitudes, los mensajes y el perfil conectado son reales. El foro se abre desde su enlace y mantiene su propia admisión.', 'El Cofre es temporal; el check-in es una simulación y AuraLink sigue en preparación. No hay cobros, reservas ni generación de imágenes conectados.', 'Este espacio es para personas adultas. La declaración de edad no verifica la identidad.']),
  legal: notice('Información del proyecto', ['SensualXcape está en un piloto privado coordinado por sus promotores, Manel y Walker. Los datos de identificación y contacto del responsable deben completarse antes de una apertura pública.', 'GitHub Pages sirve la interfaz; Supabase gestiona el acceso y los datos conectados. No se muestra una identidad legal o un buzón de atención inventados.']),
};
