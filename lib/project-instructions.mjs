// The installer and its preview merge the same instruction bytes.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { InstallationPlan, applyInstallationPlan, fileSnapshot } from '../core/installation-transaction.mjs';
import { loadProjectConfig } from '../core/project-config.mjs';

const BEGIN = '<!-- BEGIN AUTONOMOUS FRAMEWORK -->';
const END = '<!-- END AUTONOMOUS FRAMEWORK -->';

export function renderProjectInstructions(template, { projectName, frameworkVersion }) {
  return template.replace(/__(PROJECT_NAME|FRAMEWORK_VERSION)__/g,
    (_match, key) => key === 'PROJECT_NAME' ? projectName : frameworkVersion).trimEnd();
}

export function mergeProjectInstructions(current, rendered) {
  const block = `${BEGIN}\n${rendered}\n${END}`;
  if (!current) return `${block}\n`;
  const starts = current.split(BEGIN).length - 1;
  const ends = current.split(END).length - 1;
  if (!starts && !ends) return `${current}${current.endsWith('\n') ? '\n' : '\n\n'}${block}\n`;
  const start = current.indexOf(BEGIN), end = current.indexOf(END);
  if (starts !== 1 || ends !== 1 || end < start) {
    throw new Error('Project instructions contain incomplete or duplicate framework markers');
  }
  return current.slice(0, start) + block + current.slice(end + END.length);
}

// Legacy adapter entrypoints still preserve project bytes. Installed projects use the common CLI.
export function publishProjectInstructions({ targetDir, filename, content, dryRun = false, maxBytes } = {}) {
  if (!['CLAUDE.md', 'AGENTS.md'].includes(filename) || typeof content !== 'string') throw new Error('Invalid project instructions');
  const root = resolve(targetDir);
  if (loadProjectConfig({ projectDir: root }).installed) throw new Error('Use 0code upgrade to change installed project instructions');
  const snapshot = fileSnapshot(root, filename);
  const current = snapshot.bytes?.toString('utf8') || '';
  if (snapshot.bytes && !Buffer.from(current).equals(snapshot.bytes)) throw new Error('Project instructions are not valid UTF-8; original preserved');
  // Some legacy callers already rendered the complete marked block.
  const rendered = content.includes(BEGIN) ? (() => {
    if (content.split(BEGIN).length !== 2 || content.split(END).length !== 2 || content.indexOf(END) < content.indexOf(BEGIN)) throw new Error('Invalid framework markers');
    return content.slice(content.indexOf(BEGIN) + BEGIN.length, content.indexOf(END)).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  })() : content;
  const merged = mergeProjectInstructions(current, rendered);
  if (maxBytes !== undefined && Buffer.byteLength(merged) > maxBytes) throw new Error('Project instructions exceed the configured limit');
  const plan = new InstallationPlan(root);
  plan.change(filename, merged, { overwrite: true, expectedHash: snapshot.hash });
  plan.assertReady();
  const file = join(root, filename);
  if (dryRun) return { written: [], planned: plan.summary().length ? [file] : [], dryRun: true };
  const result = applyInstallationPlan(plan);
  return { written: result.changed ? [file] : [] };
}

export function planProjectInstructions({ root, targetDir, frameworkVersion }) {
  targetDir = resolve(targetDir);
  const template = readFileSync(join(root, 'templates', 'project-CLAUDE.md'), 'utf8');
  const file = join(targetDir, 'CLAUDE.md');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const rendered = renderProjectInstructions(template, {
    projectName: basename(targetDir), frameworkVersion,
  });
  const content = mergeProjectInstructions(current, rendered);
  return { file, content: content.endsWith('\n') ? content : `${content}\n` };
}
