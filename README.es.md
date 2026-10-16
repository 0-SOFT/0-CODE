<!-- tracks: README.md sha256:3861ef6052d0 -->

# 0-CODE

**Versión:** v2.0.3

Un ciclo de desarrollo autónomo para **Claude Code, Codex y OpenCode**, integrado en un proyecto existente. Una única instrucción de ciclo puede reunir investigación, implementación, correcciones, auditorías y publicación de versiones.

[English](README.md) · [中文](README.zh-CN.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md)

## Integración con tu agente

En la sesión del agente de tu proyecto pide: **«Integra 0-CODE desde https://github.com/0-SOFT/0-CODE; sigue su `INTEGRATE.md`».** Usa una copia del código público fuera del proyecto de destino, opcionalmente en una etiqueta de versión elegida. La misma [plantilla breve](INTEGRATE.md) sirve para actualizar y desinstalar en los tres motores.

El agente inventaría documentos, herramientas, MCP y comandos de comprobación, resuelve ambigüedades reales, muestra el plan, instala, ejecuta doctor y confirma los cambios en una rama independiente. Las herramientas del proyecto tienen prioridad. [Inicio manual](QUICKSTART.md).

## Qué se instala

El código del marco, configuración, esquemas, módulos y plantillas residen en **`.0-code/`**. Los motores reciben las entradas nativas necesarias de hooks, instrucciones y herramientas compatibles, además del complemento de protección de OpenCode. Se conservan código y documentos existentes; los conflictos y archivos propios modificados se detectan antes de escribir. Archivos de ejecución y copias quedan en `.0-code/run/`, excluido de git.

[PROJECT_SETTINGS](docs/PROJECT_SETTINGS.md) es la única referencia de configuración. Puedes conservar los documentos predeterminados, cambiar roles concretos o vincular todos los roles con las convenciones del proyecto. El estado sigue siendo legible por máquina. Los documentos humanos usan el idioma configurado; las instrucciones del agente siguen en inglés.

El modelo, el esfuerzo de razonamiento y el inicio de sesión pertenecen al propietario. La prioridad es **opciones explícitas > entorno > configuración del proyecto > preferencias nativas del motor**. El modelo y el esfuerzo no especificados se heredan; nunca se copia la autenticación. Consulta los [ajustes de los motores](docs/ENGINE_SETTINGS.md).

El [catálogo público](toolset/CATALOG.md) contiene **cinco MCP predeterminados: context7, playwright, chrome-devtools, sequential-thinking y memory**. Necesitan paquetes npm cuya versión sea igual o superior al mínimo SemVer probado, con el nombre y el punto de entrada correctos; conserva las versiones más nuevas válidas. No requieren claves de API externas; las herramientas de navegador también necesitan un navegador disponible. El registro y un doctor correcto no demuestran una conexión activa. Se excluyen los archivos de implementación privados de habilidades, agentes, comandos y reglas. Los ejemplos opcionales de servicios con cuentas en el manifiesto MCP permanecen desactivados hasta su configuración y autorización explícitas.

Por defecto hay **una instalación independiente por usuario**, compartida entre sus proyectos. Repetir la misma selección no cambia nada. El ámbito project fija otra selección en un proyecto. La desinstalación del proyecto conserva las herramientas de máquina; `uninstall-tools` las elimina por separado y restaura sus ajustes anteriores. No se copia autenticación. [Configuración y requisitos](docs/PROJECT_SETTINGS.md).

## Trabajo y mantenimiento

Desde un proyecto instalado:

```bash
node .0-code/tools/0code.mjs doctor --json
node .0-code/tools/0code.mjs start <cycle-prompt> --max 60
node /path/to/new-source/tools/0code.mjs upgrade --project . --dry-run
node .0-code/tools/0code.mjs uninstall --dry-run
```

Rellena la única plantilla `.0-code/templates/cycle.md`. `start` actualiza el estado de forma atómica y muestra el comando del controlador. Reinicia Claude para cargar hooks; Codex y OpenCode usan el supervisor externo. Una carpeta tiene un ciclo activo. Los límites de iteraciones y gasto son opcionales; el límite monetario requiere datos de coste del supervisor. Registra trabajos largos en el estado, sin bucles de espera con sleep.

El código público permite nuevas instalaciones y actualizaciones del diseño `.0-code/`. **La migración automática de instalaciones 1.x antiguas en la raíz no está disponible sin `config/legacy-installations.json`, excluido del árbol público.** Usa `migrate --dry-run` y luego `migrate` solo desde un código fuente que contenga pruebas de propiedad de versiones publicadas. Solo se eliminan archivos de origen demostrado byte a byte y bloques propios exactos; se conservan documentos y se trasladan o archivan datos de ejecución con copias. Termina primero cualquier ciclo antiguo activo; sin pruebas, conserva los archivos antiguos y revisa su propiedad antes de modificarlos.

[Motores](docs/ENGINE_SETTINGS.md), [Claude](CLAUDE_CODE_SETUP.md), [desarrollo](GUIDELINE.md) y [seguridad](SECURITY.md) explican funcionamiento y validación. En el código fuente ejecuta `node tests/run.mjs --coverage-min=80` y `bash tests/smoke.sh`; los resultados locales son pruebas, independientemente de la disponibilidad de CI.
