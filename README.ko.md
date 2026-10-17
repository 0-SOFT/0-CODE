<!-- tracks: README.md sha256:3861ef6052d0 -->

# 0-CODE

**버전:** v2.0.4

기존 프로젝트에 통합하는 **Claude Code, Codex, OpenCode**용 자율 개발 사이클입니다. 하나의 사이클 지시에 조사, 구현, 수정, 감사, 릴리스 작업을 함께 담을 수 있습니다.

[English](README.md) · [中文](README.zh-CN.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md)

## 에이전트로 통합하기

프로젝트 에이전트에게 **“https://github.com/0-SOFT/0-CODE 에서 0-CODE를 통합하고 해당 `INTEGRATE.md`를 따르라”**고 요청하세요. 공개 소스는 대상 프로젝트 밖에 체크아웃하고 필요하면 릴리스 태그를 선택하세요. 같은 [짧은 템플릿](INTEGRATE.md)으로 세 엔진의 업데이트와 제거도 처리합니다.

에이전트는 문서, 도구, MCP, 검증 명령을 조사하고 실제 모호한 선택을 해결합니다. 계획을 보여 주고 설치한 뒤 doctor를 실행하고 별도 브랜치에 커밋합니다. 프로젝트 도구가 우선합니다. [수동 시작](QUICKSTART.md).

## 설치 내용

프레임워크 코드, 설정, 스키마, 모듈, 템플릿은 **`.0-code/`**에 있습니다. 엔진에는 필요한 네이티브 훅, 지시, 호환 도구 항목과 OpenCode 보호 플러그인만 설치합니다. 기존 코드와 문서는 보존하며 충돌이나 변경된 소유 파일은 쓰기 전에 알립니다. 실행 파일과 백업은 git에서 제외된 `.0-code/run/`에 둡니다.

설정의 유일한 참조 문서는 [PROJECT_SETTINGS](docs/PROJECT_SETTINGS.md)입니다. 기본 문서를 사용하거나 개별 역할을 바꾸거나 모든 역할을 기존 프로젝트 규칙에 연결할 수 있습니다. 상태는 기계 판독 가능한 문서로 유지합니다. 사람을 위한 문서는 설정 언어를 사용하고 에이전트 지시는 영어로 유지합니다.

모델, 추론 강도, 로그인은 소유자가 결정합니다. 설정 우선순위는 **명시적 옵션 > 환경 > 프로젝트 설정 > 엔진의 네이티브 설정**입니다. 지정하지 않은 모델과 추론 강도는 기존 설정을 상속하며 인증은 복사하지 않습니다. [엔진 설정](docs/ENGINE_SETTINGS.md)을 참조하세요.

[공개 목록](toolset/CATALOG.md)에는 **기본 MCP 다섯 개: context7, playwright, chrome-devtools, sequential-thinking, memory**가 있습니다. npm 패키지는 검증된 SemVer 최소 버전 이상이며 이름과 진입점이 올바라야 합니다. 조건에 맞는 더 최신 버전은 보존하세요. 외부 API 키는 필요 없으며 브라우저 도구에는 사용 가능한 브라우저도 필요합니다. 등록과 doctor 성공만으로 실제 연결을 입증하지는 않습니다. 비공개 스킬, 에이전트, 명령, 규칙의 구현 파일은 제외됩니다. MCP 매니페스트의 선택적 계정 서비스 예시는 명시적 설정과 인증 전까지 꺼져 있습니다.

기본은 프로젝트들이 공유하는 **사용자당 하나의 독립 설치**입니다. 같은 선택을 반복 설치해도 변경되지 않습니다. project 범위로 다른 선택을 프로젝트에 고정할 수 있습니다. 프로젝트 제거는 머신 도구를 남기며 `uninstall-tools`가 별도로 도구를 제거하고 원래 네이티브 설정을 복원합니다. 인증은 복사하지 않습니다. [설정과 사전 조건](docs/PROJECT_SETTINGS.md).

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
