// Switchboard — main process.
// Owns the PTYs (agent sessions and plain shells), the hook server that hears from
// Claude Code, windows, notifications, the dock badge, the optional voice, settings,
// and saving/restoring sessions across restarts.

const { app, BrowserWindow, ipcMain, dialog, Menu, Notification, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const pty = require('node-pty');

const { createSession, applyHook, snapshot, setStatus, pushEvent } = require('./src/state');
const { startHookServer, writeSettingsFile } = require('./src/hooks');
const { repoInfo, createWorktree, currentBranch } = require('./src/git');
const { readContextUsage } = require('./src/transcript');

app.setName('Switchboard');
// Tests and probes run against a throwaway profile so they never touch your saved sessions.
if (process.env.SB_USER_DATA) app.setPath('userData', process.env.SB_USER_DATA);
const PERSIST = !process.env.SB_SMOKE && process.env.SB_NO_PERSIST !== '1';

let win = null;                // most recently created window (the smoke test uses it)
let hook = null;               // { server, port, token }
const sessions = new Map();    // id -> entry { state, pty, winId, ... }
let voiceOn = false;

// ---------- settings ----------

const DEFAULT_SETTINGS = {
  fontFamily: 'JetBrains Mono', fontSize: 13, lineHeight: 1.2,
  theme: 'midnight', cursorStyle: 'block', cursorBlink: true,
  optionAsMeta: false,          // false: Option types # € …; Option+arrows still jump words
  scrollback: 20000, copyOnSelect: false, bell: 'visual',
  editor: 'auto',               // auto | system | vscode | cursor | zed
  restore: true,                // reopen sessions (and resume Claude) after a restart
};
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { ...DEFAULT_SETTINGS };
function loadSettings() {
  try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { /* first run */ }
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch (e) { console.error('settings save failed', e.message); }
}

// ---------- helpers ----------

function windowFor(winId) {
  const w = winId != null ? BrowserWindow.fromId(winId) : null;
  return w && !w.isDestroyed() ? w : null;
}
function sendTo(winId, channel, ...args) {
  const w = windowFor(winId);
  if (w) w.webContents.send(channel, ...args);
}
function send(channel, ...args) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, ...args);
}
function senderWinId(e) {
  const w = BrowserWindow.fromWebContents(e.sender);
  return w ? w.id : null;
}

function broadcast(id) {
  const s = sessions.get(id);
  if (s) sendTo(s.winId, 'session:update', snapshot(s.state));
}

function shq(str) {
  return "'" + String(str).replace(/'/g, `'\\''`) + "'";
}
const tilde = (p) => String(p || '').replace(os.homedir(), '~');

function updateBadge() {
  const waiting = [...sessions.values()].filter((s) => s.state.status === 'waiting').length;
  if (process.platform === 'darwin' && app.dock) app.dock.setBadge(waiting ? String(waiting) : '');
}

// ---------- voice (macOS `say` for now; Kokoro is the planned engine) ----------

const VOICES = ['Samantha', 'Daniel', 'Karen', 'Moira', 'Rishi', 'Tessa'];
const speechQueue = [];
let speaking = false;

function speak(text, voiceIdx = 0) {
  if (!voiceOn || process.platform !== 'darwin') return;
  speechQueue.push({ text, voice: VOICES[voiceIdx % VOICES.length] });
  if (speechQueue.length > 4) speechQueue.splice(0, speechQueue.length - 4);
  pumpSpeech();
}

function pumpSpeech() {
  if (speaking || !speechQueue.length) return;
  speaking = true;
  const { text, voice } = speechQueue.shift();
  execFile('say', ['-v', voice, text], (err) => {
    const done = () => { speaking = false; pumpSpeech(); };
    if (err) execFile('say', [text], done); // voice not installed → default voice
    else done();
  });
}

// ---------- reacting to state transitions ----------

function onTransition(entry, prev, next) {
  if (prev === next) return;
  const s = entry.state;
  updateBadge();
  const w = windowFor(entry.winId);
  const focusedHere = w && w.isFocused();
  const idx = [...sessions.keys()].indexOf(s.id);

  if (next === 'waiting') {
    if (!focusedHere) notify(entry, `${s.name} needs you`, s.activity);
    speak(`${s.name} needs you.`, idx);
  } else if (next === 'done' && prev === 'working') {
    if (!focusedHere) notify(entry, `${s.name} finished`, s.activity);
    speak(`${s.name} is done.`, idx);
    currentBranch(s.cwd).then((b) => { if (b && b !== s.branch) { s.branch = b; broadcast(s.id); } });
  } else if (next === 'error') {
    if (!focusedHere) notify(entry, `${s.name} hit an error`, s.activity);
    speak(`${s.name} hit an error.`, idx);
  }
}

function notify(entry, title, body) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body: body || '', silent: false });
  n.on('click', () => {
    const w = windowFor(entry.winId);
    if (w) { w.show(); w.focus(); }
    sendTo(entry.winId, 'session:focus', entry.state.id);
  });
  n.show();
}

function scheduleContextRead(entry) {
  if (entry.ctxTimer) return;
  entry.ctxTimer = setTimeout(() => {
    entry.ctxTimer = null;
    const usage = readContextUsage(entry.state.transcriptPath);
    if (usage) { entry.state.context = usage; broadcast(entry.state.id); }
  }, 600);
}

function handleHook(id, payload, extra) {
  const entry = sessions.get(id);
  if (!entry) return;
  const { prev, next } = applyHook(entry.state, payload, extra);
  const ev = payload.hook_event_name || extra.e;
  if (ev === 'PostToolUse' || ev === 'Stop' || ev === 'UserPromptSubmit' || ev === 'SubagentStop') {
    scheduleContextRead(entry);
  }
  broadcast(id);
  onTransition(entry, prev, next);
}

// ---------- sessions ----------

// When launched with `npm start`, npm injects its own variables into the environment:
// EDITOR=vi (which flips zsh into vi keys, so Ctrl+R stops searching history),
// npm_* config, and node_modules/.bin on PATH. Sessions should get the user's own shell env.
function cleanEnv(src) {
  const env = { ...src };
  delete env.ELECTRON_RUN_AS_NODE;
  // If Switchboard itself was started from inside a Claude Code session, don't let that
  // session's markers leak in: they make every agent a "child session" (no transcript, etc.).
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT' ||
        /^CLAUDE_CODE_(ENTRYPOINT|EXECPATH|CHILD_SESSION|SESSION_|MESSAGING_|SSE_PORT)/.test(k)) delete env[k];
  }
  for (const k of ['SB_USER_DATA', 'SB_NO_PERSIST', 'SB_SMOKE', 'SB_SMOKE_OUT']) delete env[k];
  if (src.npm_lifecycle_event || src.npm_config_user_agent) {
    for (const k of Object.keys(env)) if (k.startsWith('npm_')) delete env[k];
    // npm sets EDITOR=vi itself; the session's login shell re-reads the user's own rc files anyway
    delete env.EDITOR; delete env.VISUAL;
    delete env.INIT_CWD; delete env.NODE; delete env.COLOR;
    if (env.PATH) env.PATH = env.PATH.split(':').filter((p) => !/node_modules[\\/]\.bin|node-gyp-bin/.test(p)).join(':');
  }
  return env;
}

// Spawn the terminal process for an entry and wire its output to the owning window.
function attachPty(entry, args, cwd, cols, rows) {
  const id = entry.state.id;
  const userShell = process.env.SHELL || '/bin/zsh';
  const env = { ...cleanEnv(process.env), TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Switchboard', SWITCHBOARD_SESSION: id };
  const p = pty.spawn(userShell, args, { name: 'xterm-256color', cols: cols || 100, rows: rows || 30, cwd, env });
  entry.pty = p;
  entry.tty = String(p._pty || '').replace('/dev/', '');
  entry.buf = '';
  entry.early = '';            // output produced before the window has picked this session up
  entry.claimed = false;
  p.onData((data) => {
    if (!entry.claimed) { entry.early = (entry.early + data).slice(-400000); return; }
    entry.buf += data;
    if (!entry.flushTimer) {
      entry.flushTimer = setTimeout(() => {
        entry.flushTimer = null;
        sendTo(entry.winId, 'pty:data', id, entry.buf);
        entry.buf = '';
      }, 6);
    }
  });
  p.onExit(({ exitCode }) => {
    const st = entry.state;
    st.exitCode = exitCode;
    st.command = null;
    setStatus(st, 'exited', `Terminal closed (exit ${exitCode})`);
    entry.dead = true;
    pushEvent(st, 'stop', 'Terminal closed');
    broadcast(id);
    updateBadge();
  });
}

function newEntry(state, winId) {
  const entry = { state, pty: null, winId, buf: '', flushTimer: null, ctxTimer: null, settingsFile: null, stash: '' };
  sessions.set(state.id, entry);
  return entry;
}

async function createAgentSession(opts, winId = win && win.id) {
  const { cwd, name, worktree, prompt, permissionMode, resume } = opts;
  if (!cwd || !fs.existsSync(cwd)) throw new Error('Folder not found: ' + cwd);

  const repo = await repoInfo(cwd);
  let workDir = cwd;
  let branch = repo.branch;
  let wt = opts.existingWorktree || null;
  if (worktree) {
    if (!repo.isRepo) throw new Error('That folder is not a git repository, so a worktree can’t be created.');
    const made = await createWorktree(repo.top, name);
    workDir = made.dir; branch = made.branch; wt = made.dir;
  }

  const id = crypto.randomUUID();
  const state = createSession({ id, name, cwd: workDir, branch, worktree: wt, prompt, kind: 'agent' });
  state.root = opts.root || wt || repo.top;
  state.origin = opts.origin || cwd; // the folder the user picked, so quick-start can reuse it
  state.repoKey = repo.repoKey;
  if (permissionMode && permissionMode !== 'default') state.permissionMode = permissionMode;

  const entry = newEntry(state, winId);
  entry.settingsFile = writeSettingsFile(path.join(app.getPath('userData'), 'hooks'), {
    port: hook.port, sessionId: id, token: hook.token,
  });

  const claudeBin = process.env.SWITCHBOARD_CLAUDE || 'claude';
  let cmd = `${claudeBin} --settings ${shq(entry.settingsFile)}`;
  // make bypass reachable with Shift+Tab inside every session (it is not switched on unless chosen)
  if (process.env.SWITCHBOARD_NO_BYPASS !== '1') cmd += ' --allow-dangerously-skip-permissions';
  if (permissionMode && permissionMode !== 'default') cmd += ` --permission-mode ${shq(permissionMode)}`;
  if (resume) cmd += ` --resume ${shq(resume)}`;
  else if (prompt && prompt.trim()) cmd += ` ${shq(prompt.trim())}`;
  const full = `${cmd}; echo; printf '\\033[2m[claude exited — this is now a plain shell]\\033[0m\\n'; exec "$SHELL" -l`;

  attachPty(entry, ['-l', '-i', '-c', full], workDir, opts.cols, opts.rows);
  pushEvent(state, 'user', resume ? 'Resumed after restart' : wt ? `Worktree ${branch}` : `Started in ${path.basename(workDir)}`);
  return snapshot(state);
}

function createShellSession(opts, winId = win && win.id) {
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir();
  const id = crypto.randomUUID();
  const state = createSession({ id, name: opts.name || 'shell', cwd, kind: 'shell' });
  state.origin = opts.origin || cwd;
  state.root = cwd;
  setStatus(state, 'shell', tilde(cwd));
  const entry = newEntry(state, winId);
  attachPty(entry, ['-l', '-i'], cwd, opts.cols, opts.rows);
  pushEvent(state, 'user', `Shell in ${path.basename(cwd) || cwd}`);
  return snapshot(state);
}

function killSession(id) {
  const entry = sessions.get(id);
  if (!entry) return;
  try { entry.pty && entry.pty.kill(); } catch { /* already gone */ }
  try { entry.settingsFile && fs.unlinkSync(entry.settingsFile); } catch { /* ignore */ }
  sessions.delete(id);
  updateBadge();
}

// ---------- what's running in each terminal (folder + foreground command) ----------

function run(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 4000, maxBuffer: 8 << 20 }, (err, out) => resolve(err ? '' : out)));
}

async function pollTerminals() {
  const live = [...sessions.values()].filter((e) => e.pty && !e.dead && e.tty);
  if (!live.length) return;
  const psOut = await run('ps', ['-A', '-o', 'pid=,pgid=,tpgid=,tty=,args=']);
  const rows = psOut.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean)
    .map((m) => ({ pid: +m[1], pgid: +m[2], tpgid: +m[3], tty: m[4], args: m[5] }));
  const lsofOut = await run('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', live.map((e) => e.pty.pid).join(',')]);
  const cwds = new Map();
  let curPid = null;
  for (const line of lsofOut.split('\n')) {
    if (line[0] === 'p') curPid = +line.slice(1);
    else if (line[0] === 'n' && curPid) cwds.set(curPid, line.slice(1));
  }

  for (const entry of live) {
    const st = entry.state;
    const me = rows.find((r) => r.pid === entry.pty.pid);
    let command = null;
    if (me && me.tpgid > 0 && me.tpgid !== me.pid) {
      const leader = rows.find((r) => r.pid === me.tpgid) || rows.find((r) => r.pgid === me.tpgid && r.tty === entry.tty);
      if (leader) command = leader.args.replace(/^-/, '');
    }
    const cwdNow = cwds.get(entry.pty.pid) || st.cwdNow;
    const plain = st.kind === 'shell' || st.status === 'exited';
    let changed = cwdNow !== st.cwdNow;
    st.cwdNow = cwdNow;

    if (plain) {
      if (command !== st.command) {
        changed = true;
        const prevCmd = st.command;
        const startedAt = entry.cmdSince || 0;
        st.command = command;
        entry.cmdSince = command ? Date.now() : 0;
        if (prevCmd && !command) {
          const secs = (Date.now() - startedAt) / 1000;
          pushEvent(st, 'shell', `${shortCmd(prevCmd)} · ${Math.round(secs)}s`);
          if (secs >= 8) commandFinished(entry, prevCmd, secs);
        }
      }
      const activity = command ? `▸ ${shortCmd(command)}` : tilde(cwdNow);
      if (activity !== st.activity) { st.activity = activity; changed = true; }
    }
    if (changed) broadcast(st.id);
  }
}

function shortCmd(c) {
  return String(c).replace(/^\S*\/(?=[^/\s]+(\s|$))/, '').slice(0, 80);
}

function commandFinished(entry, cmd, secs) {
  const w = windowFor(entry.winId);
  const looking = w && w.isFocused() && entry.visible;
  if (looking) return;
  entry.state.attention = 'finished';
  broadcast(entry.state.id);
  notify(entry, `Finished: ${shortCmd(cmd)}`, `${entry.state.name} · took ${Math.round(secs)}s`);
}

// ---------- opening file paths clicked in a terminal ----------

const EDITORS = {
  vscode: ['/usr/local/bin/code', '/opt/homebrew/bin/code', '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'],
  cursor: ['/usr/local/bin/cursor', '/opt/homebrew/bin/cursor', '/Applications/Cursor.app/Contents/Resources/app/bin/cursor'],
  zed: ['/usr/local/bin/zed', '/opt/homebrew/bin/zed', '/Applications/Zed.app/Contents/MacOS/cli'],
};
function findEditor(kind) {
  for (const p of EDITORS[kind] || []) if (fs.existsSync(p)) return p;
  return null;
}
function openInEditor(abs, line, col) {
  let isDir = false;
  try { isDir = fs.statSync(abs).isDirectory(); } catch { return; }
  if (isDir) { shell.openPath(abs); return; }
  const order = settings.editor === 'auto' ? ['vscode', 'cursor', 'zed'] : [settings.editor];
  for (const kind of order) {
    const bin = findEditor(kind);
    if (!bin) continue;
    const target = line ? `${abs}:${line}${col ? ':' + col : ''}` : abs;
    const args = kind === 'zed' ? [target] : ['-g', target];
    execFile(bin, args, { env: cleanEnv(process.env) }, () => {});
    return;
  }
  shell.openPath(abs);
}

function resolveCandidates(id, cands) {
  const entry = sessions.get(id);
  const base = entry ? (entry.state.cwdNow || entry.state.cwd) : os.homedir();
  const out = [];
  for (const c of cands) {
    const m = String(c).match(/^(.*?)(?::(\d+))?(?::(\d+))?$/);
    if (!m || !m[1]) continue;
    let p = m[1];
    if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
    else if (!path.isAbsolute(p)) p = path.resolve(base, p);
    if (fs.existsSync(p)) out.push({ text: c, abs: p, line: m[2] ? +m[2] : 0, col: m[3] ? +m[3] : 0 });
  }
  return out;
}

// ---------- saving & restoring sessions ----------

const stateFile = () => path.join(app.getPath('userData'), 'sessions.json');

async function collectBuffers(w) {
  try {
    return await Promise.race([
      w.webContents.executeJavaScript('window.__sbSerialize ? window.__sbSerialize() : {}', true),
      new Promise((r) => setTimeout(() => r({}), 1500)),
    ]) || {};
  } catch { return {}; }
}

let saving = null;
let startedUp = false;  // never save before restore finished: a copy killed mid-startup must not wipe your sessions
async function saveState() {
  if (!PERSIST || !startedUp) return;
  if (saving) return saving;
  saving = (async () => {
    const out = { version: 1, savedAt: Date.now(), windows: [] };
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue;
      const bufs = await collectBuffers(w);
      const list = [...sessions.values()].filter((e) => e.winId === w.id && !e.dead);
      if (!list.length) continue;
      out.windows.push({
        bounds: w.getBounds(),
        active: w.__activeId || null,
        sessions: list.map((e) => {
          const s = e.state;
          const agentLive = s.kind === 'agent' && s.status !== 'exited';
          return {
            id: s.id, kind: agentLive ? 'agent' : 'shell', name: s.name,
            cwd: agentLive ? s.cwd : (s.cwdNow || s.cwd), origin: s.origin, root: s.root,
            worktree: s.worktree, permissionMode: s.permissionMode,
            claudeSessionId: s.claudeSessionId,
            buffer: (bufs[s.id] || '').slice(-300000),
          };
        }),
      });
    }
    try {
      const tmp = stateFile() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(out));
      fs.renameSync(tmp, stateFile());
    } catch (e) { console.error('save failed', e.message); }
  })();
  try { await saving; } finally { saving = null; }
}

async function restoreState() {
  if (!PERSIST || !settings.restore) return false;
  let data;
  try { data = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return false; }
  if (!data || !Array.isArray(data.windows) || !data.windows.length) return false;
  for (const sw of data.windows) {
    const w = createWindow(sw.bounds);
    for (const ss of sw.sessions || []) {
      try {
        let snap;
        if (ss.kind === 'agent' && ss.cwd && fs.existsSync(ss.cwd)) {
          snap = await createAgentSession({
            cwd: ss.cwd, name: ss.name, permissionMode: ss.permissionMode,
            resume: ss.claudeSessionId || null, origin: ss.origin, root: ss.root, existingWorktree: ss.worktree,
          }, w.id);
        } else {
          snap = createShellSession({ cwd: ss.cwd, name: ss.name, origin: ss.origin }, w.id);
        }
        const e = sessions.get(snap.id);
        e.stash = ss.buffer || '';
        e.restoredAt = data.savedAt;
        if (sw.active === ss.id) e.state.restoredActive = true;
      } catch (err) { console.error('restore failed for', ss.name, err.message); }
    }
  }
  return true;
}

// ---------- IPC ----------

ipcMain.handle('session:create', async (e, opts) => {
  try { return { ok: true, session: await createAgentSession(opts, senderWinId(e)) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('shell:create', (e, opts) => {
  try { return { ok: true, session: createShellSession(opts || {}, senderWinId(e)) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.on('session:write', (_e, id, data) => { const s = sessions.get(id); if (s && s.pty && !s.dead) s.pty.write(data); });
ipcMain.on('session:resize', (_e, id, cols, rows) => {
  const s = sessions.get(id);
  if (s && s.pty && cols > 0 && rows > 0) try { s.pty.resize(cols, rows); } catch { /* exited */ }
});
ipcMain.handle('session:kill', (_e, id) => { killSession(id); return true; });
// The window (re)attaches to its sessions: hand over saved/early output and start streaming.
ipcMain.handle('session:list', (e) => {
  const winId = senderWinId(e);
  return [...sessions.values()].filter((x) => x.winId === winId).map((x) => {
    const out = { ...snapshot(x.state), _stash: x.stash || '', _early: x.early || '', _restoredAt: x.restoredAt || 0 };
    x.stash = ''; x.early = ''; x.restoredAt = 0; x.claimed = true;
    return out;
  });
});
ipcMain.handle('session:claim', (_e, id) => {
  const x = sessions.get(id);
  if (!x) return '';
  const early = x.early || '';
  x.early = ''; x.claimed = true;
  return early;
});
// Page is reloading: keep each terminal's screen, and hold new output until it's back.
ipcMain.on('session:stash', (e, bufs) => {
  const winId = senderWinId(e);
  for (const x of sessions.values()) {
    if (x.winId !== winId) continue;
    x.stash = (bufs && bufs[x.state.id]) || '';
    x.claimed = false;
  }
  e.returnValue = true;
});
ipcMain.on('view:visible', (e, ids, activeId) => {
  const winId = senderWinId(e);
  const w = windowFor(winId);
  if (w) w.__activeId = activeId;
  for (const x of sessions.values()) if (x.winId === winId) x.visible = ids.includes(x.state.id);
});
ipcMain.on('session:attention', (_e, id, kind) => {
  const x = sessions.get(id);
  if (!x) return;
  x.state.attention = kind || null;
  if (kind === 'bell') {
    const w = windowFor(x.winId);
    if (app.dock && !(w && w.isFocused())) app.dock.bounce('informational');
  }
  broadcast(id);
});
ipcMain.handle('session:reveal', (_e, id) => { const s = sessions.get(id); if (s) shell.openPath(s.state.cwdNow || s.state.cwd); });
ipcMain.handle('session:rename', (_e, id, name) => {
  const s = sessions.get(id);
  if (s && name && name.trim()) { s.state.name = name.trim().slice(0, 60); broadcast(id); }
});
ipcMain.handle('git:info', (_e, cwd) => repoInfo(cwd));
ipcMain.handle('fs:isDir', (_e, p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
ipcMain.handle('path:resolve', (_e, id, cands) => resolveCandidates(id, cands || []));
ipcMain.handle('path:open', (_e, abs, line, col) => openInEditor(abs, line, col));
ipcMain.handle('voice:set', (_e, on, quiet) => { voiceOn = !!on; if (voiceOn && !quiet) speak('Voice on.'); return voiceOn; });
ipcMain.handle('dialog:pickFolder', async (e) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('clip:write', (_e, text) => { clipboard.writeText(String(text || '')); });
ipcMain.handle('clip:read', () => clipboard.readText());
ipcMain.handle('beep', () => shell.beep());
ipcMain.handle('settings:get', () => ({ ...settings }));
ipcMain.handle('settings:set', (_e, patch) => {
  settings = { ...settings, ...(patch || {}) };
  saveSettings();
  send('settings:changed', { ...settings });
  return { ...settings };
});
// Right-click menu in a terminal. Resolves with the chosen action (or null).
ipcMain.handle('menu:context', (e, opts = {}) => new Promise((resolve) => {
  let picked = null;
  const pick = (a) => () => { picked = a; };
  const items = [
    { label: 'Copy', enabled: !!opts.hasSelection, click: pick('copy') },
    { label: 'Paste', click: pick('paste') },
    { label: 'Select All', click: pick('selectAll') },
    { type: 'separator' },
    { label: 'Find…', click: pick('find') },
    { label: 'Clear Buffer', click: pick('clear') },
    { type: 'separator' },
    opts.split ? { label: 'Close Split', click: pick('closeSplit') } : { label: 'Split Right (new shell)', click: pick('splitRight') },
    { label: 'New Shell Here', click: pick('newShellHere') },
    { label: 'Open Folder in Finder', click: pick('reveal') },
  ];
  Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(e.sender), callback: () => setTimeout(() => resolve(picked), 0) });
}));

// ---------- window & menu ----------

function menuSend(action, arg) {
  return () => {
    const w = BrowserWindow.getFocusedWindow() || win;
    if (w && !w.isDestroyed()) w.webContents.send('menu', action, arg);
  };
}

function buildMenu() {
  const sessionItems = [];
  for (let i = 1; i <= 9; i++) {
    sessionItems.push({ label: `Session ${i}`, accelerator: `CmdOrCtrl+${i}`, click: menuSend('select', i - 1) });
  }
  const template = [
    ...(process.platform === 'darwin' ? [{
      role: 'appMenu',
      submenu: [
        { role: 'about' }, { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: menuSend('settings') },
        { type: 'separator' }, { role: 'services' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
      ],
    }] : []),
    {
      label: 'Session',
      submenu: [
        { label: 'New Agent', accelerator: 'CmdOrCtrl+T', click: menuSend('new') },
        { label: 'New Agent with Options…', accelerator: 'CmdOrCtrl+Shift+T', click: menuSend('new-options') },
        { label: 'Open Folder in New Agent…', accelerator: 'CmdOrCtrl+O', click: menuSend('open-folder') },
        { label: 'New Shell', accelerator: 'CmdOrCtrl+Shift+N', click: menuSend('new-shell') },
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        { type: 'separator' },
        { label: 'Split Right', accelerator: 'CmdOrCtrl+D', click: menuSend('split') },
        { label: 'Close Split', accelerator: 'CmdOrCtrl+Shift+D', click: menuSend('unsplit') },
        { type: 'separator' },
        { label: 'Jump to Next Waiting Agent', accelerator: 'CmdOrCtrl+J', click: menuSend('next') },
        { label: 'Toggle Mission Control', accelerator: 'CmdOrCtrl+0', click: menuSend('mission') },
        { label: 'Toggle Inspector', accelerator: 'CmdOrCtrl+I', click: menuSend('inspector') },
        { label: 'Search All Terminals…', accelerator: 'CmdOrCtrl+P', click: menuSend('palette') },
        { label: 'Rename Session…', accelerator: 'CmdOrCtrl+Shift+E', click: menuSend('rename') },
        { type: 'separator' },
        ...sessionItems,
        { type: 'separator' },
        { label: 'Close Session', accelerator: 'CmdOrCtrl+W', click: menuSend('close') },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', click: () => { const w = BrowserWindow.getFocusedWindow(); if (w) w.close(); } },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: menuSend('find') },
        { label: 'Find Next', accelerator: 'CmdOrCtrl+G', click: menuSend('find-next') },
        { label: 'Find Previous', accelerator: 'CmdOrCtrl+Shift+G', click: menuSend('find-prev') },
        { type: 'separator' },
        { label: 'Clear Buffer', accelerator: 'CmdOrCtrl+K', click: menuSend('clear') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Bigger Text', accelerator: 'CmdOrCtrl+=', click: menuSend('font', 1) },
        { label: 'Smaller Text', accelerator: 'CmdOrCtrl+-', click: menuSend('font', -1) },
        { type: 'separator' },
        // Not ⌘R: that key is too easy to hit, and in a terminal it shouldn't do anything drastic.
        { label: 'Reload Window', accelerator: 'CmdOrCtrl+Shift+R', click: () => { const w = BrowserWindow.getFocusedWindow(); if (w) w.webContents.reload(); } },
        { role: 'toggleDevTools' }, { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

let quitting = false;

function createWindow(bounds) {
  const w = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 560,
    ...(bounds && bounds.width ? bounds : {}),
    backgroundColor: '#0B0C0E',
    title: 'Switchboard',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win = w;
  const winId = w.id;
  w.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Links clicked in a terminal open in the real browser, never inside the app.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.on('focus', () => w.webContents.send('window:focus'));
  w.on('close', (e) => {
    if (quitting) return;
    if (BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed()).length <= 1) {
      // Closing the last window quits the app — save first so everything comes back.
      e.preventDefault();
      app.quit();
      return;
    }
    for (const x of [...sessions.values()]) if (x.winId === winId) killSession(x.state.id);
  });
  w.on('closed', () => { if (win === w) win = BrowserWindow.getAllWindows()[0] || null; });
  return w;
}

app.whenReady().then(async () => {
  loadSettings();
  hook = await startHookServer(handleHook);
  buildMenu();
  const restored = await restoreState();
  if (!restored) createWindow();
  startedUp = true;
  if (process.env.SB_SMOKE) require('./test/smoke-electron')({ app, win, createAgentSession, handleHook, send });
  setInterval(pollTerminals, 1500);
  if (PERSIST) setInterval(saveState, 20000);
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => app.quit());

let savedOnQuit = false;
app.on('before-quit', (e) => {
  if (savedOnQuit || !PERSIST) { quitting = true; return; }
  e.preventDefault();
  saveState().finally(() => { savedOnQuit = true; quitting = true; app.quit(); });
});

app.on('will-quit', () => {
  for (const id of [...sessions.keys()]) killSession(id);
  if (hook) hook.server.close();
});

// `kill` / Ctrl+C on the launcher should save and quit cleanly, not just vanish.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => app.quit());
