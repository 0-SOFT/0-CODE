import { runCliAsync } from './spawn-cli.mjs';
import { classifyFailure } from '../turn-retry.mjs';

const record = value => value && typeof value === 'object' && !Array.isArray(value);

// Only return instruction metadata. The native response can contain MCP credentials and
// must never be persisted, logged or attached to a model-turn result.
export function codexInstructionConfig(response) {
  const config = response?.result?.config, layers = response?.result?.layers;
  if (!record(config) || !Array.isArray(layers)) throw new Error('Invalid Codex instruction configuration response');
  const names = key => {
    const value = config[key];
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) || value.some(name => typeof name !== 'string')) {
      throw new Error('Invalid Codex instruction configuration response');
    }
    return [...value];
  };
  return { fallbackFilenames: names('project_doc_fallback_filenames') || [],
    rootMarkers: names('project_root_markers') ?? ['.git'],
    projectDocMaxBytes: config.project_doc_max_bytes,
    inlineInstructionBudget: layers.some(layer => layer.name?.type === 'sessionFlags'
      && record(layer.config) && Object.hasOwn(layer.config, 'project_doc_max_bytes')),
    inheritedInstructionBudget: layers.some(layer => record(layer.config)
      && layer.name?.type !== 'default' && Object.hasOwn(layer.config, 'project_doc_max_bytes')) };
}

export async function inspectCodexInstructionConfig({ command, cwd, env, config = [] }) {
  let io, pending = '', response;
  const send = message => io.write(JSON.stringify(message) + '\n');
  const result = await runCliAsync(command.bin, [...command.args, ...config.flatMap(value => ['-c', value]),
    'app-server', '--stdio'], { cwd, env, encoding: 'utf8', timeoutMs: 30000, maxBuffer: 64 * 1024 * 1024,
    input(writer) {
      io = writer;
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'framework-instructions', version: '1.0' },
        capabilities: { experimentalApi: true } } });
    },
    onChunk(chunk) {
      pending += chunk;
      for (;;) {
        const end = pending.indexOf('\n'); if (end < 0) break;
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) { response = message; io.end(); continue; }
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: 'config/read', params: { includeLayers: true, cwd } });
        } else if (message.id === 2) { response = message; io.end(); }
      }
    } });
  if (result.cleanupRefused) throw new Error('Child cleanup refused: configuration inspection could not verify process ownership');
  if (result.timedOut) throw new Error('Codex instruction configuration inspection timed out');
  if (result.status !== 0 || response?.error || !response || result.truncated) {
    const kind = classifyFailure(response?.error?.message || result.stderr);
    if (kind === 'transient') throw new Error('Network error during Codex instruction configuration inspection');
    throw new Error('Invalid Codex instruction configuration response');
  }
  return codexInstructionConfig(response);
}
