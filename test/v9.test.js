'use strict';
// 엔진: 가볍게 부르는 옵션이 CLI 인자로 전달되는지, Codex 가 모델 오류를 내면 대체 모델로 다시 부르는지.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { engines } = require('../src/engines');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'domo-v9-'));
const script = (name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, `#!/usr/bin/env node\n${body}`, { mode: 0o755 }); return f; };
const skip = process.platform === 'win32';

test('Claude: lean·tools 옵션이 인자로 들어간다', { skip }, async () => {
  const bin = script('claude', `console.log(JSON.stringify({ type: 'result', result: process.argv.slice(2).join(' '), total_cost_usd: 0.01, usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 } }));`);
  const res = await engines.claude({ prompt: 'hi', agent: { bin, systemPrompt: 's', model: 'claude-sonnet-5-5', lean: true, tools: ['Read'] }, cwd: dir });
  assert.match(res.text, /--model claude-sonnet-5-5/);
  assert.match(res.text, /--tools Read --strict-mcp-config --disable-slash-commands/);
  assert.deepEqual([res.meta.tokensIn, res.meta.tokensOut], [15, 3]);
  const none = await engines.claude({ prompt: 'hi', agent: { bin, systemPrompt: 's', noTools: true }, cwd: dir });
  assert.ok(!none.text.includes('--strict-mcp-config'));
});

test('Codex: 모델을 쓸 수 없다는 오류면 대체 모델로 한 번 더 시도한다', { skip }, async () => {
  const bin = script('codex', `
const a = process.argv.slice(2);
const m = a.includes('-m') ? a[a.indexOf('-m') + 1] : 'config-default';
const out = a[a.indexOf('-o') + 1];
if (!a.includes('--ignore-user-config')) { console.log(JSON.stringify({ type: 'error', message: 'user config was used' })); process.exit(1); }
if (m === 'bad-model') { console.log(JSON.stringify({ type: 'error', message: "The '" + m + "' model is not supported when using Codex with a ChatGPT account." })); process.exit(1); }
require('fs').writeFileSync(out, 'answer from ' + m);
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 2 } }));`);
  const res = await engines.codex({ prompt: 'hi', agent: { bin, systemPrompt: 's', model: 'bad-model' }, cwd: dir });
  assert.equal(res.text, 'answer from config-default', '모델 지정 없이 다시 부른다');
  assert.equal(res.meta.modelFallback, 'bad-model');
  assert.equal(res.meta.tokensIn, 7);
  assert.equal((await engines.codex({ prompt: 'hi', agent: { bin, systemPrompt: 's', model: 'good-model' }, cwd: dir })).text, 'answer from good-model');
});
