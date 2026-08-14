#!/usr/bin/env bash
# provision-toolset.sh — deploys the personal Claude Code toolset onto a machine.
#
# Idempotently installs into ~/.claude (or $CLAUDE_CONFIG_DIR):
#   A) toolset/{skills,agents,commands,rules}  -> ~/.claude/{...}
#   B) MCP servers from config/mcp-manifest.json -> claude mcp add-json (-s user), secrets from config/.env
#   C) global hooks from config/global-settings.template.json -> deep-merged into ~/.claude/settings.json
#   D) --verify: a green/red report on MCP servers plus runtime status (a verifiable migration)
#
# Flags: --dry-run (change nothing), --force (overwrite existing toolset files),
#        --verify (report D only), --help.
#
# Secrets are NOT stored in the repository: you supply config/.env yourself (it is gitignored).
# The Windows delegator is provision-toolset.ps1.

set -uo pipefail

FRAMEWORK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
TOOLSET="$FRAMEWORK_ROOT/toolset"
# A fresh clone carries only the example manifest; fall back to it so provisioning works
# out of the box rather than failing on a file nobody was told to create.
MANIFEST="$FRAMEWORK_ROOT/config/mcp-manifest.json"
[ -f "$MANIFEST" ] || MANIFEST="$FRAMEWORK_ROOT/config/mcp-manifest.example.json"
GLOBAL_TPL="$FRAMEWORK_ROOT/config/global-settings.template.json"
ENV_FILE="$FRAMEWORK_ROOT/config/.env"
DIRS=(skills agents commands rules)

# `claude mcp` stores servers in .claude.json. By default that is ~/.claude.json (in $HOME),
# NOT $CLAUDE_DIR/.claude.json. So we do NOT override CLAUDE_CONFIG_DIR unless the user set it
# explicitly — otherwise the servers land in the wrong file and the runtime never sees them.
ORIG_CCD="${CLAUDE_CONFIG_DIR:-}"
claude_mcp() {
  if [ -n "$ORIG_CCD" ]; then CLAUDE_CONFIG_DIR="$ORIG_CCD" claude "$@"; else claude "$@"; fi
}

DRY=0; FORCE=0; VERIFY_ONLY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --force)   FORCE=1 ;;
    --verify)  VERIFY_ONLY=1 ;;
    --help|-h)
      sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "provision-toolset: unknown argument: $a" >&2; exit 1 ;;
  esac
done

# OpenCode backend (v1.3.0): the personal ~/.claude toolset belongs to Claude Code; OpenCode
# needs different provisioning (opencode.json with permissions and MCP, AGENTS.md, the plugin).
# We delegate to the Node tool (cross-platform, reusing the adapter — DRY).
if [ "${AGENT_BACKEND:-claude}" = "opencode" ]; then
  echo "AGENT_BACKEND=opencode → provisioning OpenCode (tools/provision-opencode.mjs)"
  OC_ARGS=""; [ "$DRY" -eq 1 ] && OC_ARGS="--dry-run"
  exec node "$FRAMEWORK_ROOT/tools/provision-opencode.mjs" $OC_ARGS
fi

say() { echo "    $*"; }
hr()  { echo "==> $*"; }

# --- dependency check (warnings, not a hard stop) ---
MISSING_DEPS=()
for c in claude node git; do command -v "$c" >/dev/null 2>&1 || MISSING_DEPS+=("$c"); done
[ ${#MISSING_DEPS[@]} -gt 0 ] && echo "provision: warning — missing from PATH: ${MISSING_DEPS[*]}" >&2

# ===================== Step D: verify (read-only) =====================
do_verify() {
  hr "Step D: verify"
  # MCP servers according to claude mcp list
  if command -v claude >/dev/null 2>&1; then
    local list; list="$(claude_mcp mcp list 2>/dev/null || true)"
    if [ -n "$list" ]; then
      echo "  MCP (claude mcp list):"
      echo "$list" | while IFS= read -r line; do
        [ -z "$line" ] && continue
        case "$line" in
          *"✓"*|*Connected*)        echo "    🟢 $line" ;;
          *"✗"*|*Failed*)           echo "    🔴 $line" ;;
          *"!"*|*auth*|*Auth*)      echo "    🟡 $line" ;;
          *)                         echo "    •  $line" ;;
        esac
      done
    else
      echo "  MCP: claude mcp list is empty or unavailable."
    fi
  else
    echo "  MCP: claude is not on PATH — skipped."
  fi
  # Runtimes
  echo "  Runtimes:"
  for b in node npm npx python python3 uv uvx ruff git; do
    if command -v "$b" >/dev/null 2>&1; then echo "    [ok] $b"; else echo "    [missing] $b"; fi
  done
  # manus venv
  local manus_py; manus_py="$(grep -E '^MANUS_PYTHON=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"
  if [ -n "$manus_py" ] && [ -x "$manus_py" ]; then echo "    🟢 manus python: $manus_py"
  else echo "    [setup] manus: the virtualenv is not configured (see linux_setup in the manifest, MANUS_PYTHON in config/.env)"; fi
  echo "  Hint: install the missing runtime, fill in config/.env, or log in to claude."
}

if [ "$VERIFY_ONLY" -eq 1 ]; then do_verify; exit 0; fi

hr "provision-toolset $([ "$DRY" -eq 1 ] && echo '(dry-run)')"
say "target ~/.claude: $CLAUDE_DIR"

# ===================== Step A: toolset -> ~/.claude =====================
hr "Step A: toolset (skills/agents/commands/rules)"
for d in "${DIRS[@]}"; do
  src="$TOOLSET/$d"
  [ -d "$src" ] || { say "skipped (absent from the snapshot): $d"; continue; }
  dst="$CLAUDE_DIR/$d"
  copied=0; skipped=0
  while IFS= read -r f; do
    rel="${f#"$src"/}"
    out="$dst/$rel"
    if [ -f "$out" ] && [ "$FORCE" -eq 0 ]; then skipped=$((skipped+1)); continue; fi
    if [ "$DRY" -eq 0 ]; then mkdir -p "$(dirname "$out")"; cp -f "$f" "$out"; fi
    copied=$((copied+1))
  done < <(find "$src" -type f)
  say "$d: $([ "$DRY" -eq 1 ] && echo 'to copy' || echo 'copied') $copied, skipped $skipped$([ "$FORCE" -eq 1 ] && echo ' (force)')"
done

# ===================== Step B: MCP servers from the manifest =====================
hr "Step B: MCP servers (config/mcp-manifest.json + config/.env)"
[ -f "$ENV_FILE" ] || say "config/.env was not found — servers that need secrets will be marked MISSING."

# Node helper: prints one line per local server:  ACTION \t name \t payload
ACTIONS="$(MANIFEST="$MANIFEST" ENVFILE="$ENV_FILE" node <<'NODE'
const fs=require('fs');
const man=JSON.parse(fs.readFileSync(process.env.MANIFEST,'utf8'));
let env={};
try{
  const raw=fs.readFileSync(process.env.ENVFILE,'utf8');
  for(const line of raw.split(/\r?\n/)){
    const m=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if(m && !line.trim().startsWith('#')) env[m[1]]=m[2];
  }
}catch{}
const PH=/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const sub=s=>typeof s==='string'? s.replace(PH,(_,k,def)=> (env[k]!==undefined&&env[k]!=='')?env[k]:(def!==undefined?def:`\${${k}}`)) : s;
const walk=v=>Array.isArray(v)?v.map(walk):(v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,walk(x)])):sub(v));
const out=[];
for(const s of man.servers){
  if(s.source==='claude_ai'){ out.push(['SKIP',s.name,'a claude.ai connector (requires a claude.ai login)']); continue; }
  // mandatory secrets
  const need=(s.secrets||[]).filter(k=>!(env[k]!==undefined&&env[k]!==''));
  if(s.needs_setup){ out.push(['SETUP',s.name,s.linux_setup||'requires manual setup']); continue; }
  if(need.length){ out.push(['MISSING',s.name,need.join(',')]); continue; }
  const cfg={};
  cfg.type=s.type||'stdio';
  if(cfg.type==='http'){ cfg.url=s.url; if(s.headers) cfg.headers=walk(s.headers); }
  else { cfg.command=sub(s.command); cfg.args=(s.args||[]).map(sub); if(s.env) cfg.env=walk(s.env); }
  out.push(['ADD',s.name,JSON.stringify(cfg)]);
}
for(const [a,n,p] of out) process.stdout.write(a+'\t'+n+'\t'+p+'\n');
NODE
)"

# Cache the list once (we do not call claude during a dry run — it scaffolds configs)
EXISTING_MCP=""
if [ "$DRY" -eq 0 ] && command -v claude >/dev/null 2>&1; then
  EXISTING_MCP="$(claude_mcp mcp list 2>/dev/null || true)"
fi

if [ -z "$ACTIONS" ]; then
  say "node is unavailable or the manifest is empty — step B skipped."
else
  while IFS=$'\t' read -r action name payload; do
    [ -z "$action" ] && continue
    case "$action" in
      ADD)
        if [ "$DRY" -eq 1 ]; then
          say "MCP $name: [dry] claude mcp add-json $name '<cfg>' -s user"
        elif printf '%s\n' "$EXISTING_MCP" | grep -q "^${name}:"; then
          say "MCP $name: already registered — skipped."
        elif command -v claude >/dev/null 2>&1; then
          if claude_mcp mcp add-json "$name" "$payload" -s user >/dev/null 2>&1; then
            say "MCP $name: added."
          else
            say "MCP $name: claude mcp add-json failed (check the flags with claude mcp add --help)."
          fi
        else
          say "MCP $name: claude is not on PATH — skipped (the config is ready)."
        fi
        ;;
      MISSING) say "MCP $name: secrets missing from config/.env: $payload — skipped (fill in .env)." ;;
      SETUP)   say "MCP $name: requires manual setup on Linux → $payload" ;;
      SKIP)    say "MCP $name: $payload" ;;
    esac
  done <<< "$ACTIONS"
fi

# ===================== Step C: global hooks -> settings.json =====================
hr "Step C: global hooks (deep-merged into settings.json)"
if [ ! -f "$GLOBAL_TPL" ]; then
  say "$GLOBAL_TPL is missing — skipped."
elif ! command -v node >/dev/null 2>&1; then
  say "node is not on PATH — skipped."
else
  SETTINGS="$CLAUDE_DIR/settings.json"
  DRY="$DRY" SETTINGS="$SETTINGS" GLOBAL_TPL="$GLOBAL_TPL" node <<'NODE'
const fs=require('fs');
const dst=process.env.SETTINGS, tpl=process.env.GLOBAL_TPL, dry=process.env.DRY==='1';
const b=JSON.parse(fs.readFileSync(tpl,'utf8')); delete b['$comment'];
let a={}; try{ a=JSON.parse(fs.readFileSync(dst,'utf8')); }catch{}
function merge(t,s){
  if(s===null||typeof s!=='object') return s;
  if(Array.isArray(s)){ if(!Array.isArray(t)) return [...s];
    const seen=new Set(t.map(x=>JSON.stringify(x))); const o=[...t];
    for(const x of s){ const k=JSON.stringify(x); if(!seen.has(k)){seen.add(k);o.push(x);} } return o; }
  const o={...(t||{})};
  for(const k of Object.keys(s)){ const sv=s[k],tv=o[k];
    o[k]=(sv&&typeof sv==='object'&&tv&&typeof tv==='object')?merge(tv,sv):sv; }
  return o;
}
const merged=merge(a,b);
const hooks=Object.keys(merged.hooks||{}).join(',');
if(dry){ console.log('    [dry] deep-merging hooks ('+hooks+') into '+dst+' (existing entries preserved)'); }
else{ fs.mkdirSync(require('path').dirname(dst),{recursive:true});
  fs.writeFileSync(dst, JSON.stringify(merged,null,2));
  console.log('    settings.json updated (hooks: '+hooks+'; existing entries preserved)'); }
NODE
fi

# ===================== Step D =====================
[ "$DRY" -eq 1 ] || do_verify
hr "done$([ "$DRY" -eq 1 ] && echo ' (dry run — nothing changed)')"
echo "    Tip: rerunning is idempotent; for a full report use provision-toolset.sh --verify"
