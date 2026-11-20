// Visual smoke test: SB_SMOKE=1 SWITCHBOARD_CLAUDE=test/fake-claude.sh electron .
// Creates three sessions, replays realistic hook events, saves screenshots, quits.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

module.exports = async function smoke({ app, win, createAgentSession, handleHook, send }) {
  const out = process.env.SB_SMOKE_OUT || '/tmp/sb-shots';
  fs.mkdirSync(out, { recursive: true });
  const repo = '/tmp/sb-demo/acme-web';
  if (!fs.existsSync(repo)) {
    fs.mkdirSync(path.join(repo, 'src/auth'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src/auth/session.ts'), 'export {}\n');
    execSync('git init -q -b main && git add -A && git -c user.email=a@b -c user.name=sb commit -qm init', { cwd: repo });
  }
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const a = await createAgentSession({ cwd: repo, name: 'auth-refactor', worktree: true, prompt: 'fix safari sessions', cols: 110, rows: 32 });
  const b = await createAgentSession({ cwd: repo, name: 'api-tests', worktree: true, cols: 110, rows: 32 });
  const c = await createAgentSession({ cwd: repo, name: 'docs-pass', worktree: true, permissionMode: 'acceptEdits', cols: 110, rows: 32 });
  for (const s of [a, b, c]) send('session:update', s);
  // the renderer only knows sessions it created; register these through the page
  await win.webContents.executeJavaScript(`window.__sbAdopt && window.__sbAdopt(${JSON.stringify([a.id, b.id, c.id])})`);

  const ev = (id, e, extra = {}) => handleHook(id, { session_id: 'x', permission_mode: 'default', ...e }, extra);
  const A = a.cwd, B = b.cwd;
  ev(a.id, { hook_event_name: 'UserPromptSubmit', prompt: 'Sessions expire early on Safari — fix it' });
  for (const [t, inp] of [['Read', { file_path: `${A}/src/auth/session.ts` }], ['Grep', { pattern: 'maxAge' }], ['Read', { file_path: `${A}/src/auth/cookies.ts` }], ['Bash', { command: 'npm test -- auth' }], ['Task', { description: 'find cookie call sites' }], ['Edit', { file_path: `${A}/src/auth/cookies.ts` }], ['Edit', { file_path: `${A}/src/auth/session.ts` }], ['Bash', { command: 'npm test' }], ['Read', { file_path: `${A}/test/auth.spec.ts` }], ['Write', { file_path: `${A}/test/auth.spec.ts` }]]) {
    ev(a.id, { hook_event_name: 'PreToolUse', tool_name: t, tool_input: inp });
    ev(a.id, { hook_event_name: 'PostToolUse', tool_name: t, tool_input: inp });
    if (t === 'Task') ev(a.id, { hook_event_name: 'SubagentStart', agent_type: 'Explore' });
  }
  ev(a.id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test -- auth --runInBand' } });

  ev(b.id, { hook_event_name: 'UserPromptSubmit', prompt: 'regenerate api snapshots' });
  ev(b.id, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: `${B}/src/auth/session.ts` } });
  ev(b.id, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf test/fixtures/tmp' } });

  ev(c.id, { hook_event_name: 'UserPromptSubmit', prompt: 'update docs', permission_mode: 'acceptEdits' });
  ev(c.id, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: `${c.cwd}/docs/api.md` }, permission_mode: 'acceptEdits' });
  ev(c.id, { hook_event_name: 'Stop', permission_mode: 'acceptEdits', last_assistant_message: 'Updated 14 API reference pages to match the new client. All examples compile and the docs build is green.' });

  // fake context numbers (transcripts don't exist in the smoke test)
  await win.webContents.executeJavaScript(`window.__sbCtx && window.__sbCtx(${JSON.stringify({ [a.id]: 122000, [b.id]: 41000, [c.id]: 151000 })})`);

  await wait(1500);
  await win.webContents.executeJavaScript(`window.__sbSelect(${JSON.stringify(a.id)})`);
  await wait(800);
  fs.writeFileSync(path.join(out, '1-session.png'), (await win.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`window.__sbMission()`);
  await wait(600);
  fs.writeFileSync(path.join(out, '2-mission.png'), (await win.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`window.__sbMission(); window.__sbOpenNew()`);
  await wait(600);
  fs.writeFileSync(path.join(out, '3-new.png'), (await win.capturePage()).toPNG());

  // ⌘T quick start: no dialog, reuses the active session's folder, auto-names, isolates in a worktree.
  const before = await win.webContents.executeJavaScript(`document.querySelectorAll('#session-list .s-item').length`);
  await win.webContents.executeJavaScript(`document.getElementById('new-dialog').close(); window.__sbSelect(${JSON.stringify(c.id)}); window.__sbQuick()`);
  await wait(1200);
  const quick = await win.webContents.executeJavaScript(`({
    dialogOpen: document.getElementById('new-dialog').open,
    count: document.querySelectorAll('#session-list .s-item').length,
    title: [...document.querySelectorAll('#session-list .s-name')].map((e) => e.textContent).join(',') })`);
  console.log('QUICK', JSON.stringify({ before, ...quick }));
  if (quick.dialogOpen || quick.count !== before + 1) { console.log('QUICK_FAIL'); process.exitCode = 1; }
  fs.writeFileSync(path.join(out, '4-quick.png'), (await win.capturePage()).toPNG());
  console.log('SMOKE_OK', out);
  app.quit();
};
