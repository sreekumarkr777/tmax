// Switchboard — main process.
// Owns the PTYs (one per agent session), the hook server that hears from
// Claude Code, notifications, the dock badge and the optional voice.

const { app, BrowserWindow, ipcMain, dialog, Menu, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const pty = require('node-pty');

const { createSession, applyHook, snapshot, setStatus, pushEvent } = require('./src/state');
const { startHookServer, writeSettingsFile } = require('./src/hooks');
const { repoInfo, createWorktree, currentBranch } = require('./src/git');
const { readContextUsage } = require('./src/transcript');

app.setName('Switchboard');

let win = null;
let hook = null;               // { server, port, token }
const sessions = new Map();    // id -> { state, pty, buf, flushTimer, ctxTimer }
let voiceOn = false;

// ---------- helpers ----------

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function broadcast(id) {
  const s = sessions.get(id);
  if (s) send('session:update', snapshot(s.state));
}

function shq(str) {
  return "'" + String(str).replace(/'/g, `'\\''`) + "'";
}

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
  const focusedHere = win && win.isFocused();
  const idx = [...sessions.keys()].indexOf(s.id);

  if (next === 'waiting') {
    if (!focusedHere) notify(s, `${s.name} needs you`, s.activity);
    speak(`${s.name} needs you.`, idx);
  } else if (next === 'done' && prev === 'working') {
    if (!focusedHere) notify(s, `${s.name} finished`, s.activity);
    speak(`${s.name} is done.`, idx);
    currentBranch(s.cwd).then((b) => { if (b && b !== s.branch) { s.branch = b; broadcast(s.id); } });
  } else if (next === 'error') {
    if (!focusedHere) notify(s, `${s.name} hit an error`, s.activity);
    speak(`${s.name} hit an error.`, idx);
  }
}

function notify(s, title, body) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body: body || '', silent: false });
  n.on('click', () => {
    if (win) { win.show(); win.focus(); }
    send('session:focus', s.id);
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

async function createAgentSession(opts) {
  const { cwd, name, worktree, prompt, permissionMode } = opts;
  if (!cwd || !fs.existsSync(cwd)) throw new Error('Folder not found: ' + cwd);

  const repo = await repoInfo(cwd);
  let workDir = cwd;
  let branch = repo.branch;
  let wt = null;
  if (worktree) {
    if (!repo.isRepo) throw new Error('That folder is not a git repository, so a worktree can’t be created.');
    const made = await createWorktree(repo.top, name);
    workDir = made.dir; branch = made.branch; wt = made.dir;
  }

  const id = crypto.randomUUID();
  const state = createSession({ id, name, cwd: workDir, branch, worktree: wt, prompt });
  state.root = wt || repo.top;
  state.repoKey = repo.repoKey;
  if (permissionMode && permissionMode !== 'default') state.permissionMode = permissionMode;

  const settingsFile = writeSettingsFile(path.join(app.getPath('userData'), 'hooks'), {
    port: hook.port, sessionId: id, token: hook.token,
  });

  const claudeBin = process.env.SWITCHBOARD_CLAUDE || 'claude';
  let cmd = `${claudeBin} --settings ${shq(settingsFile)}`;
  if (permissionMode && permissionMode !== 'default') cmd += ` --permission-mode ${shq(permissionMode)}`;
  if (prompt && prompt.trim()) cmd += ` ${shq(prompt.trim())}`;
  const full = `${cmd}; echo; printf '\\033[2m[claude exited — this is now a plain shell]\\033[0m\\n'; exec "$SHELL" -l`;

  const userShell = process.env.SHELL || '/bin/zsh';
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Switchboard', SWITCHBOARD_SESSION: id };
  delete env.ELECTRON_RUN_AS_NODE;

  const p = pty.spawn(userShell, ['-l', '-i', '-c', full], {
    name: 'xterm-256color', cols: opts.cols || 100, rows: opts.rows || 30, cwd: workDir, env,
  });

  const entry = { state, pty: p, buf: '', flushTimer: null, ctxTimer: null, settingsFile };
  sessions.set(id, entry);

  p.onData((data) => {
    entry.buf += data;
    if (!entry.flushTimer) {
      entry.flushTimer = setTimeout(() => {
        entry.flushTimer = null;
        send('pty:data', id, entry.buf);
        entry.buf = '';
      }, 6);
    }
  });
  p.onExit(({ exitCode }) => {
    state.exitCode = exitCode;
    setStatus(state, 'exited', `Terminal closed (exit ${exitCode})`);
    pushEvent(state, 'stop', 'Terminal closed');
    broadcast(id);
    updateBadge();
  });

  pushEvent(state, 'user', wt ? `Worktree ${branch}` : `Started in ${path.basename(workDir)}`);
  return snapshot(state);
}

function killSession(id) {
  const entry = sessions.get(id);
  if (!entry) return;
  try { entry.pty.kill(); } catch { /* already gone */ }
  try { fs.unlinkSync(entry.settingsFile); } catch { /* ignore */ }
  sessions.delete(id);
  updateBadge();
}

// ---------- IPC ----------

ipcMain.handle('session:create', async (_e, opts) => {
  try { return { ok: true, session: await createAgentSession(opts) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.on('session:write', (_e, id, data) => { const s = sessions.get(id); if (s) s.pty.write(data); });
ipcMain.on('session:resize', (_e, id, cols, rows) => {
  const s = sessions.get(id);
  if (s && cols > 0 && rows > 0) try { s.pty.resize(cols, rows); } catch { /* exited */ }
});
ipcMain.handle('session:kill', (_e, id) => { killSession(id); return true; });
ipcMain.handle('session:list', () => [...sessions.values()].map((s) => snapshot(s.state)));
ipcMain.handle('session:reveal', (_e, id) => { const s = sessions.get(id); if (s) shell.openPath(s.state.cwd); });
ipcMain.handle('git:info', (_e, cwd) => repoInfo(cwd));
ipcMain.handle('voice:set', (_e, on) => { voiceOn = !!on; if (voiceOn) speak('Voice on.'); return voiceOn; });
ipcMain.handle('dialog:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// ---------- window & menu ----------

function menuSend(action, arg) { return () => send('menu', action, arg); }

function buildMenu() {
  const sessionItems = [];
  for (let i = 1; i <= 9; i++) {
    sessionItems.push({ label: `Session ${i}`, accelerator: `CmdOrCtrl+${i}`, click: menuSend('select', i - 1) });
  }
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'Session',
      submenu: [
        { label: 'New Agent Session…', accelerator: 'CmdOrCtrl+T', click: menuSend('new') },
        { label: 'Jump to Next Waiting Agent', accelerator: 'CmdOrCtrl+J', click: menuSend('next') },
        { label: 'Toggle Mission Control', accelerator: 'CmdOrCtrl+0', click: menuSend('mission') },
        { label: 'Toggle Inspector', accelerator: 'CmdOrCtrl+I', click: menuSend('inspector') },
        { type: 'separator' },
        ...sessionItems,
        { type: 'separator' },
        { label: 'Close Session', accelerator: 'CmdOrCtrl+W', click: menuSend('close') },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Bigger Text', accelerator: 'CmdOrCtrl+=', click: menuSend('font', 1) },
        { label: 'Smaller Text', accelerator: 'CmdOrCtrl+-', click: menuSend('font', -1) },
        { type: 'separator' },
        { role: 'reload' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 560,
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
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Links clicked in a terminal open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('focus', () => send('window:focus'));
  win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
  hook = await startHookServer(handleHook);
  buildMenu();
  createWindow();
  if (process.env.SB_SMOKE) require('./test/smoke-electron')({ app, win, createAgentSession, handleHook, send });
  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('window-all-closed', () => {
  for (const id of [...sessions.keys()]) killSession(id);
  app.quit();
});

app.on('before-quit', () => {
  for (const id of [...sessions.keys()]) killSession(id);
  if (hook) hook.server.close();
});
