#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProjectRoot, loadProjectConfig, resolveProjectPath } from '../core/project-config.mjs';

export function projectContext(event, { env = process.env, cwd = process.cwd() } = {}) {
  if (!['SessionStart', 'SubagentStart'].includes(event?.hook_event_name)) throw new Error('Unsupported project context event');
  const projectDir = env.CLAUDE_PROJECT_DIR || findProjectRoot(event.cwd || cwd);
  const project = loadProjectConfig({ projectDir, env });
  if (!project.installed) throw new Error('Installed project configuration is required');
  if (!project.config.engines.includes('claude') || project.config.instructions.claude !== 'session-hook') return {};
  const file = resolveProjectPath(project.projectDir, '.0-code/AGENT.md', { allowFramework: true });
  const bytes = readFileSync(file), content = bytes.toString('utf8');
  if (!content.trim() || !Buffer.from(content).equals(bytes) || content.includes('\0')) throw new Error('Project context must be nonempty UTF-8 text');
  return { hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: content } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(projectContext(JSON.parse(readFileSync(0, 'utf8')))) + '\n'); }
  catch (error) { process.stderr.write(`project-context: ${error.message}\n`); process.exitCode = 1; }
}
