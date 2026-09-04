#!/usr/bin/env bash
# tests/smoke.sh — the framework's end-to-end smoke suite. Exit 0 means everything passed.
# Run: bash tests/smoke.sh
set -uo pipefail

FW="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0
ok(){ echo "  ✅ $1"; PASS=$((PASS+1)); }
no(){ echo "  ❌ $1"; FAIL=$((FAIL+1)); }
# Some artefacts exist only in a working checkout (a live capability catalogue, the maintainer's
# personal toolset snapshot). A fresh clone legitimately lacks them, so those checks are skipped —
# aloud, and counted, never silently. A suite that skips without saying so starts lying about its
# own coverage: this helper was missing once, and six checks vanished from a run that reported 0
# failures.
SKIPPED=0
skip(){ echo "  ➖ skipped: $1"; SKIPPED=$((SKIPPED+1)); }

echo "== 1. Script syntax =="
for f in "$FW"/lib/*.mjs "$FW"/core/*.mjs "$FW"/core/backends/*.mjs "$FW"/hooks/ralph-loop-stop.mjs "$FW"/hooks/safety-guard.mjs; do
  node --check "$f" 2>/dev/null && ok "node --check $(basename "$f")" || no "node --check $(basename "$f")"
done
for f in "$FW"/bootstrap.sh "$FW"/hooks/ralph-loop-stop "$FW"/lib/telegram-notify.sh "$FW"/hooks/run-hook.cmd; do
  bash -n "$f" 2>/dev/null && ok "bash -n $(basename "$f")" || no "bash -n $(basename "$f")"
done

echo "== 2. JSON configs are valid =="
# docs/tools-catalog.json is a live capability catalogue: it exists in a working checkout and not
# in a fresh clone. Where it exists it must be valid; where it does not, the check is skipped aloud.
for j in .claude-plugin/plugin.json hooks/hooks.json templates/project-settings.json templates/pm2-ecosystem.json docs/schemas/STATE.schema.json docs/schemas/tools-catalog.schema.json docs/tools-catalog.json; do
  if [ ! -f "$FW/$j" ] && [ "$j" = "docs/tools-catalog.json" ]; then skip "JSON $j (a live catalogue)"; continue; fi
  node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$FW/$j" 2>/dev/null && ok "JSON $j" || no "JSON $j"
done

echo "== 3. Version consistency (plugin.json is the single source) =="
PV="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version)" "$FW/.claude-plugin/plugin.json")"
SV="$(grep -m1 '^version:' "$FW/skills/orchestrator-wrapper/SKILL.md" | sed 's/version: *//')"
[ "$PV" = "$SV" ] && ok "plugin.json($PV) == SKILL.md($SV)" || no "versions: plugin=$PV skill=$SV"
# The framework keeps a second copy of the skill under .claude/skills/ so that it works on itself.
# Two copies of one document are the same drift class this project fixed in v1.7.0 for the step
# instruction: the copies diverged in that very version, silently, and nothing objected.
SKILL_SRC="$FW/skills/orchestrator-wrapper/SKILL.md"
SKILL_COPY="$FW/.claude/skills/orchestrator-wrapper/SKILL.md"
if [ -f "$SKILL_COPY" ]; then
  cmp -s "$SKILL_SRC" "$SKILL_COPY"     && ok "the .claude/ copy of SKILL.md matches the source"     || no "SKILL.md and its .claude/ copy have diverged"
else
  ok "no .claude/ copy of SKILL.md (nothing to keep in step)"
fi

T="$(mktemp -d)"
# The backstop lives in core/loop-limits.mjs. Both settings files are generated from it, but
# templates/pm2-ecosystem.json is static JSON and cannot import — so it is compared here instead.
# This is the third copy the 0.4.1 audit complained about (P2.3); it can no longer drift in silence.
BS="$(node --input-type=module -e "
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(process.argv[1]).href);
process.stdout.write(String(m.STOP_HOOK_BLOCK_CAP));
" "$FW/core/loop-limits.mjs")"
PM="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).apps[0].env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP))" "$FW/templates/pm2-ecosystem.json")"
[ "$BS" = "$PM" ] && ok "the backstop in pm2-ecosystem.json matches core/loop-limits.mjs ($BS)"   || no "backstop drift: loop-limits=$BS pm2-ecosystem=$PM"

echo "== 4. Parser: escaping and nesting =="
cat > "$T/STATE.md" <<'YAML'
---
current_version: "0.9.0"
next_step_prompt: "text with \"quotes\" and :colons"
nested:
  a: 1
iteration: 5
blockers: []
---
body
YAML
R="$(node "$FW/lib/parse-state.mjs" "$T/STATE.md" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);process.stdout.write(j.next_step_prompt+'|'+j.iteration+'|'+(j.nested&&j.nested.a))})")"
[ "$R" = 'text with "quotes" and :colons|5|1' ] && ok "round-trip: quotes + colons + nesting" || no "parser: [$R]"

# 4b. required_tools (v0.5.4) round-trip
cat > "$T/rt.md" <<'YAML'
---
current_version: "0.9.0"
required_tools: ["github","manus"]
iteration: 1
---
body
YAML
RT="$(node "$FW/lib/parse-state.mjs" "$T/rt.md" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);process.stdout.write(Array.isArray(j.required_tools)?j.required_tools.join(','):'NOTARRAY')})")"
[ "$RT" = 'github,manus' ] && ok "required_tools round-trip (v0.5.4)" || no "required_tools: [$RT]"

# 4c. tools-catalog (v0.5.5): the sample has a valid shape (schema_version=1 + mcps[] with required fields)
CAT="$(node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));const okShape=c.schema_version===1&&Array.isArray(c.mcps)&&c.mcps.every(m=>typeof m.name==='string'&&['connected','available','unknown'].includes(m.status));process.stdout.write(okShape?'OK':'BAD')" "$FW/docs/tools-catalog.json" 2>/dev/null)"
if [ -f "$FW/docs/tools-catalog.json" ]; then
  [ "$CAT" = 'OK' ] && ok "tools-catalog.json has a valid shape (v0.5.5)" || no "tools-catalog shape: [$CAT]"
else skip "tools-catalog.json (a live catalogue, present only in a working checkout)"; fi

# 4d. round-trip of keys starting with a digit (v0.5.9): task_id = "<version>_<topic>" always starts with one.
# The serialiser used to write such a key while the parser could not read it → the STATE write failed → the Stop hook fell back to failOpen.
cat > "$T/numkey.md" <<'YAML'
---
current_version: "0.9.0"
iteration: 1
---
body
YAML
echo '{"attempts_per_task":{"0.0.1_skeleton":{"count":1}}}' | node "$FW/lib/update-state.mjs" "$T/numkey.md" 2>/dev/null; NK1=$?
echo '{"iteration":2}' | node "$FW/lib/update-state.mjs" "$T/numkey.md" 2>/dev/null; NK2=$?
NKV="$(node "$FW/lib/parse-state.mjs" "$T/numkey.md" 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(String(j.attempts_per_task['0.0.1_skeleton'].count)+'|'+j.iteration)}catch(e){process.stdout.write('ERR')}})")"
{ [ "$NK1" = 0 ] && [ "$NK2" = 0 ] && [ "$NKV" = '1|2' ]; } && ok "round-trip of a key starting with a digit (v0.5.9)" || no "digit key round-trip: nk1=$NK1 nk2=$NK2 val=$NKV"

echo "== 5. update-state: write and backup =="
echo '{"iteration":99}' | node "$FW/lib/update-state.mjs" "$T/STATE.md" 2>/dev/null
grep -q 'iteration: 99' "$T/STATE.md" && ok "update-state wrote the file" || no "update-state did not write the file"
[ -f "$T/STATE.md.bak.1" ] && ok "backup created" || no "backup not created"

echo "== 6. Stop hook: every gate =="
mkdir -p "$T/proj/docs"
# Run the hook capturing stdout (HOUT) and the EXIT CODE (HRC); stderr goes to a file (we do not
# silence it, so a crashing hook is not disguised as empty output).
# Every real Stop payload carries the path of the session transcript, and since v1.14.0 that file is
# what proves a session alive — so a harness that omitted it would be testing a shape Claude Code
# never sends. One transcript per simulated session, touched at the moment that session speaks.
hookrun(){
  HSID="$(printf '%s' "$2" | sed -n 's/.*"session_id":"\([^"]*\)".*/\1/p')"
  HTR="$T/tr-${HSID:-anon}.jsonl"; printf 'turn\n' >> "$HTR"
  HPAYLOAD="$(printf '%s' "$2" | sed "s|}\$|,\"transcript_path\":\"$HTR\"}|")"
  HOUT="$(echo "$HPAYLOAD" | CLAUDE_PROJECT_DIR="$T/proj" bash "$FW/hooks/ralph-loop-stop" 2>"$T/hookerr")"; HRC=$?
}
# Make a session look gone: its transcript and the lock heartbeat both stop moving. This is what
# actually happens when a Claude Code window is closed.
hookquiet(){
  node -e "
const fs=require('fs');const old=Date.now()-40*60*1000;
const tr=process.argv[1], lp=process.argv[2];
if(fs.existsSync(tr)) fs.utimesSync(tr, old/1000, old/1000);
if(fs.existsSync(lp)){const l=JSON.parse(fs.readFileSync(lp,'utf8'));l.heartbeatAt=new Date(old).toISOString();fs.writeFileSync(lp,JSON.stringify(l,null,2));}
" "$T/tr-$1.jsonl" "$T/proj/docs/.loop.lock"
}
isblock(){ [ "$HRC" = 0 ] && printf '%s' "$HOUT" | grep -q '"decision":"block"'; }
isstop(){ [ "$HRC" = 0 ] && ! printf '%s' "$HOUT" | grep -q '"decision":"block"'; }
state(){ cat > "$T/proj/docs/STATE.md"; }
# 6a. continue -> block
state <<'Y'
---
current_version: "0.9.0"
released_version: null
blockers: []
iteration: 1
max_iterations: 10
last_session_id: null
session_count: 0
next_step_prompt: "go"
---
Y
hookrun x '{"session_id":"s1","stop_hook_active":false}'; isblock && ok "gate continue -> block (exit 0 + decision)" || no "gate continue [rc=$HRC]"
# 6b. blockers -> stop (no output)
state <<'Y'
---
current_version: "0.9.0"
released_version: null
blockers: ["stuck"]
iteration: 1
max_iterations: 10
last_session_id: "s1"
session_count: 1
next_step_prompt: "go"
---
Y
hookrun x '{"session_id":"s1","stop_hook_active":false}'; isstop && ok "gate blockers -> stop (exit 0, no decision)" || no "gate blockers [rc=$HRC out=$HOUT]"
# 6c. released==current -> stop
state <<'Y'
---
current_version: "0.9.0"
released_version: "0.9.0"
blockers: []
iteration: 1
max_iterations: 10
last_session_id: "s1"
session_count: 1
next_step_prompt: "go"
---
Y
hookrun x '{"session_id":"s1","stop_hook_active":false}'; isstop && ok "gate released==current -> stop" || no "gate released [rc=$HRC]"
# 6d. iteration cap -> stop
state <<'Y'
---
current_version: "0.9.0"
released_version: null
blockers: []
iteration: 10
max_iterations: 10
last_session_id: "s1"
session_count: 1
next_step_prompt: "go"
---
Y
hookrun x '{"session_id":"s1","stop_hook_active":false}'; isstop && ok "gate iteration cap -> stop" || no "gate iteration cap [rc=$HRC]"
# 6e. stop_hook_active -> CONTINUE (v0.5.7): we no longer stop because of stop_hook_active;
# the loop runs until a real stop condition (blocker / released / iteration cap / native cap).
state <<'Y'
---
current_version: "0.9.0"
released_version: null
blockers: []
iteration: 1
max_iterations: 10
last_session_id: null
session_count: 0
next_step_prompt: "go"
---
Y
hookrun x '{"session_id":"s1","stop_hook_active":true}'; isblock && ok "stop_hook_active -> block (continuous loop, v0.5.7)" || no "stop_hook_active must continue the loop [rc=$HRC]"
# 6f. stop_hook_active=true does NOT bypass the iteration cap (runaway protection is preserved)
state <<'Y'
---
current_version: "0.9.0"
released_version: null
blockers: []
iteration: 10
max_iterations: 10
last_session_id: "s1"
session_count: 1
next_step_prompt: "go"
---
Y
hookrun x '{"session_id":"s1","stop_hook_active":true}'; isstop && ok "iteration cap holds even with stop_hook_active (v0.5.7)" || no "iteration cap bypassed with stop_hook_active [rc=$HRC]"
# 6g. loop adoption (v0.5.9): a new session with a stale (dead) last_session_id CONTINUES the
# loop instead of yielding. This is the root fix for continuity — there used to be a failOpen here.
state <<'Y'
---
current_version: "0.9.0"
released_version: null
blockers: []
iteration: 1
max_iterations: 10
last_session_id: "dead_session"
session_count: 1
next_step_prompt: "go"
---
Y
# v1.14.0: adoption means the previous owner is GONE, so the scenario has to say so — a session
# whose transcript is still being written is not dead, it is busy, and taking its loop away was the
# defect this version closed.
hookquiet dead_session
hookrun x '{"session_id":"fresh_session","stop_hook_active":false}'
{ isblock && printf '%s' "$HOUT" | grep -q 'adopted'; } && ok "adoption: a new session continues the loop of a session that went quiet (v0.5.9)" || no "adoption is broken: [rc=$HRC $HOUT]"
# v1.14.0: and the other half of the same rule — a session that is still alive keeps its loop, and
# the second session in the same project ends normally instead of driving it. Until now the lock
# recorded the hook's own process number, which is dead milliseconds later, so this never held.
hookrun x '{"session_id":"second_window","stop_hook_active":false}'
{ isstop && grep -q 'not driving the loop' "$T/hookerr"; } && ok "one owner: a second session in the same project does not drive the loop (v1.14.0)" || no "a second session still hijacks the loop [rc=$HRC]"
{ hookrun x '{"session_id":"fresh_session","stop_hook_active":false}'; isblock; } && ok "one owner: the owning session keeps driving across turns (v1.14.0)" || no "the owner lost its own loop [rc=$HRC]"
# 6h. after adoption, last_session_id is rewritten to the new session
grep -q 'last_session_id: fresh_session' "$T/proj/docs/STATE.md" && ok "adoption recorded the new session_id (v0.5.9)" || no "adoption did not record the session_id"

echo "== 6.5 safety-guard (PreToolUse, v0.6.0) =="
sg(){ printf '%s' "$1" | node "$FW/hooks/safety-guard.mjs" 2>"$T/sgerr"; }
deny(){ echo "$1" | grep -q '"permissionDecision":"deny"'; }
# v1.2.0: a safe operation gets an EXPLICIT allow (the output used to be empty). It was that
# silence which sent the question to the ordinary permission system and produced a user prompt.
allow(){ echo "$1" | grep -q '"permissionDecision":"allow"'; }
# destructive → deny (including --force at the end of a command and inside a compound)
deny "$(sg '{"tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}')" && ok "safety-guard: force push -> deny" || no "force push was not blocked"
deny "$(sg '{"tool_name":"Bash","tool_input":{"command":"git push origin main --force"}}')" && ok "safety-guard: --force at the end -> deny" || no "--force at the end was not blocked"
deny "$(sg '{"tool_name":"Bash","tool_input":{"command":"git add . && git commit -m x && git push origin main --force"}}')" && ok "safety-guard: force inside a compound command -> deny" || no "force inside a compound command was not blocked"
# v1.11.0: the careful form is allowed. It refuses to overwrite anything that appeared after your
# last fetch, so it is the ordinary way to push a rebased branch of your own; blocking it alongside
# the blind form cost the loop a turn on a routine operation while preventing nothing.
allow "$(sg '{"tool_name":"Bash","tool_input":{"command":"git push origin main --force-with-lease"}}')" && ok "safety-guard: --force-with-lease -> allow (the careful form)" || no "--force-with-lease was blocked"
# v1.2.1: `git reset --hard` is no longer blocked — the loss is recoverable from git, while the
# glob produced false refusals on routine work (`git reset --hard origin/main`). We assert the opposite:
allow "$(sg '{"tool_name":"Bash","tool_input":{"command":"git reset --hard origin/main"}}')" && ok "safety-guard: reset --hard -> allow (routine is not blocked)" || no "reset --hard was blocked by mistake"
deny "$(sg '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}')" && ok "safety-guard: destroying the root -> deny" || no "rm -rf / was not blocked"
deny "$(sg '{"tool_name":"Bash","tool_input":{"command":"taskkill /F /IM node.exe"}}')" && ok "safety-guard: mass process kill -> deny" || no "taskkill /IM was not blocked"
allow "$(sg '{"tool_name":"Bash","tool_input":{"command":"taskkill /F /PID 1234"}}')" && ok "safety-guard: kill by process id -> allow" || no "taskkill /PID was blocked by mistake"
deny "$(sg '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}')" && ok "safety-guard: rm -rf / -> deny" || no "rm -rf / was not blocked"
deny "$(sg '{"tool_name":"Bash","tool_input":{"command":"rm -rf ~"}}')" && ok "safety-guard: rm -rf ~ -> deny" || no "rm -rf ~ was not blocked"
# routine → empty (no decision)
allow "$(sg '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}')" && ok "safety-guard: ordinary push -> allow" || no "ordinary push did not get allow"
allow "$(sg '{"tool_name":"Bash","tool_input":{"command":"git commit -m \"fix: block git push --force in hook\""}}')" && ok "safety-guard: the word force inside a commit message -> allow" || no "false positive on commit message text"
allow "$(sg '{"tool_name":"Bash","tool_input":{"command":"git add . && git commit -m x && git push origin main"}}')" && ok "safety-guard: commit+push compound -> allow" || no "a routine commit+push was blocked"
# settings template: push in allow (not in ask), deny present, PreToolUse registered
node -e "const p=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).permissions;process.exit(p.allow.includes('Bash(git push *)')&&!(p.ask||[]).includes('Bash(git push *)')&&Array.isArray(p.deny)&&p.deny.length>0?0:1)" "$FW/templates/project-settings.json" 2>/dev/null && ok "settings: git push in allow, not in ask, deny non-empty (v0.6.0)" || no "settings: git push / deny are wrong"
node -e "const h=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).hooks;process.exit(JSON.stringify(h.PreToolUse||[]).includes('safety-guard')?0:1)" "$FW/templates/project-settings.json" 2>/dev/null && ok "settings: PreToolUse safety-guard is registered (v0.6.0)" || no "settings: PreToolUse safety-guard is not registered"

echo "== 7. end-to-end bootstrap =="
BT="$T/target"
bash "$FW/bootstrap.sh" "$BT" >/dev/null 2>&1
[ "$(cat "$BT/.claude/.framework-version" 2>/dev/null)" = "$PV" ] && ok ".framework-version == $PV" || no ".framework-version"
for need in lib/yaml-mini.mjs lib/backup.mjs lib/update-state.mjs hooks/ralph-loop-stop.mjs hooks/run-hook.cmd hooks/save-session-log hooks/safety-guard hooks/safety-guard.mjs .gitignore .gitattributes ecosystem.json docs/STATE.md; do
  [ -f "$BT/$need" ] && ok "bootstrap created $need" || no "bootstrap did NOT create $need"
done
# safety-guard is registered as PreToolUse in the generated settings (v0.6.0)
node -e "const h=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).hooks;process.exit(JSON.stringify(h.PreToolUse||[]).includes('safety-guard')?0:1)" "$BT/.claude/settings.json" 2>/dev/null && ok "bootstrap: PreToolUse safety-guard in settings (v0.6.0)" || no "bootstrap: PreToolUse safety-guard is missing"
# Session logger (v0.5.6): registered in both Stop and SessionEnd
node -e "const h=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).hooks;const flat=o=>JSON.stringify(o);const stop=flat(h.Stop||[]),se=flat(h.SessionEnd||[]);process.exit(stop.includes('save-session-log')&&stop.includes('ralph-loop-stop')&&se.includes('save-session-log')?0:1)" "$BT/.claude/settings.json" 2>/dev/null && ok "settings: Stop(logger+ralph) and SessionEnd(logger) (v0.5.6)" || no "settings without the logger registered"
grep -q '^\.env' "$BT/.gitignore" 2>/dev/null && ok ".gitignore protects .env" || no ".gitignore does not cover .env"
# Session-log awareness (v0.5.8): CLAUDE.md mentions docs/logs and tells you to grep first
{ grep -q 'docs/logs' "$BT/CLAUDE.md" && grep -qi 'grep first' "$BT/CLAUDE.md"; } 2>/dev/null && ok "CLAUDE.md: docs/logs forensics guidance (v0.5.8)" || no "CLAUDE.md lacks docs/logs guidance"
grep -q '^required_tools:' "$BT/docs/STATE.md" 2>/dev/null && ok "bootstrap STATE has required_tools (v0.5.4)" || no "bootstrap STATE without required_tools"
node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.exit(c.schema_version===1&&Array.isArray(c.mcps)&&c.mcps.length===0?0:1)" "$BT/docs/tools-catalog.json" 2>/dev/null && ok "bootstrap created tools-catalog.json (mcps:[]) (v0.5.5)" || no "bootstrap tools-catalog missing or invalid"
[ -f "$BT/docs/schemas/tools-catalog.schema.json" ] && ok "bootstrap created tools-catalog.schema.json" || no "bootstrap without tools-catalog.schema"
node -e "const a=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).apps[0];process.exit(a.cwd?1:0)" "$BT/ecosystem.json" 2>/dev/null && ok "ecosystem without cwd (cross-platform)" || no "ecosystem contains cwd"
# idempotency
bash "$FW/bootstrap.sh" "$BT" 2>&1 | grep -qi "already installed" && ok "repeat bootstrap: already installed" || no "idempotency"

echo "== 8. Toolset provisioning (v0.7.0) =="
# The published tree ships config/mcp-manifest.example.json; a working checkout also has a
# personal config/mcp-manifest.json. Either satisfies the format check.
MCP_MANIFEST="$FW/config/mcp-manifest.json"
[ -f "$MCP_MANIFEST" ] || MCP_MANIFEST="$FW/config/mcp-manifest.example.json"
# 8a. the snapshot is not empty
for d in skills agents commands rules; do
  c="$(find "$FW/toolset/$d" -type f 2>/dev/null | wc -l | tr -d ' ')"
  if [ -d "$FW/toolset" ]; then
    [ "${c:-0}" -gt 0 ] && ok "toolset/$d is not empty ($c)" || no "toolset/$d is empty or missing"
  else skip "toolset/$d (the maintainer's personal snapshot, not part of the product)"; fi
done
# 8b. mcp-manifest has a valid shape and is secret-free (only ${VAR}, no token values)
node -e "const m=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));const ok=m.schema_version===1&&Array.isArray(m.servers)&&m.servers.every(s=>typeof s.name==='string');const leak=/ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/.test(JSON.stringify(m));process.exit(ok&&!leak?0:1)" "$MCP_MANIFEST" 2>/dev/null && ok "mcp-manifest: valid shape, no secret values (v0.7.0)" || no "mcp-manifest is invalid or contains a secret"
# 8c. the manifest validates against its own schema (present and parseable)
node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$FW/config/mcp-manifest.schema.json" 2>/dev/null && ok "mcp-manifest.schema.json is valid" || no "mcp-manifest.schema.json is invalid"
# 8d. .env.example exists and holds no values (KEY= lines with an empty value, or comments)
{ [ -f "$FW/config/.env.example" ] && ! grep -qE '^[A-Za-z_][A-Za-z0-9_]*=[[:space:]]*[^[:space:]]' "$FW/config/.env.example"; } && ok "config/.env.example exists and holds no values (v0.7.0)" || no ".env.example is missing or contains values"
# 8e. global-settings.template: hooks present, mcpServers/permissions absent
node -e "const g=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.exit(g.hooks&&!g.mcpServers&&!g.permissions?0:1)" "$FW/config/global-settings.template.json" 2>/dev/null && ok "global-settings: hooks without mcpServers/permissions (v0.7.0)" || no "global-settings is incorrect"
# 8f. sanitisation: no real secrets in anything git could stage from toolset/ or config/.
# This used to grep both directories wholesale, which meant it read config/.env — live values by
# design, ignored by git, excluded from publication. The suite was therefore red on every machine
# where the framework is actually used and green only where it is not, which teaches people to
# ignore red. lib/secret-scan.mjs asks git what it WOULD stage instead; no filename is
# special-cased, so an entry added to the ignore policy leaves the scan through the same door.
# Measured here: 511 scannable files against 512 on disk, the difference being config/.env alone.
SEC="$(node "$FW/lib/secret-scan.mjs" toolset config 2>&1)"; SEC_RC=$?
if [ "$SEC_RC" -eq 0 ]; then
  ok "sanitisation: nothing git could stage carries a secret (v1.7.1)"
elif [ "$SEC_RC" -eq 2 ]; then
  skip "sanitisation scan (not a git work tree — an export before git init)"
else
  no "sanitisation: a secret was found — [$SEC]"
fi
# 8f-bis. The positive invariant that replaces the old false alarm. Excluding config/.env from the
# scan is only honest if something still asserts the file cannot be committed at all.
if git -C "$FW" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  ENV_IGNORED=1; git -C "$FW" check-ignore --no-index -q -- config/.env || ENV_IGNORED=0
  ENV_TRACKED="$(git -C "$FW" ls-files -- config/.env)"
  { [ "$ENV_IGNORED" -eq 1 ] && [ -z "$ENV_TRACKED" ]; }     && ok "sanitisation: config/.env is ignored and absent from the index (v1.7.1)"     || no "sanitisation: config/.env is committable (ignored=$ENV_IGNORED tracked=[$ENV_TRACKED])"
else
  skip "config/.env invariant (not a git work tree)"
fi
# 8g. provisioning script syntax
if [ -f "$FW/tools/snapshot-toolset.sh" ]; then
  { bash -n "$FW/provision-toolset.sh" && bash -n "$FW/tools/snapshot-toolset.sh"; } 2>/dev/null \
    && ok "bash -n provision/snapshot (v0.7.0)" || no "provision/snapshot syntax"
else
  bash -n "$FW/provision-toolset.sh" 2>/dev/null && ok "bash -n provision (v0.7.0)" || no "provision syntax"
fi

echo "== 9. core/ — multi-backend (v0.8.0) =="
# 9a. the core files exist
for need in core/gates.mjs core/safety.mjs core/supervisor.mjs core/backend-factory.mjs core/backends/Backend.mjs core/backends/claude.mjs; do
  [ -f "$FW/$need" ] && ok "core: $need exists" || no "core: $need is missing"
done
# 9b. pure core functions: gates plus the destructive detector (parity with the hooks)
#     Paths are passed as argv (OS-correct) plus pathToFileURL for the ESM import.
node --input-type=module -e "
import { pathToFileURL } from 'node:url';
const { decideContinuation } = await import(pathToFileURL(process.argv[1]).href);
const { destructiveReason } = await import(pathToFileURL(process.argv[2]).href);
const A=[];
A.push(decideContinuation({blockers:[{t:1}]},{sessionId:'s'}).action==='stop');
A.push(decideContinuation({blockers:[],released_version:'1',current_version:'1'},{sessionId:'s'}).action==='stop');
A.push(decideContinuation({blockers:[],iteration:60,max_iterations:60},{sessionId:'s'}).action==='stop');
A.push(decideContinuation({blockers:[],budget_metrics:{version_cost_usd:10,cap_usd:5}},{sessionId:'s'}).action==='stop');
const c=decideContinuation({blockers:[],iteration:3,max_iterations:60,next_step_prompt:'P',last_session_id:'old'},{sessionId:'live'});
A.push(c.action==='continue'&&c.next.iteration===4&&c.stepInstruction==='P'&&c.reason.includes('P')&&c.adopted===true);
// v1.7.0: a step instruction written for another version must not reach the agent.
const stale=decideContinuation({blockers:[],iteration:3,max_iterations:60,current_version:'6.4.0',next_step_prompt:'finish stage 4.6.0'},{sessionId:'live'});
A.push(stale.action==='continue'&&!stale.reason.includes('finish stage 4.6.0')&&!!stale.staleNextPrompt);
A.push(/blockers: none/.test(stale.reason));
A.push(destructiveReason('git push --force')!==null);
A.push(destructiveReason('rm -rf /')!==null);
A.push(destructiveReason('git push origin main')===null);
A.push(destructiveReason('git add -A && git push --force')!==null);
process.exit(A.every(Boolean)?0:1);
" "$FW/core/gates.mjs" "$FW/core/safety.mjs" 2>/dev/null && ok "core: gates and safety pure functions (parity)" || no "core: gates/safety logic is broken"
# 9c. backend factory: claude and opencode are created, an unknown flag throws honestly
node --input-type=module -e "
import { pathToFileURL } from 'node:url';
const { getBackend, autodetectBackendId } = await import(pathToFileURL(process.argv[1]).href);
const A=[];
A.push(getBackend('claude').id==='claude');
A.push(getBackend('claude').guardCommand('git push --force')!==null);
A.push(getBackend('claude').guardCommand('git push origin main')===null);
A.push(getBackend('opencode').id==='opencode');
try{getBackend('xxx');A.push(false)}catch(e){A.push(/Unknown/.test(e.message))}
A.push(autodetectBackendId({AGENT_BACKEND:'opencode'})==='opencode');
A.push(autodetectBackendId({})==='claude');
process.exit(A.every(Boolean)?0:1);
" "$FW/core/backend-factory.mjs" 2>/dev/null && ok "core: backend-factory (claude+opencode ok, unknown throws, explicit flag)" || no "core: backend-factory is broken"
# 9d. supervisor --dry-run: reads STATE without mutating it (idempotent observation).
# We build a throwaway STATE instead of using the framework's own: a published checkout has no
# docs/STATE.md, because that file describes one project's progress and is not part of the product.
DRYDIR="$T/dry/docs"; mkdir -p "$DRYDIR"
cat > "$DRYDIR/STATE.md" <<'DRYSTATE'
---
schema_version: 1
current_version: "1"
released_version: "0"
iteration: 7
max_iterations: 60
blockers: []
next_step_prompt: "do X"
---

# Journal
DRYSTATE
ITER_BEFORE="$(node "$FW/lib/parse-state.mjs" "$DRYDIR/STATE.md" 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{process.stdout.write(String(JSON.parse(d).iteration))}catch(e){process.stdout.write('ERR')}})")"
node "$FW/core/supervisor.mjs" --dry-run --backend claude --state "$DRYDIR/STATE.md" >/dev/null 2>&1 && DRYOK=1 || DRYOK=0
ITER_AFTER="$(node "$FW/lib/parse-state.mjs" "$DRYDIR/STATE.md" 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{process.stdout.write(String(JSON.parse(d).iteration))}catch(e){process.stdout.write('ERR')}})")"
{ [ "$DRYOK" = "1" ] && [ "$ITER_BEFORE" = "$ITER_AFTER" ]; } && ok "core: supervisor --dry-run does not mutate STATE (iter=$ITER_BEFORE)" || no "core: supervisor dry run mutated or crashed ($ITER_BEFORE→$ITER_AFTER)"

# 9e. the version is aligned (path passed as argv, following the pattern of section 8)
node -e "const v=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version;process.exit(/^\d+\.\d+\.\d+$/.test(v)?0:1)" "$FW/.claude-plugin/plugin.json" 2>/dev/null && ok "the version in plugin.json has a valid shape" || no "the version in plugin.json has an invalid format"

echo "== 10. OpenCode adapter (v1.3.0) =="
# 10a. the files exist and are syntactically valid
[ -f "$FW/core/backends/opencode.mjs" ] && node --check "$FW/core/backends/opencode.mjs" 2>/dev/null && ok "opencode: the adapter is present and valid" || no "opencode: the adapter is missing or broken"
[ -f "$FW/tools/provision-opencode.mjs" ] && node --check "$FW/tools/provision-opencode.mjs" 2>/dev/null && ok "opencode: provisioning is present and valid" || no "opencode: provisioning is missing or broken"
# 10b. pure helpers: event parsing, argument assembly, permission translation, the plugin
node --input-type=module -e "
import { pathToFileURL } from 'node:url';
const O = await import(pathToFileURL(process.argv[1]).href);
const A=[];
// the prompt is NEVER in the arguments (the Windows command-line limit)
const args=O.buildOpenCodeArgs({model:'m/x'});
A.push(args[0]==='run' && args.includes('--format') && args.includes('--auto'));
A.push(!O.buildOpenCodeArgs({model:'m/x'}).join(' ').includes('prompt'));
// event stream parsing
const r=O.parseOpenCodeEvents(JSON.stringify({type:'text',sessionID:'ses_1',part:{type:'text',text:'OK'}})+String.fromCharCode(10)+JSON.stringify({type:'step_finish',sessionID:'ses_1',part:{type:'step-finish',cost:0.5,tokens:{input:10,output:2}}}));
A.push(r.ok && r.output==='OK' && r.costUsd===0.5 && r.sessionId==='ses_1');
// permission translation: denials are not lost
const p=O.toOpenCodePermissions({allow:[],deny:['Bash(rm -rf /)']});
A.push(p.dropped.length===0 && Object.values(p.permission.bash).includes('deny'));
// the arbiter plugin takes its rules from the shared detector
A.push(O.buildOpenCodePluginScript('/x/core/safety.mjs').includes('destructiveReason'));
process.exit(A.every(Boolean)?0:1);
" "$FW/core/backends/opencode.mjs" 2>/dev/null && ok "opencode: pure helpers (arguments/events/permissions/plugin)" || no "opencode: pure helpers are broken"
# 10c. the Backend port contract plus scaffolding self-healing
node --input-type=module -e "
import { pathToFileURL } from 'node:url';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { OpenCodeBackend } = await import(pathToFileURL(process.argv[1]).href);
const b=new OpenCodeBackend(); const A=[b.id==='opencode', !!b.guardCommand('rm -rf /'), b.guardCommand('git status')===null];
const d=mkdtempSync(join(tmpdir(),'smoke-oc-'));
await b.ensureReady({cwd:d});
const plugin=join(d,'.opencode','plugins','safety-guard.js');
A.push(existsSync(plugin));
rmSync(plugin);
const rr=await b.ensureReady({cwd:d});
A.push(existsSync(plugin) && rr.restored.length>0);
rmSync(d,{recursive:true,force:true});
process.exit(A.every(Boolean)?0:1);
" "$FW/core/backends/opencode.mjs" 2>/dev/null && ok "opencode: Backend contract plus restoring a wiped plugin" || no "opencode: contract or self-healing is broken"
# 10d. provisioning --dry-run against the real manifest, touching no files
node "$FW/tools/provision-opencode.mjs" --dry-run --target "$T/oc" >/dev/null 2>&1 && [ ! -d "$T/oc" ] && ok "opencode: provision --dry-run does not touch the filesystem" || no "opencode: provision dry run crashed or created files"

echo "== 11. Loop lock (v1.5.0) =="
# 11a. pure logic: a live owner refuses, a dead one is taken over, our own lock is released
node --input-type=module -e "
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const L = await import(pathToFileURL(process.argv[1]).href);
const d = mkdtempSync(join(tmpdir(), 'smoke-lock-'));
const T = Date.parse('2026-08-11T12:00:00Z');
const A = [];
A.push(L.acquireLock({ projectDir: d, pid: 111, host: 'h1', now: T }).acquired === true);
A.push(L.acquireLock({ projectDir: d, pid: 222, host: 'h1', now: T + 1000, pidAlive: p => p === 111 }).acquired === false);
A.push(L.acquireLock({ projectDir: d, pid: 222, host: 'h1', now: T + 1000, pidAlive: () => false }).takenOver === true);
A.push(L.releaseLock({ projectDir: d, pid: 999 }) === false);
A.push(L.releaseLock({ projectDir: d, pid: 222 }) === true);
A.push(!existsSync(L.lockPath(d)));
rmSync(d, { recursive: true, force: true });
process.exit(A.every(Boolean) ? 0 : 1);
" "$FW/core/loop-lock.mjs" 2>/dev/null && ok "lock: refuse a live owner, take over a dead one, release our own" || no "the loop lock is broken"
# 11b. both loop drivers use the lock
grep -q "acquireLock" "$FW/core/supervisor.mjs" && grep -q "acquireLock" "$FW/hooks/ralph-loop-stop.mjs"   && ok "the lock is wired into both drivers (supervisor and Stop hook)" || no "the lock is not wired everywhere"

echo "== 12. Engine self-check (v1.5.0) =="
node --input-type=module -e "
import { pathToFileURL } from 'node:url';
const P = await import(pathToFileURL(process.argv[1]).href);
const A = [];
A.push(P.assessProbe({ ok: true, output: 'OK', sessionId: 's', costUsd: 0.1 }).ok === true);
A.push(P.assessProbe({ ok: true, output: '   ' }).ok === false);          // the format changed
A.push(P.assessProbe({ ok: false, error: 'no such model' }).ok === false);   // a misconfiguration
A.push(P.assessProbe({ ok: true, output: 'OK' }).notes.length === 2);     // details are only notes
A.push(P.explainFailure({ problems: ['x'], backendId: 'opencode', model: 'm' }).includes('--no-preflight'));
process.exit(A.every(Boolean) ? 0 : 1);
" "$FW/core/preflight.mjs" 2>/dev/null && ok "self-check: fails on an empty answer and a failed turn, details are only notes" || no "the self-check is broken"
grep -q "usePreflight" "$FW/core/supervisor.mjs" && grep -q "no-preflight" "$FW/core/supervisor.mjs"   && ok "the self-check is wired into the supervisor and can be switched off by a flag" || no "the self-check is not wired in"

echo "== 13. Honest bootstrap output and the secrets notice (v1.5.0) =="
# 13a. the secrets notice recognises what matters and stays quiet on harmless files
node --input-type=module -e "
import { pathToFileURL } from 'node:url';
const S = await import(pathToFileURL(process.argv[1]).href);
const A = [];
A.push(S.looksLikeSecretFile('.env') === true);
A.push(S.looksLikeSecretFile('config/.env.local') === true);
A.push(S.looksLikeSecretFile('id_rsa') === true);
A.push(S.looksLikeSecretFile('.env.example') === false);   // a template is not a secret
A.push(S.looksLikeSecretFile('src/index.mjs') === false);
A.push(S.pickSecretFiles(['a.mjs', '.env']).length === 1);
process.exit(A.every(Boolean) ? 0 : 1);
" "$FW/core/secret-notice.mjs" 2>/dev/null && ok "secrets: key files are recognised, templates do not produce noise" || no "secret recognition is broken"
# 13b. the notice does NOT block — the module contains neither a refusal nor an exit
grep -qE "permissionDecision|process.exit|throw new Error" "$FW/core/secret-notice.mjs"   && no "the secrets notice must not be able to block"   || ok "secrets: observation only, nothing can block (an explicit user decision)"
# 13c. bootstrap is honest about notifications
grep -q "will NOT be notified" "$FW/bootstrap.sh" && ok "bootstrap warns about silent notifications" || no "bootstrap says nothing about notifications"

echo "== 14. Ignore policy: one source, both trees (v1.7.1) =="
# .gitignore and templates/gitignore.public are rendered from lib/ignore-policy.mjs. Two files
# exist because git needs one at the root of each tree; they are no longer two sources. This
# section is the reader half of that contract.
#
# It asks git, never grep. A line sitting in an ignore file and a path git actually refuses are
# different claims, and only the second protects anything — the entry guarding opencode.json was
# present in one copy for a whole release while protecting nothing on any live machine.

# 14a. both rendered files still agree with the policy (entries only — a CRLF checkout is not drift)
if IGN_OUT="$(node "$FW/tools/gen-ignore.mjs" --check 2>&1)"; then
  ok "ignore policy: both trees match lib/ignore-policy.mjs"
else
  no "ignore policy drifted: $(printf '%s' "$IGN_OUT" | grep -E 'LEAK RISK|missing in|present in|MISSING' | tr '\n' ';' | sed 's/;$//')"
fi

# 14b. behaviour: git really refuses every secret-bearing path. Probes stand in for the patterns —
# *.key cannot be handed to check-ignore literally, probe.key can. Needs a git work tree: an export
# inspected before `git init` legitimately has none, so that case is skipped aloud rather than
# reported as a pass.
if git -C "$FW" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  node --input-type=module -e "
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const S = await import(pathToFileURL(process.argv[1]).href);
const root = process.argv[2];
const probes = { '.opencode/': '.opencode/state.json', '.playwright-mcp/': '.playwright-mcp/page.yml' };
const bad = [];
for (const e of S.SECRET_BEARING) {
  const probe = probes[e] || (e.startsWith('*') ? 'probe' + e.slice(1) : e);
  const r = spawnSync('git', ['check-ignore', '--no-index', '-q', '--', probe], { cwd: root });
  if (r.status !== 0) bad.push(e);
}
if (bad.length) { process.stderr.write(bad.join(', ')); process.exit(1); }
" "$FW/lib/ignore-policy.mjs" "$FW" 2>/dev/null && ok "ignore policy: git refuses every secret-bearing path" || no "ignore policy: git would STAGE a secret-bearing path"

  # 14c. a rule cannot save a path already in the index — that needs `git rm --cached`. Three
  # Playwright snapshots reached the public repository exactly this way.
  STUCK="$(git -C "$FW" ls-files -- opencode.json AGENTS.md .opencode .playwright-mcp 2>/dev/null | tr '\n' ' ')"
  [ -z "$STUCK" ] && ok "ignore policy: nothing secret-bearing is stuck in the index" || no "ignore policy: tracked despite the rule — $STUCK"
else
  skip "ignore policy behaviour (not a git work tree — an export before git init)"
  skip "ignore policy index check (not a git work tree)"
fi

echo "== 15. Acceptance criteria of released versions (v1.18.0) =="
# WHY THIS EXISTS. The roadmap review shipped in v1.16.0 fired for the first time and found 46 open
# acceptance criteria across versions this project declares RELEASED — 2 saying out loud that they
# were not met, and 44 saying nothing at all. From the roadmap alone a version that fell short of
# its own bar looks exactly like one where somebody forgot a tick.
#
# The price was demonstrated the same day: v0.9.0 had carried "the >=80 % threshold for lines AND
# branches is met" as an open criterion since release, and the first real audit run rediscovered
# exactly that four versions later. The roadmap knew. Nobody read it.
#
# Where the check lives was chosen in the open (docs/decisions/1.18.0_criteria-guard.md): here,
# rather than as a barrier in lib/update-state.mjs, because the barrier would have coupled the
# state tool to the format of a document it has no other reason to know — 18 against 28 by score.
SILENT="$(node --input-type=module -e "
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(process.argv[1]).href);
const s = m.silentCriteria(m.readRoadmap(process.argv[2]));
process.stdout.write(s.length ? m.summariseSilent(s) : 'CLEAN');
" "$FW/core/acceptance.mjs" "$FW/docs/ROADMAP.md" 2>"$T/acceptance.err")"
if [ "$SILENT" = "CLEAN" ]; then
  ok "every open criterion of a released version says why it was not met"
elif [ -z "$SILENT" ]; then
  # Absence of output is NOT cleanliness: it means the check itself did not run. The first version of
  # this guard imported a Windows path as a bare specifier, the error went to /dev/null, and an empty
  # result read as "nothing silent" — a guard against unfalsifiable checks that was itself one.
  no "the acceptance check did not run at all: $(head -c 200 "$T/acceptance.err" 2>/dev/null)"
else
  no "silent acceptance criteria: $SILENT"
fi
echo "== TOTAL: PASS=$PASS, FAIL=$FAIL, SKIPPED=$SKIPPED =="
[ "$FAIL" -eq 0 ] && { echo "OK 0 failed — every smoke check passed"; exit 0; } || { echo "FAIL some checks did not pass"; exit 1; }
