#!/usr/bin/env node
// yaml-mini.mjs — a minimal YAML parser and serialiser for STATE.md (zero dependencies).
//
// THE SINGLE SOURCE OF TRUTH for parsing and serialising: used by parse-state.mjs and
// update-state.mjs (the parser used to be duplicated in both, so every bug had to be fixed
// twice).
//
// Supports: scalars (str/num/bool/null), inline JSON arrays and objects, block lists (- item),
// nested objects (2-space indent), quoting with escapes (double — JSON style, single — YAML
// '' → ').
// Does NOT support: multi-line blocks (| >), anchors and aliases (*&) — STATE.md does not use
// them (the serialiser always writes values on a single line).

export function parseYaml(text) {
  const lines = text.split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, container: root, key: null }];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || /^\s*#/.test(line)) { i++; continue; }
    const indent = line.match(/^( *)/)[1].length;
    const trimmed = line.slice(indent);
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].container;
    if (trimmed.startsWith('- ')) {
      if (!Array.isArray(parent)) throw new Error(`list item at line ${i + 1} in non-array parent`);
      const itemText = trimmed.slice(2);
      const itemTrimmed = itemText.trim();
      // A key may start with a digit (v0.5.9): task_id = `<version>_<topic>` (e.g. `0.0.1_skeleton`).
      // The first character used to require [A-Za-z_], so the serialiser wrote keys the parser
      // could not read → the STATE round-trip failed → the Stop hook fell back to failOpen.
      // A leading \w is now allowed.
      const objMatch = itemText.match(/^([\w][\w.-]*)\s*:\s*(.*)$/);
      if (objMatch) {
        const obj = {};
        const fk = objMatch[1];
        const fr = objMatch[2];
        const itemIndent = indent + 2;
        if (fr === '' || fr === '~') obj[fk] = null;
        else obj[fk] = parseScalarOrInline(fr);
        parent.push(obj);
        stack.push({ indent: itemIndent - 1, container: obj, key: null });
        i++; continue;
      }
      parent.push(parseScalarOrInline(itemTrimmed));
      i++; continue;
    }
    // A key may start with a digit (v0.5.9) — see the comment above at objMatch.
    const kv = trimmed.match(/^([\w][\w.-]*)\s*:\s*(.*)$/);
    if (!kv) throw new Error(`malformed line ${i + 1}: ${line}`);
    const key = kv[1];
    const rest = kv[2];
    if (rest === '' || rest === '~') {
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === '' || /^\s*#/.test(lines[j]))) j++;
      const nl = lines[j] || '';
      const ni = nl.match(/^( *)/)[1].length;
      if (j < lines.length && ni > indent && nl.slice(ni).startsWith('- ')) {
        parent[key] = [];
        stack.push({ indent, container: parent[key], key });
      } else if (j < lines.length && ni > indent) {
        parent[key] = {};
        stack.push({ indent, container: parent[key], key });
      } else {
        parent[key] = null;
      }
    } else {
      parent[key] = parseScalarOrInline(rest);
    }
    i++;
  }
  return root;
}

export function parseScalarOrInline(s) {
  s = s.trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if ((s.startsWith('[') && s.endsWith(']')) || (s.startsWith('{') && s.endsWith('}'))) {
    try { return JSON.parse(s); } catch { /* fall through */ }
  }
  // Double-quoted: JSON.parse correctly removes the escaping.
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try { return JSON.parse(s); }
    catch { return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\'); }
  }
  // Single-quoted (YAML): '' → '.
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

export function serializeYaml(obj, indent = 0) {
  const pad = '  '.repeat(indent);
  const lines = [];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === null || v === undefined) {
      lines.push(`${pad}${k}: null`);
    } else if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${pad}${k}: []`);
      } else if (v.every(x => typeof x !== 'object' || x === null)) {
        lines.push(`${pad}${k}: ${JSON.stringify(v)}`);
      } else {
        lines.push(`${pad}${k}:`);
        for (const item of v) {
          if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
            const sub = serializeYaml(item, indent + 1).split('\n');
            lines.push(`${pad}  - ${sub[0].trim()}`);
            for (let i = 1; i < sub.length; i++) {
              if (sub[i]) lines.push(`${pad}    ${sub[i].trim()}`);
            }
          } else {
            lines.push(`${pad}  - ${serializeScalar(item)}`);
          }
        }
      }
    } else if (typeof v === 'object') {
      if (Object.keys(v).length === 0) {
        lines.push(`${pad}${k}: {}`);
      } else {
        lines.push(`${pad}${k}:`);
        lines.push(serializeYaml(v, indent + 1));
      }
    } else {
      lines.push(`${pad}${k}: ${serializeScalar(v)}`);
    }
  }
  return lines.join('\n');
}

export function serializeScalar(v) {
  if (typeof v === 'string') {
    if (/^(true|false|null|~|\d)/.test(v) || /[:#\[\]{},&*?|<>=!%@`]/.test(v) ||
        v.includes('\n') || v.startsWith(' ') || v.endsWith(' ')) {
      return JSON.stringify(v);
    }
    return v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}
