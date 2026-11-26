# ObraPlan · Gestión de obra

Aplicación web para gestionar proyectos de construcción, inspirada en herramientas de campo como Fieldwire:
planos con tareas ancladas, listas de pendientes, seguimiento por responsable y equipo de obra.

Funciona en el navegador (escritorio, tablet y móvil), **sin servidor ni compilación**, y también **sin conexión**:
todos los datos (planos, tareas, fotos) se guardan localmente en el navegador mediante IndexedDB.

## Funcionalidades

| Módulo | Qué incluye |
| --- | --- |
| **Proyectos** | Crear varios proyectos, proyecto de ejemplo con datos y planos de demostración, importar copias. |
| **Panel** | Indicadores (abiertas, vencidas, cerradas en 7 días), avance del proyecto, tareas por estado / responsable / categoría, vencidas, próximos vencimientos y actividad reciente. |
| **Planos** | Subida de PDF (cada página se convierte en un plano) e imágenes, carpetas por disciplina, búsqueda, nuevas versiones del plano manteniendo la posición de las tareas. |
| **Visor de planos** | Zoom y desplazamiento (rueda, arrastre, pellizco en móvil), crear tareas tocando el plano, pines de colores por estado con número, arrastrar pines para reubicar, filtros por estado, lista lateral de tareas del plano. |
| **Tareas** | Estados (prioridad alta/media/baja, completada, verificada), responsable, categoría, fechas, ubicación, etiquetas, descripción, lista de verificación, fotos (cámara del móvil), comentarios e historial automático de cambios. |
| **Lista y tablero** | Filtros (texto, estado, categoría, responsable, plano, vencidas), ordenación, vista Kanban con arrastrar y soltar, acciones masivas (estado, asignación, eliminar). |
| **Informes** | Exportación a CSV (compatible con Excel) e informe imprimible / PDF con fotos. |
| **Equipo** | Personas con rol, empresa, contacto y color; recuento de tareas abiertas por persona. |
| **Ajustes** | Datos del proyecto, categorías personalizadas, nombre del usuario, copia de seguridad completa (.json con planos y fotos) y borrado del proyecto. |
| **PWA** | Instalable en el móvil como app y utilizable sin conexión. |

## Cómo ejecutarla

Al usar módulos ES y un *service worker*, hay que servirla por HTTP (no abrir el `index.html` directamente):

```bash
# Opción 1: Python
python3 -m http.server 8080

# Opción 2: Node
npx serve .
```

Después abre <http://localhost:8080>. Pulsa **“Cargar proyecto de ejemplo”** para explorarla con datos.

### Publicarla gratis con GitHub Pages

En el repositorio: *Settings → Pages → Build and deployment → Deploy from a branch*, elige la rama y la carpeta `/ (root)`.
La app quedará disponible en `https://<usuario>.github.io/<repositorio>/`.

## Estructura

```
index.html              Punto de entrada
manifest.webmanifest    Configuración PWA
sw.js                   Service worker (uso sin conexión)
css/styles.css          Estilos (modo claro/oscuro, adaptable a móvil)
js/app.js               Enrutador y estructura principal
js/db.js                Modelo de datos y persistencia (IndexedDB), copia de seguridad
js/media.js             PDF → imágenes (pdf.js), miniaturas, compresión de fotos, plano demo
js/ui.js                Utilidades de interfaz (modales, avisos, formato)
js/views/               Vistas: projects, dashboard, plans, viewer, tasks, taskDetail, team, settings
```

Los PDF se procesan con [pdf.js](https://mozilla.github.io/pdf.js/), que se carga desde cdnjs la primera vez que se sube un PDF.

## Limitaciones actuales y próximos pasos

Esta versión es **local y monousuario**: cada navegador tiene sus propios datos (se pueden compartir mediante exportar / importar).
Para un uso en equipo real, los siguientes pasos naturales serían:

1. **Backend y sincronización** (p. ej. Supabase/Firebase o una API propia) con cuentas de usuario, permisos por rol y sincronización offline → online.
2. **Notificaciones** de asignación y vencimiento (email / push).
3. **Anotaciones sobre el plano** (flechas, nubes de revisión, texto, mediciones) y comparación de versiones.
4. **Formularios** (partes diarios, inspecciones, checklists de calidad/seguridad) con plantillas.
5. **RFI, presupuestos y horas** por tarea; diagrama de Gantt.
