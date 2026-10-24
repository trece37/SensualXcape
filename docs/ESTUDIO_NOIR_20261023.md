# Estudio Noir · candidato local en revisión

Estado del 23/10/2026. Candidato de interfaz preparado en esta copia de trabajo para revisar en navegador. **No se ha publicado este candidato en GitHub ni en GitHub Pages:** el remoto y su demo conservan V1.1.

## Corrección humana y estado visual

Walker indicó que no le gusta cómo ha quedado la web actual. La implementación debe acercarse a las imágenes aprobadas `portada-movil-noir-larga-v3.png` y `acceso-profesional-noir-v1.png`, con el unicornio, la composición y la riqueza visual que muestran. La referencia aprobada no convierte este candidato en un resultado visual aceptado.

El candidato está **en revisión e iteración visual**. Los iconos específicos se diseñarán después; por ahora debe conservarse su lugar y presencia dentro de la composición. No se considera un cierre visual ni un hito terminado, y no se publica esta iteración en GitHub o como hito.

La dirección es una web móvil cuidada, con una presentación común y dos caminos. Conserva los servicios y tres estilos, con Noir como entrada principal. La sensación de un espacio vivo y personal permanece como horizonte de diseño; este candidato no introduce un mundo 3D, un juego ni una nueva arquitectura de backend.

## Qué se puede recorrer

| Parte | Comportamiento del candidato |
| --- | --- |
| Entrada 18+ | Pide declarar que se tienen 18 años o más, con salida y acceso a la información de privacidad. Es una declaración; no verifica edad o identidad. |
| Portada | Presenta SensualXcape y ofrece los caminos de área profesional y visitantes. |
| Área profesional | Explica los servicios y muestra el formulario de acceso de prueba y la entrada con una cuenta de muestra. No crea ni autentica una cuenta real. |
| Tres atmósferas | Noir —negro, rojo y blanco— es la principal. Rosa y Fucsia completan las tres opciones; cambian la presentación, no los permisos. |
| Mi perfil | Permite separar notas privadas y presentación, elegir fotos, ordenarlas, escoger portada y ajustar su encuadre. La vista previa no comparte el borrador. |
| Compartir y retirar | La presentación y las fotos se eligen por separado. «Compartir en esta demo» crea una copia para la sección de visitantes de la misma pestaña; puede retirarse o borrarse sin publicar en Internet. |
| Visitantes | Muestra perfiles y retratos sintéticos, además de la vista que se haya decidido compartir en esta pestaña. Tiene apariencia oscura o clara propia; no ofrece contacto, precios ni reservas. |
| Mi Cofre | Permite elegir archivos locales, crear y editar notas, buscar, filtrar, consultar, descargar y quitar contenido con confirmación. No incorpora ese contenido al perfil compartido. |
| Cómo funciona | Una guía general y ayudas en los espacios explican las acciones, con pasos breves y los límites de cada prueba. |
| Avisos contextuales | Explican imágenes, perfil, Cofre, borrado, privacidad y usos de datos con lenguaje cotidiano, junto a las acciones correspondientes. |

## Acciones locales y simulaciones

El perfil y el Cofre permiten trabajar realmente con una selección local del navegador: ver una imagen, cambiar su presentación, escribir una nota, preparar una descarga o retirar una copia de la prueba. Cambiar un encuadre no modifica el archivo original; una descarga que se guarde en el dispositivo permanece allí.

El resto de servicios conserva recorridos de demostración: los mensajes y solicitudes son ficticios; Forocromos no comunica con una comunidad; los bloqueos y avisos no llegan a un equipo; el check-in no llama ni pide ayuda. Las sugerencias y las elecciones de herramientas no se envían ni producen pagos o suscripciones.

AuraLink permite elegir una imagen propia o autorizada y ensayar su presentación en el navegador. No envía esa foto a un proveedor, no ejecuta un modelo de generación y no crea un archivo transformado mediante IA.

La separación de páginas profesionales y visitantes organiza la experiencia de esta maqueta. No acredita un sistema de autorización de producción, verificación de identidad ni permisos de servidor. El laboratorio funcional iniciado mediante `npm run local:qa` es otro entorno; sus cuentas, datos y backend no están conectados a este candidato estático.

## Qué se guarda y qué se borra

Las aportaciones de la demo viven **solo en memoria de la pestaña**. No se guardan para otra visita mediante cookies, almacenamiento del navegador o una base de datos, y desaparecen al recargar. La demo no transmite los textos ni los archivos elegidos a un backend; servir los archivos de la web es distinto de enviar esas aportaciones.

Borrar un elemento lo quita de la prueba. Borrar el perfil retira también su copia compartida; borrar todas las aportaciones reinicia la demo para limpiar los distintos espacios. Estas acciones no borran los archivos originales del dispositivo, las descargas ni las capturas guardadas fuera de la página.

El candidato no vende datos ni recoge las aportaciones para publicidad o para enseñar a una IA. La intención del producto es no vender datos; el uso y la conservación en un futuro servicio conectado deberán explicarse con su funcionamiento real. Los avisos no certifican un cumplimiento general y no inventan un responsable o un contacto de privacidad que todavía están pendientes.

## Recursos visuales

Los cuatro recursos del candidato están en `assets/v2/` y se incluyen en el empaquetado de la demo:

| Archivo | Procedencia y uso |
| --- | --- |
| `portal.webp` | Recurso existente del proyecto, preparado para la bienvenida y continuidad de marca. |
| `auralink.webp` | Ilustración existente del proyecto, utilizada para presentar el servicio visual. No demuestra una integración de IA. |
| `cofre.webp` | Ilustración generada para el candidato, utilizada en la presentación del Cofre. No representa una protección técnica de archivos. |
| `portraits.webp` | Retratos sintéticos generados para las fichas de visitantes. No corresponden a perfiles de personas reales. |

## Chequeo técnico anterior al refinamiento visual

Antes de la corrección visual de Walker se registraron:

- **226/226 pruebas automatizadas superadas**, incluida la batería del estudio, el perfil y el Cofre.
- **180 casos de presentación adaptable:** 15 rutas × 3 temas × 4 anchos de navegador, sin desbordamiento horizontal detectado.
- Revisión de los recorridos de entrada, navegación, compartir y retirar el perfil, confirmaciones y ayudas contextuales.

Estos resultados corresponden a la versión local anterior al refinamiento y no acreditan las modificaciones posteriores. No son una aceptación visual, no prueban que la web se parezca a las referencias aprobadas y no resuelven la corrección expresada por Walker.

La matriz de anchos no prueba por sí sola la experiencia completa con teclado de teléfono, cámara, selector nativo de archivos o descargas en dispositivos físicos. No se declara una prueba física en Android o iPhone ni que todos los servicios del producto estén terminados.

## Abrir la revisión local

### Iteración visual posterior

La portada recupera una vista compacta de los servicios y la escena del unicornio junto al texto. El acceso profesional superpone el formulario de cristal; las tarjetas mantienen ilustraciones a la derecha. Perfil, guía y Cofre utilizan marcos más finos, radios contenidos y medallones rubí. El Cofre integra su imagen mediante máscaras y degradados, sin el rectángulo negro de la primera revisión. Los iconos específicos de marca se diseñarán más adelante.

Después de esta recomposición se repitió la batería completa: **226/226**. Se comprobaron además **60 casos** de las cinco pantallas retocadas, los tres estilos y cuatro anchuras, sin desbordamiento horizontal ni fallos de imágenes visibles. La simplificación posterior de los textos del Cofre conserva sus **10/10** pruebas. La revisión humana final del aspecto sigue pendiente.

Con Node.js 24 y las dependencias del repositorio instaladas, construir la demo:

```sh
npm run build:demo
```

El servidor de revisión de este candidato utiliza [http://127.0.0.1:4347/SensualXcape/](http://127.0.0.1:4347/SensualXcape/). Su disponibilidad depende de que el proceso esté iniciado. Para arrancarlo en ese puerto desde PowerShell:

```powershell
$env:PORT = '4347'
npm run preview:demo
```

El comando de previsualización utiliza 4345 por defecto cuando no se indica `PORT`; ambos sirven el contenido de `dist/`. No es el laboratorio de cuentas ficticias del puerto 4341 ni un despliegue remoto. No iniciar otro proceso en 4347 si ya está atendiendo la revisión.

Para repetir la batería automatizada: `npm test`. Construir o abrir esta revisión no publica el candidato; la publicación en GitHub queda fuera de este tramo de trabajo.
