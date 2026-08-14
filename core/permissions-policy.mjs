// core/permissions-policy.mjs — the SINGLE source of truth for the framework's permissions.
//
// WHY (v1.2.0, research in the development repository):
// The user had "Bypass Permissions" enabled and Claude Code still asked for confirmation.
// Experiments proved the decision hierarchy (strongest first):
//
//   deny(settings) > ask(settings) > deny(hook) > allow(hook) > allow(settings) / bypass
//
// In other words an `ask` rule outranks BOTH the bypassPermissions mode (experiment B3) AND the
// hook's decision (experiment D1). While `ask` exists in the settings, no toggle can remove the
// prompt. And the framework was handing `ask` to itself and to every project it created — so it
// was manufacturing the user's problem.
//
// THE FIX: the `ask` category does not exist in this policy as a concept.
//   - dangerous → `deny` (it does not ask, it forbids — which is STRICTER than a question);
//   - routine   → `allow`;
//   - subtle cases a glob cannot express (the command's target rather than the command itself)
//     → the core/safety.mjs detector via the hook; experiment H1 proved a hook `deny` works even
//     under bypass.
//
// Two independent lines of defence remain: `deny` in settings plus `deny` from the hook.
// Two files used to drift apart (the framework's own settings and the template for projects) —
// both are now generated from this module (see tools/gen-settings.mjs), so drift is impossible.

// Default mode. Experiment G1: the mode from the settings file works without touching the toggle
// in the user interface — so we set it explicitly instead of relying on a human action.
export const DEFAULT_MODE = 'bypassPermissions';

// Routine operations of the autonomous loop. The list is deliberately broad: with the mode set
// and the arbiter hook in place it acts as a safety net, not as the only line of defence.
export const ALLOW = [
  // File and search tools
  'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  // Git: the full routine set. Autonomous pushing is a workflow requirement; only `--force` is
  // dangerous, and it sits in DENY as well as in the detector.
  'Bash(git status)', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git add *)',
  'Bash(git commit *)', 'Bash(git branch *)', 'Bash(git checkout *)', 'Bash(git pull *)',
  'Bash(git push *)', 'Bash(git fetch *)', 'Bash(git remote *)', 'Bash(git rev-list *)',
  'Bash(git show *)', 'Bash(git tag *)', 'Bash(git stash *)',
  // Running and building
  'Bash(node *)', 'Bash(npm test*)', 'Bash(npm run *)', 'Bash(npm ci*)', 'Bash(npm install*)',
  // MOVED OUT OF `ask`: installing tools is environment setup, not destruction.
  'Bash(npm install -g *)',
  // MOVED OUT OF `ask`: managing loop processes is a routine supervisor operation.
  'Bash(pm2 *)',
  'Bash(pytest*)', 'Bash(go test*)', 'Bash(cargo test*)', 'Bash(jq *)',
  // File and helper commands
  'Bash(mv *)', 'Bash(cp *)', 'Bash(cd *)', 'Bash(echo *)', 'Bash(printf *)',
  'Bash(tail *)', 'Bash(head *)', 'Bash(grep *)', 'Bash(sed *)', 'Bash(ls *)',
  'Bash(cat *)', 'Bash(test *)', 'Bash(mkdir *)', 'Bash(pwd)',
  // Loop notifications
  'Bash(curl https://api.telegram.org/*)',
];

// Denials (v1.2.1 — reduced to a minimum).
//
// A glob in the settings is a blunt instrument: it sees neither the command's target nor its
// context, which is exactly why globs produced false refusals on routine work (`git clean -fdx`,
// `git reset --hard origin/main`, `npm publish --dry-run`). Subtle decisions belong to the
// core/safety.mjs detector, which splits the command into segments and looks at the target.
//
// What remains here is only a safety net for the case where the hook never runs at all (the hook
// wrapper deliberately fails open, for example when the machine has no bash). Hence the list
// covers nothing but destroying the machine and rewriting shared history: cases where a glob
// cannot be wrong and the cost of being wrong is unrecoverable.
export const DENY = [
  'Bash(rm -rf /)', 'Bash(rm -rf /*)', 'Bash(rm -rf ~)', 'Bash(rm -rf ~/*)',
  'Bash(sudo rm -rf /*)', 'Bash(sudo rm -rf ~*)',
  'Bash(git push --force*)', 'Bash(git push -f *)',
];

// The permissions block for settings.json. There is no `ask` key here and there cannot be one.
export function buildPermissionsBlock({ mode = DEFAULT_MODE } = {}) {
  return { defaultMode: mode, allow: [...ALLOW], deny: [...DENY] };
}

// Registration of the arbiter hook. The matcher is "*" because experiment F1 showed that without
// an explicit hook decision a prompt also appears for non-Bash tools (Write and friends).
export function buildPreToolUseHook(command) {
  return { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] };
}

// Finding the forbidden category in an arbitrary settings object — used for diagnostics and for
// the test that keeps the framework's settings and the project template consistent.
export function findAskRules(settings) {
  const ask = settings && settings.permissions && settings.permissions.ask;
  return Array.isArray(ask) ? [...ask] : [];
}
