// Hook bridge: a tiny localhost HTTP server + the per-session settings file
// that tells Claude Code to report every lifecycle event to it.
//
// We use `command` hooks that pipe the event JSON to curl. They work on every
// Claude Code version that has hooks, and stdout is discarded so nothing leaks
// into the conversation. If the app isn't running, curl fails silently (|| true).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EVENTS = [
  'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'SubagentStart', 'SubagentStop',
  'Stop', 'StopFailure', 'SessionEnd',
];

// Notification matchers we care about, mapped to a short tag (?n=…).
const NOTIFICATIONS = {
  permission_prompt: 'permission',
  idle_prompt: 'idle',
  agent_needs_input: 'input',
};

function curlCommand(url) {
  // Single-quoted URL; ids are [a-z0-9-] and the token is hex, so no escaping issues.
  return `curl -s -m 3 --noproxy '*' -X POST -H 'Content-Type: application/json' --data-binary @- '${url}' >/dev/null 2>&1 || true`;
}

function buildHookSettings({ port, sessionId, token }) {
  const base = `http://127.0.0.1:${port}/hook/${sessionId}?t=${token}`;
  const hooks = {};
  for (const ev of EVENTS) {
    hooks[ev] = [{ hooks: [{ type: 'command', command: curlCommand(`${base}&e=${ev}`), timeout: 5 }] }];
  }
  hooks.Notification = Object.entries(NOTIFICATIONS).map(([matcher, tag]) => ({
    matcher,
    hooks: [{ type: 'command', command: curlCommand(`${base}&e=Notification&n=${tag}`), timeout: 5 }],
  }));
  return { hooks };
}

function writeSettingsFile(dir, opts) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `hooks-${opts.sessionId}.json`);
  fs.writeFileSync(file, JSON.stringify(buildHookSettings(opts), null, 2));
  return file;
}

/**
 * Start the hook server on a random localhost port.
 * onEvent(sessionId, payload, extraParams) is called for each valid hook.
 */
function startHookServer(onEvent) {
  const token = crypto.randomBytes(12).toString('hex');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const m = url.pathname.match(/^\/hook\/([a-z0-9-]+)$/);
    if (req.method !== 'POST' || !m || url.searchParams.get('t') !== token) {
      res.writeHead(404); res.end(); return;
    }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 5e6) req.destroy(); });
    req.on('end', () => {
      // Answer immediately with an empty JSON object: we observe, never decide.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch { /* ignore */ }
      const extra = Object.fromEntries([...url.searchParams].filter(([k]) => k !== 't'));
      try { onEvent(m[1], payload, extra); } catch (e) { console.error('hook handler error', e); }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, token }));
  });
}

module.exports = { buildHookSettings, writeSettingsFile, startHookServer, EVENTS };
