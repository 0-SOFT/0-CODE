#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { resolveMcpReference } from '../core/mcp-reference.mjs';
import { resolveProjectPath } from '../core/project-config.mjs';
import { resolveCliLaunch } from '../core/backends/cli-launch.mjs';
export function launchReference(file,{env=process.env}={}) {
  file=resolve(file);const root=dirname(dirname(dirname(file)));
  const source=resolveProjectPath(root,'.0-code/mcp/'+file.split(/[\\/]/).at(-1),{allowFramework:true});
  if(file!==source)throw new Error('MCP reference file is outside its owned directory');
  const spec=JSON.parse(readFileSync(file,'utf8'));
  if(spec.schema_version!==1)throw new Error('MCP reference version is unsupported');
  if(spec.cwd!==undefined&&spec.cwd!=='caller')throw new Error('Invalid MCP working directory policy');
  const input=resolveMcpReference(root,spec.reference,{env,cwd:spec.cwd==='caller'?process.cwd():root});
  if(input.type==='http')return httpReference(input);
  const launch=resolveCliLaunch(input.command,input.args,{env:input.environment,cwd:input.cwd});
  const child=spawn(launch.command,launch.args,{cwd:input.cwd,env:input.environment,stdio:'inherit',windowsHide:true,shell:false});
  for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.once(signal,()=>child.kill(signal));
  child.once('error',()=>{process.stderr.write('MCP executable could not be started\n');process.exitCode=1;});
  child.once('exit',code=>{process.exitCode=Number.isInteger(code)?code:1;});return child;
}
// Streamable HTTP POST/SSE replies; OAuth and the legacy SSE/GET transport need native setup.
export function httpReference(input) {
  let session,version;const pending=new Map(),lines=createInterface({input:process.stdin});
  const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
  async function forward(message) {
    if(message.method==='notifications/cancelled')pending.get(message.params?.requestId)?.abort();
    const controller=new AbortController();if(message.id!==undefined)pending.set(message.id,controller);
    try {
      const response=await fetch(input.url,{method:'POST',redirect:'error',signal:controller.signal,
        headers:{...input.headers,'Content-Type':'application/json',Accept:'application/json, text/event-stream',
          ...(session?{'Mcp-Session-Id':session}:{}),...(version?{'MCP-Protocol-Version':version}:{})},body:JSON.stringify(message)});
      if(!response.ok)throw new Error('MCP HTTP request failed');
      if(response.headers.has('mcp-session-id'))session=response.headers.get('mcp-session-id');
      if(response.status===202||response.status===204)return;
      function received(value) {
        if(message.method==='initialize'&&value.id===message.id)version=value.result?.protocolVersion;
        send(value);
        return message.id!==undefined&&value.id===message.id&&!value.method;
      }
      const type=response.headers.get('content-type')||'';
      if(type.includes('application/json'))received(await response.json());
      else if(type.includes('text/event-stream')) {
        const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
        let finished=false;
        try {while(!finished) {
          const part=await reader.read();if(part.done)break;
          buffer=(buffer+decoder.decode(part.value,{stream:true})).replaceAll('\r\n','\n');
          let index;
          while((index=buffer.indexOf('\n\n'))>=0) {
            const event=buffer.slice(0,index);buffer=buffer.slice(index+2);
            const data=event.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
            if(data&&received(JSON.parse(data))){finished=true;break;}
          }
        }} finally {await reader.cancel().catch(()=>{});}
      } else throw new Error('MCP HTTP reply format is unsupported');
    } catch {
      if(message.id!==undefined&&!controller.signal.aborted)send({jsonrpc:'2.0',id:message.id,error:{code:-32603,message:'MCP reference transport failed'}});
    } finally {if(message.id!==undefined)pending.delete(message.id);}
  }
  lines.on('line',line=>{try {const message=JSON.parse(line);if(message&&message.jsonrpc==='2.0')void forward(message);}catch{process.stderr.write('Invalid MCP input\n');}});
  lines.on('close',()=>{for(const controller of pending.values())controller.abort();});
  return lines;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {launchReference(process.argv[2]);}catch{process.stderr.write('MCP reference configuration or environment is invalid\n');process.exitCode=1;}
}
