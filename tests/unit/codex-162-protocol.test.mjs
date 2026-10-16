// Genuine CLI recording; requested model is captured separately from JSONL.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parseCodexEvents} from '../../core/backends/codex.mjs';
const text=readFileSync(new URL('../fixtures/codex/0.162.0-protocol.jsonl',import.meta.url),'utf8');
const receipt=JSON.parse(readFileSync(new URL('../fixtures/codex/0.162.0-protocol.provenance.json',import.meta.url),'utf8'));
const events=text.trimEnd().split(/\r?\n/).map(JSON.parse);
const sha=x=>createHash('sha256').update(x).digest('hex');

test('recorded Codex 0.162.0 retains command, final output, complete usage and provenance',()=>{
  assert.equal(receipt.cliVersion,'0.162.0');assert.equal(sha(text),receipt.fixture.sha256);
  assert.match(receipt.capture.sourceCommit,/^[a-f0-9]{40}$/);
  for(const value of [receipt.capture.rawSha256,receipt.capture.runnerSha256,...Object.values(receipt.capture.evidence)])assert.match(value,/^[a-f0-9]{64}$/);
  assert.equal(receipt.fixture.eventsOtherwiseUnchanged,true);
  const args=receipt.request.command.args;
  assert.equal(args[args.indexOf('-m')+1],'gpt-6.1-sol');assert.ok(args.includes('model_reasoning_effort="medium"'));
  for(const flag of ['--json','features.hooks=true','features.unified_exec=false','features.unified_exec_tty=false'])assert.ok(args.includes(flag));
  assert.equal(receipt.observation.actualLaunch,true);assert.equal(receipt.observation.launchStatus,0);
  assert.equal(receipt.observation.multiTurnAcceptance,false);
  assert.deepEqual(receipt.managedRestoration.map(r=>[r.name,r.present,r.match]),[['framework-owner.json',true,true],['framework-mcp.json',false,true]]);
  for(const type of ['thread.started','turn.started','turn.completed'])assert.equal(events.filter(e=>e.type===type).length,1);
  const messages=events.filter(e=>e.type==='item.completed'&&e.item?.type==='agent_message');assert.ok(messages.length>1);
  const command=events.find(e=>e.type==='item.completed'&&e.item?.type==='command_execution');
  assert.equal(command.item.exit_code,0);assert.match(command.item.command,/node --version/);
  assert.equal(command.item.aggregated_output.trim(),receipt.observation.commandNodeVersion);
  const parsed=parseCodexEvents(text,{exitCode:0});assert.equal(parsed.ok,true);assert.equal(parsed.formatChanged,undefined);
  assert.equal(parsed.sessionId,receipt.observation.sessionId);
  assert.deepEqual(parsed.usage,events.find(e=>e.type==='turn.completed').usage);
  assert.deepEqual(parsed.usage,receipt.observation.usage);assert.deepEqual(parsed.usageTotal,parsed.usage);
  assert.equal(parsed.output,messages.at(-1).item.text);assert.notEqual(parsed.output,messages[0].item.text);
  assert.equal(sha(parsed.output),receipt.observation.outputSha256);assert.equal(Object.hasOwn(parsed,'costUsd'),false);
});

test('recorded Codex 0.162.0 rejects loss of a required token field despite final text',()=>{
  const damaged=events.map(e=>{if(e.type!=='turn.completed')return e;const {input_tokens,...rest}=e.usage;assert.ok(input_tokens>0);return {...e,usage:rest};}).map(JSON.stringify).join('\n')+'\n';
  const parsed=parseCodexEvents(damaged,{exitCode:0});assert.equal(parsed.ok,false);assert.equal(parsed.formatChanged,true);
  assert.equal(parsed.usage,undefined);assert.match(parsed.error,/usage schema changed/);
});
