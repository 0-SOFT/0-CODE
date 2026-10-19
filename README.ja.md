<!-- tracks: README.md sha256:6be15af01675 -->

# 0-CODE

**バージョン:** v2.1.0

既存プロジェクトに組み込む **Claude Code、Codex、OpenCode** 向けの自律開発サイクルです。ひとつのサイクル指示に調査、実装、修正、監査、リリース作業を含められます。

[English](README.md) · [中文](README.zh-CN.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md)

## エージェントで統合する

プロジェクトのエージェントに、**「https://github.com/0-SOFT/0-CODE から 0-CODE を統合し、その `INTEGRATE.md` に従って」**と依頼します。公開ソースを対象プロジェクトの外にチェックアウトし、必要ならリリースタグを指定します。同じ[短いテンプレート](INTEGRATE.md)で、三つのエンジンの更新と削除にも対応します。

エージェントは文書、ツール、MCP、検証コマンドを一覧化し、本当の曖昧さを解消して変更をプレビューします。その後インストール、doctor、専用ブランチへのコミットを行います。プロジェクトのツールが優先されます。[手動導入](QUICKSTART.md)。

## インストールされるもの

フレームワークのコード、設定、スキーマ、モジュール、テンプレートは **`.0-code/`** に配置します。エンジンには必須のネイティブフック、指示、互換ツールと OpenCode の保護プラグインのみを登録します。既存のコードと文書を保持し、衝突や変更された所有ファイルは書き込み前に報告します。実行時ファイルとバックアップは git 対象外の `.0-code/run/` に置きます。

設定の唯一の参照先は [PROJECT_SETTINGS](docs/PROJECT_SETTINGS.md) です。標準の文書を採用する、個別の役割を変える、既存のプロジェクト規約に全役割を対応付けることができます。状態は機械可読のままです。人向け文書は設定言語、エージェント指示は英語を使います。

モデル、推論の強度、ログインは所有者が決めます。設定の優先順位は **明示的なフラグ > 環境変数 > プロジェクト設定 > エンジンのネイティブ設定** です。未指定のモデルと推論の強度は既存設定を継承し、認証情報はコピーしません。[エンジン設定](docs/ENGINE_SETTINGS.md)を参照してください。

[公開カタログ](toolset/CATALOG.md)には **五つの標準 MCP：context7、playwright、chrome-devtools、sequential-thinking、memory** が含まれます。npm パッケージは検証済みの SemVer 最低バージョン以上で、名前とエントリーポイントが正しい必要があります。条件を満たす新しいバージョンは保持します。外部 API キーは不要ですが、ブラウザツールには利用可能なブラウザも必要です。登録や doctor の成功だけでは実際の接続を証明しません。非公開のスキル、エージェント、コマンド、ルールの実装ファイルは除外されています。MCP マニフェストの任意のアカウントサービス例は、明示的に設定し認証するまで無効です。

既定は**ユーザーごとに独立した一つのインストール**で、そのユーザーのプロジェクト間で共有します。同じ選択を再インストールしても変更しません。project スコープで別の選択をプロジェクトに固定できます。プロジェクトの削除ではマシンのツールを残し、`uninstall-tools` で別途削除して元のネイティブ設定を復元します。認証はコピーしません。[設定と前提条件](docs/PROJECT_SETTINGS.md)。

## 2.1.0 の文書、移行、所有権

新規インストールでは九つの文書ロールを `.0-code/docs/` に置きます。`STATE.md`、`ROADMAP.md`、`reports/`、`decisions/`、`todo/`、`logs/`、`prompts/`、`prompts/templates/`、`userdocs/` です。永続文書は Git に保存し、セッションログは除外します。ログには `.0-code/run/logs/` も使えますが、永続ロールには実行時領域を使えません。明示的な外部ロールは引き続き有効で、通常の upgrade は既存のパスを保持します。文書は所有権レシートの対象外です。doctor は受け入れ、upgrade は保持し、uninstall は文書とディレクトリを残して実行時ファイルとバックアップを削除します。

2.0.x の標準 `docs/*` ロールを移すには、`upgrade --relocate-documents <files.json>` または `migrate --relocate-documents <files.json>` を明示的に使い、最初に `--dry-run` で確認します。正確なファイル一覧を確認してください。未指定の製品文書は残ります。設定、STATE の参照、選択したテンプレートが更新され、変更前のバイト列は保存されます。独自の外部パスは変わりません。移動や受け入れ前にサイクルを完了し、バックグラウンド処理の結果を回収してドライバーを停止します。生きたロックや入力の変更は拒否されます。移動をまとめて Git に登録すると名前変更を検出できます。

レシートのない改変済み `.0-code/` は、確認済み SHA-256 と `replace`/`preserve` を記した `migrate --adopt-manifest <manifest.json>` で受け入れます。保持できるのは正確に列挙した `bin/`、`claude/`、`.0-code/README.md` のプロジェクト拡張のみで、コードは置換して保存します。拡張は編集でき、upgrade/uninstall 後も残ります。不明なファイルやハッシュ不一致は拒否され、受け入れと文書移動は別操作です。生成ガイドの置換前に独自の AGENT ルールを文書に保存し、`instructions.project_rules` で参照します。

Claude は `instructions.claude: session-hook` で `CLAUDE.md` に書き込まずに動作できます。`instructions.claude_settings: .0-code/claude/settings.json` を指定するとセッション設定を使え、ランチャー、MCP、system-prompt を保持できます。`claude --settings .0-code/claude/settings.json` で起動してください。通常のセッションは自動で読み込みません。互換設定はポリシーを保持し、外部の Stop/guard フックは検討が必要です。Uninstall は元の設定に戻します。Doctor はローカルフックを検証しますが、ユーザー・managed・CLI の上書きは評価しません。[形式、コマンド、制限](docs/PROJECT_SETTINGS.md)。

2.1.0 の開発時の受け入れ検証は Windows と Node 24 で実施しました。Linux、macOS、Node 20/22 は対象外で、CI マトリクスの設定だけでは実行の証拠になりません。ファイルシステムとカバレッジの制限は[検証範囲](docs/PROJECT_SETTINGS.md#validation-scope)を参照してください。

## 作業と保守

インストール済みプロジェクトから実行します。

```bash
node .0-code/tools/0code.mjs doctor --json
node .0-code/tools/0code.mjs start <cycle-prompt> --max 60
node /path/to/new-source/tools/0code.mjs upgrade --project . --dry-run
node .0-code/tools/0code.mjs uninstall --dry-run
```

唯一の `.0-code/templates/cycle.md` を記入します。`start` は状態を原子的に設定し、ドライバーの起動コマンドを表示します。フック読込みのため Claude を再起動します。Codex と OpenCode は外部スーパーバイザーを使います。一つのフォルダーで一つのサイクルを実行します。反復数と費用の上限は任意設定で、費用上限にはスーパーバイザーの費用データが必要です。長い作業は状態へ登録し、sleep ループで待機しません。

公開ソースは新規インストールと `.0-code/` 構造の更新に対応します。**プロジェクトのルートに配置された旧 1.x の自動移行には `config/legacy-installations.json` が必要ですが、このファイルは公開ツリーに含まれません。** 公開済みリリースの所有権証拠を含むソースでのみ `migrate --dry-run`、続いて `migrate` を使います。バイト単位で証明されたファイルと正確な所有ブロックだけを削除し、文書は保持します。実行時データはバックアップ付きで移動または保管します。実行中の旧サイクルを先に終了し、証拠がなければ旧ファイルを保持して変更前に所有権を確認してください。

[エンジン設定](docs/ENGINE_SETTINGS.md)、[Claude 設定](CLAUDE_CODE_SETUP.md)、[開発ガイド](GUIDELINE.md)、[セキュリティ](SECURITY.md)で運用と検証を説明しています。ソースで `node tests/run.mjs --coverage-min=80` と `bash tests/smoke.sh` を実行します。ローカル結果が証拠であり、CI の利用可否は別の問題です。
