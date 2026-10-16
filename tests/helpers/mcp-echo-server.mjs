// A real minimal stdio MCP server for transport tests and native CLI discovery.
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
let initialized=false;
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{
  let message;try{message=JSON.parse(line);}catch{return;}
  if(message.id===undefined)return;
  let result,error;
  if(message.method==='initialize') {initialized=true;result={protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'0-code-transport-echo',version:'1.0.0'}};}
  else if(!initialized)error={code:-32000,message:'Initialize first'};
  else if(message.method==='tools/list') result={tools:[{name:'echo',description:'Echo text and report transport context without disclosing environment values.',
    inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]};
  else if(message.method==='tools/call') {
    const context={text:message.params.arguments.text,cwd:process.cwd(),
      tokenDigest:createHash('sha256').update(process.env.TOKEN??'').digest('hex'),unrelatedPresent:Boolean(process.env.UNRELATED_MCP_FIXTURE)};
    result={content:[{type:'text',text:JSON.stringify(context)}]};
  } else if(message.method==='ping')result={};
  else error={code:-32601,message:'Unknown method'};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,...(error?{error}:{result})})+'\n');
});
