import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeSecretFile, pickSecretFiles } from '../../core/secret-notice.mjs';

// An explicit user decision: THERE IS NO BAN ON COMMITTING SECRETS. The ability to commit a key
// is fully preserved — the module only reports. We check that it recognises what matters and
// stays quiet on harmless files (noise is worse than silence: nobody reads a noisy warning).

test('recognises key storage files', () => {
  for (const f of ['.env', '.env.local', '.env.production', 'config/.env',
    '.npmrc', '.netrc', '.git-credentials', 'id_rsa', 'certs/server.pem',
    'credentials.json', 'auth.json', 'service-account-prod.json', 'app.key', 'secrets.yml']) {
    assert.equal(looksLikeSecretFile(f), true, `must be recognised: ${f}`);
  }
});

test('stays quiet on harmless files', () => {
  for (const f of ['.env.example', '.env.sample', '.env.template', 'README.md',
    'src/index.mjs', 'package.json', 'docs/STATE.md', 'keyboard.mjs', 'monkey.py']) {
    assert.equal(looksLikeSecretFile(f), false, `must not be recognised: ${f}`);
  }
});

test('empty and non-string input', () => {
  assert.equal(looksLikeSecretFile(''), false);
  assert.equal(looksLikeSecretFile(null), false);
  assert.equal(looksLikeSecretFile(42), false);
});

test('selection from a list of committed files', () => {
  const found = pickSecretFiles(['src/a.mjs', '.env', 'README.md', 'config/.env.local']);
  assert.deepEqual(found, ['.env', 'config/.env.local']);
});

test('paths with backslashes (Windows) are parsed too', () => {
  // the backslash is built from a character code: in source it is easy to lose during
  // escaping, after which the test would check something other than intended.
  const path = 'config' + String.fromCharCode(92) + '.env';
  assert.equal(looksLikeSecretFile(path), true);
});
