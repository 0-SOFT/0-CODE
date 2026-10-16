// Standalone hook, copied byte-for-byte into HOME/guard/backends/. Its detector lives
// at HOME/guard/safety.mjs. Load inside the catch: a missing module must return deny JSON.
import { readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function decision(reason) {
  if (!reason) return null; // No rewrite: Codex requires empty stdout for a routine allow.
  return { hookSpecificOutput: { hookEventName: 'PreToolUse',
    permissionDecision: 'deny', permissionDecisionReason: reason } };
}

export function evaluateCodexHook(payload, decide, { mode = 'arbiter', onDecision } = {}) {
  let event;
  try { event = JSON.parse(payload); }
  catch { return decision('Codex safety hook input is not valid JSON'); }
  if (!event || typeof event !== 'object' || Array.isArray(event)
      || event.hook_event_name !== 'PreToolUse' || typeof event.tool_name !== 'string'
      || !event.tool_name.trim() || !Object.hasOwn(event, 'tool_input')) {
    return decision('Codex safety hook input does not match PreToolUse');
  }
  if (typeof decide !== 'function') return decision('Codex safety decision is unavailable');
  if (!['Bash', 'exec_command', 'shell_command'].includes(event.tool_name)) return decision();
  const command = event.tool_input?.command ?? event.tool_input?.cmd;
  if (typeof command !== 'string' || !command.trim()) {
    return decision('Codex shell hook input has no nonempty command');
  }
  try {
    const result = decide(event, { mode });
    if (result === null) return null;
    const out = result?.hookSpecificOutput;
    if (!out || !['allow', 'deny'].includes(out.permissionDecision)
        || typeof out.permissionDecisionReason !== 'string' || !out.permissionDecisionReason.trim()) {
      return decision('Codex safety decision returned an invalid result');
    }
    try { onDecision?.(out); } catch { /* an audit observer cannot change the decision */ }
    // Codex requires empty stdout for an ordinary allow; an allow JSON without updatedInput
    // is not the same wire contract as Claude's hook. Preserve structured denial only.
    return out.permissionDecision === 'deny' ? result : null;
  } catch { return decision('Codex safety decision failed'); }
}

export async function runCodexHook({ read = () => readFileSync(0, 'utf8'),
  write = text => process.stdout.write(text), writeError = text => process.stderr.write(text),
  loadDetector = () => import('../permission-decision.mjs'), env = process.env,
  auditFile = env.SAFETY_GUARD_LOG || process.argv[2] } = {}) {
  let result;
  try {
    const detector = await loadDetector();
    const report = detector.resolveMode(env);
    if (!report.recognised) writeError(`safety-guard: unknown mode; using ${report.mode}\n`);
    const payload = read();
    result = evaluateCodexHook(payload, detector.decidePermission, { ...report, onDecision(out) {
      // Record confirmation and explicit mode selection in stderr, captured by the caller.
      if (out.permissionDecision === 'allow' && (/ rule confirmed by the agent /.test(out.permissionDecisionReason)
          || report.mode === 'allow-all')) writeError(out.permissionDecisionReason + '\n');
      const entry = detector.guardAuditRecord?.(JSON.parse(payload), { hookSpecificOutput: out }, report);
      if (entry && auditFile) appendFileSync(auditFile, JSON.stringify(entry) + '\n');
    } });
  } catch { result = decision('Codex safety hook could not read input or load its detector'); }
  if (result) {
    write(JSON.stringify(result) + '\n');
    writeError(result.hookSpecificOutput.permissionDecisionReason + '\n');
    // Codex parses structured denial on exit 0. An outer PowerShell -Command
    // changes a native exit 2 into exit 1, which Codex treats as a hook failure
    // and continues. Keep the decision in the supported JSON, not an exit code.
  }
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runCodexHook();
}
