<!-- tracks: README.md sha256:3861ef6052d0 -->

# 0-CODE

**Version:** v2.0.2

Un cycle de développement autonome pour **Claude Code, Codex et OpenCode**, intégré à un projet existant. Une seule consigne de cycle peut réunir recherche, réalisation, corrections, audits et livraison.

[English](README.md) · [中文](README.zh-CN.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md)

## Intégrer avec votre agent

Dans la session de votre projet, demandez : **« Intègre 0-CODE depuis https://github.com/0-SOFT/0-CODE ; suis son `INTEGRATE.md`. »** Utilisez une copie des sources publiques hors du projet cible, éventuellement à un tag de version choisi. Le même [modèle court](INTEGRATE.md) gère la mise à jour et la suppression pour les trois moteurs.

L’agent inventorie documents, outils, MCP et commandes de vérification, résout les ambiguïtés réelles, présente le plan, installe, lance doctor et crée un commit dans une branche séparée. Les outils du projet ont priorité. [Démarrage manuel](QUICKSTART.md).

## Ce qui est installé

Le code du framework, la configuration, les schémas, modules et modèles résident dans **`.0-code/`**. Les moteurs reçoivent les entrées natives nécessaires : hooks, instructions, outils compatibles et plugin de protection OpenCode. Le code et les documents existants sont préservés ; conflits et fichiers propres modifiés sont détectés avant toute écriture. Les fichiers d’exécution et sauvegardes résident dans `.0-code/run/`, exclu de git.

[PROJECT_SETTINGS](docs/PROJECT_SETTINGS.md) est l’unique référence de configuration. Gardez les documents par défaut, modifiez certains rôles ou associez tous les rôles aux conventions existantes. L’état demeure lisible par machine. Les documents humains utilisent la langue configurée ; les instructions de l’agent restent en anglais.

Le modèle, l’effort de raisonnement et la connexion relèvent du propriétaire. La priorité est **options explicites > environnement > configuration du projet > préférences natives du moteur**. Le modèle et l’effort non spécifiés sont hérités ; l’authentification n’est jamais copiée. Voir les [paramètres des moteurs](docs/ENGINE_SETTINGS.md).

Le [catalogue public](toolset/CATALOG.md) contient **cinq MCP par défaut : context7, playwright, chrome-devtools, sequential-thinking et memory**. Ils nécessitent des paquets npm de version égale ou supérieure au minimum SemVer testé, avec le nom et le point d’entrée corrects ; conservez les versions plus récentes valides. Aucune clé d’API externe n’est requise ; les outils de navigateur nécessitent aussi un navigateur disponible. L’enregistrement et un doctor réussi ne prouvent pas une connexion active. Les fichiers d’implémentation privés des compétences, agents, commandes et règles sont exclus. Les exemples optionnels de services liés à un compte dans le manifeste MCP restent désactivés jusqu’à leur configuration et autorisation explicites.

Par défaut, **une installation indépendante par utilisateur** est partagée entre ses projets. Répéter la même sélection ne change rien. Le périmètre project fixe une autre sélection dans un projet. Désinstaller le projet conserve les outils de la machine ; `uninstall-tools` les retire séparément et restaure leurs paramètres antérieurs. L’authentification n’est jamais copiée. [Configuration et prérequis](docs/PROJECT_SETTINGS.md).

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
