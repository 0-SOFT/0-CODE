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
// A rule's level decides what the guard may do about it (v1.11.0).
//
//   hard        — refusing is the only right answer. There is no task context in which destroying
//                 the machine or cutting the loop is correct, so asking the agent to argue for it
//                 could only ever produce a wrong answer, and would add risk for nothing.
//   confirmable — the command has legitimate uses, so the framework does not know better than the
//                 agent does. It names the consequence and asks for a stated reason.
//   advisory    — worth a moment's thought, not worth a refusal. These rules exist ONLY in the
//                 confirm mode: several of them were removed in v1.2.1 because false refusals cost
//                 the loop a turn, and a rewritten command is a far cheaper mistake to make.
export const HARD = 'hard';
export const CONFIRMABLE = 'confirmable';
export const ADVISORY = 'advisory';

// Destructive check for a SINGLE segment. Returns { reason, level } or null.
// `advisory` opts in to the third level; without it the behaviour is exactly what it was in v1.10.0.
export function segmentVerdict(rawSeg, { advisory = false } = {}) {
  const seg = head(rawSeg);

  // 1. Filesystem destruction — POSIX (`rm -r` targeting root or home).
  if (/^rm\b/i.test(seg) && /(?:^|\s)-\w*r/i.test(seg) && FATAL_TARGET.test(seg))
    return { level: HARD, reason: 'deleting the root or home directory in full — the machine will not recover' };

  // 1b. The same thing in Windows syntax.
  if (/^(?:remove-item|ri|rd|rmdir|del|erase)\b/i.test(seg) && FATAL_TARGET.test(seg))
    return { level: HARD, reason: 'deleting a drive root or the entire home folder — the machine will not recover' };

  // 2. Formatting and wiping disks — irreversible whatever the target.
  if (/^(?:format-volume|clear-disk|format|mkfs(?:\.\w+)?|diskpart)\b/i.test(seg))
    return { level: HARD, reason: 'formatting or wiping a disk' };

  // 3. Selecting agent processes BY NAME and killing them: this takes down every Claude Code
  //    session and the supervisor itself — i.e. it cuts the loop. Killing ONE process by its id
  //    (`taskkill /PID 1234`, `Stop-Process -Id 1234`, `kill 4321`) is legitimate and left alone.
  //
  //    v1.18.1 — WHAT THIS RULE USED TO MISS, and what it cost. It matched only `/IM`, so on
  //    2026-09-01 an agent in this project ran
  //
  //        taskkill //FI "IMAGENAME eq claude.exe" //F
  //
  //    the guard ALLOWED it, and a Claude Code session belonging to an unrelated project died mid
  //    tool call. Neither half of that spelling is exotic: MSYS/git-bash requires the doubled slash
  //    on Windows so the shell does not rewrite the flag into a path, and `/FI IMAGENAME eq` is the
  //    documented filter syntax. A HARD rule with a hole in the one shell this loop actually runs
  //    in is not a rule.
  //
  //    So the rule is stated at the level of the danger rather than of the spelling: what is
  //    forbidden is SELECTING PROCESSES BY NAME. Which flag expresses the selection is an accident
  //    of the command line, and the next accident will have a different spelling again.
  const flag = (name) => new RegExp(`(?:^|\\s)/{1,2}${name}\\b`, 'i');
  const namesAgent = /(?:claude|node)(?:\.exe)?\b/i;
  if (/^taskkill\b/i.test(seg)) {
    const byImage = flag('im').test(seg) && namesAgent.test(seg.replace(/(?:^|\s)\/{1,2}pid\b[^\s]*\s*\S*/gi, ''));
    // The filter form names the selector in its VALUE rather than in the flag.
    const byFilter = /imagename\s*(?:eq|ne)\s*['"]?\s*(?:claude|node)/i.test(seg);
    if (byImage || byFilter) {
      return { level: HARD, reason: 'taskkill selecting claude/node by name would kill EVERY session and the loop itself — use /PID with one process id' };
    }
  }
  // PowerShell is the other shell on this platform, and -Name is its image-name selector.
  if (/^stop-process\b/i.test(seg) && /(?:^|\s)-name\b/i.test(seg) && namesAgent.test(seg))
    return { level: HARD, reason: 'Stop-Process -Name claude/node would kill EVERY session and the loop itself — use -Id with one process id' };
  if (/^(?:pkill|killall)\b/i.test(seg) && /(?:^|\s)(?:claude|node)(?:\s|$)/i.test(seg))
    return { level: HARD, reason: 'pkill/killall by claude/node name would kill EVERY session and the loop itself — use a process id' };

  // 4. Force-rewriting shared history: this machine is not the only victim.
  //
  //    `--force-with-lease` is deliberately NOT matched (v1.11.0). It refuses to overwrite anything
  //    that appeared after your last fetch, which makes it the careful form and the ordinary way to
  //    push a rebased branch of your own. Blocking it alongside the blind form cost a turn on a
  //    routine operation while preventing nothing.
  if (/^git\s+push\b/i.test(seg) && /(?:^|\s)(--force(?!-with-lease)\b|-f\b)/i.test(seg))
    return { level: CONFIRMABLE, reason: 'git push that force-overwrites shared history' };

  if (!advisory) return null;

  // --- Advisory rules: the confirm mode only ----------------------------------------------------
  //
  // Each of these was either dropped in v1.2.1 as too expensive to refuse, or was never expressible
  // as a refusal at all. They live here because asking an agent to think costs a rewritten command,
  // where refusing costs a turn — and three lost turns end the loop.

  // Wiping untracked files. This is how an agent once deleted its OWN guard plugin and carried on
  // without it (v1.3.0) — the incident behind restoring the scaffolding before every turn.
  if (/^git\s+clean\b/i.test(seg) && /(?:^|\s)-\w*[fd]/i.test(seg))
    return { level: ADVISORY, reason: 'git clean removes untracked files — they are not in git, so git cannot give them back' };

  // Discarding uncommitted work in one move.
  if (/^git\s+reset\b/i.test(seg) && /(?:^|\s)--hard\b/i.test(seg))
    return { level: ADVISORY, reason: 'git reset --hard discards uncommitted work, which git cannot give back' };

  // The container then sees the whole machine. Invisible to every rule above, because the dangerous
  // part is an argument to a perfectly ordinary command.
  if (/^docker\b/i.test(seg) && /(?:^|\s)-v\s*["']?(?:\/|[A-Za-z]:[\/])["']?:/i.test(seg))
    return { level: ADVISORY, reason: 'mounting the filesystem root into a container hands it the whole machine' };

  return null;
}

// The v1.10.0 contract, kept as it was: a plain reason string for hard and confirmable rules.
// Used by the OpenCode adapter as well, which is why it is not folded into segmentVerdict.
export function segmentReason(rawSeg) {
  const v = segmentVerdict(rawSeg);
  return v ? v.reason : null;
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

// Waiting inside a turn (v1.13.0). Checked on the WHOLE command rather than per segment, because
// the segment splitter cuts `until …; do sleep 15; done` into three pieces and the loop keyword
// ends up separated from the sleep it drives.
//
// Why advisory and not forbidden: a short pause is sometimes the honest thing, and a refusal costs
// the loop a turn — which is precisely the waste this rule is about. Asking costs a rewritten
// command.
//
// The threshold, chosen from the measurement rather than by feel: in the session that prompted this
// release most sleeps were 5–15 seconds and harmless, while the damage came from 200–900 second
// pauses. A minute is where a pause stops being a pause and becomes a wait — and the loop itself is
// a better timer than `sleep`, because it can do other work between checks.
const LONG_SLEEP_SECONDS = 60;

export function waitingVerdict(command) {
  const text = String(command || '');
  const hasSleep = /(?:^|[\s;&|])sleep\s+\d/i.test(text);

  if (hasSleep && /(?:^|[\s;&|])(?:until|while)\b/i.test(text)) {
    return {
      level: ADVISORY,
      reason: 'a shell loop that polls with sleep blocks the turn — and a turn is the loop\'s only ' +
        'spendable resource. If the job it waits for dies, the loop waits for ever. Start it in the ' +
        'background, record it under running_jobs in docs/STATE.md, and end the turn: the next turn ' +
        'sees whether it is running, finished or dead',
    };
  }

  for (const m of text.matchAll(/(?:^|[\s;&|])sleep\s+(\d+)/gi)) {
    if (Number(m[1]) >= LONG_SLEEP_SECONDS) {
      return {
        level: ADVISORY,
        reason: `sleeping ${m[1]} seconds spends a turn on nothing. Record the work under ` +
          'running_jobs in docs/STATE.md and end the turn — the loop is a better timer than sleep, ' +
          'because it can do other work between checks',
      };
    }
  }
  return null;
}

// Main API: the reason the WHOLE command is destructive (first dangerous segment), or null.
// The v1.10.0 contract, unchanged, including which rules it reports: the OpenCode adapter uses it.
export function destructiveReason(command) {
  const v = destructiveVerdict(command);
  return v ? v.reason : null;
}

// The richer verdict: the reason plus the level that decides what the guard may do about it.
export function destructiveVerdict(command, { advisory = false } = {}) {
  if (!command || typeof command !== 'string') return null;
  const stripped = stripHeredocBodies(command);
  for (const seg of splitSegments(stripped)) {
    const v = segmentVerdict(seg, { advisory });
    if (v) return v;
  }
  // Whole-command rules last: a real danger outranks a note about wasted time.
  return advisory ? waitingVerdict(stripped) : null;
}

// The confirmation an agent attaches to a command it has reconsidered and still wants to run.
//
// It travels IN THE COMMAND rather than in some remembered state, and that is the whole design. The
// hook lives for a fraction of a second per call; remembering a refusal between calls would mean a
// file, keys, an expiry and races — a lot of machinery for one idea. Carrying the confirmation in
// the text costs nothing and buys something better: an agent cannot confirm by repeating itself
// mechanically, it has to rewrite the command and say why, and the reason then lands in the log
// next to what it justified.
//
// Marker: `# safety-guard: confirmed <reason>` — a shell comment, so the command still runs as
// written. Only outside quotes: inside them it is text somebody is echoing, not a decision.
const CONFIRM_MARKER = /(?:^|\s)#\s*safety-guard:\s*confirmed\s+(.+)$/i;

export function confirmationOf(command) {
  if (!command || typeof command !== 'string') return null;
  // Strip quoted runs first, so a marker inside a string cannot pass for a decision.
  let outside = '', quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    outside += ch;
  }
  const m = CONFIRM_MARKER.exec(outside);
  return m ? m[1].trim() : null;
}
