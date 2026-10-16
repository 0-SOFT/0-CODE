// Supervisor attempt records are diagnostic evidence, not token-accounting transcripts.
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';

function secretValues(project, env) {
  const entries=Object.entries(env);
  for(const rel of ['.env','config/.env']) {
    let text;
    try {text=readFileSync(join(project.projectDir,rel),'utf8');}
    catch(error) {if(error.code==='ENOENT')continue;throw new Error('Cannot read journal redaction source');}
    for(const line of text.split(/\r?\n/)) {
      const match=/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if(!match)continue;
      const raw=match[2],value=/^(['"])[\s\S]*\1$/.test(raw)?raw.slice(1,-1):raw.replace(/\s+#.*$/,'');
      entries.push([match[1],value]);
    }
  }
  return [...new Set(entries.filter(([key,value])=>/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|(?:^|_)KEY(?:_|$))/i.test(key)
    &&typeof value==='string'&&value.length>=4).map(([,value])=>value))].sort((a,b)=>b.length-a.length);
}

function redact(value, secrets) {
  if(typeof value==='string')return secrets.reduce((text,secret)=>text.split(secret).join('[REDACTED]'),value);
  if(Array.isArray(value))return value.map(item=>redact(item,secrets));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>
    [redact(key,secrets),redact(item,secrets)]));
  return value;
}

export function saveTurnJournal(project, record, {env=process.env,now=new Date(),id=randomUUID()}={}) {
  if(!project.config.modules.session_logs)return null;
  const date=now.toISOString().slice(0,10);
  // Unique ID in all naming placeholders also protects custom role templates that omit <id>.
  const name='supervisor-'+id;
  const path=project.documentPath('logs',{date,id:name,name,version:name});
  const safe=redact({...record,schema_version:1,source:'0-code-supervisor',accounting:false,
    created_at:now.toISOString()},secretValues(project,env));
  const bytes=JSON.stringify(safe)+'\n';
  mkdirSync(dirname(path),{recursive:true});
  // Revalidate the role after creating parents; exclusive create refuses every existing file/link.
  project.documentPath('logs',{date,id:name,name,version:name});
  try {writeFileSync(path,bytes,{flag:'wx',mode:0o600});}
  catch {throw new Error('Cannot create supervisor attempt journal; target may already exist');}
  return path;
}
