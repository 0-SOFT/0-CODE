// Save actual transcripts using the document role; token accounting remains an optional module.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findProjectRoot, loadProjectConfig, projectRelativePath } from './project-config.mjs';
const MARKER = '<!-- 0-CODE session log -->';
const DAY = 86400000;
function content(record) {
  return Array.isArray(record.message?.content) ? record.message.content
    : Array.isArray(record.message) ? record.message : Array.isArray(record.content) ? record.content : [];
}
function summary(records, payload, project, now) {
  const ru = project.config.language.startsWith('ru');
  const text = [MARKER, `# ${ru ? '\u0416\u0443\u0440\u043d\u0430\u043b \u0441\u0435\u0441\u0441\u0438\u0438' : 'Session Log'}: ${payload.session_id}`, '',
    `- ${now.toISOString()}`, `- ${payload.hook_event_name || 'Stop'}`, `- ${project.projectDir}`, ''];
  for (const record of records) {
    if (record.type === 'user' || record.type === 'assistant') {
      const blocks = content(record);
      const plain = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n');
      if (plain) text.push(`## ${record.type === 'user' ? (ru ? '\u041f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044c' : 'User') : (ru ? '\u0410\u0433\u0435\u043d\u0442' : 'Assistant')}`, '', plain, '');
      for (const block of blocks.filter(block => block.type === 'tool_use')) {
        text.push(`### ${ru ? '\u0418\u043d\u0441\u0442\u0440\u0443\u043c\u0435\u043d\u0442' : 'Tool'}: ${block.name}`, '', '```json', JSON.stringify(block.input, null, 2), '```', '');
      }
    } else if (record.type === 'tool_result') {
      const value = typeof record.content === 'string' ? record.content : JSON.stringify(record.content || '');
      text.push(`<details><summary>${ru ? '\u0420\u0435\u0437\u0443\u043b\u044c\u0442\u0430\u0442' : 'Result'} (${value.length})</summary>`, '', '```', value.slice(0, 500), '```', '</details>', '');
    }
  }
  return text.join('\n') + '\n';
}
// Only files paired with our marked summary are rotated. User logs and usage history stay intact.
function rotate(directory, now) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name), stat = lstatSync(file);
    if (stat.isSymbolicLink()) continue;
    if (entry.isDirectory()) { rotate(file, now); continue; }
    if (!entry.name.endsWith('.summary.md') || stat.nlink !== 1 || now - stat.mtimeMs <= 30 * DAY) continue;
    if (!readFileSync(file, 'utf8').startsWith(MARKER + '\n')) continue;
    const transcript = file.slice(0, -'.summary.md'.length) + '.jsonl';
    if (existsSync(transcript)) {
      const paired = lstatSync(transcript);
      if (paired.isSymbolicLink() || !paired.isFile() || paired.nlink !== 1) continue;
      unlinkSync(transcript);
    }
    unlinkSync(file);
  }
}
export async function saveSessionLog(payload, { env = process.env, now = new Date() } = {}) {
  if (!payload?.transcript_path || !payload.session_id || !existsSync(payload.transcript_path)) return null;
  if (!String(payload.transcript_path).endsWith('.jsonl')) throw new Error('Transcript must be a JSONL file');
  const root = env.CLAUDE_PROJECT_DIR || findProjectRoot(payload.cwd || process.cwd());
  const project = loadProjectConfig({ projectDir: root, env });
  if (project.installed && !project.config.modules.session_logs) return null;
  const date = now.toISOString().slice(0, 10), id = String(payload.session_id);
  if (projectRelativePath(id).includes('/')) throw new Error('Session identifier cannot contain a directory');
  // Validates identifier before any write, even for the legacy naming contract.
  const configured = project.documentPath('logs', { date, id, name: 'session', version: 'session' });
  const logs = project.documentPath('logs');
  let destination = configured;
  if (!project.installed) {
    const directory = join(logs, date), short = id.slice(0, 8);
    const previous = existsSync(directory) && readdirSync(directory).find(name => name.endsWith(`_${short}.jsonl`));
    destination = join(directory, previous || `${now.toISOString().slice(11, 19).replaceAll(':', '-')}_${short}.jsonl`);
  }
  const bytes = readFileSync(payload.transcript_path), records = bytes.toString('utf8').split(/\r?\n/).filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  mkdirSync(dirname(destination), { recursive: true });
  for (const file of [destination, destination.replace(/\.jsonl$/, '') + '.summary.md']) {
    if (existsSync(file) && (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile() || lstatSync(file).nlink !== 1)) throw new Error('Session log target is not an ordinary file');
  }
  const base = destination.replace(/\.jsonl$/, '');
  if (project.installed && existsSync(destination)
    && (!existsSync(base + '.summary.md') || !readFileSync(base + '.summary.md', 'utf8').startsWith(MARKER + '\n'))) throw new Error('Existing project log has no session ownership marker');
  writeFileSync(destination, bytes);
  let rendered = summary(records, payload, project, now);
  const reporter = join(project.frameworkDir, 'lib', 'token-report.mjs');
  if ((!project.installed || project.config.modules.token_usage) && existsSync(reporter)) {
    const { readSessionUsage, sessionSection } = await import(pathToFileURL(reporter).href);
    const usage = { ...readSessionUsage(payload.transcript_path), transcript: payload.transcript_path, generated_at: now.toISOString() };
    const file = base + '.usage.json';
    if (existsSync(file) && (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile() || lstatSync(file).nlink !== 1)) throw new Error('Usage target is not an ordinary file');
    writeFileSync(file, JSON.stringify(usage, null, 2) + '\n');
    rendered += sessionSection(usage);
  }
  writeFileSync(base + '.summary.md', rendered);
  rotate(logs, now.getTime());
  return { transcript: destination, summary: base + '.summary.md', id: basename(base) };
}
