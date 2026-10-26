# Foro Cromos · actividad y novedades · 26/10/2026

La entrada privada muestra qué se ha publicado y quién ha participado, sin deducir
presencia a partir de accesos o visitas. Se conservan las tres atmósferas y el foro existente.

## Recorrido implementado

- **Lo último, entre nosotras:** seis publicaciones recientes, con hilo, extracto de
  hasta 160 caracteres, alias y hora. En móvil se muestran tres y se ofrece «Más actividad».
- **Últimas en participar:** hasta cinco cuentas admitidas que realmente han publicado,
  ordenadas por su última aportación. «Ver más» abre un listado paginado. No es un contador
  de personas conectadas ni expone inicios de sesión, correos o visitas privadas.
- **Última actividad:** una respuesta hace subir su hilo. Cada fila muestra el número
  de respuestas visibles, la última autora y el momento de esa aportación.
- **Nuevo hilo / respuestas nuevas:** estados distintos y propios de cada cuenta.
  El filtro «Novedades por ver» permite encontrarlos sin recorrer todo el foro.
- **Volver a la conversación:** el título abre la primera respuesta pendiente cuando
  existe; la última aportación y los enlaces del panel llevan a la página real de esa
  respuesta. Las direcciones incluyen identificadores de hilo y respuesta para compartirlas.
- **Lectura conservada:** se registran únicamente los IDs de las respuestas de la página
  abierta explícitamente. No se marca todo el hilo, no se consume una respuesta concurrente
  y las actualizaciones de fondo no marcan lectura. Es un registro privado; no confirma
  que una persona haya leído cada palabra ni se muestra a las autoras.

El encabezado se compacta después de la admisión para dar prioridad a la actividad.
En móvil las últimas participantes aparecen primero, en una banda desplazable, y los
mensajes se resumen debajo. La búsqueda, categorías, guardados y moderación se mantienen.

## Backend y privacidad

Migración aditiva: `supabase/forocromos-activity.sql`.

APIs: `fc_topics_page`, `fc_activity_feed`, `fc_recent_contributors`,
`fc_mark_topic_read` y `fc_locate_reply`.

Las funciones públicas son wrappers invoker; el helper privado exige Auth y admisión
activa antes de consultar. Los recibos están en `fc_private.topic_reads` y
`fc_private.reply_reads`, con RLS y sin acceso directo del cliente. Las respuestas
retiradas u ocultas y sus padres no disponibles quedan fuera de la actividad general,
también para moderación. No se reescribe ni elimina el historial existente.

Los aportes históricos visibles de una autora suspendida conservan un alias genérico;
esa cuenta no aparece entre participantes recientes. No se cruza con contactos privados,
el perfil V2 ni el sistema de correo.

Los recibos se unen de forma idempotente entre dispositivos. Aportar algo no crea una
novedad para su propia autora. Los cursores de actividad y participantes incluyen
desempate estable. El helper mantiene un bloqueo `FOR SHARE` de la membresía, compatible
con las referencias de las notificaciones y suficiente para impedir una suspensión a
mitad de una respuesta. La revisión detectó y corrigió una inversión de locks; las
pruebas PGlite no acreditan concurrencia PostgreSQL con varias conexiones reales.

La interfaz limpia actividad, modal y marcas visibles al salir, cambiar de cuenta o
caducar la sesión. Los resultados tardíos se descartan. Las publicaciones generales
siguen comprobándose en el servidor y los archivos conservan sus políticas previas.

## Investigación y procedencia

Se contrastaron patrones visibles y documentación primaria de:

- [Hardlimit, España](https://foro.hardlimit.com/es/recent): listado de conversaciones recientes.
- [NodeBB Community](https://community.nodebb.org/recent): exploración de actividad por temas.
- [Guía oficial de Discourse](https://meta.discourse.org/t/understanding-discourse-for-new-users/96331):
  diferencia entre temas nuevos, respuestas pendientes, participantes y punto de lectura.
- [XenForo Discovery](https://xenforo.com/features/discovery/) y
  [widgets oficiales](https://docs.xenforo.com/manual/appearance/widgets): bloques de novedades.

La implementación es propia sobre el contrato de Foro Cromos. Se adoptan mecanismos
de navegación y lectura; no se incorporaron marcas, imágenes ni código de esos foros.

Se identificó [REA — Reverse Engineer Anything](https://github.com/morluto/rea), de
`morluto/rea`, con código propio bajo MIT y web [rea.tools](https://rea.tools/).
Se consultó su procedencia y alcance. No se instaló su CLI/MCP: esta tarea se resolvió
con observación de las interfaces, documentación pública y el fuente existente del proyecto.

## Verificación

Pruebas SQL: acceso admitido frente a anónimo/pendiente/suspendida, filtros, orden por
respuesta, deduplicación de autoras, cursores completos, ocultación/retirada, recibos
monotónicos, aportación concurrente con fecha anterior y ubicación exacta en páginas de 50.

Pruebas de cliente: texto seguro, modal y cursores, actividad tardía tras logout,
novedades y filtros, respuesta en página posterior, IDs de lectura acotados, ausencia
de lectura automática al refrescar y conservación del foco durante actualizaciones.

La suite completa previa al último ajuste focal pasó 436/436. Las regresiones finales
de cliente y SQL se verificaron de forma focal; la publicación ejecuta además la suite
completa mediante GitHub Actions. La V1 mantiene sus cinco archivos byte por byte.

El navegador conectado verificó restauración de sesión, feed real, modal «Más actividad»,
enlace a una respuesta y diseño estrecho sin desbordamiento horizontal. No se publica
una transcripción de las aportaciones de las usuarias como evidencia técnica.
