# Foro Cromos

Estado del 26/10/2026: el backend está instalado en Supabase y contiene catorce aperturas editoriales, repartidas entre Avisos y cuidados, Zaragoza, De ruta, El oficio, Vida propia y SensualXcape. Son textos del equipo para iniciar conversaciones; no representan testimonios ni usuarias ficticias.

La ruta del frontend es [SensualXcape /foro/](https://trece37.github.io/SensualXcape/foro/). El flujo de GitHub Pages publica `dist-pages/` al pasar las comprobaciones de `main`; las ejecuciones concretas se conservan en Actions.

## Qué hace

El acceso incluye «Prueba con el equipo»: Manel y Walker seleccionan dos cuentas
de ensayo, rellenando el correo y enfocando la contraseña. La clave no está
incluida en el frontend. Estas cuentas se preparan manualmente desde Auth y se
admiten con su rol en `fc_members`, sin cambiar la confirmación del registro general.
Retirar estos accesos y reemplazar las cuentas de ensayo antes de abrir el foro al público.

El foro permite solicitar acceso, leer y participar una vez admitida, buscar y guardar temas, editar el texto propio y retirar aportaciones. Moderación puede admitir o suspender miembros, fijar, cerrar u ocultar temas, ocultar respuestas y resolver avisos. Los temas cerrados quedan en lectura; una retirada redacta la aportación y no puede restaurarse desde moderación.

Las personas externas y las cuentas pendientes o suspendidas no pueden leer la comunidad. Las aportaciones muestran alias. Los reportes de contenido y los avisos generales son confidenciales: sólo los consulta su autora activa o moderación. Un reporte no se publica ni genera una advertencia automática.

La interfaz ofrece Noir, Ágape y Eros. El backend usa tablas `fc_*` independientes y conserva las tablas anteriores `sx_*`. Las reglas de acceso, propiedad, estado y cuotas se comprueban en la base de datos.

## Probar la fuente

Con Node.js 24, desde la raíz del repositorio:

```sh
npm ci
npm test
npm run build:pages
npm run preview:pages
```

Abre [Foro Cromos local](http://127.0.0.1:4349/SensualXcape/foro/). El servidor debe estar arrancado. Esta vista se conecta al Supabase remoto; las acciones de cuentas admitidas son persistentes. No corresponde al ensayo con cuentas ficticias del puerto 4341.

La fuente está en [`forum/`](../forum/), el SQL de referencia en [`supabase/forocromos-live.sql`](../supabase/forocromos-live.sql) y el build en [`scripts/build-forum.mjs`](../scripts/build-forum.mjs). `build:pages` genera `dist-pages/foro/` junto a V1 y V2. La configuración del navegador debe contener únicamente credenciales públicas; una clave administrativa nunca pertenece al frontend.

## Comprobaciones realizadas

- 270 pruebas locales pasan: 248 anteriores, nueve de permisos y comportamiento SQL en PGlite y trece de interfaz.
- Ensayos SQL remotos con rollback comprobaron publicación, respuesta, reporte de respuesta, cierre que rechaza responder, resolución y suspensión que impide leer. Volver a solicitar acceso no reactiva una suspensión.
- Una lectura anónima de `fc_topics` por la API devolvió 401.
- La entrada pública se revisó en 321 × 740, 390 × 844 y 1279 × 720 con los tres temas, sin desbordamiento horizontal. Sigue pendiente la aceptación completa desde un teléfono físico y una sesión real.

## Pendientes y siguiente prueba

La dirección exacta del foro está autorizada en Supabase y el retorno se ha comprobado mediante HTTP 303, sin enviar correos ni alterar las cuentas. El Site URL anterior permanece para el laboratorio. El alta, la confirmación de correo y la recuperación de contraseña todavía requieren aceptación de extremo a extremo con una cuenta real.

La siguiente aceptación con los promotores debe recorrer solicitud, admisión, publicación, respuesta, recarga, aviso privado y suspensión desde el enlace publicado. No basta con que el build termine o que el servicio de datos responda.

No se entrega un APK ni una IA que conteste automáticamente. La moderación es humana; los textos sobre cuidados o lugares no acreditan recomendaciones verificadas ni atención inmediata.
# Perfiles, trayectoria y archivos · 26/10/2026

El botón **Mi perfil** abre una identidad propia de Foro Cromos, vinculada a la cuenta de Auth. Guarda alias, frase de hasta 160 caracteres, avatar y preferencias de fuente/color en Supabase. El perfil de `/v2/#profile` sigue siendo una demo independiente: no se importan sus fotos ni sus datos automáticamente.

La tarjeta muestra fecha de entrada, temas, respuestas, días de participación e insignia. Los contadores se calculan en el servidor sobre publicaciones visibles; ocultar o retirar contenido puede reducirlos. Las etapas requieren simultáneamente antigüedad y aportaciones: Bienvenida; Vecina (7 días/3); Habitual (30/15 y 5 días activos); Referente (90/50 y 15 activos); Veterana (180/100 y 30 activos). No conceden moderación. Los fundadores pueden nombrar ayudantes o moderadoras desde el panel tras acordar la responsabilidad. Las ayudantes no leen reportes confidenciales ni administran accesos.

Los mensajes permiten tres fuentes, cuatro colores legibles en las tres atmósferas y doce emojis locales. El cuerpo sigue siendo texto: no se interpreta HTML ni se cargan enlaces externos como imágenes.

`supabase/forocromos-community.sql` amplía el contrato anterior. Tres buckets privados: `fc-attachments` (950000 bytes por archivo), `fc-founder-files` (50000000) y `fc-avatars` (950000; solo JPEG/PNG/WebP). El cliente prepara avatares cuadrados WebP de 256 px sin metadatos. Los adjuntos aceptan imágenes, PDF, texto, audio y vídeo; se descargan bajo demanda. Máximo tres adjuntos por publicación. Las cuatro capacidades fundadoras se provisionan administrativamente por IDs de Auth verificados, fuera del código público; ser moderadora no concede esa excepción.

Cada subida necesita una reserva propia y una ruta inmutable. Storage comprueba ruta, propietario, tipo y tamaño; finalizar comprueba metadatos reales. Publicar consume los adjuntos y crea el mensaje en una transacción. No se permiten reemplazos ni URLs firmadas; las descargas autenticadas vuelven a evaluar el acceso. La retirada, ocultación o suspensión se comprueba en servidor y el cliente revoca sus URLs locales al perder acceso.

Cupos de piloto: 20 reservas/día, seis subidas sin publicar simultáneas, 19 MB/día y 50 MB de presupuesto por cuenta ordinaria; fundadores 200 MB/día y 200 MB de presupuesto. Presupuesto global del foro: 900 MB. Las reservas retienen presupuesto 24 horas incluso al cancelarse; archivos enlazados o restos físicos continúan contando. **Mi perfil → Archivos sin publicar** permite retirar y borrar restos. No hay cron de limpieza instalado. Estos límites propios no sustituyen las cuotas del proveedor ni el envío de correo pendiente.

Verificación: 306 pruebas locales completas correctas; revisión adversarial con cinco correcciones verificadas. Storage remoto probado con avatar sintético y adjunto fundador de 950001 bytes: subida/finalización/descarga correctas, lectura anónima y URL firmada denegadas, borrado físico confirmado. No se crean mensajes sintéticos en las conversaciones de las usuarias.

## Avisos de respuestas y Web Push · 26/10/2026

La campana **Mis avisos** recoge respuestas nuevas en los hilos que abres o en los que participas. **Seguir este hilo / Silenciar avisos** controla cada conversación; un silencio no se revoca al volver a participar. No se avisa de tus propias respuestas ni se suscribe a toda la moderación. Las notificaciones, los títulos y los contadores dejan de estar disponibles cuando el contenido o la membresía ya no permiten consultarlos.

En **Mi perfil → Tus avisos → Activar avisos en este dispositivo** cada usuaria puede conceder permiso a su navegador. Se utiliza Web Push: colas, configuración, claves en Vault, revisión de permisos y reparto mediante Supabase Database, Cron, pg_net y Edge Functions. La entrega utiliza el servicio de push de cada navegador; no requiere una cuenta de correo ni un proveedor de emails. En iPhone/iPad16.4 o posterior hay que añadir la web a la pantalla de inicio y abrirla desde allí, según [WebKit](https://webkit.org/blog/13878/). La entrega también depende de los permisos y ajustes del dispositivo.

Los avisos externos contienen un mensaje genérico y un enlace autenticado a la conversación, sin reproducir mensajes, títulos ni direcciones personales. Cada dispositivo se vincula a una cuenta; Salir limpia inmediatamente la página y desvincula las tarjetas del dispositivo sin esperar a la red. El service worker conserva sólo un identificador opaco de dispositivo; no almacena sesiones ni respuestas del foro. Cinco dispositivos activos por cuenta, revocación por dispositivo y reintentos limitados a ocho intentos/24h. El protocolo puede repetir un envío ante una confirmación incierta; se usa una etiqueta estable para evitar tarjetas duplicadas.

Los destinos de email se guardan en una tabla privada y no cambian el correo de acceso. Su asignación inicial es administrativa para este piloto. **El envío de email continúa desactivado**, porque no hay proveedor/remitente conectado; no se acumulan correos antiguos para enviarlos al activarlo. El trabajador de email está preparado en `supabase/functions/fc-deliver-notifications`, separado del trabajador Web Push desplegado `fc-deliver-push`.

Contrato en `supabase/forocromos-notifications.sql` y `supabase/forocromos-push.sql`. Las instalaciones nuevas son aditivas: políticas con comprobación previa y triggers `CREATE OR REPLACE`, sin sentencias DROP. No volver a ejecutar los SQL anteriores como tarea rutinaria. Las claves reales y los destinos no forman parte del repositorio. El job de Cron sólo llama a una función privada: su comando no contiene credenciales. El endpoint Edge desactiva la validación JWT de la pasarela porque autentica cada llamada con un secreto independiente comprobado en Vault mediante una RPC exclusiva del servicio.

Verificación de la ampliación: **361 pruebas completas correctas**; revisión independiente con correcciones de cierre de sesión, carrera al mostrar una notificación durante la desvinculación y silencio/reactivación. Despacho real Cron→Edge comprobado con HTTP200 y lote vacío. La recepción de una notificación en un teléfono físico queda para la aceptación de la usuaria tras dar permiso; no se acredita por esas pruebas de servidor.

