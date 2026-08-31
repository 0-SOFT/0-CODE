#!/usr/bin/env bash
# bootstrap.sh — Bootstrap the Claude Code Autonomous Framework into a target project.
#
# Usage: bash /path/to/framework/bootstrap.sh [target-dir]
#
# Default target is current working directory. Conflict resolution is per-file
# (see § 3.H of docs/reports/0.0.2_skeleton-research.md):
#   - missing → create from template
#   - exists & identical → skip
#   - exists & different → backup, then merge or overwrite per-file policy.

set -uo pipefail

# --- Paths ---
FRAMEWORK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Framework version — single source of truth: .claude-plugin/plugin.json.
# The path is passed through argv (process.argv[1]) to rule out injection via special characters
# in the path. node is a mandatory dependency (checked below); if it is missing we fall back to
# a hard-coded version, and the dependency check stops bootstrap with a clear error anyway.
FRAMEWORK_VERSION="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version)" "$FRAMEWORK_ROOT/.claude-plugin/plugin.json" 2>/dev/null || echo "1.0.0")"
# Target project backend (v1.4.0). Found by audit: bootstrap used to prepare a project ONLY for
# Claude Code, so the claim "deploys into any project" was only half true — an OpenCode project
# was left without configuration, instructions or the arbiter plugin.
BACKEND="${AGENT_BACKEND:-claude}"
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --backend) BACKEND="$2"; shift 2 ;;
    --backend=*) BACKEND="${1#*=}"; shift ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
case "$BACKEND" in
  claude|opencode) : ;;
  *) echo "bootstrap: unknown backend: $BACKEND (available: claude, opencode)" >&2; exit 1 ;;
esac
TARGET_DIR="${ARGS[0]:-$(pwd)}"
# Create the target directory if it does not exist. Without this the `cd` below failed, TARGET_DIR
# became EMPTY and bootstrap wrote into `/` (a real bug, caught by a live run on a server).
mkdir -p "$TARGET_DIR" || { echo "bootstrap: cannot create the target directory: $TARGET_DIR" >&2; exit 1; }
TARGET_DIR="$(cd "$TARGET_DIR" && pwd)" || { echo "bootstrap: cannot enter the target directory: $TARGET_DIR" >&2; exit 1; }

if [ "$FRAMEWORK_ROOT" = "$TARGET_DIR" ]; then
  echo "bootstrap: target dir equals framework root. Refusing recursive bootstrap." >&2
  exit 1
fi

echo "==> Bootstrapping framework v$FRAMEWORK_VERSION"
echo "    from:  $FRAMEWORK_ROOT"
echo "    into:  $TARGET_DIR"
echo

# --- 1. Dependency check ---

missing=()
for cmd in node bash jq curl claude; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    missing+=("$cmd")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "bootstrap: missing required commands: ${missing[*]}" >&2
  echo "    Install:" >&2
  echo "      - node, bash, jq, curl: standard packages or Git for Windows" >&2
  echo "      - claude: npm install -g @anthropic-ai/claude-code" >&2
  exit 1
fi

# PM2 optional
if ! command -v pm2 >/dev/null 2>&1; then
  echo "==> PM2 not found. PM2 is optional (used for cross-session crash recovery)."
  if [ -t 0 ]; then
    read -r -p "    Install PM2 globally? [y/N] " yn
    case "$yn" in
      [Yy]*) npm install -g pm2 || echo "    PM2 install failed; continuing without it." ;;
      *) echo "    Skipping PM2." ;;
    esac
  else
    echo "    (non-interactive — skipping PM2 install; bootstrap continues)"
  fi
fi

# --- 2. Re-bootstrap guard ---

MARKER="$TARGET_DIR/.claude/.framework-version"
if [ -f "$MARKER" ]; then
  EXISTING="$(cat "$MARKER")"
  if [ "$EXISTING" = "$FRAMEWORK_VERSION" ]; then
    echo "==> Framework v$FRAMEWORK_VERSION already installed in target. Nothing to do."
    exit 0
  else
    echo "==> Framework v$EXISTING already installed — upgrading to v$FRAMEWORK_VERSION."
  fi
fi

# --- 3. Helpers ---

stamp() { date +%Y-%m-%dT%H-%M-%S; }

# Framework artefacts (hooks, lib/, core/, schemas, templates) must MATCH the framework version, so
# a differing copy is replaced — after a backup. The name says so: an earlier name, copy_if_missing,
# read as "only copies when absent" and was believed by at least one reader of the source.
copy_with_backup() {
  local src="$1"
  local dst="$2"
  if [ -f "$dst" ]; then
    if cmp -s "$src" "$dst"; then
      echo "    skip (identical):    $dst"
    else
      local bak="$dst.bak.$(stamp)"
      cp -a "$dst" "$bak"
      echo "    backup:              $dst -> $bak"
      cp -a "$src" "$dst"
      echo "    overwrite:           $dst"
      OVERWRITTEN="${OVERWRITTEN:-}  $dst -> $bak
"
    fi
  else
    mkdir -p "$(dirname "$dst")"
    cp -a "$src" "$dst"
    echo "    create:              $dst"
  fi
}

# Additive config files are MERGED, never replaced. A line in .gitignore is a statement the project
# made about itself; replacing the file deletes statements nobody asked to delete, and a backup does
# not help — a rule that lives only in .gitignore.bak protects nothing. In the incident behind
# v1.8.0 the deleted statement was the one hiding a file of root passwords, and the next commit
# picked them up.
#
# Existing lines are never touched, reordered or rewritten. Missing ones are appended under a header
# so the project can see what came from here. Comparison is per line, exactly like
# lib/ignore-policy.mjs does it, which also makes a repeated install add nothing.
merge_additive() {
  local src="$1"
  local dst="$2"
  if [ ! -f "$dst" ]; then
    mkdir -p "$(dirname "$dst")"
    cp -a "$src" "$dst"
    echo "    create:              $dst"
    return
  fi
  local missing="" line count=0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;                       # blanks and comments carry no rule
    esac
    if ! grep -qxF -- "$line" "$dst" 2>/dev/null; then
      missing="${missing}${line}
"
      count=$((count + 1))
    fi
  done < "$src"
  if [ "$count" -eq 0 ]; then
    echo "    already merged:      $dst (nothing to add)"
    return
  fi
  {
    printf '\n# --- added by 0-CODE bootstrap ---\n'
    printf '%s' "$missing"
  } >> "$dst"
  echo "    merged:              $dst (+$count rule(s), existing lines untouched)"
}

create_dir_if_missing() {
  local d="$1"
  if [ ! -d "$d" ]; then
    mkdir -p "$d"
    echo "    mkdir:               $d"
  fi
}

# --- 4. Copy hooks ---

create_dir_if_missing "$TARGET_DIR/hooks"
# The Stop hook wrapper (extensionless) plus every .mjs/.cmd (the hook logic lives in
# ralph-loop-stop.mjs, the polyglot wrapper in run-hook.cmd). hooks.json is NOT copied — it is
# only for plugin mode. A glob rather than a hard-coded list — the same root fix as for lib/.
copy_with_backup "$FRAMEWORK_ROOT/hooks/ralph-loop-stop" "$TARGET_DIR/hooks/ralph-loop-stop"
# Session logger (v0.5.6+): extensionless like ralph-loop-stop — launched through run-hook.cmd.
# It automatically saves the transcript into docs/logs/<date>/ on Stop and SessionEnd.
copy_with_backup "$FRAMEWORK_ROOT/hooks/save-session-log" "$TARGET_DIR/hooks/save-session-log"
# The protective PreToolUse hook (v0.6.0+): an extensionless wrapper plus safety-guard.mjs.
# It blocks irreversible commands — real protection while git operations run without prompts.

copy_with_backup "$FRAMEWORK_ROOT/hooks/safety-guard" "$TARGET_DIR/hooks/safety-guard"
for src in "$FRAMEWORK_ROOT"/hooks/*.mjs "$FRAMEWORK_ROOT"/hooks/*.cmd; do
  [ -f "$src" ] || continue
  copy_with_backup "$src" "$TARGET_DIR/hooks/$(basename "$src")"
done
chmod +x "$TARGET_DIR/hooks/ralph-loop-stop" "$TARGET_DIR/hooks/save-session-log" "$TARGET_DIR/hooks/safety-guard" "$TARGET_DIR/hooks/run-hook.cmd" 2>/dev/null || true

# CRLF→LF normalisation of the polyglot wrapper on POSIX (a finding: hooks in target projects
# failed silently). run-hook.cmd is stored with eol=crlf (.gitattributes is mandatory for Windows
# cmd.exe), BUT on Linux/macOS bash executes it, and bash chokes on CRLF: `$'\r': command not found`
# → every hook is dead. On Windows (MINGW/MSYS/CYGWIN) CRLF is required, so we leave it alone.
# We use tr rather than `sed -i` for portability (BSD sed on macOS behaves differently).
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) : ;;  # Windows: cmd.exe requires CRLF — skip
  *)
    for cmdfile in "$TARGET_DIR"/hooks/*.cmd; do
      [ -f "$cmdfile" ] || continue
      tmp="$cmdfile.lf.$$"
      tr -d '\r' < "$cmdfile" > "$tmp" && mv "$tmp" "$cmdfile" && chmod +x "$cmdfile" 2>/dev/null
      echo "    normalize LF:        $cmdfile"
    done
    ;;
esac

# --- 5. Copy lib ---

create_dir_if_missing "$TARGET_DIR/lib"
# Copy EVERY file in lib/ rather than a hard-coded list: otherwise a newly added module
# is easy to forget and the bootstrapped project fails with ERR_MODULE_NOT_FOUND.
# The root fix is a glob by file type.
for src in "$FRAMEWORK_ROOT"/lib/*.mjs "$FRAMEWORK_ROOT"/lib/*.sh "$FRAMEWORK_ROOT"/lib/*.ps1; do
  [ -f "$src" ] || continue
  copy_with_backup "$src" "$TARGET_DIR/lib/$(basename "$src")"
done
chmod +x "$TARGET_DIR/lib/telegram-notify.sh" 2>/dev/null || true

# --- 5a. Copy core (the agent-independent core) ---
# hooks/ralph-loop-stop.mjs imports ../core/gates.mjs and hooks/safety-guard.mjs imports
# ../core/safety.mjs. Without core/ BOTH hooks fail with ERR_MODULE_NOT_FOUND and exit with
# code 0 — that is, SILENTLY: the Stop hook returns no decision:block and the target project has
# no autonomous loop at all, while bootstrap still reports success.
# A glob rather than a hard-coded list — for the same reason as lib/ above.
create_dir_if_missing "$TARGET_DIR/core"
for src in "$FRAMEWORK_ROOT"/core/*.mjs; do
  [ -f "$src" ] || continue
  copy_with_backup "$src" "$TARGET_DIR/core/$(basename "$src")"
done
if [ -d "$FRAMEWORK_ROOT/core/backends" ]; then
  create_dir_if_missing "$TARGET_DIR/core/backends"
  for src in "$FRAMEWORK_ROOT"/core/backends/*.mjs; do
    [ -f "$src" ] || continue
    copy_with_backup "$src" "$TARGET_DIR/core/backends/$(basename "$src")"
  done
fi

# --- 5b. Root config dotfiles (.gitignore, .gitattributes) ---
# Without them the bootstrapped project is exposed: no .gitignore means .env can reach git;
# no .gitattributes means bash scripts get CRLF on a Linux checkout and break (the same root
# cause as above, but for target projects).
#
# These two are MERGED, not copied. The comment that used to stand here claimed copy_if_missing
# "never overwrites existing files" — it always did, after a backup, and this was the most dangerous
# place to be wrong about it: a project that already had its own .gitignore lost the rules that were
# only in it. Of all the call sites in this script these are the only additive files; the rest are
# framework artefacts that must match the framework version.
# The .gitignore handed to a target project comes from templates/gitignore.public when it exists
# (the canonical, publishable version) and falls back to the framework root otherwise.
GITIGNORE_SRC="$FRAMEWORK_ROOT/templates/gitignore.public"
[ -f "$GITIGNORE_SRC" ] || GITIGNORE_SRC="$FRAMEWORK_ROOT/.gitignore"
merge_additive "$GITIGNORE_SRC"                 "$TARGET_DIR/.gitignore"
merge_additive "$FRAMEWORK_ROOT/.gitattributes" "$TARGET_DIR/.gitattributes"

# --- 6. Copy schemas ---

create_dir_if_missing "$TARGET_DIR/docs/schemas"
copy_with_backup "$FRAMEWORK_ROOT/docs/schemas/STATE.schema.json" "$TARGET_DIR/docs/schemas/STATE.schema.json"
copy_with_backup "$FRAMEWORK_ROOT/docs/schemas/tools-catalog.schema.json" "$TARGET_DIR/docs/schemas/tools-catalog.schema.json"

# --- 6b. Seed tools-catalog.json (v0.5.5+): persistent MCP capability catalog ---
# An empty catalogue; the orchestrator fills it during planning and on every MCP re-check.
CATALOG_DST="$TARGET_DIR/docs/tools-catalog.json"
if [ ! -f "$CATALOG_DST" ]; then
  cat > "$CATALOG_DST" <<'EOF'
{
  "schema_version": 1,
  "updated_at": null,
  "mcps": []
}
EOF
  echo "    create:              $CATALOG_DST"
else
  echo "    skip (exists):       $CATALOG_DST"
fi

# --- 7. Copy framework-local orchestrator-wrapper skill ---

create_dir_if_missing "$TARGET_DIR/.claude/skills/orchestrator-wrapper"
copy_with_backup \
  "$FRAMEWORK_ROOT/skills/orchestrator-wrapper/SKILL.md" \
  "$TARGET_DIR/.claude/skills/orchestrator-wrapper/SKILL.md"

# --- 8. CLAUDE.md (append-with-markers if exists) ---

PROJECT_NAME="$(basename "$TARGET_DIR")"
CLAUDE_MD_TPL="$FRAMEWORK_ROOT/templates/project-CLAUDE.md"
CLAUDE_MD_DST="$TARGET_DIR/CLAUDE.md"

# Render template (substitute __PROJECT_NAME__ and __FRAMEWORK_VERSION__)
RENDERED_CLAUDE="$(sed -e "s|__PROJECT_NAME__|$PROJECT_NAME|g" -e "s|__FRAMEWORK_VERSION__|$FRAMEWORK_VERSION|g" "$CLAUDE_MD_TPL")"

if [ -f "$CLAUDE_MD_DST" ]; then
  if grep -q "BEGIN AUTONOMOUS FRAMEWORK" "$CLAUDE_MD_DST"; then
    # Replace the marked block
    awk -v new="$RENDERED_CLAUDE" '
      BEGIN { in_block=0 }
      /<!-- BEGIN AUTONOMOUS FRAMEWORK -->/ { print "<!-- BEGIN AUTONOMOUS FRAMEWORK -->"; print new; in_block=1; next }
      /<!-- END AUTONOMOUS FRAMEWORK -->/ { print "<!-- END AUTONOMOUS FRAMEWORK -->"; in_block=0; next }
      !in_block { print }
    ' "$CLAUDE_MD_DST" > "$CLAUDE_MD_DST.tmp.$$"
    mv "$CLAUDE_MD_DST.tmp.$$" "$CLAUDE_MD_DST"
    echo "    refresh (marker):    $CLAUDE_MD_DST"
  else
    bak="$CLAUDE_MD_DST.bak.$(stamp)"
    cp -a "$CLAUDE_MD_DST" "$bak"
    echo "    backup:              $CLAUDE_MD_DST -> $bak"
    {
      cat "$CLAUDE_MD_DST"
      echo
      echo "<!-- BEGIN AUTONOMOUS FRAMEWORK -->"
      echo "$RENDERED_CLAUDE"
      echo "<!-- END AUTONOMOUS FRAMEWORK -->"
    } > "$CLAUDE_MD_DST.tmp.$$"
    mv "$CLAUDE_MD_DST.tmp.$$" "$CLAUDE_MD_DST"
    echo "    append (markers):    $CLAUDE_MD_DST"
  fi
else
  {
    echo "<!-- BEGIN AUTONOMOUS FRAMEWORK -->"
    echo "$RENDERED_CLAUDE"
    echo "<!-- END AUTONOMOUS FRAMEWORK -->"
  } > "$CLAUDE_MD_DST"
  echo "    create:              $CLAUDE_MD_DST"
fi

# --- 9. .claude/settings.json (deep-merge) ---

# Path prefix for the Stop hook. A ROOT FIX (v0.5.3): in headless mode (`claude -p`, under a
# process manager) claude does NOT expand ${CLAUDE_PROJECT_DIR} inside the hook command → the path
# breaks → the hook is silently never called → no autonomous loop (proven on a server). On POSIX we
# substitute the absolute project path (reliable in every mode). On Windows we keep
# ${CLAUDE_PROJECT_DIR} (it works interactively there, and an absolute Git Bash path /c/... would
# break launching .cmd through cmd.exe; unattended runs on Windows are unsupported anyway).
# On POSIX we also add a `bash` prefix: run-hook.cmd is a polyglot without a shebang, so on Linux
# it cannot be exec'd directly (ENOEXEC) and needs an explicit interpreter. On Windows `.cmd` is
# launched by cmd.exe itself (which finds Git Bash), so no bash prefix is needed there.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) HOOK_PREFIX='${CLAUDE_PROJECT_DIR}' ;;
  *)                    HOOK_PREFIX="bash $TARGET_DIR" ;;
esac

create_dir_if_missing "$TARGET_DIR/.claude"
SETTINGS_TPL="$FRAMEWORK_ROOT/templates/project-settings.json"
SETTINGS_DST="$TARGET_DIR/.claude/settings.json"

if [ -f "$SETTINGS_DST" ]; then
  bak="$SETTINGS_DST.bak.$(stamp)"
  cp -a "$SETTINGS_DST" "$bak"
  echo "    backup:              $SETTINGS_DST -> $bak"

  # Deep merge via Node (one-shot, no dependencies). Paths are passed through argv to rule out
  # injection via special characters (', \, newline) inside the path.
  node -e '
    const fs = require("fs");
    const dst = process.argv[1], tpl = process.argv[2], tmp = process.argv[3];
    const a = JSON.parse(fs.readFileSync(dst, "utf8"));
    const b = JSON.parse(fs.readFileSync(tpl, "utf8"));
    function merge(t, s) {
      if (typeof s !== "object" || s === null) return s;
      if (Array.isArray(s)) {
        if (!Array.isArray(t)) return [...s];
        const seen = new Set(t.map(x => JSON.stringify(x)));
        const out = [...t];
        for (const x of s) {
          const k = JSON.stringify(x);
          if (!seen.has(k)) { seen.add(k); out.push(x); }
        }
        return out;
      }
      const out = { ...(t || {}) };
      for (const k of Object.keys(s)) {
        const sv = s[k]; const tv = out[k];
        if (sv && typeof sv === "object" && tv && typeof tv === "object") out[k] = merge(tv, sv);
        else out[k] = sv;
      }
      return out;
    }
    delete b["$schema_comment"];
    const merged = merge(a, b);
    const hookPrefix = process.argv[4];
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2).split("${CLAUDE_PROJECT_DIR}").join(hookPrefix));
  ' "$SETTINGS_DST" "$SETTINGS_TPL" "$SETTINGS_DST.tmp.$$" "$HOOK_PREFIX"
  mv "$SETTINGS_DST.tmp.$$" "$SETTINGS_DST"
  echo "    merge:               $SETTINGS_DST"
else
  # Just copy minus the $schema_comment (paths through argv)
  node -e '
    const fs = require("fs");
    const b = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    delete b["$schema_comment"];
    const hookPrefix = process.argv[3];
    fs.writeFileSync(process.argv[2], JSON.stringify(b, null, 2).split("${CLAUDE_PROJECT_DIR}").join(hookPrefix));
  ' "$SETTINGS_TPL" "$SETTINGS_DST" "$HOOK_PREFIX"
  echo "    create:              $SETTINGS_DST"
fi

# --- 10. PM2 ecosystem ---

PM2_TPL="$FRAMEWORK_ROOT/templates/pm2-ecosystem.json"
PM2_DST="$TARGET_DIR/ecosystem.json"
# We do NOT substitute cwd: the process manager takes the working directory from wherever
# `pm2 start ecosystem.json` was launched (cross-platform; a Git Bash path /c/... used to be
RENDERED_PM2="$(sed -e "s|__PROJECT_NAME__|$PROJECT_NAME|g" "$PM2_TPL")"

if [ -f "$PM2_DST" ]; then
  if echo "$RENDERED_PM2" | cmp -s - "$PM2_DST"; then
    echo "    skip (identical):    $PM2_DST"
  else
    bak="$PM2_DST.bak.$(stamp)"
    cp -a "$PM2_DST" "$bak"
    echo "    backup:              $PM2_DST -> $bak"
    echo "$RENDERED_PM2" > "$PM2_DST"
    echo "    overwrite:           $PM2_DST"
  fi
else
  echo "$RENDERED_PM2" > "$PM2_DST"
  echo "    create:              $PM2_DST"
fi

# --- 11. docs/ subtree (STATE, ROADMAP placeholders) ---

create_dir_if_missing "$TARGET_DIR/docs/prompts/templates"
create_dir_if_missing "$TARGET_DIR/docs/reports"
create_dir_if_missing "$TARGET_DIR/docs/todo"
create_dir_if_missing "$TARGET_DIR/docs/logs"

# Copy prompt templates (always, they're framework artifacts)
for t in research.md update.md audit_architecture.md audit_codebase.md audit_frontend.md audit_tests.md testing.md guideline.md; do
  if [ -f "$FRAMEWORK_ROOT/docs/prompts/templates/$t" ]; then
    copy_with_backup "$FRAMEWORK_ROOT/docs/prompts/templates/$t" "$TARGET_DIR/docs/prompts/templates/$t"
  fi
done

# STATE.md — only create if missing (never overwrite a working state)
STATE_DST="$TARGET_DIR/docs/STATE.md"
if [ ! -f "$STATE_DST" ]; then
  TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cat > "$STATE_DST" <<EOF
---
schema_version: 1
project_name: "$PROJECT_NAME"
current_stage: 0
current_version: "0.0.1"
previous_version: null
current_prompt_index: 0
current_prompt_file: null
last_action_at: "$TS"
last_action: "bootstrapped"
last_session_id: null
blockers: []
required_tools: []
open_findings: []
audit_cycle: null
verification_pending: false
session_count: 0
iteration: 0
# Limits are opt-in (v1.9.0). A project is born without an iteration cap and without a spending
# cap: whoever wants a limit sets one, rather than a number nobody chose standing in the way.
#
# The price, recorded openly rather than softened. The v1.4.0 audit found that ANY claude launch
# inside a project folder joins the loop, so with no cap an accidental probe runs unbounded. With
# limits off, exactly two things stop the loop: a blocker, and released_version == current_version.
# What remains visible is the silence watchdog (v1.8.0): it does not stop anything, but a state
# file that stops changing is reported in every continuation.
#
# To set a limit, write a positive number here (and cap_usd below for spending):
#   max_iterations: 25
max_iterations: null
progress_metrics:
  last_3_sessions_diff_lines: []
  last_3_sessions_test_diff: []
budget_metrics:
  version_cost_usd: 0
  cap_usd: null
framework_version: "$FRAMEWORK_VERSION"
next_step_prompt: "This is the initialisation step. Start stage 0 — goal setting. Read the project brief in docs/userdocs/ (if present), ask the user the clarifying questions you need, and fill in docs/ROADMAP.md."
# The passport of the instruction above (v1.7.0). lib/update-state.mjs mints it on every write;
# a project born without one would start out "unverified" and rely on a weaker heuristic, so the
# very first instruction gets its passport here. Never edit this block by hand.
next_step_prompt_meta:
  version: "0.0.1"
  stage: 0
  prompt_file: null
  at: "$TS"
---

# Journal

- $TS — bootstrapped from framework v$FRAMEWORK_VERSION.
EOF
  echo "    create:              $STATE_DST"
else
  echo "    skip (exists):       $STATE_DST"
fi

# ROADMAP.md — create only if missing
ROADMAP_DST="$TARGET_DIR/docs/ROADMAP.md"
if [ ! -f "$ROADMAP_DST" ]; then
  cat > "$ROADMAP_DST" <<EOF
# ROADMAP — $PROJECT_NAME

> This ROADMAP will be filled in automatically during stage 0 (goal setting),
> based on your project brief.
>
> Until then it is a placeholder.

## v0.0.1 — TBD

- **Goal:** to be determined during stage 0.
- **Status:** \`planned\`
EOF
  echo "    create:              $ROADMAP_DST"
else
  echo "    skip (exists):       $ROADMAP_DST"
fi

# --- 12. Marker ---

mkdir -p "$TARGET_DIR/.claude"
echo "$FRAMEWORK_VERSION" > "$TARGET_DIR/.claude/.framework-version"
echo "    create:              $TARGET_DIR/.claude/.framework-version"

# --- 13. Telegram (optional, soft) ---

if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  "$TARGET_DIR/lib/telegram-notify.sh" \
    "Bootstrap v$FRAMEWORK_VERSION" \
    "Project: $PROJECT_NAME at $TARGET_DIR" 2>/dev/null || true
fi

# --- 14. Quick-start hint ---

# --- Being honest about notifications (v1.5.0) ---
# WHY: the v1.3.0 blocker never reached the user — the Telegram variables were unset and the
# notification script silently sent nothing. The human only learned about the stop by asking.
# A system staying silent about its own silence is the worst kind of silence.
echo ""
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  echo "Notifications: ENABLED — you will get a Telegram message when the loop stops."
else
  echo "Notifications: DISABLED. When the loop stops (blocker, iteration limit, budget cap)"
  echo "  you will NOT be notified — you will have to check docs/STATE.md yourself."
  echo "  To enable: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the environment."
fi

# --- Provisioning the selected backend (v1.4.0) ---
if [ "$BACKEND" = "opencode" ]; then
  echo ""
  echo "OpenCode backend: preparing opencode.json, AGENTS.md and the arbiter plugin..."
  if node "$FRAMEWORK_ROOT/tools/provision-opencode.mjs" --target "$TARGET_DIR"; then
    echo "  The OpenCode loop is driven by the external supervisor (it has no Stop hook):"
    echo "    AGENT_BACKEND=opencode node \"$FRAMEWORK_ROOT/core/supervisor.mjs\" --state docs/STATE.md"
  else
    echo "  ! OpenCode provisioning failed — the project is deployed but the backend is not configured" >&2
  fi
fi

echo
echo "==> Bootstrap complete."
echo
# Replacing a file the project already had is the one action here a person may need to undo, and it
# used to be visible only as a single line inside a hundred and fifty of output. It gets its own
# block. Nothing is listed when nothing was replaced, so the block cannot become noise.
if [ -n "${OVERWRITTEN:-}" ]; then
  echo "The following existing files were REPLACED with the framework version:"
  printf '%s' "$OVERWRITTEN"
  echo "  (a .bak copy is kept next to each; .gitignore and .gitattributes are never replaced,"
  echo "   they are merged, so your own rules stay where they are)"
  echo
fi
# The closing instructions are the first thing a new user follows, so they must match the backend
# that was actually installed. This block used to say "Start Claude Code" even after
# `--backend opencode` — pointing the user at the wrong engine on their very first step.
echo "Next steps:"
echo "  1) cd into the project directory."
if [ "$BACKEND" = "opencode" ]; then
  echo "  2) Put a real task in docs/STATE.md → next_step_prompt."
  echo "  3) Start the loop from outside the session:"
  echo "       AGENT_BACKEND=opencode node core/supervisor.mjs --state docs/STATE.md"
  echo "     (OPENROUTER_API_KEY must be set. The supervisor runs a short self-check first.)"
elif [ -n "${CLAUDECODE:-}" ] || [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; then
  # Installed from INSIDE a running Claude Code session. Claude Code reads .claude/settings.json
  # when a session STARTS: the hooks are now in the file but not in the process, and the loop is not
  # running. Announcing "the Ralph Loop is now active" here was false in exactly the situation where
  # the framework matters most — a project begun without the loop, where somebody realised half-way
  # through. Reported from a live project after a six-hour idle: the agent finished a turn, nothing
  # brought it back, and the human believed the loop was watching.
  #
  # The marker is CLAUDECODE, the same one core/backend-factory.mjs already trusts to recognise this
  # engine. CLAUDE_PROJECT_DIR was the other candidate and was rejected by measurement: Claude Code
  # substitutes it into hook command strings but does not export it to the environment of commands
  # the agent runs, so a check on it would never fire.
  #
  # The exit code stays 0 on purpose. The installation genuinely succeeded; failing it would break
  # scripted installs and the suite's own end-to-end check, and would trade a false success message
  # for a false failure. Visibility is bought with a block nobody can scroll past instead.
  IN_SESSION=1
  echo "  2) Leave this session:  /exit"
  echo "  3) Return to it:        claude --continue"
  echo "  4) From that point the Ralph Loop runs by itself."
else
  echo "  2) Start Claude Code: claude"
  echo "  3) The Ralph Loop is now active. Give an initial prompt or wait"
  echo "     for the orchestrator-wrapper skill to take over."
fi

cat <<'EOF'

If PM2 is installed:
  pm2 start ecosystem.json

If you want cross-session crash recovery, see README.md for PM2
service setup (pm2-windows-service or systemd).

No tooling (MCP servers, skills, agents, commands, rules) on this machine?
Deploy the toolset once: bash <framework>/provision-toolset.sh
(then provision-toolset.sh --verify for a report). See README.

EOF

# The warning goes LAST, after every other closing block. Printed in the middle of the summary it
# would be true and useless: a live run showed three more sections scrolling past underneath it,
# and the one thing the reader must not miss is that the loop is not running yet.
if [ -n "${IN_SESSION:-}" ]; then
  cat <<'EOF'
!! ATTENTION: this install ran INSIDE a running Claude Code session.
   The hooks are written to .claude/settings.json, but they are NOT loaded:
   settings are read when a session starts, so this session does not have them.
   THE LOOP IS NOT RUNNING YET.

   Restart it:  /exit    then:  claude --continue

EOF
fi

exit 0
