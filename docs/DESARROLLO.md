# Desarrollar y probar SensualXcape V1.1

## Dos entornos con un alcance distinto

| | Demo de GitHub Pages | Laboratorio local |
| --- | --- | --- |
| Entrada | `demo/index.html` | `index.html`, adaptado por el servidor de ensayo |
| Preparación | `npm run build:demo` → `dist/` | `npm run local:qa` prepara los bundles y arranca el servidor |
| Cuentas | Sin cuenta | A, B y C ficticias; indicaciones en pantalla |
| Mensajes y contactos | Ejemplos en memoria de la página | Solicitud, decisión, conversación y bloqueo con permisos en base local |
| Cofre y comunidad | Muestras que se borran al recargar | Datos locales de prueba; pueden conservarse en este equipo |
| Check-in | Recorrido manual sin reloj ni avisos | Ensayo local; no acredita respuesta humana ni entrega externa |
| Red | La aplicación no conecta a API; CSP `connect-src 'none'` | Servidor enlazado exclusivamente a `127.0.0.1` |

La demo permite una previsualización voluntaria de imágenes en AuraLink mediante una URL de objeto del navegador. Esa imagen no se transmite ni se guarda. No introduzcas datos personales en recorridos de prueba.

## Arranque limpio

Con Node.js 24, ejecutar desde la raíz:

```sh
npm ci
npm test
npm run build:demo
npm run preview:demo
```

El servidor de previsualización sirve únicamente los archivos de `dist/` en http://127.0.0.1:4345/SensualXcape/. Esa subcarpeta reproduce la dirección de GitHub Pages y permite comprobar rutas de recursos.

El laboratorio funcional se inicia con `npm run local:qa` en http://127.0.0.1:4341/. No necesita un proyecto remoto. El chat se reinicia al terminar el proceso; otros módulos del laboratorio usan carpetas locales de prueba. No abras este servidor a Internet ni lo uses con archivos o cuentas reales.

## Publicación de la demo

El workflow `.github/workflows/pages.yml` instala las dependencias del lockfile, ejecuta las pruebas, construye `dist/` y publica ese artefacto en GitHub Pages desde `main`. En pull requests solo comprueba y construye.

El sitio publica `index.html`, `demo.js`, `demo.css` y el recurso gráfico del portal. El SDK, la configuración del laboratorio y las fuentes del servidor no forman parte del sitio. `scripts/build-demo.mjs` aplica un adaptador explícito al shell común; si cambia el código esperado, el build se detiene para exigir revisión del adaptador.

En **Settings → Pages**, la fuente debe ser **GitHub Actions**. El enlace de la demo es https://trece37.github.io/SensualXcape/.

## Comandos que pertenecen al laboratorio

`npm run build:cofre` prepara bundles locales. `npm run build` es el empaquetado histórico de Connect y requiere un `config.js` privado local; **no construye la demo V1.1 de Pages**. `config.example.js` es solo una plantilla y nunca contiene credenciales reales.

Los SQL de `supabase/` y las comprobaciones de permisos documentan el contrato del laboratorio. Su presencia no prueba que estén aplicados a un backend remoto. No se ejecutan contra ningún servicio externo durante la publicación de la demo.

## Qué verificar al cambiar la interfaz

- Recorrer inicio, mensajes, comunidad, Cofre y Más en los tres estilos.
- Comprobar ancho pequeño, orientación horizontal, teclado, foco, volver atrás y contraste.
- Distinguir siempre el ejemplo visual del comportamiento funcional local.
- Ejecutar las pruebas y construir la demo; revisar visualmente el resultado servido desde `/SensualXcape/`.
- Mantener fuera del repositorio `config.js`, `.env`, archivos locales, datos, logs y credenciales. `.gitignore` recoge esas exclusiones.

Las pruebas automatizadas verifican contratos concretos; no sustituyen una prueba física en Android/iPhone ni acreditan todos los servicios terminados.
