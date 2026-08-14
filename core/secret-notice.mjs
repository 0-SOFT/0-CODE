// core/secret-notice.mjs — a notice about secrets in a commit (v1.5.0). IT NEVER BLOCKS.
//
// AN EXPLICIT USER DECISION: there is no ban on committing secrets and there will not be one.
// The ability to commit a key is fully preserved — sometimes it is done deliberately. Our job is
// to inform, not to obstruct. This is the same principle adopted in v1.2.1: autonomy comes first
// and the decision stays with the human.
//
// WHY THIS EXISTS AT ALL. A real case from v1.4.0: in one production repository the `.env` file
// turned out to be TRACKED by git, and an agent running `git add -A` would have committed a key
// into it — the only thing that prevented it was a human noticing. One line in the log is cheap
// and turns "nobody found out" into "the human knows and decides".
//
// HOW IT WORKS. The check runs AFTER a turn, against the commits that actually appeared: this is
// observation, not authorisation. No execution path can be interrupted by this module — by design.

import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

// Names that in the vast majority of projects mean "key storage".
// The list is deliberately narrow: a broad one would produce false positives, and the price of
// noise is that the warning stops being read.
const SUSPICIOUS = [
  /^\.env$/i, /^\.env\..+/i, /^env$/i,
  /^\.npmrc$/i, /^\.pypirc$/i, /^\.netrc$/i, /^\.git-credentials$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)$/i, /\.pem$/i, /\.pfx$/i, /\.p12$/i, /\.key$/i,
  /^credentials(?:\.json|\.yml|\.yaml)?$/i,
  /^service-account.*\.json$/i,
  /^auth\.json$/i,
  /(?:^|[-_.])secrets?(?:\.json|\.yml|\.yaml|\.txt)?$/i,
];

/** Does the file name look like key storage? Pure function. */
export function looksLikeSecretFile(path) {
  if (!path || typeof path !== 'string') return false;
  const name = basename(path.trim().replace(/\\/g, '/'));
  if (!name) return false;
  // Examples and templates are not secrets: they are committed on purpose.
  if (/\.(?:example|sample|template|dist)$/i.test(name)) return false;
  if (/^\.env\.(?:example|sample|template)$/i.test(name)) return false;
  return SUSPICIOUS.some((p) => p.test(name));
}

/** Select suspicious paths from a list. Pure function. */
export function pickSecretFiles(files = []) {
  return files.filter(looksLikeSecretFile);
}

/** Files that appeared in commits between two repository states. */
export function filesInRange(cwd, fromHead, toHead) {
  if (!fromHead || !toHead || fromHead === toHead) return [];
  const r = spawnSync('git', ['diff', '--name-only', `${fromHead}..${toHead}`],
    { cwd, encoding: 'utf8', timeout: 20000 });
  if (!r || r.status !== 0) return [];
  return String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * Post-turn observation: did any files that look like key storage end up in the commits?
 * BLOCKS NOTHING — it only returns the warning text (or null).
 */
export function noticeAfterTurn({ cwd = process.cwd(), before, after } = {}) {
  const files = pickSecretFiles(filesInRange(cwd, before?.gitHead, after?.gitHead));
  if (files.length === 0) return null;
  return {
    files,
    message: `files that look like key storage were committed: ${files.join(', ')}. `
      + 'Work was not interrupted (there is deliberately no ban) — if this was unintended, treat '
      + 'the keys as exposed: rotate them and purge them from history.',
  };
}
