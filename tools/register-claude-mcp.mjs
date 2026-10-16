// Private JSON arrives on stdin; the command line carries only the public server name.
import { registerClaudeMcp } from '../core/backends/claude-mcp.mjs';

try {
  const name = process.argv[2];
  if (process.argv.length !== 3) throw new Error('Invalid arguments');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const entry = JSON.parse(input);
  const result = registerClaudeMcp({ schema_version: 1, servers: [{ ...entry, name }] });
  if (!result.registered.includes(name)) throw new Error('Registration refused');
} catch {
  process.stderr.write('MCP registration failed; configuration was not replaced with empty data\n');
  process.exitCode = 1;
}
