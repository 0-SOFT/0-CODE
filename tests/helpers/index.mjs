// tests/helpers/index.mjs — shared test fixtures (DRY). Zero dependencies.

import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseYaml } from '../../lib/yaml-mini.mjs';

// Create a temporary project with docs/STATE.md built from the given frontmatter object.
// Returns { dir, stateFile, cleanup() }. The caller must invoke cleanup() in t.after.
export function mkTempProject(frontmatter = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ralph-test-'));
  const fm = {
    schema_version: 1, project_name: 'test', current_stage: 2, current_version: '0.0.1',
    blockers: [], session_count: 0, iteration: 0, max_iterations: 60, ...frontmatter,
  };
  const body = '---\n' + serializeFm(fm) + '---\n\n# Journal\n';
  mkdirSync(join(dir, 'docs'), { recursive: true });
  const stateFile = join(dir, 'docs', 'STATE.md');
  writeFileSync(stateFile, body, 'utf8');
  return { dir, stateFile, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

// Minimal frontmatter serialisation for fixtures (values are primitives, arrays or objects).
function serializeFm(obj) {
  let out = '';
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) out += v.length === 0 ? `${k}: []\n` : `${k}: ${JSON.stringify(v)}\n`;
    else if (v && typeof v === 'object') out += `${k}: ${JSON.stringify(v)}\n`;
    else if (v === null) out += `${k}: null\n`;
    else out += `${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}\n`;
  }
  return out;
}

// Read the STATE.md frontmatter (through the project's real parser).
export function readFrontmatter(file) {
  const raw = readFileSync(file, 'utf8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  return parseYaml(m[1]);
}

// A fake `claude --output-format json` stdout (for testing parseClaudeJson without the CLI).
export function fakeClaudeJson({ result = 'ok', session_id = 'sess1', total_cost_usd = 0.01 } = {}) {
  return JSON.stringify({ result, session_id, total_cost_usd });
}

