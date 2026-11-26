# ObraPlan · Gestión de obra

Aplicación web para gestionar proyectos de construcción, inspirada en herramientas de campo como Fieldwire:
planos con tareas ancladas, listas de pendientes, seguimiento por responsable y equipo de obra.

Funciona en el navegador (escritorio, tablet y móvil) de dos maneras:

- **Modo equipo (con servidor)**: cuentas de usuario, proyectos compartidos con roles y sincronización entre dispositivos.
  Se sigue pudiendo trabajar sin conexión; los cambios se envían al recuperarla.
- **Modo local (sin servidor)**: si la app se abre desde un hosting estático, todo se guarda sólo en ese navegador.

## Funcionalidades

| Módulo | Qué incluye |
| --- | --- |
| **Proyectos** | Crear varios proyectos, proyecto de ejemplo con datos y planos de demostración, importar copias. |
| **Panel** | Indicadores (abiertas, vencidas, cerradas en 7 días), avance del proyecto, tareas por estado / responsable / categoría, vencidas, próximos vencimientos y actividad reciente. |
| **Planos** | Subida de PDF (cada página se convierte en un plano) e imágenes **conservando la calidad original**: se guarda el PDF y, al hacer zoom, la zona visible se redibuja en vectorial a la resolución de la pantalla. Las imágenes se guardan sin recomprimir. Además, carpetas por disciplina, búsqueda, nuevas versiones del plano manteniendo la posición de las tareas. |
| **Visor de planos** | Zoom y desplazamiento (rueda, arrastre, pellizco en móvil), crear tareas tocando el plano, pines de colores por estado con número, arrastrar pines para reubicar, filtros por estado, lista lateral de tareas del plano. |
| **Anotaciones** | Modo “Anotar” en el visor: lápiz, rotulador fluorescente, línea, flecha, rectángulo, elipse, nube de revisión, texto y borrador; 10 colores, 3 grosores y deshacer. **Pulsación larga** sobre una anotación para seleccionarla: moverla, redimensionarla con tiradores, cambiarle el color o eliminarla. Se guardan con el plano, se sincronizan con el equipo y se pueden mostrar u ocultar. |
| **Mediciones** | Calibración de la escala del plano con una cota conocida o con la escala de impresión (1:50, 1:100…, usando el tamaño real del papel del PDF). Herramientas de distancia, recorrido (suma de tramos) y área en m², que se recalculan si cambia la escala. |
| **Versiones y comparación** | Historial de versiones de cada plano. Comparación por **superposición** (rojo = eliminado, azul = nuevo, gris = sin cambios) o **cortina** deslizante; al hacer zoom se recalcula nítida desde los PDF originales. |
| **Tareas** | Estados (prioridad alta/media/baja, completada, verificada), responsable, categoría, fechas, ubicación, etiquetas, descripción, lista de verificación, fotos (cámara del móvil), comentarios e historial automático de cambios. |
| **Lista y tablero** | Filtros (texto, estado, categoría, responsable, plano, vencidas), ordenación, vista Kanban con arrastrar y soltar, acciones masivas (estado, asignación, eliminar). |
| **Informes** | Exportación a CSV (compatible con Excel) e informe imprimible / PDF con fotos. |
| **Equipo** | Personas con rol, empresa, contacto y color; recuento de tareas abiertas por persona. |
| **Ajustes** | Datos del proyecto, categorías personalizadas, nombre del usuario, copia de seguridad completa (.json con planos y fotos) y borrado del proyecto. |
| **Cuentas y accesos** | Registro con email y contraseña; acceso a cada proyecto como **Administrador**, **Miembro** o **Seguidor** (solo lectura). Invitación por email a personas que aún no tienen cuenta. |
| **Sincronización** | Local primero: todo se guarda en el dispositivo y se sincroniza en segundo plano (cada 15 s, al volver la conexión y al editar). Indicador de estado y cambios pendientes. Los comentarios simultáneos se fusionan y los números de tarea duplicados se renumeran. |
| **PWA** | Instalable en el móvil como app y utilizable sin conexión. |

## Cómo ejecutarla

### Modo equipo (recomendado)

Requiere **Node.js 22.5 o superior** (sin dependencias: usa el SQLite integrado en Node).

```bash
npm start            # http://localhost:3000
npm test             # pruebas de la API
```

Variables de entorno: `PORT` (3000), `HOST` (0.0.0.0) y `DATA_DIR` (`./data`: base de datos SQLite y archivos subidos).
La primera persona que crea un proyecto es su administradora; desde **Equipo → Acceso a la aplicación** da acceso a las demás.

Con Docker:

```bash
docker build -t obraplan .
docker run -p 3000:3000 -v obraplan-data:/data obraplan
```

Para publicarla en internet sirve cualquier plataforma que ejecute Node o Docker con un **disco persistente** montado en `DATA_DIR`
(Render, Railway, Fly.io, un VPS...). Pon delante HTTPS (estas plataformas lo incluyen) y haz copias de la carpeta de datos.

### Modo local (sin servidor)

Basta con servir los archivos estáticos, por ejemplo con `python3 -m http.server 8080` o GitHub Pages
(*Settings → Pages → Deploy from a branch*, carpeta `/ (root)`). No abras el `index.html` directamente: los módulos ES necesitan HTTP.

Pulsa **“Cargar proyecto de ejemplo”** para explorarla con datos.

## Estructura

```
index.html              Punto de entrada
manifest.webmanifest    Configuración PWA
sw.js                   Service worker (uso sin conexión)
css/styles.css          Estilos (modo claro/oscuro, adaptable a móvil)
js/app.js               Enrutador, estructura principal y arranque (modo local / equipo)
js/db.js                Modelo de datos y persistencia (IndexedDB), bandeja de cambios, copia de seguridad
js/sync.js              Cuentas, roles y motor de sincronización con el servidor
js/media.js             PDF → imagen base sin pérdida (pdf.js), miniaturas, compresión de fotos, plano demo
js/hires.js             Redibujado nítido desde el PDF original al hacer zoom en el visor
js/markup.js            Anotaciones y mediciones sobre el plano
js/compare.js           Comparación de versiones (superposición de colores y cortina)
js/ui.js                Utilidades de interfaz (modales, avisos, formato)
js/views/               Vistas: auth, projects, dashboard, plans, viewer, tasks, taskDetail, team, settings
server/app.js           API HTTP (cuentas, permisos, sincronización, archivos) y servidor de la app
server/store.js         Esquema y consultas SQLite
server/test/            Pruebas de la API (node --test)
Dockerfile              Imagen para desplegar el servidor
```

### Cómo funciona la sincronización

Cada cambio local se guarda en IndexedDB junto con una entrada en una *bandeja de salida*. El cliente envía la bandeja a
`POST /api/sync` con un cursor por proyecto y recibe a cambio todo lo modificado por otras personas desde ese cursor.
El servidor comprueba el rol de cada cambio, guarda la versión más reciente de cada documento (en las tareas fusiona
comentarios e historial) y renumera tareas con número repetido. Los planos y fotos se suben aparte (`PUT /api/files/:id`) y
los demás dispositivos los descargan cuando los necesitan.

Los PDF se procesan con [pdf.js](https://mozilla.github.io/pdf.js/), que se carga desde cdnjs la primera vez que se sube un PDF.

## Limitaciones actuales y próximos pasos

- Las invitaciones no envían email: la persona administradora comparte el enlace de la app y la invitada se registra con ese email.
- No hay recuperación de contraseña por email todavía.
- Ante ediciones simultáneas del mismo campo gana la última (salvo comentarios e historial, que se fusionan).

Siguientes fases previstas:

1. **Notificaciones** de asignación y vencimiento (email / push) y recuperación de contraseña.
2. **Formularios** (partes diarios, inspecciones, checklists de calidad/seguridad) con plantillas.
3. **RFI, presupuestos y horas** por tarea; diagrama de Gantt.
