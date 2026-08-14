// core/safety.mjs — MINIMAL protection against irreversible damage (v1.2.1).
//
// WHY THIS WAS REBUILT. In v1.2.0 the rule set had grown, and a measurement showed that 7 out of
// 11 everyday development commands were blocked by mistake (searching for text in the codebase, a
// commit message, cleaning a build directory, `npm publish --dry-run`, `git clean -fdx`,
// `git reset --hard origin/main`, killing a stuck process). Every false positive costs the loop a
// turn, and three in a row become a blocker under the framework's own rules. In other words, the
// protection had started to fight the very thing the framework exists for: autonomy.
//
// SELECTION CRITERION (first principles). A rule stays only if BOTH hold:
//   (a) the consequence is unrecoverable and reaches beyond the working directory — you lose the
//       machine, shared history, or the loop itself;
//   (b) there is essentially no legitimate use for it inside an autonomous development loop, so
//       keeping the rule costs autonomy nothing.
// Everything that fails either condition was removed DELIBERATELY: losses inside a repository are
// recoverable from git, and the price of false refusals is higher than the benefit.
//
// WHAT REMAINS (4 rules):
//   1. destroying the filesystem (root, home directory) — POSIX and Windows;
//   2. formatting or wiping a disk;
//   3. mass-killing claude/node processes by image name — that is the loop committing suicide,
//      so here the protection works FOR autonomy rather than against it;
//   4. force-rewriting shared history (`git push --force`).
//
// WHAT WAS REMOVED and why: `git reset --hard`, `git clean -fd`, `git checkout -- .` (the loss is
// recoverable from git and these are routine), `chmod 777`, `npm publish`, `docker system prune`,
// `kubectl delete`, SQL `DROP`, `--no-verify` (they fired on plain text and on legitimate
// operations while preventing no catastrophe).
//
// The command is split on the same separators Claude Code uses (&&, ||, ;, |, &, newline), the
// split respects quoting (see splitSegments), and each segment is checked by its "head" — so text
// inside quotes does not trigger a false positive.

// Strip leading env assignments and harmless wrappers to reach the "head" of the command.
export function head(seg) {
  let s = seg;
  // KEY=val ... (repeatable)
  s = s.replace(/^(?:[A-Za-z_][\w]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, '');
  // process wrappers
  s = s.replace(/^(?:nohup|time|stdbuf(?:\s+-\S+)*|nice(?:\s+-n\s+\d+)?|ionice(?:\s+-\S+)*|timeout\s+\S+)\s+/i, '');
  // sudo is a prefix, not a command of its own — look at what follows it
  s = s.replace(/^sudo\s+(?:-\S+\s+)*/i, '');
  return s.trim();
}

// A target whose destruction means losing the machine: the filesystem root, a drive root, or the
// entire home directory. A path like `~/projects/build` or `C:\project\build` does NOT match —
// that is a working directory and cleaning it is legitimate.
const FATAL_TARGET =
  /(?:^|\s)["']?(?:\/|\/\*|~|~\/\*|\$HOME(?:\/\*)?|\$\{HOME\}(?:\/\*)?|[A-Za-z]:[\\/]\*?|%USERPROFILE%|\$env:USERPROFILE)["']?(?:\s|$)/i;

// Destructive check for a SINGLE segment. Returns a reason or null.
export function segmentReason(rawSeg) {
  const seg = head(rawSeg);

  // 1. Filesystem destruction — POSIX (`rm -r` targeting root or home).
  if (/^rm\b/i.test(seg) && /(?:^|\s)-\w*r/i.test(seg) && FATAL_TARGET.test(seg))
    return 'deleting the root or home directory in full — the machine will not recover';

  // 1b. The same thing in Windows syntax.
  if (/^(?:remove-item|ri|rd|rmdir|del|erase)\b/i.test(seg) && FATAL_TARGET.test(seg))
    return 'deleting a drive root or the entire home folder — the machine will not recover';

  // 2. Formatting and wiping disks — irreversible whatever the target.
  if (/^(?:format-volume|clear-disk|format|mkfs(?:\.\w+)?|diskpart)\b/i.test(seg))
    return 'formatting or wiping a disk';

  // 3. Mass-killing agent processes by IMAGE NAME: this takes down every Claude Code session and
  //    the supervisor itself — i.e. it cuts the loop. Killing one process by id
  //    (`taskkill /PID 1234`, `kill 4321`) is legitimate and left alone.
  if (/^taskkill\b/i.test(seg) && /(?:^|\s)\/im\s+\S*(?:claude|node)/i.test(seg))
    return 'taskkill by claude/node image name would kill EVERY session and the loop itself — use /PID';
  if (/^(?:pkill|killall)\b/i.test(seg) && /(?:^|\s)(?:claude|node)(?:\s|$)/i.test(seg))
    return 'pkill/killall by claude/node name would kill EVERY session and the loop itself — use a process id';

  // 4. Force-rewriting shared history: this machine is not the only victim.
  if (/^git\s+push\b/i.test(seg) && /(?:^|\s)(--force\b|--force-with-lease\b|-f\b)/i.test(seg))
    return 'git push that force-overwrites shared history';

  return null;
}

// Split a command line into segments on shell separators, IGNORING separators inside quotes.
//
// This used to be a plain `String.split` on the separator characters, and the comment above claimed
// that quoting protected against false positives. It did not. `grep -iE "rule|mkfs|reset" file`
// was split at the pipes inside the regex, which made `mkfs` the head of a segment, and the search
// was refused as "formatting or wiping a disk". That is not a hypothetical: it happened during the
// documentation audit of v1.6.0 and cost a turn — the precise cost that justifies keeping the
// ruleset small in the first place.
//
// Text inside quotes is an argument, not a command, so the shell will not execute it either.
export function splitSegments(command) {
  const out = [];
  let cur = '', quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      // Inside double quotes a backslash still escapes; inside single quotes it does not.
      if (ch === '\\' && quote === '"' && i + 1 < command.length) { cur += ch + command[++i]; continue; }
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === ';' || ch === '\n' || ch === '&' || ch === '|') {
      if ((ch === '&' || ch === '|') && command[i + 1] === ch) i++;   // && and || are one separator
      out.push(cur); cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}

// Interpreters that EXECUTE what they read from a heredoc. For these the body stays under scrutiny.
const SHELL_INTERPRETER = /^(?:bash|sh|zsh|dash|ksh)\b/i;

// Heredoc bodies are data, not commands — a Python script, a file being written, a commit message.
// Scanning them as shell text is how quote state gets inverted: a stray apostrophe inside the body
// flips the parser, and pipes several lines later are read as separators. That is how the guard came
// to refuse a `grep` during the v1.6.0 audit even after the splitter was taught about quotes.
//
// The exception is a body that is genuinely executed (`bash <<'EOF'`), which stays in scope: the
// point is to check commands, and there the body IS commands.
export function stripHeredocBodies(command) {
  const lines = command.split('\n');
  const kept = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    kept.push(line);
    i++;
    const opener = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(line);
    if (!opener) continue;
    const marker = opener[2];
    const lastSegment = line.split(/&&|\|\||;|\||&/g).pop() || '';
    const executed = SHELL_INTERPRETER.test(head(lastSegment.trim()));
    const body = [];
    while (i < lines.length && lines[i].trim() !== marker) { body.push(lines[i]); i++; }
    if (executed) kept.push(...body);
    if (i < lines.length) { kept.push(lines[i]); i++; }   // the terminator line itself
  }
  return kept.join('\n');
}

// Main API: the reason the WHOLE command is destructive (first dangerous segment), or null.
export function destructiveReason(command) {
  if (!command || typeof command !== 'string') return null;
  const segments = splitSegments(stripHeredocBodies(command));
  for (const seg of segments) {
    const r = segmentReason(seg);
    if (r) return r;
  }
  return null;
}
