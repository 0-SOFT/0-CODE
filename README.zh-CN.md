<!-- tracks: README.md sha256:6be15af01675 -->

# 0-CODE

**版本:** v2.1.0

适用于 **Claude Code、Codex 和 OpenCode** 的自主开发循环，可集成到现有项目。一个循环提示词可以涵盖研究、实现、修复、审计和版本发布。

[English](README.md) · [中文](README.zh-CN.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md)

## 通过智能体集成

在项目的智能体会话中提出：**“从 https://github.com/0-SOFT/0-CODE 集成 0-CODE，并遵循其中的 `INTEGRATE.md`。”** 将公共源码检出到目标项目之外，可选择特定版本标签。同一份[简短模板](INTEGRATE.md)支持三个引擎的更新和卸载。

智能体盘点项目文档、工具、MCP 和检查命令，只解决真正的歧义，预览计划，安装，运行 doctor，并在独立分支提交。项目自身工具优先。[手动入门](QUICKSTART.md)。

## 安装内容

框架代码、配置、模式、模块和模板均位于 **`.0-code/`**。引擎只获得必需的原生钩子、指令、兼容工具条目及 OpenCode 防护插件。保留已有代码和文档；冲突及被修改的框架文件在写入之前报告。运行文件和备份放在 git 忽略的 `.0-code/run/` 中。

唯一的配置参考是 [PROJECT_SETTINGS](docs/PROJECT_SETTINGS.md)。可采用默认文档、覆盖单个角色，或将所有角色映射到项目既有约定。状态仍是机器可读文档。面向人的文档使用配置语言，智能体指令保持英文。

模型、推理强度和登录由所有者决定。配置优先级为 **显式参数 > 环境变量 > 项目配置 > 引擎原生偏好**。未指定的模型和推理强度继承原设置；绝不复制认证文件。参见[引擎配置](docs/ENGINE_SETTINGS.md)。

[公共工具目录](toolset/CATALOG.md)包含 **五个默认 MCP：context7、playwright、chrome-devtools、sequential-thinking 和 memory**。npm 包版本须不低于经过验证的 SemVer 下限，且包名和入口正确；保留符合要求的较新版本。无需外部 API 密钥；浏览器工具还需要可用浏览器。注册成功和 doctor 通过不代表已建立实际连接。私有技能、智能体、命令和规则的实现文件不包含在内。MCP 清单中的可选账户示例只有明确配置并授权后才启用。

默认采用**每用户一份独立安装**，供其项目共享。重复安装相同选择不会修改任何文件。project 范围可在单个项目固定不同选择。卸载项目保留机器工具；`uninstall-tools` 单独卸载它们并恢复原有原生配置。绝不复制认证文件。[配置与前置条件](docs/PROJECT_SETTINGS.md)。

## 2.1.0 的文档、迁移与所有权

新安装将九个文档角色放在 `.0-code/docs/`：`STATE.md`、`ROADMAP.md`、`reports/`、`decisions/`、`todo/`、`logs/`、`prompts/`、`prompts/templates/` 和 `userdocs/`。持久文档应提交到 Git；会话日志被忽略。日志也可放在 `.0-code/run/logs/`，持久角色不能使用运行时目录。显式外部角色仍受支持，普通 upgrade 保持现有路径。文档不属于所有权收据：doctor 接受它们，upgrade 保留它们，uninstall 保留文档及目录并删除运行时文件和备份。

迁移 2.0.x 的标准 `docs/*` 角色时，显式使用 `upgrade --relocate-documents <files.json>` 或 `migrate --relocate-documents <files.json>`，先加 `--dry-run`。审核精确文件列表；未列出的产品文档留在原处。配置、STATE 指针和选定模板会更新，被改写的原始字节会归档。自定义外部路径不变。迁移或接纳安装前，先完成循环、收集后台任务并停止驱动；活动锁或输入变化会导致拒绝。将移动一起暂存到 Git，以识别重命名。

没有收据的定制 `.0-code/` 安装可通过 `migrate --adopt-manifest <manifest.json>` 接纳，使用审核过的 SHA-256 和 `replace`/`preserve` 操作。只能保留精确列出的 `bin/`、`claude/` 和 `.0-code/README.md` 项目扩展；框架代码会替换并归档。扩展仍可编辑，upgrade/uninstall 会保留它们。未知文件或哈希不符会导致拒绝；接纳与文档迁移必须分开。替换生成的指引前，将自定义 AGENT 规则保存为文档，并通过 `instructions.project_rules` 引用。

Claude 可使用 `instructions.claude: session-hook` 而不写入 `CLAUDE.md`。设置 `instructions.claude_settings: .0-code/claude/settings.json` 可使用会话配置，保留启动器、MCP 和 system-prompt 文件。通过 `claude --settings .0-code/claude/settings.json` 启动；普通会话不会自动加载该文件。兼容设置保留原策略；外来 Stop/guard 钩子需要审核。Uninstall 恢复原设置。Doctor 检查本地钩子，不评估用户、managed 或 CLI 覆盖。[格式、命令和限制](docs/PROJECT_SETTINGS.md)。

2.1.0 的开发验收在 Windows 和 Node 24 上完成，未覆盖 Linux、macOS 或 Node 20/22；配置了 CI 矩阵并不证明已经执行。文件系统和覆盖率限制见[验证范围](docs/PROJECT_SETTINGS.md#validation-scope)。

## 使用与维护

在已安装的项目中：

```bash
node .0-code/tools/0code.mjs doctor --json
node .0-code/tools/0code.mjs start <cycle-prompt> --max 60
node /path/to/new-source/tools/0code.mjs upgrade --project . --dry-run
node .0-code/tools/0code.mjs uninstall --dry-run
```

填写唯一模板 `.0-code/templates/cycle.md`。`start` 原子更新状态并显示驱动命令。重启 Claude 以加载钩子；Codex 和 OpenCode 使用外部监督器。一个目录只有一个活动循环。迭代和费用限制需要主动设置；费用上限依赖监督器成本数据。长任务应登记在状态中，不要用 sleep 循环轮询。

公共源码支持新安装及 `.0-code/` 布局的升级。**旧版 1.x 在项目根目录中的安装无法自动迁移，除非源码包含 `config/legacy-installations.json`；公共树不包含此文件。** 只有源码具备来自已发布版本的所有权证据时，才运行 `migrate --dry-run`，再运行 `migrate`。只删除逐字节证明属于框架的文件和精确的自有块；文档原地保留，运行数据带备份迁移或归档。先结束仍在运行的旧循环；没有证据时保留旧文件，在修改前审查所有权。

[引擎配置](docs/ENGINE_SETTINGS.md)、[Claude 安装](CLAUDE_CODE_SETUP.md)、[开发指南](GUIDELINE.md)和[安全说明](SECURITY.md)介绍运行与验证。源码中运行 `node tests/run.mjs --coverage-min=80` 和 `bash tests/smoke.sh`；本地结果是证据，CI 是否可用是另一回事。
