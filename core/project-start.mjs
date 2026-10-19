import { readFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadProjectConfig, projectRelativePath } from './project-config.mjs';
import { readInstallationReceipt, claudeSettingsPath } from './project-installation.mjs';
import { InstallationPlan, applyInstallationPlan, fileSnapshot, recoverInstallation } from './installation-transaction.mjs';
import { parseYaml } from '../lib/yaml-mini.mjs';
function header(bytes, label) {
  const match = bytes.toString('utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw new Error(`${label} requires YAML frontmatter`);
  return parseYaml(match[1]);
}
export function planProjectStart(root, promptFile, { maxIterations } = {}) {
  const project = loadProjectConfig({ projectDir: root });
  if (!project.installed || !readInstallationReceipt(root)) throw new Error('Install 0-CODE before starting a cycle');
  if (maxIterations !== undefined && (!Number.isSafeInteger(maxIterations) || maxIterations <= 0)) throw new Error('Cycle limit must be a positive whole number');
  const source = readFileSync(resolve(promptFile)), prompt = header(source, 'Cycle prompt');
  const version = String(prompt.version || '');
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Cycle prompt requires a version');
  if (!Number.isInteger(prompt.stage) || prompt.stage < 0 || prompt.stage > 4) throw new Error('Cycle prompt requires stage 0..4');
  const name = basename(promptFile, extname(promptFile)); projectRelativePath(name);
  const target = project.documentRelative('prompts', { version, name, id: version, date: new Date().toISOString().slice(0, 10) });
  const statePath = project.documentRelative('state'), snapshot = fileSnapshot(project.projectDir, statePath);
  if (snapshot.bytes === null) throw new Error('Configured cycle state is missing');
  const state = header(snapshot.bytes, 'Cycle state');
  const initial = state.current_stage === 0 && Number(state.iteration) === 0 && !state.current_prompt_file
    && !state.next_step_prompt && !state.released_version;
  if (!initial && state.released_version !== state.current_version) throw new Error('A cycle is already active; continue its prompt or finish it before starting another');
  if (state.released_version === version) throw new Error('This cycle version has already been released');
  const patch = { previous_version: state.current_version, current_version: version, current_stage: prompt.stage,
    current_prompt_index: 0, current_prompt_file: target, next_step_prompt: `Read ${target} and execute its next unfinished step. Use .0-code/config.json document roles and write cycle documents in ${project.config.language}.`,
    max_iterations: maxIterations ?? null, iteration: 0, session_count: 0, blockers: [], open_findings: [],
    roadmap_reviewed_at_iteration: 0,
    roadmap_review_note: `New cycle ${version}: the preceding cycle's review describes another prompt. Reset its review clock so the first scheduled review compares the configured plan with work completed in this cycle.`,
    running_jobs: [], budget_metrics: { version_cost_usd: 0 }, last_action: `Started cycle ${version}: ${target}` };
  const update = spawnSync(process.execPath, [resolve(project.frameworkDir, 'lib/update-state.mjs'), project.documentPath('state'), '--preview'],
    { input: JSON.stringify(patch), encoding: 'utf8', windowsHide: true });
  if (update.status !== 0) throw new Error(`Cycle state update refused: ${String(update.stderr || '').trim()}`);
  const plan = new InstallationPlan(project.projectDir);
  plan.change(target, source);
  plan.change(statePath, update.stdout, { overwrite: true, expectedHash: snapshot.hash });
  plan.change('.0-code/run/.loop-progress', null, { overwrite: true });
  plan.assertReady();
  const drivers = project.config.engines.map(engine => ({ engine,
    argv: engine === 'claude' ? ['claude',...(claudeSettingsPath(project.config)==='.0-code/claude/settings.json'?['--settings',claudeSettingsPath(project.config)]:[])] : ['node', '.0-code/core/supervisor.mjs', '--backend', engine], cwd: project.projectDir }));
  return { project, plan, patch, prompt: target, drivers };
}
export function startProjectCycle(root, promptFile, options = {}) {
  recoverInstallation(root);
  const prepared = planProjectStart(root, promptFile, options);
  return { ...prepared, result: applyInstallationPlan(prepared.plan) };
}
