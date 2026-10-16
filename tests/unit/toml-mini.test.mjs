import test from 'node:test';
import assert from 'node:assert/strict';
import { parseToml } from '../../lib/toml-mini.mjs';
test('native TOML reads real role and transport shapes including quoted names, nested tables and multiline instructions',()=>{
  const data=parseToml('# Owner config\r\nmodel = "owner"\n[agents."review.role"]\nconfig_file = \'agents/review.toml\'\n[mcp_servers."own.server"]\ncommand = "node"\nargs = [\n "one", # explanation\n "two",\n]\nenabled = true\nstartup_timeout_sec = 1_000\n[mcp_servers."own.server".env]\nTOKEN = "${OWNER_KEY}"\n');
  assert.equal(data.agents['review.role'].config_file,'agents/review.toml');
  assert.deepEqual(data.mcp_servers['own.server'].args,['one','two']);
  assert.equal(data.mcp_servers['own.server'].env.TOKEN,'${OWNER_KEY}');
  const role=parseToml('developer_instructions = """\nFirst line.\nSecond \\u263A \\U0001F600.\n"""\nmodel_reasoning_effort = "high"\n');
  assert.equal(role.developer_instructions,'First line.\nSecond ☺ 😀.\n');
  assert.equal(parseToml("developer_instructions = '''\nLiteral \\n body\n'''").developer_instructions,'Literal \\n body\n');
});
test('native TOML accepts inline public metadata and fails closed on ambiguous declarations without echoing values',()=>{
  const data=parseToml('env = { TOKEN = "${TOKEN}", nested.key = 4 }\ncount = 0x10\nratio = 2.5e2\n');
  assert.equal(data.env.nested.key,4);assert.equal(data.count,16);assert.equal(data.ratio,250);
  for(const source of ['key = "private-fixture"\nkey = "different"','key = "unfinished','date = 2026-10-13','[[agents.review]]','env = {}\n[env]','constructor = "private-fixture"','key = "\\q"','value = [1 2]','x = {key = 1,}']) {
    assert.throws(()=>parseToml(source),error=>!error.message.includes('private-fixture'));
  }
});
