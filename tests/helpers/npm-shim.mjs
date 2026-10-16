import { writeFileSync } from 'node:fs';

// A literal fixture of npm's generated forwarding shim; no hand-written command escaping.
export function writeNpmNodeShim(file, entry = 'node_modules\\fixture\\cli.mjs') {
  writeFileSync(file, '@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\nIF EXIST "%dp0%\\node.exe" (\n  SET "_prog=%dp0%\\node.exe"\n) ELSE (\n  SET "_prog=node"\n  SET PATHEXT=%PATHEXT:;.JS;=;%\n)\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\' + entry + '" %*\n');
}
