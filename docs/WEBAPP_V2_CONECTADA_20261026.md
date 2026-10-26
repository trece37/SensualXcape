# SensualXcape V2 conectada · 26/10/2026

La web conserva la dirección artística y conecta acceso, contactos, conversaciones y
perfil a Supabase. La V1 original sigue congelada y la maqueta V2 anterior tiene una
dirección propia.

## Direcciones

- Web conectada: https://trece37.github.io/SensualXcape/v2/
- Foro Cromos: https://trece37.github.io/SensualXcape/foro/
- Maqueta sin cuenta: https://trece37.github.io/SensualXcape/demo/
- V1 original: https://trece37.github.io/SensualXcape/
- Código y publicación: https://github.com/trece37/SensualXcape

## Qué funciona

Una sesión de Supabase abre V2 y el foro. Las nuevas altas externas por email siguen
pendientes del remitente y del servicio de envío; el piloto usa cuentas preparadas.
Estar autenticada en la web no concede admisión al foro ni acceso a perfiles ajenos.

En Mensajes se prepara una invitación y se solicita contacto. La receptora acepta o
rechaza. Al aceptar se abre una conversación privada con historial persistente,
actualización automática y reintentos que no duplican el mismo envío. Un rechazo no
se revoca repitiendo la solicitud. Se conservan las conversaciones anteriores de
Connect; los pares heredados de dos personas mantienen su consentimiento anterior
salvo decisión explícita o bloqueo.

El bloqueo se aplica en el servidor a todas las salas de ese par. Cada participante
controla su propio bloqueo; el desbloqueo de una persona no elimina el de la otra.
El historial permanece legible para quienes participaron. Los borradores sin enviar
son temporales de la sesión y se limpian al cambiar de cuenta.

Mi perfil guarda cuatro textos, hasta seis fotos, portada, orden y encuadre. El
borrador es privado. Compartir requiere confirmar qué información y fotos incluir:
se publica una copia separada exclusivamente para contactos aceptados y sin bloqueos.
Editar el borrador no cambia lo compartido. Retirar o quitar una foto revoca su acceso
antes de intentar la eliminación física. No hay directorio público de personas reales.

Las fotos admiten entrada JPG/PNG/WebP de hasta 8 MiB y se convierten en el navegador
a WebP sin metadatos, máximo **950.000 bytes** por archivo guardado. El bucket es
privado: descarga autenticada, sin URLs firmadas ni acceso público. Las actualizaciones
de perfil usan revisiones para impedir que una pestaña sobrescriba un borrador más nuevo.
El perfil y avatar de Foro Cromos siguen siendo independientes.

Foro Cromos tiene enlace desde la navegación y el pie de V2. El foro vuelve a V2
desde su marca y pie. Tu voz cuenta y las dudas de la aplicación llevan a la comunidad.
Los reportes y la moderación siguen dentro del foro.

## Límites visibles

El Cofre permite organizar, previsualizar y descargar notas y archivos **temporales**
de la pestaña. Se vacía al recargar o cambiar de cuenta; no está conectado a Storage.
Estoy segura enlaza a su demostración y no envía avisos ni ofrece asistencia.
AuraLink conserva la preparación visual local y no conecta generación de IA.
Planes no contrata ni cobra. Las condiciones del responsable siguen pendientes antes
de una apertura pública. El correo saliente todavía no está configurado.

Noir, Rosa y Fucsia se conservan. Atmósfera y Modo fácil se recuerdan en el dispositivo;
no modifican los permisos. La ayuda distingue las acciones conectadas de las simuladas.

## Backend e instalación

Orden de migraciones aditivas:

1. `supabase/webapp-live.sql`: consentimiento sobre `sx_*`, lectura acotada de historial,
   escritura idempotente, fecha de servidor y consulta de binding push propio para logout.
2. `supabase/webapp-profile.sql`: borradores, copias compartidas, revisiones, reservas y
   políticas restrictivas del bucket `sx-profile-photos`.
3. `supabase/webapp-storage-budget.sql`: presupuesto compartido de almacenamiento.

Las reservas de fotos y foro comparten mutex y techo conservador de **900.000.000 bytes**:
todos los objetos físicos de Storage más reservas vigentes de ambos módulos que aún
no tienen objeto. No se cuentan dos veces los objetos subidos. El perfil tiene además
30 MB por cuenta; mantiene reservas retiradas durante su ventana de 24 horas.
Esto limita capacidad almacenada, no el tráfico mensual ni el coste de las descargas.
Otros proyectos de la organización pueden compartir las cuotas del plan de Supabase.

No se despliega el servidor local ni se abre un nuevo Site. Los secretos administrativos
no forman parte del frontend. Todas las decisiones de acceso se comprueban en el servidor.

## Verificación

La migración conserva las huellas de las cuatro salas, ocho membresías y 167 mensajes
existentes. La prueba de producción de solicitud, aceptación, envío, perfil y bloqueo
se ejecutó dentro de una transacción revertida; no añadió conversaciones humanas ni
aportaciones ficticias permanentes.

Se probó el Storage real con una imagen de prueba de 202.962 bytes: subida, confirmación,
descarga autenticada, denegación a otra cuenta y eliminación del archivo de prueba.

Las pruebas automatizadas cubren RLS y contratos SQL juntos, privacidad por cuenta,
reintentos al cambiar de conversación, confirmaciones atrasadas, invalidación de sesión,
retirada de fotos, revisiones en conflicto, presupuesto compartido y V1 byte por byte.
La publicación utiliza el workflow Pages del repositorio. Las comprobaciones de navegador
no sustituyen una aceptación en Android/iPhone físicos ni acreditan recepción de email.
