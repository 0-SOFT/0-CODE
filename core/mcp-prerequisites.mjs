// Local prerequisite evidence only: no account connection, package installation or model call.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { runCli } from './backends/spawn-cli.mjs';

function parseSemVer(value) {
  if(typeof value!=='string')return null;
  const match=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if(!match)return null;
  const pre=match[4]?.split('.')||[];
  if(pre.some(part=>/^\d+$/.test(part)&&part.length>1&&part.startsWith('0')))return null;
  return {core:match.slice(1,4).map(BigInt),pre};
}

// Build metadata is ignored; a prerelease sorts below the corresponding stable version.
export function compareSemVer(left, right) {
  const a=parseSemVer(left),b=parseSemVer(right);
  if(!a||!b)return null;
  const order=(x,y)=>x===y?0:x>y?1:-1;
  for(let i=0;i<3;i++)if(a.core[i]!==b.core[i])return order(a.core[i],b.core[i]);
  if(!a.pre.length||!b.pre.length)return order(Number(!a.pre.length),Number(!b.pre.length));
  for(let i=0;i<Math.max(a.pre.length,b.pre.length);i++) {
    if(a.pre[i]===undefined)return -1;
    if(b.pre[i]===undefined)return 1;
    if(a.pre[i]===b.pre[i])continue;
    const an=/^\d+$/.test(a.pre[i]),bn=/^\d+$/.test(b.pre[i]);
    return an&&bn?order(BigInt(a.pre[i]),BigInt(b.pre[i])):an!==bn?(an?-1:1):order(a.pre[i],b.pre[i]);
  }
  return 0;
}

export function inspectMcpPrerequisites(root, delivery, {env=process.env}={}) {
  const rows=(delivery?.tools||[]).filter(row=>row.kind==='mcp'&&row.origin==='framework'&&['delivered','reference'].includes(row.status));
  const names=[...new Set(rows.map(row=>row.id.slice('mcp/'.length)))];
  if(!names.length)return [];
  let manifest;
  try { manifest=JSON.parse(readFileSync(join(root,'.0-code/config/mcp-manifest.json'),'utf8')); }
  catch {return [{id:'mcp-prerequisites',ok:false,reason:'Selected MCP manifest is missing or invalid'}];}
  let npmRoot=env.NPM_GLOBAL_ROOT;
  if(!npmRoot&&names.some(name=>manifest.servers?.find(server=>server.name===name)?.npm_package)) {
    const result=runCli('npm',['root','-g'],{env,encoding:'utf8',timeoutMs:10000});
    if(result.status===0)npmRoot=String(result.stdout).trim();
  }
  return names.map(name=>{
    const id='mcp-prerequisite-'+name;
    try {
      const server=manifest.servers?.find(server=>server.name===name);
      if(!server)throw new Error('Selected MCP definition is absent');
      const missing=(server.secrets||[]).filter(key=>!String(env[key]||'').trim());
      if(missing.length)throw new Error('Required environment variables are absent: '+missing.join(', '));
      if(server.npm_package) {
        const pin=/^((?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+)@([^@]+)$/.exec(server.npm_package);
        if(!pin||!parseSemVer(pin[2]))throw new Error('Selected npm package must have an exact version');
        if(!npmRoot)throw new Error('npm global root is unavailable; set NPM_GLOBAL_ROOT or make npm available');
        const packageDir=resolve(npmRoot,pin[1]);
        let pkg;try{pkg=JSON.parse(readFileSync(join(packageDir,'package.json'),'utf8'));}catch{throw new Error('Missing prerequisite: '+server.npm_package);}
        if(pkg.name!==pin[1])throw new Error('Wrong prerequisite package name; expected '+pin[1]);
        const comparison=compareSemVer(pkg.version,pin[2]);
        if(comparison===null||comparison<0)throw new Error('Wrong prerequisite version; minimum '+server.npm_package);
        const entry=(server.args||[]).find(arg=>arg.startsWith('${NPM_GLOBAL_ROOT}/'));
        if(!entry)throw new Error('Pinned package entry is not declared');
        const target=resolve(npmRoot,entry.slice('${NPM_GLOBAL_ROOT}/'.length)),tail=relative(packageDir,target);
        if(isAbsolute(tail)||tail==='..'||tail.startsWith('..')||!existsSync(target)||!statSync(target).isFile())
          throw new Error('Pinned package entry is absent or outside its package: '+server.npm_package);
        return {id,ok:true,detail:'Package and entry checked locally: '+pkg.name+'@'+pkg.version+'; minimum '+pin[2]};
      }
      return {id,ok:true,detail:'Required environment names checked; external service and account authorization not probed'};
    } catch(error){return {id,ok:false,reason:error.message};}
  });
}
