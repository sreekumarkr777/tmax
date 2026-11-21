const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readUsage, priceFor } = require('../src/usage');

assert.deepEqual(priceFor('claude-opus-5-5'), [4, 20, 0.2]);
assert.deepEqual(priceFor('claude-sonnet-4-6'), [3, 15, 0.3]);

const f = path.join(os.tmpdir(), `tmax-usage-${process.pid}.jsonl`);
const line = (id, u, ts = '2026-11-21T10:00:00Z') => JSON.stringify({ type: 'assistant', requestId: 'r' + id, timestamp: ts, message: { id, model: 'claude-opus-5-5', usage: u } });
const u1 = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 10000, cache_creation_input_tokens: 2000 };
fs.writeFileSync(f, [line('m1', u1), line('m1', u1), JSON.stringify({ type: 'user', message: { content: 'hi' } })].join('\n') + '\n');
const m = {};
assert.equal(readUsage(m, f), true);
assert.equal(m.usage.replies, 1, 'duplicate lines of one reply count once');
assert.equal(m.usage.output, 500);
// 1000*4 + 2000*5 + 10000*0.2 + 500*20 = 26000 → $0.026
assert.ok(Math.abs(m.usage.cost - 0.026) < 1e-9, m.usage.cost);
assert.equal(readUsage(m, f), false, 'nothing new');
fs.appendFileSync(f, line('m2', { input_tokens: 10, output_tokens: 10 }) + '\n');
assert.equal(readUsage(m, f), true);
assert.equal(m.usage.replies, 2);
fs.unlinkSync(f);
console.log('usage tests passed');
