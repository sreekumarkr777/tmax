// Pure session state: turns Claude Code hook events into a session model.
// No Electron imports here so it can be unit-tested with plain node.

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
const MAX_EVENTS = 300;

function toolKind(name = '') {
  if (EDIT_TOOLS.has(name)) return 'edit';
  if (READ_TOOLS.has(name)) return 'read';
  if (name === 'Bash' || name === 'BashOutput' || name === 'KillShell') return 'shell';
  if (name === 'Task' || name === 'Agent') return 'agent';
  if (name.startsWith('mcp__')) return 'mcp';
  if (name === 'WebFetch' || name === 'WebSearch') return 'web';
  return 'other';
}

function short(str, n = 80) {
  if (!str) return '';
  const s = String(str).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function baseName(p = '') {
  const parts = String(p).split('/');
  return parts[parts.length - 1] || p;
}

function describeTool(name, input = {}) {
  input = input || {};
  switch (name) {
    case 'Bash': return `$ ${short(input.command, 70)}`;
    case 'Read': return `Read ${baseName(input.file_path)}`;
    case 'Edit':
    case 'MultiEdit': return `Edit ${baseName(input.file_path)}`;
    case 'Write': return `Write ${baseName(input.file_path)}`;
    case 'Grep': return `Grep "${short(input.pattern, 40)}"`;
    case 'Glob': return `Glob ${short(input.pattern, 40)}`;
    case 'Task':
    case 'Agent': return `Subagent: ${short(input.description || input.subagent_type || 'task', 50)}`;
    case 'WebFetch': return `Fetch ${short(input.url, 60)}`;
    case 'WebSearch': return `Search "${short(input.query, 50)}"`;
    default:
      if (name && name.startsWith('mcp__')) return name.replace(/^mcp__/, '').replace(/__/g, ' › ');
      return name || 'tool';
  }
}

function createSession({ id, name, cwd, branch = null, worktree = null, prompt = null, kind = 'agent' }) {
  return {
    id, name, cwd, branch, worktree, prompt,
    kind,                     // 'agent' (runs claude) | 'shell' (plain terminal)
    cwdNow: cwd,              // where the shell is now (tracked while it runs)
    command: null,            // foreground command in the terminal, if any
    attention: null,          // 'bell' | 'finished' — something happened while you weren't looking
    createdAt: Date.now(),
    status: 'starting',       // starting | working | waiting | done | error | exited
    statusSince: Date.now(),
    activity: 'Starting claude…',
    currentTool: null,
    permissionMode: 'default',
    claudeSessionId: null,
    transcriptPath: null,
    toolCount: 0,
    subagentsActive: 0,
    subagentsTotal: 0,
    files: {},                // path -> { reads, writes, last }
    events: [],               // { t, kind, label }
    lastMessage: '',
    context: null,            // { used, window }
    exitCode: null,
  };
}

function setStatus(s, status, activity) {
  if (s.status !== status) {
    s.status = status;
    s.statusSince = Date.now();
  }
  if (activity !== undefined) s.activity = activity;
}

function pushEvent(s, kind, label) {
  s.events.push({ t: Date.now(), kind, label });
  if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
}

function touchFile(s, filePath, kind) {
  if (!filePath) return;
  const f = s.files[filePath] || (s.files[filePath] = { reads: 0, writes: 0, last: 0 });
  if (kind === 'edit') f.writes++; else f.reads++;
  f.last = Date.now();
}

/**
 * Apply one hook payload. `extra` carries query params from the hook URL
 * (e.g. { n: 'permission' } for Notification matchers).
 * Returns { prev, next } statuses so callers can react to transitions.
 */
function applyHook(s, ev, extra = {}) {
  const prev = s.status;
  const name = ev.hook_event_name || extra.e;
  if (ev.session_id) s.claudeSessionId = ev.session_id;
  if (ev.transcript_path) s.transcriptPath = ev.transcript_path;
  if (ev.permission_mode) s.permissionMode = ev.permission_mode;
  const inSubagent = !!ev.agent_id;

  switch (name) {
    case 'UserPromptSubmit':
      setStatus(s, 'working', 'Thinking…');
      pushEvent(s, 'user', short(ev.prompt, 60) || 'Prompt');
      break;

    case 'PreToolUse': {
      const label = describeTool(ev.tool_name, ev.tool_input);
      s.currentTool = label;
      setStatus(s, 'working', (inSubagent ? '↳ ' : '') + label);
      break;
    }

    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const kind = toolKind(ev.tool_name);
      const label = describeTool(ev.tool_name, ev.tool_input);
      s.toolCount++;
      s.currentTool = null;
      const fp = ev.tool_input && (ev.tool_input.file_path || ev.tool_input.notebook_path);
      if (fp && (kind === 'edit' || kind === 'read')) touchFile(s, fp, kind);
      pushEvent(s, name === 'PostToolUseFailure' ? 'fail' : kind, label);
      if (s.status === 'waiting' || s.status === 'starting') setStatus(s, 'working');
      s.activity = (name === 'PostToolUseFailure' ? '✕ ' : '✓ ') + label;
      break;
    }

    case 'PermissionRequest': {
      const label = describeTool(ev.tool_name, ev.tool_input);
      setStatus(s, 'waiting', `Permission: ${label}`);
      pushEvent(s, 'ask', `Permission: ${label}`);
      break;
    }

    case 'Notification': {
      const msg = short(ev.message, 90);
      const type = extra.n || ev.notification_type || '';
      if (type === 'permission' || type === 'permission_prompt' || type === 'input' || type === 'agent_needs_input') {
        setStatus(s, 'waiting', msg || 'Needs your input');
        pushEvent(s, 'ask', msg || 'Needs input');
      } else if (type === 'idle' || type === 'idle_prompt') {
        if (s.status !== 'waiting') setStatus(s, 'done', msg || 'Waiting for your next prompt');
      }
      break;
    }

    case 'SubagentStart':
      s.subagentsActive++;
      s.subagentsTotal++;
      pushEvent(s, 'agent', `Subagent started${ev.agent_type ? ': ' + ev.agent_type : ''}`);
      break;

    case 'SubagentStop':
      s.subagentsActive = Math.max(0, s.subagentsActive - 1);
      pushEvent(s, 'agent', `Subagent finished${ev.agent_type ? ': ' + ev.agent_type : ''}`);
      break;

    case 'Stop':
      s.currentTool = null;
      s.subagentsActive = 0;
      if (ev.last_assistant_message) s.lastMessage = String(ev.last_assistant_message).slice(0, 2000);
      setStatus(s, 'done', short(ev.last_assistant_message, 90) || 'Finished — your turn');
      pushEvent(s, 'stop', 'Turn finished');
      break;

    case 'StopFailure':
      setStatus(s, 'error', short(ev.error || ev.message, 90) || 'Turn ended with an API error');
      pushEvent(s, 'fail', 'API error');
      break;

    case 'SessionEnd':
      setStatus(s, 'exited', 'Claude session ended');
      break;

    default:
      break;
  }
  return { prev, next: s.status };
}

// Path relative to the session's checkout, so two worktrees of the same repo
// editing "src/a.ts" count as the same file (a merge conflict waiting to happen).
function relPath(s, p) {
  const root = (s.root || s.cwd || '').replace(/\/$/, '');
  return root && p.startsWith(root + '/') ? p.slice(root.length + 1) : p;
}

// Which sessions have written the same file? -> [{ path, sessions: [id,…] }]
function findCollisions(sessions) {
  const writers = new Map();
  for (const s of sessions) {
    if (s.status === 'exited') continue;
    for (const [p, f] of Object.entries(s.files)) {
      if (!f.writes) continue;
      const key = (s.repoKey || s.root || s.cwd) + '::' + relPath(s, p);
      if (!writers.has(key)) writers.set(key, { path: relPath(s, p), ids: new Set() });
      writers.get(key).ids.add(s.id);
    }
  }
  const out = [];
  for (const { path, ids } of writers.values()) if (ids.size > 1) out.push({ path, sessions: [...ids] });
  return out;
}

// Serializable view for the renderer.
function snapshot(s) {
  const files = Object.entries(s.files)
    .map(([path, f]) => ({ path, ...f }))
    .sort((a, b) => b.last - a.last)
    .slice(0, 40);
  return { ...s, files, events: s.events.slice(-160) };
}

module.exports = { createSession, applyHook, describeTool, toolKind, findCollisions, snapshot, setStatus, pushEvent };
