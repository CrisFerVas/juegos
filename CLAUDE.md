# ObraPlan · memoria del proyecto

Resumen de todo lo necesario para retomar el trabajo. Documentación de uso en `README.md`.

> **Instrucciones para Claude**: este archivo es la guía del proyecto. Léelo antes de trabajar y sigue sus
> convenciones. Al terminar cada funcionalidad o decisión importante, **actualízalo** (lista de hechas,
> pendientes, trampas conocidas) en el mismo commit, para que la siguiente sesión pueda continuar desde aquí.

## Qué es
App web de gestión de obra (inspirada en Fieldwire, con nombre y diseño propios): planos con tareas
ancladas, anotaciones, mediciones, comparación de versiones, fotos en obra, partes e inspecciones.
**Orientada a móvil y tablet.** Todo el texto de la interfaz y del código está en **español**.

## Enlaces y repositorio
- Repo: `CrisFerVas/juegos` (público por decisión del usuario), rama de trabajo `claude/fieldwire-like-app-xgfr2a`.
  No hay PR abierto; no crear uno salvo que se pida.
- Versión que usa el usuario en su teléfono: GitHub Pages → https://crisfervas.github.io/juegos/ (modo local).
- Vista previa en Claude (privada): https://claude.ai/artifact/1enTFTXQkwnJtrfGPyiqzp
  (allí la cámara integrada, las descargas y la impresión están bloqueadas por la plataforma).

## Arquitectura
- **Frontend sin compilación**: HTML + CSS + módulos ES (`index.html`, `css/styles.css`, `js/`). PWA con `sw.js`.
- **Dos modos** (`js/sync.js` decide al arrancar):
  - *Local*: sin servidor (GitHub Pages, vista previa). Datos solo en IndexedDB del navegador.
  - *Equipo*: si responde `api/health`, pide login; sincroniza con el servidor.
- **Servidor** (`server/`): Node ≥ 22.5, sin dependencias, SQLite integrado (`node:sqlite`).
  `npm start` (PORT, HOST, DATA_DIR=./data), `npm test` (10 tests de la API). `Dockerfile` incluido (no probado).
- **Datos** (`js/db.js`, IndexedDB versión 5). Almacenes sincronizados:
  `projects, members, sheets, tasks, files, markups, forms, templates, folders`. Internos: `outbox`, `meta`.
  Al añadir un almacén: subir `VERSION` en `js/db.js`, añadirlo a `STORES`, a `SYNCED_STORES`
  en `server/store.js`, a exportar/importar en `db.js` y, si hace falta, a `sw.js`.
- **Sincronización**: local primero. Cada `db.put/del` crea una entrada en `outbox`; `syncNow()` envía a
  `POST /api/sync` con cursores por proyecto. Gana la versión más reciente (`_rev`); en tareas se fusionan
  comentarios e historial. El servidor renumera tareas y partes con número repetido.
  Archivos aparte: `PUT/GET /api/files/:id` (máx. 500 MB, guardado en streaming).
- **Roles**: admin / miembro / seguidor (solo lectura, clase CSS `.readonly .write{display:none}`).

## Módulos clave
| Archivo | Función |
| --- | --- |
| `js/app.js` | Enrutador por hash `#/p/:id/<sección>/...`, menú, estado de sincronización |
| `js/media.js` | PDF → imagen base PNG (≤16 Mpx, límite iOS) + PDF original; fotos en calidad original o 2560 px (`photoQuality`) |
| `js/hires.js` | Redibujado nítido de la zona visible desde el PDF al hacer zoom |
| `js/markup.js` | Anotaciones (svg, coords normalizadas 0-1), selección por pulsación larga, mediciones |
| `js/compare.js` | Comparar versiones: superposición rojo/azul/gris y cortina, nítida con zoom |
| `js/photopins.js` | Fotos colocadas en el plano (markups `type:'photo'`) y visor de fotos |
| `js/photoannotate.js` | Anotar fotos (markups con `sheetId = 'photo:<fileId>'`) |
| `js/camera.js` | Cámara integrada (getUserMedia) con alternativa si está bloqueada |
| `js/forms.js`, `views/forms.js`, `views/formDetail.js`, `views/templateEditor.js` | Partes e inspecciones |
| `js/signature.js` | Firma con el dedo |
| `js/exportplan.js` | Descarga de planos en PDF con anotaciones/mediciones/tareas en vectorial (pdf-lib 1.17.1, cdnjs) |
| `js/folders.js` | Carpetas y subcarpetas de planos (rutas `A/B/C` en `sheet.folder`; vacías en el almacén `folders`) |
| `js/reminders-core.js` | Reglas y horario de avisos de tareas; script clásico (`self.ObraReminders`) usado por la app y por `sw.js` (`importScripts`) |
| `js/reminders.js` | Avisos en la app: permiso, ajustes, comprobación cada minuto, sincronización periódica |
| `js/views/viewer.js` | Visor de planos: zoom/paneo/pellizco, pines, modos view/add/place/draw/photo |

## Funcionalidades hechas (en orden)
1. App base: proyectos, panel, planos (PDF multipágina/imagen), visor con tareas en plano, lista/tablero,
   CSV, informe imprimible, equipo, ajustes, copia de seguridad JSON, proyecto de ejemplo.
2. Servidor multiusuario: cuentas, invitaciones por email (sin envío de correo), roles, sincronización.
3. Calidad original de planos (PDF vectorial al hacer zoom).
4. Anotaciones (lápiz, rotulador, línea, flecha, rectángulo, elipse, nube, texto, borrador, 10 colores, 3 grosores, deshacer).
5. Pulsación larga para seleccionar, mover, redimensionar, recolorear y borrar anotaciones.
6. Mediciones: calibración (cota conocida o escala 1:N con tamaño real del papel), distancia, recorrido, área.
7. Historial de versiones de planos y comparación.
8. Fotos en el plano (cámara o galería), visor con deslizamiento, crear tarea desde fotos.
9. Cámara integrada en la app (funciona en GitHub Pages; probado por el usuario en Android).
10. Ajustes de diseño para móvil y tablet (barra del visor en 2 filas, tareas como tarjetas, filtros plegados).
11. Anotar fotos (mismas herramientas sin mediciones).
12. Partes e inspecciones: parte diario, calidad, seguridad, plantillas propias, firma, cierre, PDF,
    tarea desde no conformidad.
13. Zoom en el editor de fotos: pellizco con dos dedos (zoom + paneo, cancela el trazo en curso), rueda del
    ratón y botones −/100%/+ (hasta 800 %). `mountAnnotatedPhoto` expone `zoomAt/panBy/resetZoom/onZoom`.
14. Almacenamiento persistente del navegador; permisos de la carpeta de datos en Docker.
15. Descargar planos en PDF con anotaciones, mediciones y pines de tareas en la calidad original: botón ⤓ del
    visor (plano actual) y «Descargar PDF» en Planos (varios en un PDF). La página PDF original se copia con
    pdf-lib (vectorial) y encima se dibuja en vectorial con la matriz inversa de `viewport.transform` de pdf.js
    (funciona con páginas giradas). Imágenes: se incrustan sin recomprimir. Fotos en el plano no se incluyen.
16. Carpetas y subcarpetas de planos (especialidad › subespecialidad, sin límite de niveles). `sheet.folder` guarda
    la ruta (`Instalaciones/Climatización`, `''` = raíz); las carpetas vacías se guardan en el almacén `folders`
    (los miembros no pueden editar el documento del proyecto). Navegación por carpetas con migas en Planos
    (`#/p/:id/plans?f=<ruta>`), crear/renombrar/mover/eliminar (al eliminar, el contenido sube un nivel),
    subir planos a la carpeta actual o a una subcarpeta nueva, búsqueda global, el visor vuelve a la carpeta
    del plano y agrupa el selector de planos por carpeta. Datos antiguos («Arquitectura») siguen valiendo.
17. Pulsación larga sobre una foto del plano → menú (Ver / Mover / Eliminar; `photoPinMenu`, `deletePhotoPin` en
    `photopins.js`). «Mover» activa el modo `movephoto` del visor: tocar el nuevo punto o arrastrar esa foto;
    aviso con botón Cancelar. Las fotos ya **no** se arrastran en modo normal (evita moverlas sin querer al
    desplazar el plano); los pines de tareas sí. Solo para quien puede editar.
18. Fotos en alta resolución: la cámara integrada usa `ImageCapture.takePhoto()` con el tamaño máximo de
    `getPhotoCapabilities()` (sensor completo en Chrome Android); si falla, fotograma del vídeo pedido a 4096×3072.
    Muestra los Mpx en la cámara (tras la 1.ª foto, el tamaño real). `savePhotos` guarda el archivo original sin
    recomprimir (JPEG/PNG/WebP, con EXIF) salvo que en Ajustes › Calidad de las fotos se elija «Optimizada»
    (2560 px). Ajuste por dispositivo en `localStorage` (`obraplan.photoQuality`), por defecto «Original».
19. Zoom en los visores de fotos (plano, tarea, parte): `mountAnnotatedPhoto(..., { zoomable: true, onSwipe })`
    añade pellizco, doble toque, arrastrar para desplazar con zoom, deslizar para pasar de foto (solo sin zoom)
    y botones −/100%/+. En PC: **Ctrl + rueda** amplía (también el pellizco del touchpad, que llega como
    wheel con ctrlKey); la rueda sin Ctrl desplaza la foto ampliada (`photoWheel`, también en el editor).
20. Botón/gesto **Atrás** del móvil: cierra la capa de arriba (diálogos, visor de fotos, editor de anotaciones,
    cámara, ficha de tarea) en vez de cambiar de pantalla. `trackOverlay(el, close)` en `ui.js` hace
    `pushState` con `{ ovl: id }` (ids crecientes desde `Date.now()`); en `popstate` se cierran las capas con
    id mayor que la entrada a la que se vuelve y se saltan entradas de capas ya cerradas. Si la capa se cierra
    desde la app (detectado con MutationObserver), se hace `history.back()` solo si su entrada sigue siendo la
    actual. Cámara: Atrás conserva las fotos hechas. Editor: Atrás = «Listo».
21. Avisos de tareas pendientes (notificaciones del sistema). Alta = urgente: 4/día repartidos en el horario
    (8:00 · 10:20 · 12:40 · 15:00 por defecto); media: 2/día (9:00 · 13:00); baja: ninguno. Cualquier tarea
    pendiente pasa a urgente si falta ≤ 1 día para `dueDate` o está vencida (no cambia su prioridad guardada).
    Lunes a viernes (sábado/domingo opcionales). Ajustes › Avisos de tareas (por dispositivo; horario, días,
    «solo asignadas a mí» en modo equipo por email del miembro). Config y última comprobación en Cache API
    (`obraplan-reminders`, compartida con el SW; `sw.js` ya no borra cachés que no empiecen por `obraplan-v`).
    **Sin servidor push**: avisa con la app abierta/en segundo plano (cada minuto), al reabrirla (lo pendiente
    de hoy, una vez por tarea) y, con la app instalada en Chrome Android, por `periodicsync` (frecuencia que
    decide el navegador, poco fiable). Aviso → `#/p/:id/tasks?task=<id>` abre la ficha de la tarea.
22. La app empieza siempre en la lista de proyectos: `start_url` = `./#/` y, al abrir la app (marca en
    `sessionStorage` `obraplan.started`; no al recargar), una dirección de proyecto sin `?` se cambia a `#/`
    (los enlaces con parámetros, como los de los avisos, se respetan). En móvil, barra superior fija
    `.mobile-project-bar` con «‹ Proyectos» y el nombre del proyecto (no en el visor a pantalla completa).

## Pendiente / ideas
- RFI, presupuestos y horas por tarea; diagrama de Gantt.
- Avisos fiables con la app cerrada: Web Push desde el servidor (VAPID) cuando se publique; email; recuperación de contraseña.
- Publicar el servidor (Render/Railway/Fly.io o VPS con disco persistente) cuando el usuario quiera modo equipo real.

## Preferencias del usuario
- Responder en español, de forma directa. Usa la app sobre todo en el **móvil** (Android, Chrome).
- Le importa mucho la **calidad de los planos** al hacer zoom (planos de climatización A0/A1).
- Su plano de prueba es `E-01 VENTILACIÓN VESTÍBULO` (PDF 1414×1000 mm); **no está en el repo**.
- Tras cada cambio: commit + push a la rama y actualizar la vista previa publicada.

## Lecciones y trampas conocidas
- **Clics fantasma en táctil**: tras un toque que abre un diálogo, el clic siguiente puede cerrarlo
  (los diálogos ignoran el fondo 400 ms). Tras un trazo, el primer clic puede perderse: los botones
  críticos responden también a `pointerup` con antiduplicado (inicializar a `-Infinity`, no a 0).
- Capas del plano (z-index): imagen base < `.hires` < comparación < `.markups` < `.pins`.
- pdf.js 3.11.174 desde cdnjs, worker creado desde un blob. En el contenedor de pruebas cdnjs está bloqueado:
  las pruebas sirven pdf.js local (npm `pdfjs-dist@3.11.174`) y pdf-lib (npm `pdf-lib@1.17.1`) interceptando la URL.
- En la vista previa de Claude: sin cámara, sin descargas, sin `window.open`/imprimir.
- Nombres de descarga solo en ASCII (`safeName` en `exportplan.js`): Chrome sin interfaz descarta el nombre
  si lleva tildes o «–» y guarda como «download». La fuente del PDF exportado es Helvetica estándar (WinAnsi):
  símbolos fuera de ese juego se sustituyen (→ por ->) o salen como «?».
- Cámara simulada de Chromium (`--use-fake-device-for-media-stream`): `getPhotoCapabilities` dice 1920×1080 pero
  `takePhoto` da 3840×2160; por eso la etiqueta de Mpx usa el mayor de ambos y luego el tamaño real.
- pdf-lib usa nombres propios en sus enumeraciones (`TextRenderingMode.Outline`, no `Stroke`).
- Toda capa nueva que tape la pantalla debe registrarse con `trackOverlay` (los `modal()` ya lo hacen).
- Pruebas de pellizco en Playwright: usar CDP `Input.dispatchTouchEvent` con varios `touchPoints`
  (genera eventos pointer reales; los `PointerEvent` sintéticos fallan en `setPointerCapture`).
- Las pruebas end-to-end (Playwright) se escribieron en el directorio temporal de la sesión, **no están en el repo**;
  convendría añadir una carpeta `tests/` con las principales si se retoma el proyecto.
