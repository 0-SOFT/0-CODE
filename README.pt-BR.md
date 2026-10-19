<!-- tracks: README.md sha256:dc67310727a4 -->

# 0-CODE

**Versão:** v2.1.1

Um ciclo autônomo de desenvolvimento para **Claude Code, Codex e OpenCode**, integrado a um projeto existente. Uma única instrução de ciclo pode reunir pesquisa, implementação, correções, auditorias e lançamento.

[English](README.md) · [中文](README.zh-CN.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md)

## Integre com seu agente

Na sessão do agente do projeto, peça: **“Integre 0-CODE a partir de https://github.com/0-SOFT/0-CODE; siga seu `INTEGRATE.md`.”** Use uma cópia do código público fora do projeto de destino, opcionalmente em uma tag de versão escolhida. O mesmo [modelo curto](INTEGRATE.md) atende atualização e remoção nos três motores.

O agente inventaria documentos, ferramentas, MCP e comandos de verificação, resolve ambiguidades reais, apresenta o plano, instala, executa doctor e faz commit em uma branch separada. As ferramentas do projeto têm prioridade. [Início manual](QUICKSTART.md).

## O que é instalado

O código do framework, a configuração, os esquemas, módulos e modelos integrados ficam em **`.0-code/`**. Os documentos do ciclo pertencem ao projeto e ficam em **`.0-code/docs/`**; arquivos de execução e backups ficam em **`.0-code/run/`**, ignorado pelo Git. A integração normal adiciona hooks, instruções, ferramentas compatíveis e o plugin de proteção do OpenCode necessários aos motores escolhidos; a sessão isolada do Claude descrita abaixo mantém sua integração dentro de `.0-code/`. Código e documentos existentes são preservados; conflitos e arquivos próprios alterados são informados antes da escrita.

[PROJECT_SETTINGS](docs/PROJECT_SETTINGS.md) é a referência única de configuração. Adote os documentos padrão, altere papéis específicos ou associe todos os papéis às convenções existentes. O estado continua sendo um documento legível por máquina. Documentos humanos usam o idioma configurado; instruções do agente ficam em inglês.

Modelo, esforço de raciocínio e login pertencem ao proprietário. A prioridade é **opções explícitas > ambiente > configuração do projeto > preferências nativas do motor**. Modelo e esforço não especificados são herdados; a autenticação nunca é copiada. Veja as [configurações dos motores](docs/ENGINE_SETTINGS.md).

O [catálogo público](toolset/CATALOG.md) contém **cinco MCP padrão: context7, playwright, chrome-devtools, sequential-thinking e memory**. Precisam de pacotes npm com versão igual ou superior ao mínimo SemVer testado, com nome e ponto de entrada corretos; preserve versões mais novas válidas. Não exigem chave de API externa; ferramentas de navegador também precisam de um navegador disponível. Registro e doctor aprovado não comprovam uma conexão ativa. Os arquivos de implementação privados de habilidades, agentes, comandos e regras são excluídos. Exemplos opcionais de serviços com contas no manifesto MCP ficam desligados até configuração e autorização explícitas.

O padrão é **uma instalação independente por usuário**, compartilhada entre seus projetos. Repetir a mesma seleção não altera nada. O escopo project fixa outra seleção em um projeto. Os install/upgrade/migrate do Claude isolado não instalam ferramentas de usuário automaticamente: é necessário solicitar `install-tools` separadamente e de forma explícita. Desinstalar o projeto mantém as ferramentas da máquina; `uninstall-tools` as remove separadamente e restaura suas configurações originais. A autenticação nunca é copiada. [Configuração e pré-requisitos](docs/PROJECT_SETTINGS.md).

## Documentos, migração e isolamento de sessão na 2.1.1

Novas instalações colocam os nove papéis em `.0-code/docs/`: `STATE.md`, `ROADMAP.md`, `reports/`, `decisions/`, `todo/`, `logs/`, `prompts/`, `prompts/templates/` e `userdocs/`. Documentos permanentes devem entrar no Git; logs de sessão são ignorados. Logs também podem usar `.0-code/run/logs/`; papéis permanentes não podem usar runtime. Papéis externos explícitos continuam válidos e upgrade mantém seus caminhos. Documentos ficam fora do recibo de propriedade: doctor os aceita, upgrade os preserva e uninstall mantém documentos e diretórios, removendo runtime e backups.

Mova os papéis padrão 2.0.x de `docs/*` explicitamente com `upgrade --relocate-documents <files.json>` ou `migrate --relocate-documents <files.json>`, primeiro com `--dry-run`. Revise a lista exata; documentação do produto fora dela permanece. Config, referências de STATE e modelos selecionados são atualizados, com os bytes originais alterados arquivados. Caminhos externos personalizados não mudam. Antes da mudança ou adoção, conclua o ciclo, recolha trabalhos em segundo plano e pare o controlador; lock ativo ou entradas alteradas causam recusa. Prepare os movimentos juntos no Git para reconhecer renomeações.

Uma instalação `.0-code/` modificada sem recibo usa `migrate --adopt-manifest <manifest.json>`, com SHA-256 revisados e ações `replace`/`preserve`. Apenas extensões do projeto listadas exatamente em `bin/`, `claude/` e `.0-code/README.md` podem ser mantidas; o código é substituído e arquivado. Extensões continuam editáveis e sobrevivem a upgrade/uninstall. Arquivos desconhecidos ou hashes diferentes causam recusa; adoção e mudança de documentos são separadas. Guarde regras próprias de AGENT como documento e referencie com `instructions.project_rules` antes de substituir a instrução gerada.

A sessão isolada do Claude exige tanto `instructions.claude: session-hook` quanto `instructions.claude_settings: .0-code/claude/settings.json`. Com apenas Claude selecionado e papéis de documentos internos, install, upgrade, migrate e adoção não fazem escritas, exclusões ou alterações de recuperação externas não escolhidas, incluindo `.claude/`, `.mcp.json` e `CLAUDE.md`. Papéis externos explícitos, outros motores selecionados e um `install-tools` solicitado separadamente são exceções limitadas aos respectivos escopos. Recibos de propriedade ou diários de transações antigos não autorizam limpeza externa; uma transição que precise dela é recusada antes da escrita e exige limpeza revisada no modo anterior. A integração normal `project-file` e `session-hook` com `.claude/settings.json` mantém a entrega nativa.

Inicie com `claude --settings .0-code/claude/settings.json` ou um launcher revisado que passe esse arquivo. SessionStart e SubagentStart expõem pelo `.0-code/AGENT.md` as fontes internas do orquestrador e dos procedimentos de auditoria habilitados; comandos slash nativos não são registrados. Com `modules.audits: false`, não há fontes nem referências de auditoria. Ferramentas de texto seguras podem usar referências; controles nativos de execução e novos registros MCP incompatíveis com essa entrega recebem `unsupported`. Launcher, MCP, system-prompt e políticas de configuração preservados permanecem; configurações compatíveis recebem entradas do framework, e uninstall restaura os valores originais. Sessões normais não carregam o arquivo automaticamente. Doctor verifica hooks locais, não substituições de usuário, gerenciadas ou de CLI. [Formatos, comandos e limites](docs/PROJECT_SETTINGS.md).

As plataformas e versões do Node testadas, os limites do sistema de arquivos e os critérios de cobertura estão no [escopo da validação](docs/PROJECT_SETTINGS.md#validation-scope). Uma matriz CI configurada não comprova sua execução.

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
