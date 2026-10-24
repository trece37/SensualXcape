<p align="center">
  <a href="https://trece37.github.io/SensualXcape/"><img src="docs/media/banner.svg" alt="SensualXcape · Tu espacio, a tu manera" width="100%"></a>
</p>

<h3 align="center">Un espacio propio. Conexiones que tú eliges. Herramientas que te sirven.</h3>

<p align="center">
  <a href="https://trece37.github.io/SensualXcape/"><strong>✨ ABRIR LA DEMO WEB</strong></a>
  &nbsp; · &nbsp; <a href="#tres-atmósferas-una-misma-experiencia">Ver los estilos</a>
  &nbsp; · &nbsp; <a href="docs/DESARROLLO.md">Guía de desarrollo</a>
</p>

<p align="center">
  <a href="https://github.com/trece37/SensualXcape/actions/workflows/pages.yml"><img src="https://github.com/trece37/SensualXcape/actions/workflows/pages.yml/badge.svg" alt="Comprobación y publicación de la demo"></a>
  <img src="https://img.shields.io/badge/versión-V1.1-c92337?style=flat-square" alt="Versión V1.1">
  <img src="https://img.shields.io/badge/estado-en_desarrollo-a78bfa?style=flat-square" alt="En desarrollo">
  <img src="https://img.shields.io/badge/demo-datos_ficticios-eaa4c2?style=flat-square" alt="Demo con datos ficticios">
</p>

---

## Un producto con un propósito

SensualXcape se construye para mujeres adultas que ejercen la prostitución: un espacio para organizarse, conectar entre compañeras y elegir qué compartir, con quién y cuándo. El producto parte de necesidades reales, autonomía y utilidad cotidiana.

Esta V1.1 reúne su identidad visual y sus recorridos en una web adaptable. En el teléfono encontrarás navegación al alcance del pulgar, accesos rápidos, conversaciones enfocadas y superficies de cristal con una presencia más cuidada.

**Durante el desarrollo, el código y la demo están en GitHub.** La demo se publica con GitHub Pages. La decisión sobre un alojamiento del producto completo vendrá después.

> **Prueba sin cuenta.** Todos los contactos, conversaciones, archivos y temas de comunidad de la demo son inventados. Sus cambios viven solo en memoria y desaparecen al recargar. No envía mensajes, no cobra ni avisa a nadie.

## V2 · Estudio Noir y efectos

El candidato del **23/10/2026** amplía la experiencia con una entrada para personas adultas, dos caminos —área profesional y visitantes—, un perfil con fotos y un Cofre que permite trabajar con notas y archivos de prueba. Noir es el estilo principal; Rosa y Fucsia conservan las otras dos atmósferas. Cada espacio incluye una guía «Cómo funciona» y avisos en lenguaje cotidiano.

El **24/10/2026** se incorporaron las correcciones de la maqueta y la dirección de efectos aprobada: imágenes integradas con el fondo, servicios compactos, ayuda discreta, reflejos y respuestas breves. El humo queda en las ilustraciones de entrada y en el Cofre. El Cofre se abre al tocarlo o mantener pulsado; sus objetos representan las mismas notas y archivos que aparecen en la lista. Moverlos o recogerlos no elimina su contenido.

**Se mantienen dos versiones.** La V1.1 original conserva la raíz de GitHub Pages. La V2 se prepara bajo `/SensualXcape/v2/`; su publicación está pendiente de resolver el acceso de escritura a GitHub. El build comprueba que los cinco archivos de la V1 conservan exactamente sus huellas originales. Estado y comprobaciones: [V2 · implementación y verificación](docs/V2_20261024.md).

El perfil, las fotos y el Cofre funcionan en la pestaña: permiten probar acciones reales del navegador, sin guardar tus aportaciones después de recargar. La entrada no autentica cuentas; los mensajes, la comunidad y los avisos siguen siendo simulaciones, y AuraLink no tiene generación de IA conectada.

La V2 conserva Noir, Rosa y Fucsia, el Modo fácil y los avisos de cada servicio. Los efectos se pueden apagar y respetan la preferencia de movimiento reducido. La comprobación en un Android físico queda pendiente de la prueba del enlace por Walker.

El [estado del 23/10](docs/ESTUDIO_NOIR_20261023.md) conserva el contexto histórico anterior a esta integración.

## Tres atmósferas, una misma experiencia

<table>
  <tr><th>🌸 Rosa</th><th>💜 Neón</th><th>♥ Noir</th></tr>
  <tr>
    <td align="center"><img src="docs/media/rose.jpg" alt="V1.1 en estilo Rosa: tonos suaves y superficies claras" width="260"></td>
    <td align="center"><img src="docs/media/neon.jpg" alt="V1.1 en estilo Neón: violeta y rosa sobre fondo oscuro" width="260"></td>
    <td align="center"><img src="docs/media/noir.jpg" alt="V1.1 en estilo Noir: negro, rojo y blanco" width="260"></td>
  </tr>
  <tr><td>Cálido, luminoso y cercano.</td><td>Oscuro, vibrante y expresivo.</td><td>Negro, rojo y blanco, con equilibrio.</td></tr>
</table>

Capturas del ensayo local V1.1 con datos ficticios. La demo pública conserva la misma interfaz y ofrece recorridos propios de demostración.

## Servicios y alcance

| Espacio | Qué puedes explorar en la demo pública |
| --- | --- |
| **Mensajes y contactos** | Aceptar o rechazar solicitudes ficticias, abrir conversaciones, añadir ejemplos y probar un bloqueo. |
| **Forocromos** | Buscar, leer y responder en temas inventados entre compañeras. |
| **Mi Cofre** | Añadir, consultar y retirar archivos de muestra. No accede a tus archivos reales. |
| **Estoy segura** | Simular manualmente un check-in y su final. Sin temporizador activo, avisos ni ayuda conectada. |
| **Mi perfil** | Ensayar un alias, una presentación y opciones de visibilidad. |
| **Mis límites** | Explorar bloqueos y recibos de aviso ficticios. Sin moderación conectada. |
| **Factoría Visual · AuraLink** | Previsualizar voluntariamente una imagen autorizada en el navegador, sin subirla ni generar otra imagen. |
| **Mejorar SensualXcape** | Preparar una sugerencia de prueba, sin enviarla. |
| **Herramientas a tu medida** | Explorar propuestas de servicios. Precios y condiciones pendientes; sin compras ni suscripciones. |

El servidor de ensayo local permite probar comportamientos más completos con cuentas ficticias. Sus pruebas locales no acreditan un servicio desplegado en producción. Consulta las diferencias en la [guía de desarrollo](docs/DESARROLLO.md).

## Probar y desarrollar

Necesitas **Node.js 24** y npm. Desde una copia de este repositorio:

```sh
npm ci
npm test
npm run build:demo
npm run preview:demo
```

Abre **http://127.0.0.1:4345/SensualXcape/**. La demo no necesita claves ni configuración de backend.

Para comprobar la publicación conjunta de V1 y V2:

```sh
npm run build:pages
npm run preview:pages
```

Abre **http://127.0.0.1:4349/SensualXcape/** para V1 y **http://127.0.0.1:4349/SensualXcape/v2/** para V2. GitHub Actions publica únicamente `dist-pages/` desde `main`.

Para el ensayo funcional local con cuentas ficticias:

```sh
npm run local:qa
```

Abre **http://127.0.0.1:4341/** y sigue las instrucciones que aparecen en la franja de ensayo. Si ya tienes ese puerto ocupado, conserva tu proceso actual o ciérralo antes de iniciar otro.

## Dentro del repositorio

```text
demo/                    Entrada y adaptadores de la demo pública
platform-v11.*           Interfaz común, navegación y tres estilos
services-v11.js          Vistas interactivas de los servicios
app.js                   Cliente del laboratorio de contactos y mensajes
cofre.* · forocromos.*   Módulos del laboratorio local
care.*                   Check-in del laboratorio local
scripts/                 Builds, servidor local y comprobaciones
tests/                   Pruebas del comportamiento y los permisos
supabase/                SQL de referencia del laboratorio
docs/                    Guía pública y recursos de presentación
.github/workflows/       Comprobación y publicación en GitHub Pages
```

## Cómo avanzamos

Conservar los servicios y los tres estilos, pulir la experiencia móvil y comprobar cada cambio con ejemplos reproducibles. El siguiente trabajo de producto sigue centrado en acceso privado, solicitud, decisión, conversación y bloqueo efectivo, con un Modo fácil comprensible.

El repositorio incluye el laboratorio y una demo estática. Los proyectos de web heredada, aplicación móvil y otros experimentos mantienen sus propias raíces. Aún queda validar el producto completo en dispositivos físicos y decidir su despliegue de producción.

## Dependencias y derechos

Las dependencias conservan sus licencias; los avisos recopilados están en [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt). El código y la identidad propios no tienen una licencia de reutilización concedida en este repositorio. No se incluyen credenciales, bases de datos ni información de personas reales.

<p align="center"><a href="https://trece37.github.io/SensualXcape/"><strong>Entrar en SensualXcape · Demo V1.1 →</strong></a></p>
