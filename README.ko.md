<!-- tracks: README.md sha256:dc67310727a4 -->

# 0-CODE

**버전:** v2.1.1

기존 프로젝트에 통합하는 **Claude Code, Codex, OpenCode**용 자율 개발 사이클입니다. 하나의 사이클 지시에 조사, 구현, 수정, 감사, 릴리스 작업을 함께 담을 수 있습니다.

[English](README.md) · [中文](README.zh-CN.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md)

## 에이전트로 통합하기

프로젝트 에이전트에게 **“https://github.com/0-SOFT/0-CODE 에서 0-CODE를 통합하고 해당 `INTEGRATE.md`를 따르라”**고 요청하세요. 공개 소스는 대상 프로젝트 밖에 체크아웃하고 필요하면 릴리스 태그를 선택하세요. 같은 [짧은 템플릿](INTEGRATE.md)으로 세 엔진의 업데이트와 제거도 처리합니다.

에이전트는 문서, 도구, MCP, 검증 명령을 조사하고 실제 모호한 선택을 해결합니다. 계획을 보여 주고 설치한 뒤 doctor를 실행하고 별도 브랜치에 커밋합니다. 프로젝트 도구가 우선합니다. [수동 시작](QUICKSTART.md).

## 설치 내용

프레임워크 코드, 설정, 스키마, 모듈과 기본 템플릿은 **`.0-code/`**에 있습니다. 프로젝트가 소유하는 주기 문서는 **`.0-code/docs/`**, 실행 파일과 백업은 Git에서 제외하는 **`.0-code/run/`**에 둡니다. 일반 통합은 선택한 엔진에 필요한 네이티브 훅, 지시, 호환 도구 및 OpenCode 보호 플러그인을 추가합니다. 아래의 격리 Claude 세션은 자체 통합을 `.0-code/` 내부에 유지합니다. 기존 코드와 문서를 보존하며 충돌과 변경된 소유 파일은 쓰기 전에 알립니다.

설정의 유일한 참조 문서는 [PROJECT_SETTINGS](docs/PROJECT_SETTINGS.md)입니다. 기본 문서를 사용하거나 개별 역할을 바꾸거나 모든 역할을 기존 프로젝트 규칙에 연결할 수 있습니다. 상태는 기계 판독 가능한 문서로 유지합니다. 사람을 위한 문서는 설정 언어를 사용하고 에이전트 지시는 영어로 유지합니다.

모델, 추론 강도, 로그인은 소유자가 결정합니다. 설정 우선순위는 **명시적 옵션 > 환경 > 프로젝트 설정 > 엔진의 네이티브 설정**입니다. 지정하지 않은 모델과 추론 강도는 기존 설정을 상속하며 인증은 복사하지 않습니다. [엔진 설정](docs/ENGINE_SETTINGS.md)을 참조하세요.

[공개 목록](toolset/CATALOG.md)에는 **기본 MCP 다섯 개: context7, playwright, chrome-devtools, sequential-thinking, memory**가 있습니다. npm 패키지는 검증된 SemVer 최소 버전 이상이며 이름과 진입점이 올바라야 합니다. 조건에 맞는 더 최신 버전은 보존하세요. 외부 API 키는 필요 없으며 브라우저 도구에는 사용 가능한 브라우저도 필요합니다. 등록과 doctor 성공만으로 실제 연결을 입증하지는 않습니다. 비공개 스킬, 에이전트, 명령, 규칙의 구현 파일은 제외됩니다. MCP 매니페스트의 선택적 계정 서비스 예시는 명시적 설정과 인증 전까지 꺼져 있습니다.

도구의 기본값은 사용자의 프로젝트가 공유하는 **사용자별 독립 설치 한 개**입니다. 같은 선택을 다시 설치해도 바뀌지 않습니다. project 범위로 프로젝트에 다른 구성을 고정할 수 있습니다. 격리 Claude의 install/upgrade/migrate는 사용자 도구를 자동 설치하지 않으므로, 별도로 명시적으로 요청한 `install-tools`가 필요합니다. 프로젝트를 제거해도 시스템 도구는 남으며, `uninstall-tools`가 별도로 제거하고 원래 설정을 복원합니다. 인증 정보는 복사하지 않습니다. [설정과 사전 요구 사항](docs/PROJECT_SETTINGS.md).

## 2.1.1의 문서, 이전 및 세션 격리

새 설치는 아홉 문서 역할을 `.0-code/docs/` 아래에 둡니다: `STATE.md`, `ROADMAP.md`, `reports/`, `decisions/`, `todo/`, `logs/`, `prompts/`, `prompts/templates/`, `userdocs/`. 영구 문서는 Git에 저장하고 세션 로그는 제외합니다. 로그는 `.0-code/run/logs/`에도 둘 수 있지만 영구 역할에는 런타임 영역을 사용할 수 없습니다. 명시적 외부 역할은 계속 지원하며 일반 upgrade는 기존 경로를 유지합니다. 문서는 소유권 영수증에 포함되지 않습니다. doctor는 이를 허용하고 upgrade는 보존하며 uninstall은 문서와 디렉터리를 남기고 런타임 및 백업을 삭제합니다.

2.0.x의 표준 `docs/*` 역할은 `upgrade --relocate-documents <files.json>` 또는 `migrate --relocate-documents <files.json>`으로 명시적으로 이전하며 먼저 `--dry-run`을 사용합니다. 정확한 파일 목록을 검토하세요. 목록에 없는 제품 문서는 그대로 남습니다. 설정, STATE 참조 및 선택한 템플릿을 갱신하고 변경 전 바이트를 보관합니다. 사용자 지정 외부 경로는 유지됩니다. 이전이나 설치 인수 전에 주기를 완료하고 백그라운드 작업 결과를 수집한 뒤 드라이버를 중지하세요. 활성 잠금이나 입력 변경은 거부됩니다. 이동을 함께 Git에 스테이징하면 이름 변경을 인식할 수 있습니다.

영수증 없는 수정된 `.0-code/` 설치는 검토한 SHA-256 및 `replace`/`preserve` 동작을 담은 `migrate --adopt-manifest <manifest.json>`으로 인수합니다. 정확히 나열한 `bin/`, `claude/`, `.0-code/README.md` 프로젝트 확장만 보존할 수 있으며 프레임워크 코드는 교체하고 보관합니다. 확장은 편집 가능하며 upgrade/uninstall 후에도 남습니다. 알 수 없는 파일이나 해시 불일치는 거부하며 인수와 문서 이전은 별도 작업입니다. 생성된 가이드를 교체하기 전에 자체 AGENT 규칙을 문서로 저장하고 `instructions.project_rules`로 참조하세요.

Claude 격리 세션에는 `instructions.claude: session-hook`과 `instructions.claude_settings: .0-code/claude/settings.json`이 모두 필요합니다. Claude만 선택하고 문서 역할이 내부에 있으면 install, upgrade, migrate와 설치 인수는 `.claude/`, `.mcp.json`, `CLAUDE.md`를 포함해 선택하지 않은 외부 쓰기, 삭제 또는 복구 변경을 수행하지 않습니다. 명시적 외부 문서 역할, 별도로 선택한 엔진, 따로 요청한 `install-tools`는 각 범위에 한정된 예외입니다. 이전 소유권 기록과 트랜잭션 로그는 외부 정리를 허용하지 않습니다. 정리가 필요한 전환은 쓰기 전에 거부되며 이전 모드에서 검토한 정리가 필요합니다. 일반 `project-file` 통합과 `.claude/settings.json`을 사용하는 `session-hook`은 네이티브 제공 동작을 유지합니다.

`claude --settings .0-code/claude/settings.json` 또는 이 파일을 전달하는 검토된 실행기로 시작하세요. SessionStart와 SubagentStart는 `.0-code/AGENT.md`를 통해 내부 오케스트레이터와 활성화된 감사 절차의 소스를 제공합니다. 네이티브 슬래시 명령은 등록하지 않습니다. `modules.audits: false`이면 감사 소스와 참조가 없습니다. 안전한 텍스트 도구는 참조로 제공할 수 있지만, 이 방법으로 제공할 수 없는 네이티브 실행 제어와 새 MCP 등록은 `unsupported`로 보고합니다. 보존한 실행기, MCP, system-prompt와 설정 정책은 유지하고 호환 설정에는 프레임워크 항목을 추가하며 uninstall은 원래 값을 복원합니다. 일반 세션은 이 파일을 자동 로드하지 않습니다. Doctor는 로컬 훅을 확인하며 사용자, 관리 설정 또는 CLI 재정의는 평가하지 않습니다. [형식, 명령 및 제한](docs/PROJECT_SETTINGS.md).

실제로 검증한 플랫폼, Node 버전, 파일 시스템 제한과 커버리지 기준은 [검증 범위](docs/PROJECT_SETTINGS.md#validation-scope)에 기록합니다. CI 매트릭스를 설정한 사실만으로 실행을 입증할 수는 없습니다.

## 작업과 유지보수

설치된 프로젝트에서 실행하세요.

```bash
node .0-code/tools/0code.mjs doctor --json
node .0-code/tools/0code.mjs start <cycle-prompt> --max 60
node /path/to/new-source/tools/0code.mjs upgrade --project . --dry-run
node .0-code/tools/0code.mjs uninstall --dry-run
```

유일한 `.0-code/templates/cycle.md`를 작성하세요. `start`는 상태를 원자적으로 설정하고 드라이버 명령을 출력합니다. 새 훅을 읽도록 Claude를 재시작하며 Codex와 OpenCode는 외부 감독기를 사용합니다. 폴더 하나에 활성 사이클 하나를 실행합니다. 반복과 비용 제한은 선택 사항이며 비용 제한에는 감독기의 비용 데이터가 필요합니다. 긴 작업은 상태에 등록하고 sleep 반복문으로 기다리지 마세요.

공개 소스는 새 설치와 `.0-code/` 구조의 업데이트를 지원합니다. **프로젝트 루트에 설치된 이전 1.x의 자동 이전은 `config/legacy-installations.json` 없이는 사용할 수 없습니다. 이 파일은 공개 트리에서 제외됩니다.** 공개 릴리스의 소유권 증거를 포함하는 소스에서만 `migrate --dry-run` 후 `migrate`를 실행하세요. 바이트 단위로 입증된 파일과 정확한 소유 블록만 제거하며 문서는 보존하고 실행 데이터는 백업과 함께 옮기거나 보관합니다. 실행 중인 이전 사이클을 먼저 종료하세요. 증거가 없으면 기존 파일을 보존하고 변경 전에 소유권을 확인하세요.

[엔진 설정](docs/ENGINE_SETTINGS.md), [Claude 설정](CLAUDE_CODE_SETUP.md), [개발 안내](GUIDELINE.md), [보안](SECURITY.md)이 운영과 검증을 설명합니다. 소스에서 `node tests/run.mjs --coverage-min=80`과 `bash tests/smoke.sh`를 실행하세요. 로컬 결과가 증거이며 CI 이용 가능 여부는 별개입니다.
