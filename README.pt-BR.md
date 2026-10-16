<!-- tracks: README.md sha256:3861ef6052d0 -->

# 0-CODE

**Versão:** v2.0.3

Um ciclo autônomo de desenvolvimento para **Claude Code, Codex e OpenCode**, integrado a um projeto existente. Uma única instrução de ciclo pode reunir pesquisa, implementação, correções, auditorias e lançamento.

[English](README.md) · [中文](README.zh-CN.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md)

## Integre com seu agente

Na sessão do agente do projeto, peça: **“Integre 0-CODE a partir de https://github.com/0-SOFT/0-CODE; siga seu `INTEGRATE.md`.”** Use uma cópia do código público fora do projeto de destino, opcionalmente em uma tag de versão escolhida. O mesmo [modelo curto](INTEGRATE.md) atende atualização e remoção nos três motores.

O agente inventaria documentos, ferramentas, MCP e comandos de verificação, resolve ambiguidades reais, apresenta o plano, instala, executa doctor e faz commit em uma branch separada. As ferramentas do projeto têm prioridade. [Início manual](QUICKSTART.md).

## O que é instalado

Código do framework, configuração, esquemas, módulos e modelos ficam em **`.0-code/`**. Os motores recebem apenas hooks, instruções e ferramentas compatíveis nos locais nativos necessários, além do plugin de proteção do OpenCode. Código e documentos existentes são preservados; conflitos e arquivos próprios alterados são identificados antes da escrita. Arquivos de execução e backups ficam em `.0-code/run/`, ignorado pelo git.

[PROJECT_SETTINGS](docs/PROJECT_SETTINGS.md) é a referência única de configuração. Adote os documentos padrão, altere papéis específicos ou associe todos os papéis às convenções existentes. O estado continua sendo um documento legível por máquina. Documentos humanos usam o idioma configurado; instruções do agente ficam em inglês.

Modelo, esforço de raciocínio e login pertencem ao proprietário. A prioridade é **opções explícitas > ambiente > configuração do projeto > preferências nativas do motor**. Modelo e esforço não especificados são herdados; a autenticação nunca é copiada. Veja as [configurações dos motores](docs/ENGINE_SETTINGS.md).

O [catálogo público](toolset/CATALOG.md) contém **cinco MCP padrão: context7, playwright, chrome-devtools, sequential-thinking e memory**. Precisam de pacotes npm com versão igual ou superior ao mínimo SemVer testado, com nome e ponto de entrada corretos; preserve versões mais novas válidas. Não exigem chave de API externa; ferramentas de navegador também precisam de um navegador disponível. Registro e doctor aprovado não comprovam uma conexão ativa. Os arquivos de implementação privados de habilidades, agentes, comandos e regras são excluídos. Exemplos opcionais de serviços com contas no manifesto MCP ficam desligados até configuração e autorização explícitas.

O padrão é **uma instalação independente por usuário**, compartilhada entre seus projetos. Repetir a mesma seleção não muda nada. O escopo project fixa outra seleção em um projeto. Remover o projeto mantém as ferramentas da máquina; `uninstall-tools` as remove separadamente e restaura as configurações anteriores. A autenticação nunca é copiada. [Configuração e dependências](docs/PROJECT_SETTINGS.md).

## Trabalho e manutenção

No projeto instalado:

```bash
node .0-code/tools/0code.mjs doctor --json
node .0-code/tools/0code.mjs start <cycle-prompt> --max 60
node /path/to/new-source/tools/0code.mjs upgrade --project . --dry-run
node .0-code/tools/0code.mjs uninstall --dry-run
```

Preencha o único modelo `.0-code/templates/cycle.md`. `start` atualiza o estado atomicamente e mostra o comando do controlador. Reinicie Claude para carregar hooks; Codex e OpenCode usam o supervisor externo. Uma pasta tem um ciclo ativo. Limites de iterações e gastos são opcionais; o limite de custo exige dados do supervisor. Registre trabalhos longos no estado em vez de consultar com laços de sleep.

O código público permite novas instalações e atualizações da estrutura `.0-code/`. **A migração automática de instalações antigas 1.x na raiz não está disponível sem `config/legacy-installations.json`, excluído da árvore pública.** Use `migrate --dry-run`, depois `migrate`, apenas a partir de fontes com provas de propriedade de versões publicadas. Só arquivos comprovados byte a byte e blocos próprios exatos são removidos; documentos permanecem e dados de execução são movidos ou arquivados com backups. Encerre primeiro qualquer ciclo antigo ativo; sem provas, preserve os arquivos antigos e revise sua propriedade antes de alterá-los.

[Motores](docs/ENGINE_SETTINGS.md), [Claude](CLAUDE_CODE_SETUP.md), [desenvolvimento](GUIDELINE.md) e [segurança](SECURITY.md) explicam operação e validação. Nos fontes, execute `node tests/run.mjs --coverage-min=80` e `bash tests/smoke.sh`; resultados locais são evidências, independentemente da disponibilidade do CI.
