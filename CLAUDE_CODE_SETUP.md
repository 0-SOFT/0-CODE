# Claude Code Setup — Full Inventory

**Date:** 2026-04-03 (last verified 2026-05-26)
**Source:** [Everything Claude Code (ECC)](https://github.com/anthropics/everything-claude-code) + custom config
**Config location:** `~/.claude/`

---

## 1. MCP Servers (10 — all active, scope: user)

Stored in `~/.claude.json` (user scope). Verified with `claude mcp list` on 2026-05-26.

| # | Name | Type | Command / URL | Status | Auth |
|---|------|------|---------------|--------|------|
| 1 | **github** | stdio | `~/.claude/bin/github-mcp-server.exe stdio` | ✓ Connected | `GITHUB_PERSONAL_ACCESS_TOKEN` env |
| 2 | **manus** | stdio | `Manus-MCP/.venv/Scripts/python.exe -m manus_mcp` | ✓ Connected | `MANUS_API_KEY` env |
| 3 | **telegram** | stdio | `uv --directory ~/.claude/mcp-servers/telegram-mcp run main.py` | messaging and notifications |
| 4 | **2captcha** | stdio | `python -m twocaptcha_mcp` | ✓ Connected | `2Captcha_API_KEY` env |
| 5 | **context7** | stdio | `npx -y @upstash/context7-mcp@latest` | ✓ Connected | none |
| 6 | **playwright** | stdio | `npx -y @playwright/mcp@latest --headless` | ✓ Connected | none |
| 7 | **chrome-devtools** | stdio | `npx -y chrome-devtools-mcp@latest` | ✓ Connected | none |
| 8 | **sequential-thinking** | stdio | `npx -y @modelcontextprotocol/server-sequential-thinking@latest` | ✓ Connected | none |
| 9 | **memory** | stdio | `npx -y @modelcontextprotocol/server-memory@latest` | ✓ Connected | none |
| 10 | **sentry** | http | `https://mcp.sentry.dev/mcp` | ! Needs authentication | OAuth — run `/mcp` in Claude Code |

### Notes on changes since first draft

- The original doc listed `chrome-devtools` as `@anthropic-ai/chrome-devtools-mcp` — that package does not exist on npm. Correct package is `chrome-devtools-mcp` (maintained by `google-wombot`).
- **telegram (CRITICAL — name squat):** the PyPI name `telegram-mcp` is owned by an *unrelated, outdated* project. The original command `uvx --from telegram-mcp telegram-mcp` installs that wrong package — the live config now runs the real project (`chigwell/telegram-mcp`, v2.0.1, Telethon user-account, 116 tools) from a local clone at `~/.claude/mcp-servers/telegram-mcp`. The package ships an `install_guard` that refuses to start unless launched from a source checkout or an explicit git/file install. **Reinstall on a new machine — git only:**
  - Portable: `uvx --from git+https://github.com/chigwell/telegram-mcp.git telegram-mcp`
  - Or clone: `git clone https://github.com/chigwell/telegram-mcp.git ~/.claude/mcp-servers/telegram-mcp` then run `uv --directory ~/.claude/mcp-servers/telegram-mcp run main.py`.
  - `TELEGRAM_SESSION_STRING` is bound to one account **and one IP at a time** — regenerate per machine via `telegram-mcp-generate-session` (or `session_string_generator.py`), otherwise Telegram revokes the auth key (the current "Down" cause). `TELEGRAM_CHAT_ID` is **not** used by this MCP — it belongs to the Bot-API loop notifier (`lib/telegram-notify.sh` + `TELEGRAM_BOT_TOKEN`), a separate integration.
- `~/.claude/settings.json` still has a duplicate `mcpServers` block. Claude Code reads MCPs from `~/.claude.json`, not from that block — it can be left alone or deleted.
- `npx` caches under `%LOCALAPPDATA%/npm-cache/_npx/<hash>/` can become corrupt and produce `ERR_MODULE_NOT_FOUND`. Cleared during setup for context7, memory, playwright.

---

## 2. Hooks (2)

Configured in `~/.claude/settings.json`.

### PostToolUse
| Matcher | Action | Timeout |
|---------|--------|---------|
| `Write(*.py)` | `ruff format` on saved file | 15s |

### PreToolUse
| Matcher | Action |
|---------|--------|
| `Bash` | Block `pip`/`pip3` (use `uv`), block `rm -rf /` |

---

## 3. Agents (30)

Located in `~/.claude/agents/`.

| # | Agent | Purpose |
|---|-------|---------|
| 1 | architect | System design, scalability, technical decisions |
| 2 | build-error-resolver | Fix build/type errors with minimal diffs |
| 3 | chief-of-staff | Triage email, Slack, LINE, Messenger |
| 4 | code-reviewer | Code quality, security, maintainability review |
| 5 | cpp-build-resolver | C++ build, CMake, compilation errors |
| 6 | cpp-reviewer | C++ memory safety, modern idioms, concurrency |
| 7 | database-reviewer | PostgreSQL query optimization, schema, security |
| 8 | doc-updater | Documentation and codemap updates |
| 9 | docs-lookup | Library docs via Context7 MCP |
| 10 | e2e-runner | E2E testing with Playwright |
| 11 | flutter-reviewer | Flutter/Dart code review |
| 12 | go-build-resolver | Go build, vet, linter issues |
| 13 | go-reviewer | Go code review (idiomatic, concurrency, errors) |
| 14 | harness-optimizer | Agent harness config optimization |
| 15 | healthcare-reviewer | Clinical safety, PHI compliance |
| 16 | java-build-resolver | Java/Maven/Gradle build errors |
| 17 | java-reviewer | Java/Spring Boot code review |
| 18 | kotlin-build-resolver | Kotlin/Gradle build errors |
| 19 | kotlin-reviewer | Kotlin/Android/KMP code review |
| 20 | loop-operator | Autonomous agent loop monitoring |
| 21 | performance-optimizer | Performance analysis, bottleneck detection |
| 22 | planner | Implementation planning for complex features |
| 23 | python-reviewer | Python PEP 8, type hints, security |
| 24 | pytorch-build-resolver | PyTorch runtime, CUDA, training errors |
| 25 | refactor-cleaner | Dead code cleanup, consolidation |
| 26 | rust-build-resolver | Rust cargo build, borrow checker |
| 27 | rust-reviewer | Rust ownership, lifetimes, idiomatic patterns |
| 28 | security-reviewer | OWASP Top 10, secrets, injection detection |
| 29 | tdd-guide | Test-driven development enforcement |
| 30 | typescript-reviewer | TypeScript/JS type safety, async, security |

---

## 4. Skills (138)

Located in `~/.claude/skills/`. All from ECC GitHub.

| # | Skill | Category |
|---|-------|----------|
| 1 | agent-eval | Agent comparison/benchmarking |
| 2 | agent-harness-construction | Agent action space design |
| 3 | agent-payment-x402 | Agent payment execution |
| 4 | agentic-engineering | Eval-first agent engineering |
| 5 | ai-first-engineering | AI-assisted team operating model |
| 6 | ai-regression-testing | AI regression testing strategies |
| 7 | android-clean-architecture | Android Clean Architecture |
| 8 | api-design | REST API design patterns |
| 9 | architecture-decision-records | ADR capture |
| 10 | article-writing | Long-form content writing |
| 11 | autonomous-loops | Autonomous agent loop patterns |
| 12 | backend-patterns | Backend architecture (Node/Express/Next) |
| 13 | benchmark | Performance benchmarking |
| 14 | blueprint | Multi-session construction planning |
| 15 | browser-qa | Visual testing via browser automation |
| 16 | bun-runtime | Bun runtime patterns |
| 17 | canary-watch | Post-deploy URL monitoring |
| 18 | carrier-relationship-management | Freight carrier management |
| 19 | ck | Persistent per-project REPL memory |
| 20 | claude-api | Anthropic Claude API patterns |
| 21 | claude-devfleet | Multi-agent orchestration |
| 22 | click-path-audit | UI button/touchpoint trace audit |
| 23 | clickhouse-io | ClickHouse analytics patterns |
| 24 | codebase-onboarding | Repo onboarding guide generation |
| 25 | coding-standards | Universal coding standards |
| 26 | compose-multiplatform-patterns | Compose Multiplatform (KMP) |
| 27 | configure-ecc | ECC interactive installer |
| 28 | content-engine | Multi-platform content systems |
| 29 | content-hash-cache-pattern | SHA-256 content hash caching |
| 30 | context-budget | Context window audit |
| 31 | continuous-agent-loop | Continuous loops with quality gates |
| 32 | continuous-learning | Session pattern extraction |
| 33 | continuous-learning-v2 | Instinct-based learning system |
| 34 | cost-aware-llm-pipeline | LLM API cost optimization |
| 35 | cpp-coding-standards | C++ Core Guidelines |
| 36 | cpp-testing | C++ GoogleTest/CTest |
| 37 | crosspost | Multi-platform content distribution |
| 38 | customs-trade-compliance | Customs/tariff compliance |
| 39 | data-scraper-agent | Automated data collection agent |
| 40 | database-migrations | DB migration best practices |
| 41 | deep-research | Multi-source research synthesis |
| 42 | deployment-patterns | CI/CD, Docker, health checks |
| 43 | design-system | Design system generation/audit |
| 44 | django-patterns | Django architecture patterns |
| 45 | django-security | Django security best practices |
| 46 | django-tdd | Django TDD with pytest |
| 47 | django-verification | Django verification loop |
| 48 | dmux-workflows | Multi-agent tmux orchestration |
| 49 | docker-patterns | Docker/Compose patterns |
| 50 | documentation-lookup | Docs via Context7 MCP |
| 51 | e2e-testing | Playwright E2E patterns |
| 52 | energy-procurement | Energy cost optimization |
| 53 | enterprise-agent-ops | Long-lived agent operations |
| 54 | eval-harness | Eval-driven development framework |
| 55 | everything-claude-code-plugin | ECC meta-plugin |
| 56 | exa-search | Exa neural search |
| 57 | fal-ai-media | fal.ai media generation |
| 58 | flutter-dart-code-review | Flutter/Dart review checklist |
| 59 | foundation-models-on-device | Apple FoundationModels (iOS 26) |
| 60 | frontend-design | Production-grade frontend UI |
| 61 | frontend-patterns | React/Next.js patterns |
| 62 | frontend-slides | HTML presentation creation |
| 63 | git-workflow | Git branching/commit patterns |
| 64 | golang-patterns | Idiomatic Go patterns |
| 65 | golang-testing | Go testing (table-driven, TDD) |
| 66 | healthcare-cdss-patterns | Clinical Decision Support |
| 67 | healthcare-emr-patterns | EMR/EHR development |
| 68 | healthcare-eval-harness | Patient safety eval |
| 69 | healthcare-phi-compliance | PHI/PII compliance |
| 70 | interface-design | Dashboard/app UI design |
| 71 | inventory-demand-planning | Demand forecasting |
| 72 | investor-materials | Pitch decks, fundraising docs |
| 73 | investor-outreach | Cold emails, investor comms |
| 74 | iterative-retrieval | Progressive context retrieval |
| 75 | java-coding-standards | Java/Spring Boot standards |
| 76 | jpa-patterns | JPA/Hibernate patterns |
| 77 | kotlin-coroutines-flows | Kotlin Coroutines/Flow |
| 78 | kotlin-exposed-patterns | JetBrains Exposed ORM |
| 79 | kotlin-ktor-patterns | Ktor server patterns |
| 80 | kotlin-patterns | Idiomatic Kotlin |
| 81 | kotlin-testing | Kotlin Kotest/MockK TDD |
| 82 | laravel-patterns | Laravel architecture |
| 83 | laravel-plugin-discovery | LaraPlugins.io discovery |
| 84 | laravel-security | Laravel security |
| 85 | laravel-tdd | Laravel TDD (PHPUnit/Pest) |
| 86 | laravel-verification | Laravel verification loop |
| 87 | liquid-glass-design | iOS 26 Liquid Glass |
| 88 | logistics-exception-management | Freight exception handling |
| 89 | market-research | Market/competitive analysis |
| 90 | mcp-server-patterns | MCP server building |
| 91 | nanoclaw-repl | NanoClaw v2 REPL |
| 92 | nextjs-turbopack | Next.js 16+ Turbopack |
| 93 | nutrient-document-processing | Nutrient DWS API |
| 94 | nuxt4-patterns | Nuxt 4 app patterns |
| 95 | openclaw-persona-forge | OpenClaw AI Agent persona |
| 96 | perl-patterns | Modern Perl 5.36+ |
| 97 | perl-security | Perl security (taint, DBI) |
| 98 | perl-testing | Perl Test2::V0 TDD |
| 99 | plankton-code-quality | Auto-format via hooks |
| 100 | postgres-patterns | PostgreSQL optimization |
| 101 | pr-review-toolkit | PR review toolkit |
| 102 | product-lens | Product validation |
| 103 | production-scheduling | Manufacturing scheduling |
| 104 | project-guidelines-example | Project-specific template |
| 105 | prompt-optimizer | Prompt analysis/optimization |
| 106 | python-patterns | Pythonic idioms, PEP 8 |
| 107 | python-testing | pytest TDD |
| 108 | pytorch-patterns | PyTorch deep learning |
| 109 | quality-nonconformance | Quality control (FDA, IATF) |
| 110 | ralphinho-rfc-pipeline | RFC-driven multi-agent DAG |
| 111 | regex-vs-llm-structured-text | Regex vs LLM parsing |
| 112 | repo-scan | Cross-stack source audit |
| 113 | returns-reverse-logistics | Returns/reverse logistics |
| 114 | rules-distill | Cross-cutting rule extraction |
| 115 | rust-patterns | Idiomatic Rust |
| 116 | rust-testing | Rust TDD |
| 117 | safety-guard | Destructive operation prevention |
| 118 | santa-method | Multi-agent adversarial verification |
| 119 | search-first | Research-before-coding |
| 120 | security-review | Security checklist/patterns |
| 121 | security-scan | AgentShield config scan |
| 122 | skill-comply | Skill compliance visualization |
| 123 | skill-stocktake | Skill quality audit |
| 124 | springboot-patterns | Spring Boot architecture |
| 125 | springboot-security | Spring Security |
| 126 | springboot-tdd | Spring Boot TDD |
| 127 | springboot-verification | Spring Boot verification |
| 128 | strategic-compact | Manual context compaction |
| 129 | superpowers | (meta-skill) |
| 130 | swift-actor-persistence | Swift actor persistence |
| 131 | swift-concurrency-6-2 | Swift 6.2 concurrency |
| 132 | swift-protocol-di-testing | Swift protocol DI testing |
| 133 | swiftui-patterns | SwiftUI architecture |
| 134 | tdd-workflow | TDD enforcement (80%+ coverage) |
| 135 | team-builder | Parallel agent team picker |
| 136 | token-budget-advisor | Token budget control |
| 137 | verification-loop | Comprehensive verification |
| 138 | video-editing | AI video editing workflows |
| 139 | videodb | Video/audio processing |
| 140 | visa-doc-translate | Visa doc translation |
| 141 | x-api | X/Twitter API integration |

---

## 5. Commands (66)

Located in `~/.claude/commands/`. Slash-command invocations.

| # | Command | Purpose |
|---|---------|---------|
| 1 | /add-language-rules | Add language rules scaffold |
| 2 | /aside | Quick side question without losing context |
| 3 | /build-fix | Build and fix errors |
| 4 | /checkpoint | Create checkpoint |
| 5 | /claw | Start NanoClaw v2 REPL |
| 6 | /code-review | Code review |
| 7 | /context-budget | Analyze context window usage |
| 8 | /cpp-build | Fix C++ build errors |
| 9 | /cpp-review | C++ code review |
| 10 | /cpp-test | C++ TDD workflow |
| 11 | /database-migration | Database migration workflow |
| 12 | /devfleet | Multi-agent orchestration |
| 13 | /docs | Docs lookup via Context7 |
| 14 | /e2e | E2E test generation/run |
| 15 | /ESSKETIT | Run the most recently generated prompt in `docs/prompts/` (or a path passed in args) as if given directly |
| 16 | /eval | Evaluation command |
| 17 | /evolve | Analyze and evolve instincts |
| 18 | /feature-development | Feature implementation workflow |
| 19 | /go-build | Fix Go build errors |
| 20 | /go-review | Go code review |
| 21 | /go-test | Go TDD workflow |
| 22 | /gradle-build | Fix Gradle build errors |
| 23 | /harness-audit | Harness audit |
| 24 | /instinct-export | Export instincts |
| 25 | /instinct-import | Import instincts |
| 26 | /instinct-status | Show learned instincts |
| 27 | /kotlin-build | Fix Kotlin build errors |
| 28 | /kotlin-review | Kotlin code review |
| 29 | /kotlin-test | Kotlin TDD workflow |
| 30 | /learn | Extract reusable patterns |
| 31 | /learn-eval | Learn + self-evaluate quality |
| 32 | /loop-start | Start recurring loop |
| 33 | /loop-status | Check loop status |
| 34 | /model-route | Model routing |
| 35 | /multi-backend | Backend multi-model dev |
| 36 | /multi-execute | Multi-model execution |
| 37 | /multi-frontend | Frontend multi-model dev |
| 38 | /multi-plan | Multi-model planning |
| 39 | /multi-workflow | Multi-model workflow |
| 40 | /orchestrate | Multi-agent orchestration guide |
| 41 | /plan | Implementation planning |
| 42 | /pm2 | PM2 initialization |
| 43 | /projects | List known projects |
| 44 | /promote | Promote instincts to global |
| 45 | /prompt-optimize | Optimize a prompt |
| 46 | /prune | Delete stale instincts |
| 47 | /python-review | Python code review |
| 48 | /quality-gate | Quality gate check |
| 49 | /refactor-clean | Dead code refactor |
| 50 | /resume-session | Resume previous session |
| 51 | /review | Review git changes |
| 52 | /rules-distill | Extract rules from skills |
| 53 | /rust-build | Fix Rust build errors |
| 54 | /rust-review | Rust code review |
| 55 | /rust-test | Rust TDD workflow |
| 56 | /save-session | Save session state |
| 57 | /sessions | Manage session history |
| 58 | /setup-pm | Setup project management |
| 59 | /skill-create | Create skill from git history |
| 60 | /skill-health | Skill health dashboard |
| 61 | /tdd | TDD workflow |
| 62 | /test | Write test first, then implement |
| 63 | /test-coverage | Test coverage check |
| 64 | /update-codemaps | Update codemaps |
| 65 | /update-docs | Update documentation |
| 66 | /verify | Verification loop |

---

## 6. Rules (13 categories, 78 files)

Located in `~/.claude/rules/`.

| Directory | Files | Languages/Topics |
|-----------|-------|------------------|
| `common/` | 9 | agents, code-review, coding-style, development-workflow, git-workflow, hooks, patterns, performance, security, testing |
| `zh/` | 10 | Chinese translations of common |
| `cpp/` | 5 | coding-style, hooks, patterns, security, testing |
| `csharp/` | 5 | coding-style, hooks, patterns, security, testing |
| `golang/` | 5 | coding-style, hooks, patterns, security, testing |
| `java/` | 5 | coding-style, hooks, patterns, security, testing |
| `kotlin/` | 5 | coding-style, hooks, patterns, security, testing |
| `perl/` | 5 | coding-style, hooks, patterns, security, testing |
| `php/` | 5 | coding-style, hooks, patterns, security, testing |
| `python/` | 5 | coding-style, hooks, patterns, security, testing |
| `rust/` | 5 | coding-style, hooks, patterns, security, testing |
| `swift/` | 5 | coding-style, hooks, patterns, security, testing |
| `typescript/` | 5 | coding-style, hooks, patterns, security, testing |
| Root | 2 | everything-claude-code-guardrails, node |

---

## 7. Global Settings

From `~/.claude/settings.json`:

| Setting | Value |
|---------|-------|
| `effortLevel` | `max` |
| `model` | `opus[1m]` (Claude Opus 4.6, 1M context) |

---

## Summary

| Component | Count (doc target) | Count (actually installed) |
|-----------|--------------------|----------------------------|
| MCP Servers | 7 configured | 10 active (`github`, `manus`, `telegram`, `2captcha`, `context7`, `playwright`, `chrome-devtools`, `sequential-thinking`, `memory`, `sentry`) |
| Hooks | 2 (PostToolUse + PreToolUse) | 2 ✓ |
| Agents | 30 | 48 (all 30 from doc + 18 extras) |
| Skills | 141 | 183 (all from doc + extras) |
| Commands | 66 | 80 (most from doc + extras; see § Discrepancies below) |
| Rule files | 78 (13 language packs) | matches |

### Discrepancies (doc → installed)

Commands listed in the doc but not present locally as exact names:

- `/add-language-rules` — missing
- `/database-migration` — missing
- `/feature-development` — installed as `feature-dev.md` (renamed)
- `/review` — installed as `review-pr.md` (renamed)
- `/test` — missing (covered by `/tdd`)

All 30 agents from the doc are installed.
