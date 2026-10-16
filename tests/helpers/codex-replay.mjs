// An actual child process replaying captured CLI stdout. This verifies transport and the
// supervisor integration; it is deliberately NOT claimed as a live model acceptance run.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from '../../lib/yaml-mini.mjs';
import { CODEX_VERSION } from '../../core/backends/codex.mjs';

const stdout = readFileSync(new URL('../fixtures/codex/0.160.1-ok.jsonl', import.meta.url), 'utf8');
// Version metadata is simulated; the captured 0.160.1 response stays byte-for-byte unchanged.
if (process.argv.includes('--version')) { console.log(`codex-cli ${CODEX_VERSION}`); }
else if (process.argv.includes('login')) { process.stderr.write('Logged in using ChatGPT\n'); }
else {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  if (process.env.CODEX_REPLAY_ERROR) {
    if (process.env.CODEX_REPLAY_PARTIAL) process.stdout.write(stdout.split('\n').slice(0, 2).join('\n') + '\n');
    process.stderr.write(process.env.CODEX_REPLAY_ERROR);
    process.exitCode = 1;
  } else {
    if (input !== 'Reply with one word: OK') {
      const file = join(process.cwd(), 'docs', 'STATE.md');
      const state = parseYaml(readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
      writeFileSync(join(process.cwd(), `work-${state.iteration}.txt`), input + '\n' + JSON.stringify(process.argv.slice(2)));
      if (process.env.CODEX_REPLAY_RELEASE && state.iteration >= 1) {
        const update = fileURLToPath(new URL('../../lib/update-state.mjs', import.meta.url));
        const result = spawnSync(process.execPath, [update, file], {
          input: JSON.stringify({ released_version: state.current_version }), encoding: 'utf8',
        });
        if (result.status !== 0) throw new Error(result.stderr);
      }
    }
    process.stdout.write(stdout);
  }
}
