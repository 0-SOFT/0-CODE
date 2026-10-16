import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

// The export language gate had no tests at all, which is why its hole survived to v1.19.0: it
// selected files BY EXTENSION, so a name with no extension matched nothing in the list and was
// never looked at. Measured on the real tree - the gate announced "0 files with untranslated text"
// while `.gitattributes` held 212 matches of the alphabet it forbids, ready to go public.
//
// Same shape as the guard defect fixed one release earlier: a rule written against the FORM OF THE
// NAME when the danger is in the content.
//
// WHY THE GUARD AROUND THE IMPORT. `tools/export-public.mjs` is deliberately NOT published - it is
// how the public tree is built, not part of it - while `tests/` is. A test that imported it
// unconditionally would pass where it was written and fail where it is used, which is exactly the
// blind spot v1.12.0 recorded and v1.18.1 repeated. So the suite says out loud that it skipped.
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const TOOL = join(ROOT, 'tools', 'export-public.mjs');
const present = existsSync(TOOL);
// An absolute Windows path is not a module specifier - v1.18.0 recorded exactly this mistake, and
// the recording did not stop it being made again. pathToFileURL is the only portable form.
const TOOL_URL = pathToFileURL(TOOL).href;
const skip = present ? false : 'the export tool is not part of the published tree';

const cfg = { pattern: '[\\u0400-\\u04FF]', allowed_exceptions: [] };

// The forbidden alphabet is built from code points rather than written out, so that this file -
// which is itself published - does not contain the very thing it tests for. Writing the sample
// literally is how the first version of this test smuggled fifteen of them into the public tree.
const FORBIDDEN = String.fromCharCode(0x440, 0x443, 0x441, 0x441, 0x43a, 0x438, 0x439);
const NUL = String.fromCharCode(0);

test('a file with no extension is checked, not skipped', { skip }, async () => {
  const { scanLanguage } = await import(TOOL_URL);
  for (const name of ['.gitattributes', 'LICENSE', 'hooks/ralph-loop-stop', 'config/.env.example']) {
    const hit = scanLanguage(`# ${FORBIDDEN}\n`, cfg, name);
    assert.ok(hit, `${name} must be checked - it is published, and its name says nothing about that`);
    assert.equal(hit.first.line, 1, 'and the report must point at the line');
  }
});

test('ordinary source and documentation are still checked', { skip }, async () => {
  const { scanLanguage } = await import(TOOL_URL);
  for (const name of ['core/gates.mjs', 'README.md', 'config/x.json', 'tests/smoke.sh']) {
    assert.ok(scanLanguage(`const x = "${FORBIDDEN}";\n`, cfg, name), `${name} must be checked`);
  }
});

test('English text passes, whatever the file is called', { skip }, async () => {
  const { scanLanguage } = await import(TOOL_URL);
  for (const name of ['.gitattributes', 'LICENSE', 'core/gates.mjs', 'README.md']) {
    assert.equal(scanLanguage('# ordinary English text\n', cfg, name), null, `${name} must pass`);
  }
});

test('a known binary extension is skipped, because it has no language to check', { skip }, async () => {
  const { scanLanguage } = await import(TOOL_URL);
  assert.equal(scanLanguage(FORBIDDEN, cfg, 'docs/logo.png'), null);
  assert.equal(scanLanguage(FORBIDDEN, cfg, 'docs/font.woff2'), null);
});

// THE HOLE THIS FIX ALMOST SHIPPED WITH, found by running the fixed gate against the tree it had
// just been fixed for. Deciding "is this text?" by looking for a NUL byte means a file that is text
// in every other respect but happens to contain one is silently skipped - and the first version of
// this very test file contained a real NUL, so the gate looked straight past its untranslated
// fixtures and called the tree clean.
//
// The root is not the NUL. It is that "no verdict" and "clean" were the same answer, which is the
// distinction v1.13.0 exists for and v1.18.0 repeated. A file that is neither plainly text nor a
// known binary is now REPORTED rather than skipped: a source file carrying a NUL byte is wrong on
// its own account, and a gate that cannot read something must say so instead of passing it.
test('a file that is neither plainly text nor a known binary is reported, never skipped', { skip }, async () => {
  const { scanLanguage } = await import(TOOL_URL);
  const hit = scanLanguage(`const x = "${FORBIDDEN}";${NUL}\n`, cfg, 'tests/unit/whatever.test.mjs');
  assert.ok(hit, 'silence here would mean "clean", and it does not');
  assert.match(String(hit.first.text), /binary|not readable as text/i,
    'and the reason must say the file could not be read, not pretend it was checked');
});

// ALLOWED LITERALS (v1.21.0). Ten translated READMEs each carry a language table naming languages by
// their endonym — the name a language uses for itself, because a reader scans that list for their own
// word, not for an English one. One endonym is written in the forbidden alphabet, and the gate
// correctly stopped the export on all eleven files at once.
//
// The fix had to be narrow. Excusing README.md by path would have dropped the check on the most
// important file in the tree, so the next untranslated paragraph landing there would ship in silence.
// Loosening the pattern would have been worse still: this gate exists precisely because a rule
// written against the FORM of a thing lets dangerous CONTENT through.
//
// So the exception is a list of literals, and these tests pin the property that makes it safe: the
// word is excused, the language is not.
const ENDONYM = String.fromCharCode(0x0420, 0x0443, 0x0441, 0x0441, 0x043a, 0x0438, 0x0439);
const withLiterals = { ...cfg, allowed_literals: [ENDONYM] };

test('an allowed literal does not trip the gate', { skip }, async () => {
  const { scanLanguage } = await import(TOOL_URL);
  const line = `**Read this in your language:** [${ENDONYM}](README.ru.md)\n`;
  assert.equal(scanLanguage(line, withLiterals, 'README.md'), null);
});

test('the same literal still trips the gate when the list is empty', { skip }, async () => {
  // Otherwise this test would pass for the wrong reason and prove nothing about the allowance.
  const { scanLanguage } = await import(TOOL_URL);
  assert.ok(scanLanguage(`[${ENDONYM}](README.ru.md)\n`, cfg, 'README.md'));
});

test('a sentence around an allowed literal is still caught', { skip }, async () => {
  // The whole point: the word is excused, not the language. Everything else in the sentence remains
  // forbidden, so a real untranslated paragraph cannot hide behind one permitted word.
  const { scanLanguage } = await import(TOOL_URL);
  const sentence = `${FORBIDDEN} ${ENDONYM} ${FORBIDDEN}\n`;
  const hit = scanLanguage(sentence, withLiterals, 'README.md');
  assert.ok(hit, 'an allowed word must not launder the text around it');
});

test('allowed literals do not shift the reported line number', { skip }, async () => {
  // The literal is blanked with a same-length filler rather than removed, so the line numbers the
  // report prints still point at the real place in the file.
  const { scanLanguage } = await import(TOOL_URL);
  const text = `line one\n[${ENDONYM}](README.ru.md)\nline three\n${FORBIDDEN}\n`;
  const hit = scanLanguage(text, withLiterals, 'README.md');
  assert.ok(hit);
  assert.equal(hit.first.line, 4);
});
