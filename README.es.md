<!-- tracks: README.md sha256:6be15af01675 -->

# 0-CODE

**Versión:** v2.1.0

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

## Documentos, migración y propiedad en 2.1.0

Las instalaciones nuevas sitúan los nueve roles en `.0-code/docs/`: `STATE.md`, `ROADMAP.md`, `reports/`, `decisions/`, `todo/`, `logs/`, `prompts/`, `prompts/templates/` y `userdocs/`. Guarda los documentos permanentes en Git; los registros de sesión se ignoran. Los registros también pueden usar `.0-code/run/logs/`; los roles permanentes no pueden usar runtime. Los roles externos explícitos siguen admitidos y upgrade conserva sus rutas. Los documentos quedan fuera del recibo de propiedad: doctor los acepta, upgrade los conserva y uninstall mantiene documentos y directorios, eliminando runtime y copias.

Traslada los roles estándar 2.0.x de `docs/*` explícitamente con `upgrade --relocate-documents <files.json>` o `migrate --relocate-documents <files.json>`, primero con `--dry-run`. Revisa la lista exacta; la documentación del producto no incluida permanece. Se actualizan config, referencias de STATE y plantillas seleccionadas, archivando los bytes originales modificados. Las rutas externas personalizadas no cambian. Antes del traslado o adopción termina el ciclo, recoge trabajos de fondo y detén el controlador; un bloqueo activo o entradas cambiadas causan rechazo. Añade los movimientos juntos a Git para reconocer renombrados.

Una instalación `.0-code/` modificada sin recibo usa `migrate --adopt-manifest <manifest.json>` con SHA-256 revisados y acciones `replace`/`preserve`. Solo se conservan extensiones del proyecto enumeradas exactamente en `bin/`, `claude/` y `.0-code/README.md`; el código se sustituye y archiva. Las extensiones siguen editables y sobreviven a upgrade/uninstall. Archivos desconocidos o hashes distintos causan rechazo; adopción y traslado son operaciones separadas. Guarda las reglas propias de AGENT como documento y enlázalas mediante `instructions.project_rules` antes de sustituir la guía generada.

Claude permite `instructions.claude: session-hook` sin escribir en `CLAUDE.md`. Para ajustes de sesión usa `instructions.claude_settings: .0-code/claude/settings.json`, conservando lanzador, MCP y system-prompt. Inicia con `claude --settings .0-code/claude/settings.json`; las sesiones normales no cargan este archivo automáticamente. Los ajustes compatibles conservan sus políticas; hooks Stop/guard ajenos requieren revisión. Uninstall restaura los ajustes originales. Doctor comprueba hooks locales, no overrides de usuario/managed/CLI. [Formatos, comandos y límites](docs/PROJECT_SETTINGS.md).

La aceptación de desarrollo de 2.1.0 se realizó en Windows con Node 24. No cubrió Linux, macOS ni Node 20/22; una matriz CI configurada no demuestra su ejecución. Consulta el [alcance de validación](docs/PROJECT_SETTINGS.md#validation-scope) para los límites del sistema de archivos y de cobertura.

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
