// Translations of README.md, and the one thing that makes them safe to have.
//
// WHY THIS MODULE EXISTS (v1.21.0). A translation is a copy of a claim with no expiry date. This
// project has spent three releases on exactly that shape of defect — a cached value that drifts
// away from its source in silence (v1.7.0, v1.14.0, v1.16.0). Ten translated READMEs are ten more
// copies, and the English one changes every release. Without a mechanism the project would end up
// making different claims in different languages, and nobody would find out from the inside.
//
// WHAT IS CHECKED, AND WHAT IS DELIBERATELY NOT. Each translation records the digest of the English
// README it was made from. When README.md changes, every translation still pointing at the old
// digest is reported as stale. That is all. The check does not translate, does not grade the prose,
// and cannot tell a re-stamped marker from real work — a maintainer who edits the marker without
// touching the text defeats it in one line.
//
// That limit is named rather than hidden, because the alternative is worse. A guard that tried to
// judge translation quality would be unfalsifiable, and an unfalsifiable guard is the thing this
// project keeps finding in its own gates. What this one buys is narrow and real: drift cannot be
// SILENT. Somebody has to look.
//
// WHY A DIGEST AND NOT A VERSION NUMBER. A version number only moves at a release, so a README
// corrected between releases would drift with every translation still claiming to be current. The
// digest moves whenever the text does, which is the question actually being asked.

import { createHash } from 'node:crypto';

// Twelve hex characters. Long enough that an accidental collision is not a practical concern for a
// handful of files, short enough to sit in a header line a human will read and retype.
export const DIGEST_LENGTH = 12;

const MARKER_RE = /<!--\s*tracks:\s*(\S+)\s+sha256:([0-9a-f]+)\s*-->/;

// Line endings are normalised before hashing. Without this the same file produces two different
// digests depending on which platform checked it out, and the guard would turn red on Windows for
// everyone who did nothing wrong.
//
// v1.22.0: the release number in the `**Version:**` header is masked before hashing. It changes at
// every release and carries no meaning to translate, so the first release after 1.21.0 reported all
// ten translations stale over one digit — and the only way out was re-stamping the markers without
// work, the one move this guard cannot see through. The number has its own exact check instead
// (tests/unit/blind-spots.test.mjs compares every README header with plugin.json). Only the number
// is masked: the other words of that line still count. See docs/decisions/1.22.0_version-line-digest.md.
const VERSION_STAMP_RE = /(\*\*Version:\*\*\s*)v?\d+\.\d+\.\d+/;

export function digestOf(text) {
  const normalised = String(text).replace(/\r\n/g, '\n').replace(VERSION_STAMP_RE, '$1v#.#.#');
  return createHash('sha256').update(normalised, 'utf8').digest('hex').slice(0, DIGEST_LENGTH);
}

// Returns { source, digest } or null when the file carries no marker at all.
export function readMarker(text) {
  const m = MARKER_RE.exec(String(text));
  if (!m) return null;
  return { source: m[1], digest: m[2] };
}

export function markerFor(source, digest) {
  return `<!-- tracks: ${source} sha256:${digest} -->`;
}

// englishText: the contents of README.md.
// translations: [{ path, text }].
//
// Every translation gets a verdict, including the good ones — a list that only ever contains
// problems cannot distinguish "all fine" from "nothing was examined", and this project has already
// shipped one gate that reported success while measuring zero files.
export function reviewTranslations(englishText, translations, sourceName = 'README.md') {
  const expected = digestOf(englishText);
  const results = [];
  for (const { path, text } of translations) {
    const marker = readMarker(text);
    if (!marker) results.push({ path, state: 'no-marker' });
    else if (marker.source !== sourceName) results.push({ path, state: 'wrong-source', found: marker.source });
    else if (marker.digest !== expected) results.push({ path, state: 'stale', found: marker.digest });
    else results.push({ path, state: 'current' });
  }
  return { expected, results };
}

export function staleOnes(review) {
  return review.results.filter(r => r.state !== 'current');
}

export function summariseProblems(review) {
  return staleOnes(review)
    .map(r => {
      if (r.state === 'no-marker') return `${r.path} (no tracks marker)`;
      if (r.state === 'wrong-source') return `${r.path} (tracks ${r.found}, not the README)`;
      return `${r.path} (made from ${r.found}, README is now ${review.expected})`;
    })
    .join('; ');
}
