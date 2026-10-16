// Codex prefixes match argv literals, not the permission policy's shell globs.
// Every source denial has a mapping; incomplete translations stay visible in dropped.
import { isAbsolute, win32 } from 'node:path';

export function compileCodexRules(policy) {
  if (!policy || !Array.isArray(policy.deny) || policy.deny.some(r => typeof r !== 'string')) {
    throw new Error('Codex permission policy must contain a deny array of strings');
  }
  const mapping = [], unique = new Map();
  for (const rule of policy.deny) {
    const match = /^Bash\(([^\r\n]+)\)$/.exec(rule);
    let prefixes = [], status = 'dropped', reason;
    if (!match || /["'`;$&|<>\\()\[\]?{}]/.test(match[1])) {
      reason = 'Only unquoted Bash argv prefixes can be translated; this form has no native prefix representation.';
    } else {
      const tokens = match[1].trim().split(/\s+/).filter(Boolean);
      // A final standalone * means arbitrary subsequent arguments. A prefix expresses that
      // without broadening a token such as --force* into every git push.
      if (tokens.at(-1) === '*') tokens.pop();
      if (!tokens.length || tokens.some(t => t === '*')) {
        reason = 'An arbitrary executable or argument position cannot be a literal prefix.';
      } else if (tokens.some(t => t.includes('*'))) {
        const literal = tokens.map(t => t.replaceAll('*', ''));
        prefixes = [tokens];
        if (literal.every(Boolean)) prefixes.unshift(literal);
        status = 'partial';
        reason = 'Embedded globs have no argv-prefix equivalent: only literal representatives are forbidden; other suffixes and shell expansions are outside these rules. The shared guard has its own semantic policy.';
      } else {
        prefixes = [tokens];
        status = 'translated';
      }
    }
    mapping.push({ rule, status, prefixes, ...(reason ? { reason } : {}) });
    for (const prefix of prefixes) {
      const key = JSON.stringify(prefix);
      if (!unique.has(key)) unique.set(key, { prefix, rule });
    }
  }
  const rules = '# Generated from the shared deny policy; embedded globs are NOT wildcard prefixes.\n'
    + [...unique.values()].map(({ prefix, rule }) =>
      `prefix_rule(pattern=${JSON.stringify(prefix)}, decision="forbidden", justification=${JSON.stringify(`Framework deny: ${rule}`)})`).join('\n') + '\n';
  const dropped = mapping.filter(m => m.status !== 'translated').map(m => ({
    rule: m.rule, kind: m.status, reason: m.reason, represented: m.prefixes,
  }));
  return { rules, mapping, dropped };
}

const posixQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const powershellQuote = value => `'${value.replaceAll("'", "''")}'`;

export function buildCodexHooks({ hookFile, auditFile, nodePath = process.execPath,
  powershellPath = win32.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') }) {
  if (![hookFile, nodePath].every(p => typeof p === 'string' && isAbsolute(p))) {
    throw new Error('Codex hook and Node executable paths must be absolute');
  }
  if (!win32.isAbsolute(powershellPath) || /["\r\n]/.test(powershellPath)) {
    throw new Error('Codex Windows hook interpreter must be an absolute executable path');
  }
  if (auditFile !== undefined && (typeof auditFile !== 'string' || !isAbsolute(auditFile))) throw new Error('Codex audit path must be absolute');
  const command = `${posixQuote(nodePath.replaceAll('\\', '/'))} ${posixQuote(hookFile.replaceAll('\\', '/'))}`
    + (auditFile ? ` ${posixQuote(auditFile.replaceAll('\\', '/'))}` : '');
  // Explicit stdin forwarding and UTF-8 avoid PowerShell's default text encoding. The encoded
  // script carries literal paths safely through either cmd.exe or PowerShell as the outer shell.
  const script = '$OutputEncoding=[Text.UTF8Encoding]::new(); '
    + '$hookPayload=[Console]::In.ReadToEnd(); $hookPayload | & '
    + `${powershellQuote(nodePath)} ${powershellQuote(hookFile)}`
    + (auditFile ? ` ${powershellQuote(auditFile)}` : '') + '; exit $LASTEXITCODE';
  // Do not search PATH or the agent's current directory for the interpreter.
  const windowsExe = powershellPath.replaceAll('\\', '/');
  const quotedExe = /[\s&|<>^()%]/.test(windowsExe) ? `"${windowsExe}"` : windowsExe;
  const commandWindows = `${quotedExe} -NoProfile -NonInteractive -EncodedCommand `
    + Buffer.from(script, 'utf16le').toString('base64');
  return { hooks: { PreToolUse: [{ matcher: '*', hooks: [
    { type: 'command', command, commandWindows, timeout: 15 },
  ] }] } };
}
