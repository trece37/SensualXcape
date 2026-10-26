# Foro Cromos

Estado del 26/10/2026: el backend está instalado en Supabase y contiene catorce aperturas editoriales, repartidas entre Avisos y cuidados, Zaragoza, De ruta, El oficio, Vida propia y SensualXcape. Son textos del equipo para iniciar conversaciones; no representan testimonios ni usuarias ficticias.

La ruta del frontend es [SensualXcape /foro/](https://trece37.github.io/SensualXcape/foro/). El flujo de GitHub Pages publica `dist-pages/` al pasar las comprobaciones de `main`; las ejecuciones concretas se conservan en Actions.

## Qué hace

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
