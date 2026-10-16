#!/usr/bin/env bash
# cloud-setup.sh — setup script for a Claude Code cloud environment (claude.ai/code).
#
# Paste its body into the environment's "Setup script" field once; every cloud session in that
# environment then starts with the same toolset, whatever repository it opens:
#   1) the framework itself, cloned (or refreshed) into $ZERO_CODE_DIR;
#   2) command-line tools the audits and gates rely on (best effort — a missing one is reported,
#      never fatal: a setup script that fails costs the whole session);
#   3) provision-toolset.sh: skills/agents/commands/rules into ~/.claude, local MCP servers from
#      the selected catalog. Owner account tools are disabled by default; project cycle hooks stay in projects.
#
# Variables it reads (all optional):
#   ZERO_CODE_REPO   framework repository  (default: the public https://github.com/0-SOFT/0-CODE.git)
#   ZERO_CODE_REF    branch or tag         (default: the repository's default branch)
#   ZERO_CODE_DIR    where to put it       (default: $HOME/.0-code)
#   GITHUB_TOKEN     read token, needed only if the framework repository is private
#   CODEX_API_KEY    Codex API credential, read later by its supervisor, never copied to files
#   CLOUD_SETUP_SKIP_TOOLS=1   skip step 2 (faster start when the tools are not needed)
#
# What to expect, measured on 2026-10-05: about three and a half minutes from scratch, exit code 0
# always; a rerun refreshes the framework and installs nothing. Remote MCP servers are not set up from
# here — the sandbox proxy refuses them (403) — connect them as claude.ai connectors instead. The
# history of token usage (docs/logs/) lives on the machine and goes with it. The old timing
# excludes the Codex installation added later; measure the current script again before claiming a
# new duration. Do not supply TELEGRAM_API_ID/HASH/SESSION_STRING from an owner account.

set -uo pipefail

# The default is the PUBLIC repository: this script is published, and a reader of the public tree
# cannot clone the development one. The maintainer points ZERO_CODE_REPO at the development
# repository (plus GITHUB_TOKEN) in the environment's variables.
REPO="${ZERO_CODE_REPO:-https://github.com/0-SOFT/0-CODE.git}"
DIR="${ZERO_CODE_DIR:-$HOME/.0-code}"
REF="${ZERO_CODE_REF:-}"

say() { echo "cloud-setup: $*"; }

# ---------- 1) framework ----------
clone_url="$REPO"
if [ -n "${GITHUB_TOKEN:-}" ] && [[ "$REPO" == https://github.com/* ]]; then
  clone_url="https://x-access-token:${GITHUB_TOKEN}@${REPO#https://}"
fi
if [ -d "$DIR/.git" ]; then
  # The stored remote carries no token (see below), so a private framework is pulled from the
  # authenticated URL given on the command line — it is used for this one fetch and not written.
  git -C "$DIR" pull --ff-only --quiet "$clone_url" ${REF:+"$REF"} 2>/dev/null && say "framework refreshed: $DIR" \
    || say "framework present, refresh failed — using what is there: $DIR"
else
  args=(clone --depth 1 --quiet)
  [ -n "$REF" ] && args+=(--branch "$REF")
  if git "${args[@]}" "$clone_url" "$DIR" 2>/dev/null; then
    # Never leave the token inside .git/config.
    git -C "$DIR" remote set-url origin "$REPO"
    say "framework cloned: $DIR"
  else
    say "WARNING: could not clone $REPO (private repository without GITHUB_TOKEN, or network policy)."
  fi
fi

# ---------- 2) command-line tools ----------
have() { command -v "$1" >/dev/null 2>&1; }
if [ "${CLOUD_SETUP_SKIP_TOOLS:-0}" != "1" ]; then
  if have apt-get; then
    missing=()
    for p in shellcheck jq ripgrep gh; do
      b="$p"; [ "$p" = ripgrep ] && b=rg
      have "$b" || missing+=("$p")
    done
    if [ ${#missing[@]} -gt 0 ]; then
      { apt-get update -qq && apt-get install -y -qq "${missing[@]}"; } >/dev/null 2>&1 \
        && say "apt: installed ${missing[*]}" || say "apt: could not install ${missing[*]}"
    fi
  fi
  # The Codex backend is verified against this exact CLI. Inspect npm's package
  # metadata without loading personal Codex configuration or credentials.
  CODEX_PIN="0.162.0"
  if have npm && have node; then
    CODEX_PACKAGE="$(npm root -g 2>/dev/null)/@openai/codex/package.json"
    CODEX_INSTALLED="$(node -e 'try { console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version); } catch {}' "$CODEX_PACKAGE" 2>/dev/null)"
    if [ "$CODEX_INSTALLED" = "$CODEX_PIN" ]; then
      say "npm: Codex $CODEX_PIN already installed"
    else
      npm install -g "@openai/codex@$CODEX_PIN" >/dev/null 2>&1 \
        && say "npm: installed Codex $CODEX_PIN" \
        || say "WARNING: could not install Codex $CODEX_PIN; do not start the Codex backend until it is available"
    fi
  else
    say "WARNING: npm or node is unavailable; Codex $CODEX_PIN was not installed"
  fi

  # uv puts tools into ~/.local/bin, which the session's PATH already has.
  # Versions are pinned for the same reason the MCP manifest pins its npm packages: every cloud
  # session should audit with the same tools. They are the versions the 2026-10-05 run installed;
  # raise them deliberately, in one commit, not by whatever @latest resolves to that day.
  if have uv && ! have semgrep; then
    uv tool install --quiet "semgrep==1.179.0" >/dev/null 2>&1 && say "uv: installed semgrep" || say "uv: could not install semgrep"
  fi
  # ~/go/bin is NOT on the session's PATH, and an `export PATH` here dies with this script:
  # install straight into /usr/local/bin instead.
  if have go; then
    export GOBIN=/usr/local/bin
    for pkg in github.com/zricethezav/gitleaks/v8@v8.30.1 \
               github.com/google/osv-scanner/v2/cmd/osv-scanner@v2.6.0 \
               github.com/rhysd/actionlint/cmd/actionlint@v1.7.12; do
      b="${pkg%@*}"; b="${b##*/}"; [ "$b" = v8 ] && b=gitleaks
      have "$b" || { go install "$pkg" >/dev/null 2>&1 && say "go: installed $b" || say "go: could not install $b"; }
    done
  fi
fi

# ---------- 3) toolset, MCP servers, global hooks ----------
if [ -x "$DIR/provision-toolset.sh" ] || [ -f "$DIR/provision-toolset.sh" ]; then
  FRAMEWORK_CLOUD_MODE=1 bash "$DIR/provision-toolset.sh" --backend claude || say "WARNING: provision-toolset.sh reported a failure (see above)."
else
  say "provision-toolset.sh is absent — step 3 skipped."
fi

say "done."
exit 0
