<!-- tracks: README.md sha256:dc67310727a4 -->

# 0-CODE

**Version:** v2.1.1

Un cycle de développement autonome pour **Claude Code, Codex et OpenCode**, intégré à un projet existant. Une seule consigne de cycle peut réunir recherche, réalisation, corrections, audits et livraison.

[English](README.md) · [中文](README.zh-CN.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md)

## Intégrer avec votre agent

Dans la session de votre projet, demandez : **« Intègre 0-CODE depuis https://github.com/0-SOFT/0-CODE ; suis son `INTEGRATE.md`. »** Utilisez une copie des sources publiques hors du projet cible, éventuellement à un tag de version choisi. Le même [modèle court](INTEGRATE.md) gère la mise à jour et la suppression pour les trois moteurs.

L’agent inventorie documents, outils, MCP et commandes de vérification, résout les ambiguïtés réelles, présente le plan, installe, lance doctor et crée un commit dans une branche séparée. Les outils du projet ont priorité. [Démarrage manuel](QUICKSTART.md).

## Ce qui est installé

Le code du framework, la configuration, les schémas, modules et modèles intégrés résident dans **`.0-code/`**. Les documents du cycle appartiennent au projet et résident dans **`.0-code/docs/`** ; fichiers d’exécution et sauvegardes restent dans **`.0-code/run/`**, ignoré par Git. L’intégration normale ajoute les hooks, instructions, outils compatibles et le plugin de protection OpenCode nécessaires aux moteurs choisis ; la session Claude isolée décrite ci-dessous conserve son intégration dans `.0-code/`. Code et documents existants sont préservés ; conflits et fichiers propres modifiés sont signalés avant toute écriture.

[PROJECT_SETTINGS](docs/PROJECT_SETTINGS.md) est l’unique référence de configuration. Gardez les documents par défaut, modifiez certains rôles ou associez tous les rôles aux conventions existantes. L’état demeure lisible par machine. Les documents humains utilisent la langue configurée ; les instructions de l’agent restent en anglais.

Le modèle, l’effort de raisonnement et la connexion relèvent du propriétaire. La priorité est **options explicites > environnement > configuration du projet > préférences natives du moteur**. Le modèle et l’effort non spécifiés sont hérités ; l’authentification n’est jamais copiée. Voir les [paramètres des moteurs](docs/ENGINE_SETTINGS.md).

Le [catalogue public](toolset/CATALOG.md) contient **cinq MCP par défaut : context7, playwright, chrome-devtools, sequential-thinking et memory**. Ils nécessitent des paquets npm de version égale ou supérieure au minimum SemVer testé, avec le nom et le point d’entrée corrects ; conservez les versions plus récentes valides. Aucune clé d’API externe n’est requise ; les outils de navigateur nécessitent aussi un navigateur disponible. L’enregistrement et un doctor réussi ne prouvent pas une connexion active. Les fichiers d’implémentation privés des compétences, agents, commandes et règles sont exclus. Les exemples optionnels de services liés à un compte dans le manifeste MCP restent désactivés jusqu’à leur configuration et autorisation explicites.

Par défaut, **une installation indépendante par utilisateur** est partagée entre ses projets. Répéter la même sélection ne change rien. Le périmètre project fixe une autre sélection dans un projet. Les actions install/upgrade/migrate de Claude isolé n’installent pas automatiquement les outils utilisateur : une action `install-tools` distincte et explicitement demandée est nécessaire. Désinstaller le projet conserve les outils de la machine ; `uninstall-tools` les retire séparément et restaure leurs paramètres d’origine. L’authentification n’est jamais copiée. [Configuration et prérequis](docs/PROJECT_SETTINGS.md).

## Documents, migration et isolation de session en 2.1.1

Les nouvelles installations placent les neuf rôles dans `.0-code/docs/` : `STATE.md`, `ROADMAP.md`, `reports/`, `decisions/`, `todo/`, `logs/`, `prompts/`, `prompts/templates/` et `userdocs/`. Les documents durables doivent être suivis par Git ; les journaux sont ignorés. Les journaux peuvent aussi utiliser `.0-code/run/logs/`, contrairement aux rôles permanents. Les rôles externes explicites restent pris en charge ; upgrade conserve leurs chemins. Les documents sont hors du reçu de propriété : doctor les accepte, upgrade les préserve et uninstall les garde avec leurs répertoires, tout en supprimant données d’exécution et sauvegardes.

Déplacez explicitement les rôles standard 2.0.x de `docs/*` avec `upgrade --relocate-documents <files.json>` ou `migrate --relocate-documents <files.json>`, d’abord avec `--dry-run`. Vérifiez la liste exacte ; la documentation produit non listée reste en place. Config, références STATE et modèles sélectionnés sont adaptés, avec archivage des octets originaux modifiés. Les chemins externes personnalisés restent inchangés. Avant déplacement ou adoption, terminez le cycle, récupérez les travaux de fond et arrêtez le pilote ; un verrou actif ou des entrées modifiées entraînent un refus. Préparez les déplacements ensemble dans Git pour reconnaître les renommages.

Une installation `.0-code/` modifiée sans reçu utilise `migrate --adopt-manifest <manifest.json>`, avec SHA-256 vérifiés et actions `replace`/`preserve`. Seules les extensions du projet exactement listées dans `bin/`, `claude/` et `.0-code/README.md` peuvent être conservées ; le code est remplacé et archivé. Les extensions restent modifiables et survivent à upgrade/uninstall. Fichiers inconnus ou empreintes différentes entraînent un refus ; adoption et déplacement sont séparés. Sauvegardez les règles AGENT propres au projet dans un document référencé par `instructions.project_rules` avant de remplacer le guide généré.

La session Claude isolée exige à la fois `instructions.claude: session-hook` et `instructions.claude_settings: .0-code/claude/settings.json`. Avec Claude seul et des rôles documentaires internes, install, upgrade, migrate et l’adoption ne font aucune écriture, suppression ou modification de récupération externe non choisie, y compris dans `.claude/`, `.mcp.json` et `CLAUDE.md`. Les rôles externes explicites, les autres moteurs choisis et un `install-tools` demandé séparément sont des exceptions limitées à leur périmètre. Les anciens reçus de propriété ou journaux de transaction n’autorisent aucun nettoyage externe ; une transition qui en exige un est refusée avant écriture et nécessite un nettoyage vérifié dans l’ancien mode. L’intégration normale `project-file` et `session-hook` avec `.claude/settings.json` conservent leur livraison native.

Lancez `claude --settings .0-code/claude/settings.json` ou un lanceur vérifié qui transmet ce fichier. SessionStart et SubagentStart exposent par `.0-code/AGENT.md` les sources internes de l’orchestrateur et des procédures d’audit activées ; les commandes slash natives ne sont pas enregistrées. Avec `modules.audits: false`, les sources et références d’audit sont absentes. Les outils textuels sûrs peuvent être référencés ; les contrôles d’exécution natifs et nouveaux enregistrements MCP incompatibles avec ce mode sont signalés comme `unsupported`. Lanceur, MCP, system-prompt et politiques de configuration conservés restent en place ; les paramètres compatibles reçoivent les entrées du framework, et uninstall restaure les valeurs d’origine. Les sessions ordinaires ne chargent pas le fichier automatiquement. Doctor vérifie les hooks locaux, pas les substitutions utilisateur, administrées ou de CLI. [Formats, commandes et limites](docs/PROJECT_SETTINGS.md).

Les plateformes et versions de Node testées, les limites du système de fichiers et les seuils de couverture sont consignés dans le [périmètre de validation](docs/PROJECT_SETTINGS.md#validation-scope). Une matrice CI configurée ne prouve pas son exécution.

## Travailler et maintenir

Depuis un projet installé :

```bash
node .0-code/tools/0code.mjs doctor --json
node .0-code/tools/0code.mjs start <cycle-prompt> --max 60
node /path/to/new-source/tools/0code.mjs upgrade --project . --dry-run
node .0-code/tools/0code.mjs uninstall --dry-run
```

Remplissez l’unique modèle `.0-code/templates/cycle.md`. `start` met l’état à jour atomiquement et affiche la commande du pilote. Redémarrez Claude pour charger les hooks ; Codex et OpenCode utilisent le superviseur externe. Un dossier possède un seul cycle actif. Les limites d’itérations et de dépenses sont facultatives ; la limite financière exige les données de coût du superviseur. Enregistrez les travaux longs dans l’état au lieu d’attendre dans des boucles avec sleep.

Les sources publiques permettent une nouvelle installation et la mise à jour de la structure `.0-code/`. **La migration automatique des anciennes installations 1.x à la racine est indisponible sans `config/legacy-installations.json`, exclu de l’arbre public.** Utilisez `migrate --dry-run`, puis `migrate`, uniquement avec des sources contenant les preuves de propriété issues des versions publiées. Seuls les fichiers prouvés octet par octet et les blocs propres exacts sont supprimés ; les documents restent, les données d’exécution sont déplacées ou archivées avec sauvegardes. Terminez d’abord tout ancien cycle actif ; sans preuves, conservez les anciens fichiers et vérifiez leur propriété avant toute modification.

[Moteurs](docs/ENGINE_SETTINGS.md), [Claude](CLAUDE_CODE_SETUP.md), [développement](GUIDELINE.md) et [sécurité](SECURITY.md) expliquent fonctionnement et validation. Dans les sources, lancez `node tests/run.mjs --coverage-min=80` et `bash tests/smoke.sh` ; les résultats locaux font preuve, indépendamment de la disponibilité de CI.
