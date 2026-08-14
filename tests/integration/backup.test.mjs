import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotateBackups, MAX_BACKUPS } from '../../lib/backup.mjs';

test('rotateBackups: the first backup equals the current file', () => {
  const d = mkdtempSync(join(tmpdir(), 'bak-'));
  const f = join(d, 'STATE.md');
  try {
    writeFileSync(f, 'v1', 'utf8');
    rotateBackups(f);
    assert.equal(readFileSync(`${f}.bak.1`, 'utf8'), 'v1');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('rotateBackups: shifts .bak.1 → .bak.2', () => {
  const d = mkdtempSync(join(tmpdir(), 'bak-'));
  const f = join(d, 'STATE.md');
  try {
    writeFileSync(f, 'v1', 'utf8'); rotateBackups(f);   // bak.1=v1
    writeFileSync(f, 'v2', 'utf8'); rotateBackups(f);   // bak.1=v2, bak.2=v1
    assert.equal(readFileSync(`${f}.bak.1`, 'utf8'), 'v2');
    assert.equal(readFileSync(`${f}.bak.2`, 'utf8'), 'v1');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('rotateBackups: honours max (the oldest are pushed out)', () => {
  const d = mkdtempSync(join(tmpdir(), 'bak-'));
  const f = join(d, 'STATE.md');
  try {
    for (let i = 1; i <= 5; i++) { writeFileSync(f, `v${i}`, 'utf8'); rotateBackups(f, 3); }
    assert.ok(existsSync(`${f}.bak.1`));
    assert.ok(existsSync(`${f}.bak.3`));
    assert.ok(!existsSync(`${f}.bak.4`), 'bak.4 must not exist when max=3');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('rotateBackups: MAX_BACKUPS defaults to 5', () => {
  const d = mkdtempSync(join(tmpdir(), 'bak-'));
  const f = join(d, 'STATE.md');
  try {
    for (let i = 1; i <= 7; i++) { writeFileSync(f, `v${i}`, 'utf8'); rotateBackups(f); }
    assert.equal(MAX_BACKUPS, 5);
    assert.ok(existsSync(`${f}.bak.${MAX_BACKUPS}`));
    assert.ok(!existsSync(`${f}.bak.${MAX_BACKUPS + 1}`));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('rotateBackups: a missing file does not crash it (best effort)', () => {
  const d = mkdtempSync(join(tmpdir(), 'bak-'));
  try {
    assert.doesNotThrow(() => rotateBackups(join(d, 'missing.md')));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
