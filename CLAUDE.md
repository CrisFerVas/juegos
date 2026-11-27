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
- **Datos** (`js/db.js`, IndexedDB versión 4). Almacenes sincronizados:
  `projects, members, sheets, tasks, files, markups, forms, templates`. Internos: `outbox`, `meta`.
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
| `js/media.js` | PDF → imagen base PNG (≤16 Mpx, límite iOS) + PDF original; fotos a 2560 px |
| `js/hires.js` | Redibujado nítido de la zona visible desde el PDF al hacer zoom |
| `js/markup.js` | Anotaciones (svg, coords normalizadas 0-1), selección por pulsación larga, mediciones |
| `js/compare.js` | Comparar versiones: superposición rojo/azul/gris y cortina, nítida con zoom |
| `js/photopins.js` | Fotos colocadas en el plano (markups `type:'photo'`) y visor de fotos |
| `js/photoannotate.js` | Anotar fotos (markups con `sheetId = 'photo:<fileId>'`) |
| `js/camera.js` | Cámara integrada (getUserMedia) con alternativa si está bloqueada |
| `js/forms.js`, `views/forms.js`, `views/formDetail.js`, `views/templateEditor.js` | Partes e inspecciones |
| `js/signature.js` | Firma con el dedo |
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

## Pendiente / ideas
- RFI, presupuestos y horas por tarea; diagrama de Gantt.
- Avisos (email/push) y recuperación de contraseña (requiere servicio de correo y app publicada).
- Zoom dentro del editor de fotos.
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
  las pruebas sirven pdf.js local (npm `pdfjs-dist@3.11.174`) interceptando la URL.
- En la vista previa de Claude: sin cámara, sin descargas, sin `window.open`/imprimir.
- Las pruebas end-to-end (Playwright) se escribieron en el directorio temporal de la sesión, **no están en el repo**;
  convendría añadir una carpeta `tests/` con las principales si se retoma el proyecto.
