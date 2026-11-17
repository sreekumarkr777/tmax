// End-to-end check of the hook bridge: generate the settings file, then run
// the exact shell command Claude Code would run, piping a JSON event to it.
const assert = require('assert');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');
const run = (cmd, input) => new Promise((res, rej) => { const c = exec(cmd, (e, out) => e ? rej(e) : res(out)); c.stdin.end(input || ''); });
const { startHookServer, buildHookSettings } = require('../src/hooks');

(async () => {
  const got = [];
  const { server, port, token } = await startHookServer((id, payload, extra) => got.push({ id, payload, extra }));
  const settings = buildHookSettings({ port, sessionId: 'abc-123', token });

  const pre = settings.hooks.PreToolUse[0].hooks[0].command;
  await run(pre, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }));

  const perm = settings.hooks.Notification.find((g) => g.matcher === 'permission_prompt').hooks[0].command;
  await run(perm, JSON.stringify({ hook_event_name: 'Notification', message: 'Claude needs your permission' }));

  // wrong token is rejected
  await run(`curl -s --noproxy '*' -X POST --data-binary '{}' 'http://127.0.0.1:${port}/hook/abc-123?t=nope' >/dev/null || true`);

  await new Promise((r) => setTimeout(r, 200));
  assert.equal(got.length, 2);
  assert.equal(got[0].id, 'abc-123');
  assert.equal(got[0].payload.tool_name, 'Bash');
  assert.equal(got[0].extra.e, 'PreToolUse');
  assert.equal(got[1].extra.n, 'permission');

  // when the app isn't running the hook must still exit 0 and print nothing
  server.close();
  const out = await run(pre, '{}');
  assert.equal(out, '');

  console.log('hook bridge tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
