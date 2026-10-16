// Resolve Windows npm forwarding shims to their executable entrypoint. Arguments never become
// shell source. Arbitrary batch programs need an explicit executable adapter, not guessed quoting.
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';

function file(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

function environment(env, name) {
  const key = Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase());
  return key ? String(env[key] || '') : '';
}

function findCommand(bin, env, cwd) {
  const extensions = extname(bin) ? [''] : (environment(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD')
    .split(';').filter(value => /^\.(?:com|exe|bat|cmd)$/i.test(value));
  const roots = /[\\/]/.test(bin) ? [''] : [cwd, ...environment(env, 'PATH').split(';').filter(Boolean)];
  for (const root of roots) for (const extension of extensions) {
    const candidate = resolve(cwd, root.replace(/^"|"$/g, ''), bin + extension);
    if (file(candidate)) return candidate;
  }
  return bin; // Preserve the ordinary spawn error for a missing command.
}

const PREAMBLE = '@ECHO off\\n(?:GOTO start\\n:find_dp0\\nSET dp0=%~dp0\\nEXIT /b\\n:start\\nSETLOCAL\\nCALL :find_dp0\\n)?';
const NATIVE_SHIM = new RegExp('^' + PREAMBLE + '"%(?:dp0%|~dp0)[\\\\/]?([^"%\\n]+\\.exe)"\\s+%\\*$', 'i');
const NODE_SHIM = new RegExp('^' + PREAMBLE
  + 'IF EXIST "%dp0%\\\\node.exe" \\(\\nSET "_prog=%dp0%\\\\node.exe"\\n\\) ELSE \\(\\n'
  + 'SET "_prog=node"\\nSET PATHEXT=%PATHEXT:;.JS;=;%\\n\\)\\n'
  + 'endLocal & goto #_undefined_# 2>NUL \\|\\| title %COMSPEC% & "%_prog%"\\s+"%dp0%\\\\([^"%\\n]+)"\\s+%\\*$', 'i');

export function resolveCliLaunch(bin, args, { platform = process.platform, env = process.env,
  cwd = process.cwd(), nodePath = process.execPath } = {}) {
  if (platform !== 'win32') return { command: bin, args };
  const command = findCommand(bin, env, cwd);
  if (!/\.(?:cmd|bat)$/i.test(command) || !file(command)) return { command, args };
  const source = readFileSync(command, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
    .map(line => line.trim()).filter(Boolean).join('\n');
  const native = NATIVE_SHIM.exec(source);
  const node = NODE_SHIM.exec(source);
  // npm's own npm/npx shims select a CLI shipped in the same npm installation. Use that JS
  // entrypoint directly, so prompts cannot be expanded by cmd and npx keeps its own parsing.
  const builtin = /^(?:npm|npx)\.cmd$/i.test(basename(command))
    && /^:: Created by npm,/i.test(source)
    && /"%NODE_EXE%" "%(?:NPM|NPX)_CLI_JS%" %\*$/i.test(source)
    ? /SET "(?:NPM|NPX)_CLI_JS=%~dp0[\\/]([^"%\n]+)"/i.exec(source) : null;
  const match = native || node || builtin;
  if (!match) {
    const error = new Error('Unsupported Windows batch command: use a native executable or a standard npm forwarding shim');
    error.code = 'UNSUPPORTED_BATCH';
    throw error;
  }
  const entry = resolve(dirname(command), match[1].replace(/[\\/]/g, '/'));
  if (!file(entry)) throw new Error('Windows CLI shim entrypoint is missing');
  if (native) return { command: entry, args };
  const adjacentNode = join(dirname(command), 'node.exe');
  return { command: file(adjacentNode) ? adjacentNode : nodePath, args: [entry, ...args] };
}
