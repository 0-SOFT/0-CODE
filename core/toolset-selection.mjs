// Selection and project precedence are shared by packaging and native delivery.
export function selectToolset(catalog, config) {
  if (catalog?.schema_version !== 1 || !Array.isArray(catalog.elements)) throw new Error('Invalid toolset catalog');
  const entries = new Map();
  for (const entry of catalog.elements) {
    if (!entry || typeof entry.id !== 'string' || entries.has(entry.id) || typeof entry.name !== 'string'
      || (entry.kind!=='mcp'&&!/^[\w-]+(?:\/[\w-]+)*$/.test(entry.name)) || entry.id !== `${entry.kind}/${entry.name}`
      || !['skills','agents','commands','rules','mcp'].includes(entry.kind)
      || !['default','optional','removed'].includes(entry.status)) throw new Error('Invalid toolset catalog entry');
    entries.set(entry.id, entry);
  }
  const enabled = new Set(config.toolset.enable), disabled = new Set(config.toolset.disable);
  for (const id of [...enabled, ...disabled]) if (!entries.has(id)) throw new Error(`Unknown toolset element: ${id}`);
  for (const id of enabled) if (entries.get(id).status === 'removed') throw new Error(`Removed toolset element cannot be enabled: ${id}`);
  const selected = [], overridden = [];
  if (!config.modules.toolset) return { selected, overridden };
  for (const entry of entries.values()) {
    if (entry.status === 'removed' || disabled.has(entry.id)
      || !(enabled.has(entry.id) || config.toolset.defaults && entry.status === 'default')) continue;
    if (entry.kind === 'mcp' && !config.modules.mcp_catalog) continue;
    const project = (config.inventory.tools || []).filter(tool => tool.kind === entry.kind && tool.name === entry.name);
    if (project.length) overridden.push({ id: entry.id, sources: project.map(tool => tool.path) });
    else selected.push(entry);
  }
  return { selected, overridden };
}
