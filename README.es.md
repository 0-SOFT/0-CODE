<!-- tracks: README.md sha256:dc67310727a4 -->

# 0-CODE

**Versión:** v2.1.1

Un ciclo de desarrollo autónomo para **Claude Code, Codex y OpenCode**, integrado en un proyecto existente. Una única instrucción de ciclo puede reunir investigación, implementación, correcciones, auditorías y publicación de versiones.

[English](README.md) · [中文](README.zh-CN.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md)

## Integración con tu agente

En la sesión del agente de tu proyecto pide: **«Integra 0-CODE desde https://github.com/0-SOFT/0-CODE; sigue su `INTEGRATE.md`».** Usa una copia del código público fuera del proyecto de destino, opcionalmente en una etiqueta de versión elegida. La misma [plantilla breve](INTEGRATE.md) sirve para actualizar y desinstalar en los tres motores.

El agente inventaría documentos, herramientas, MCP y comandos de comprobación, resuelve ambigüedades reales, muestra el plan, instala, ejecuta doctor y confirma los cambios en una rama independiente. Las herramientas del proyecto tienen prioridad. [Inicio manual](QUICKSTART.md).

## Qué se instala

El código del marco, la configuración, los esquemas, módulos y plantillas integradas residen en **`.0-code/`**. Los documentos del ciclo pertenecen al proyecto y residen en **`.0-code/docs/`**; los archivos de ejecución y las copias están en **`.0-code/run/`**, ignorado por Git. La integración normal añade los hooks, instrucciones, herramientas compatibles y complemento de protección de OpenCode necesarios para los motores elegidos; la sesión aislada de Claude descrita abajo conserva su integración dentro de `.0-code/`. Se preservan el código y los documentos existentes; los conflictos y archivos propios modificados se notifican antes de escribir.

[PROJECT_SETTINGS](docs/PROJECT_SETTINGS.md) es la única referencia de configuración. Puedes conservar los documentos predeterminados, cambiar roles concretos o vincular todos los roles con las convenciones del proyecto. El estado sigue siendo legible por máquina. Los documentos humanos usan el idioma configurado; las instrucciones del agente siguen en inglés.

El modelo, el esfuerzo de razonamiento y el inicio de sesión pertenecen al propietario. La prioridad es **opciones explícitas > entorno > configuración del proyecto > preferencias nativas del motor**. El modelo y el esfuerzo no especificados se heredan; nunca se copia la autenticación. Consulta los [ajustes de los motores](docs/ENGINE_SETTINGS.md).

El [catálogo público](toolset/CATALOG.md) contiene **cinco MCP predeterminados: context7, playwright, chrome-devtools, sequential-thinking y memory**. Necesitan paquetes npm cuya versión sea igual o superior al mínimo SemVer probado, con el nombre y el punto de entrada correctos; conserva las versiones más nuevas válidas. No requieren claves de API externas; las herramientas de navegador también necesitan un navegador disponible. El registro y un doctor correcto no demuestran una conexión activa. Se excluyen los archivos de implementación privados de habilidades, agentes, comandos y reglas. Los ejemplos opcionales de servicios con cuentas en el manifiesto MCP permanecen desactivados hasta su configuración y autorización explícitas.

Las herramientas tienen por defecto **una instalación independiente por usuario**, compartida entre sus proyectos. Repetir la misma selección no cambia nada. El ámbito project fija otra selección en un proyecto. Los install/upgrade/migrate de Claude aislado no instalan herramientas de usuario automáticamente: hace falta solicitar `install-tools` por separado y de forma explícita. Desinstalar el proyecto conserva las herramientas de máquina; `uninstall-tools` las elimina por separado y restaura sus ajustes originales. Nunca se copia la autenticación. [Configuración y requisitos](docs/PROJECT_SETTINGS.md).

## Documentos, migración y aislamiento de sesión en 2.1.1

Las instalaciones nuevas sitúan los nueve roles en `.0-code/docs/`: `STATE.md`, `ROADMAP.md`, `reports/`, `decisions/`, `todo/`, `logs/`, `prompts/`, `prompts/templates/` y `userdocs/`. Guarda los documentos permanentes en Git; los registros de sesión se ignoran. Los registros también pueden usar `.0-code/run/logs/`; los roles permanentes no pueden usar runtime. Los roles externos explícitos siguen admitidos y upgrade conserva sus rutas. Los documentos quedan fuera del recibo de propiedad: doctor los acepta, upgrade los conserva y uninstall mantiene documentos y directorios, eliminando runtime y copias.

Traslada los roles estándar 2.0.x de `docs/*` explícitamente con `upgrade --relocate-documents <files.json>` o `migrate --relocate-documents <files.json>`, primero con `--dry-run`. Revisa la lista exacta; la documentación del producto no incluida permanece. Se actualizan config, referencias de STATE y plantillas seleccionadas, archivando los bytes originales modificados. Las rutas externas personalizadas no cambian. Antes del traslado o adopción termina el ciclo, recoge trabajos de fondo y detén el controlador; un bloqueo activo o entradas cambiadas causan rechazo. Añade los movimientos juntos a Git para reconocer renombrados.

Una instalación `.0-code/` modificada sin recibo usa `migrate --adopt-manifest <manifest.json>` con SHA-256 revisados y acciones `replace`/`preserve`. Solo se conservan extensiones del proyecto enumeradas exactamente en `bin/`, `claude/` y `.0-code/README.md`; el código se sustituye y archiva. Las extensiones siguen editables y sobreviven a upgrade/uninstall. Archivos desconocidos o hashes distintos causan rechazo; adopción y traslado son operaciones separadas. Guarda las reglas propias de AGENT como documento y enlázalas mediante `instructions.project_rules` antes de sustituir la guía generada.

La sesión aislada de Claude exige tanto `instructions.claude: session-hook` como `instructions.claude_settings: .0-code/claude/settings.json`. Si solo se elige Claude y los roles documentales son internos, install, upgrade, migrate y la adopción no realizan escrituras, eliminaciones ni cambios de recuperación externos no elegidos, incluidos `.claude/`, `.mcp.json` y `CLAUDE.md`. Los roles externos explícitos, otros motores elegidos y un `install-tools` solicitado por separado son excepciones de alcance limitado. Los recibos de propiedad o diarios de transacciones antiguos no autorizan limpieza externa; una transición que la necesite se rechaza antes de escribir y exige una limpieza revisada en el modo anterior. La integración normal `project-file` y `session-hook` con `.claude/settings.json` conservan la entrega nativa.

Inicia con `claude --settings .0-code/claude/settings.json` o con un lanzador revisado que pase ese archivo. SessionStart y SubagentStart exponen mediante `.0-code/AGENT.md` las fuentes internas del orquestador y de los procedimientos de auditoría habilitados; no se registran comandos slash nativos. Con `modules.audits: false` no hay fuentes ni referencias de auditoría. Las herramientas de texto seguras pueden usar referencias; los controles de ejecución nativos y los registros MCP nuevos incompatibles con esta entrega se indican como `unsupported`. Se conservan lanzador, MCP, system-prompt y políticas de ajustes; los ajustes compatibles reciben entradas del marco y uninstall restaura los valores originales. Las sesiones normales no cargan el archivo automáticamente. Doctor comprueba hooks locales, no sobrescrituras de usuario, administradas o de CLI. [Formatos, comandos y límites](docs/PROJECT_SETTINGS.md).

Las plataformas y versiones de Node probadas, los límites del sistema de archivos y los umbrales de cobertura figuran en el [alcance de validación](docs/PROJECT_SETTINGS.md#validation-scope). Una matriz CI configurada no demuestra su ejecución.

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
