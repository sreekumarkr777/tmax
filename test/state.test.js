const assert = require('assert');
const { createSession, applyHook, findCollisions, snapshot } = require('../src/state');

const s = createSession({ id: 'a', name: 'auth', cwd: '/r/app' });
s.root = '/r/app';
s.repoKey = '/r/app/.git';

let t = applyHook(s, { hook_event_name: 'UserPromptSubmit', prompt: 'fix it', permission_mode: 'acceptEdits', session_id: 'x', transcript_path: '/tmp/t.jsonl' });
assert.equal(t.next, 'working');
assert.equal(s.permissionMode, 'acceptEdits');
assert.equal(s.transcriptPath, '/tmp/t.jsonl');

applyHook(s, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } });
assert.equal(s.activity, '$ npm test');

applyHook(s, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/r/app/src/a.ts' } });
applyHook(s, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/r/app/src/b.ts' } });
assert.equal(s.toolCount, 2);
assert.equal(s.files['/r/app/src/a.ts'].writes, 1);
assert.equal(s.files['/r/app/src/b.ts'].reads, 1);

t = applyHook(s, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf tmp' } });
assert.equal(t.next, 'waiting');
assert.match(s.activity, /rm -rf tmp/);

// idle notification must not clear a pending permission
applyHook(s, { hook_event_name: 'Notification', message: 'waiting' }, { n: 'idle' });
assert.equal(s.status, 'waiting');

applyHook(s, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf tmp' } });
assert.equal(s.status, 'working');

applyHook(s, { hook_event_name: 'SubagentStart', agent_type: 'Explore' });
assert.equal(s.subagentsActive, 1);
applyHook(s, { hook_event_name: 'SubagentStop', agent_type: 'Explore' });
assert.equal(s.subagentsActive, 0);

t = applyHook(s, { hook_event_name: 'Stop', last_assistant_message: 'Fixed the cookie bug.' });
assert.equal(t.next, 'done');
assert.equal(s.lastMessage, 'Fixed the cookie bug.');

// collisions across two worktrees of the same repo, same relative file
const b = createSession({ id: 'b', name: 'tests', cwd: '/r/app.worktrees/tests' });
b.root = '/r/app.worktrees/tests';
b.repoKey = '/r/app/.git';
applyHook(b, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: '/r/app.worktrees/tests/src/a.ts' } });
const cols = findCollisions([s, b]);
assert.equal(cols.length, 1);
assert.equal(cols[0].path, 'src/a.ts');

const snap = snapshot(s);
assert.ok(Array.isArray(snap.files));
JSON.stringify(snap);

console.log('state tests passed');
