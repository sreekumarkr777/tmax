/* Tmax renderer. Plain JS, no build step. */
(() => {
  const sb = window.sb;
  const $ = (sel) => document.querySelector(sel);

  const STATUS = {
    starting: { label: 'Starting', badge: 'starting' },
    working: { label: 'Working', badge: 'working' },
    waiting: { label: 'Needs you', badge: 'waiting' },
    done: { label: 'Your turn', badge: 'done' },
    error: { label: 'Error', badge: 'error' },
    exited: { label: 'Shell', badge: 'exited' },
    shell: { label: 'Shell', badge: 'exited' },
  };
  const SAFETY = {
    default: { text: 'Asks before acting', cls: '' },
    plan: { text: 'Plan mode · read-only', cls: '' },
    acceptEdits: { text: 'Auto-accepting edits', cls: 'warn' },
    auto: { text: 'Auto mode', cls: 'warn' },
    manual: { text: 'Asks before acting', cls: '' },
    dontAsk: { text: 'Won’t ask · denies unknown', cls: 'warn' },
    bypassPermissions: { text: 'Bypass · no prompts', cls: 'danger' },
  };
  const TICK_COLOR = {
    read: '#6D7091', edit: '#F5B544', shell: '#7C8CFF', agent: '#A78BFA', ask: '#FFE08A',
    fail: '#FF6B81', user: '#22D3EE', stop: '#34D399', mcp: '#6B7A8F', web: '#6B7A8F', other: '#6B7A8F',
  };
  const TICK_H = { edit: 16, agent: 14, ask: 18, fail: 14, user: 18, stop: 12 };

  const THEMES = {
    midnight: {
      background: '#0A0B12', foreground: '#E6E5F2', cursor: '#22D3EE', cursorAccent: '#0A0B12',
      selectionBackground: '#2E2A5C',
      black: '#171930', red: '#FF6B81', green: '#34D399', yellow: '#F5B544', blue: '#7C8CFF',
      magenta: '#A78BFA', cyan: '#22D3EE', white: '#C6C7DA',
      brightBlack: '#565A80', brightRed: '#FF94A5', brightGreen: '#6EE7B7', brightYellow: '#F8D08A',
      brightBlue: '#A5B0FF', brightMagenta: '#C4B5FD', brightCyan: '#7DE6F5', brightWhite: '#F4F3FB',
    },
    paper: {
      background: '#FBFAF7', foreground: '#23262C', cursor: '#23262C', cursorAccent: '#FBFAF7',
      selectionBackground: '#CFD8E8',
      black: '#23262C', red: '#C4473A', green: '#2E7D62', yellow: '#9A6A12', blue: '#2F6FCC',
      magenta: '#7A55C9', cyan: '#1F7F8C', white: '#8A8F98',
      brightBlack: '#6B6F78', brightRed: '#D6584B', brightGreen: '#3A9A79', brightYellow: '#B07D1A',
      brightBlue: '#4A86E0', brightMagenta: '#9070DA', brightCyan: '#2C97A6', brightWhite: '#3A3D44',
    },
    contrast: {
      background: '#000000', foreground: '#FFFFFF', cursor: '#FFFFFF', cursorAccent: '#000000',
      selectionBackground: '#1F4E99',
      black: '#000000', red: '#FF5F56', green: '#3CF0A0', yellow: '#FFD23F', blue: '#5FA8FF',
      magenta: '#D48CFF', cyan: '#5FF0FF', white: '#E6E6E6',
      brightBlack: '#8C8C8C', brightRed: '#FF8A80', brightGreen: '#7CFFC4', brightYellow: '#FFE57F',
      brightBlue: '#9CC8FF', brightMagenta: '#E8B8FF', brightCyan: '#A0FFFF', brightWhite: '#FFFFFF',
    },
  };

  const state = {
    order: [],               // session ids in creation order
    sessions: new Map(),     // id -> snapshot
    terms: new Map(),        // id -> { term, fit, search, serial, wrap }
    titles: new Map(),       // id -> title set by the program (OSC 0/2)
    activeId: null,          // focused session (the focused pane when split)
    split: null,             // { a, b } — two sessions side by side
    view: 'session',         // 'session' | 'mission'
    voice: false,
  };
  let settings = {
    fontFamily: 'JetBrains Mono', fontSize: 13, lineHeight: 1.2, theme: 'midnight', cursorStyle: 'block',
    cursorBlink: true, optionAsMeta: false, scrollback: 20000, copyOnSelect: false, bell: 'visual', editor: 'auto', restore: true, glass: 'medium',
  };

  // ---------- utils ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const home = (p) => String(p || '').replace(/^\/Users\/[^/]+/, '~');
  function ago(t) {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }
  function projectName(s) {
    if (s.repoKey && /\/\.git\/?$/.test(s.repoKey)) return s.repoKey.replace(/\/\.git\/?$/, '').split('/').pop();
    return String(s.root || s.cwd).split('/').filter(Boolean).pop() || '';
  }
  function fmtTokens(n) { return n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n); }
  const fmtCost = (c) => (c >= 100 ? `$${Math.round(c)}` : c >= 1 ? `$${c.toFixed(2)}` : `$${c.toFixed(3)}`);
  const totalTokens = (u) => u ? u.input + u.output + u.cacheRead + u.cacheWrite : 0;
  function todayKey() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  function ctxInfo(s) {
    if (!s.context) return null;
    const used = s.context.used;
    const win = used > 200000 || /\[1m\]/i.test(s.context.model || '') ? 1000000 : 200000;
    const pct = Math.min(100, Math.round((used / win) * 100));
    return { used, win, pct, cls: pct >= 85 ? 'crit' : pct >= 65 ? 'hot' : '' };
  }
  // How see-through the window is (1 = solid). The terminal stays a little more solid than the chrome.
  const GLASS = { off: 1, subtle: 0.9, medium: 0.8, strong: 0.62 };
  function hexRgba(hex, a) {
    const n = parseInt(hex.replace('#', ''), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  function applyGlass() {
    const a = GLASS[settings.glass] ?? GLASS.medium;
    const root = document.documentElement;
    root.style.setProperty('--glass', String(a));
    root.classList.toggle('glass', a < 1);
    const bg = (THEMES[settings.theme] || THEMES.midnight).background;
    const light = settings.theme === 'paper';
    $('#stage').style.background = a >= 1 ? bg : hexRgba(bg, light ? Math.max(0.92, a) : Math.min(0.9, a * 0.5 + 0.1));
  }
  const isPlain = (s) => s && (s.kind === 'shell' || s.status === 'exited' || s.status === 'shell');
  const fontStack = (f) => `"${f}", "SF Mono", Menlo, monospace`;

  let raf = 0;
  function render() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; renderAll(); });
  }

  // ---------- terminals ----------
  function termOptions() {
    return {
      fontFamily: fontStack(settings.fontFamily), fontSize: settings.fontSize, lineHeight: settings.lineHeight,
      cursorBlink: settings.cursorBlink, cursorStyle: settings.cursorStyle, scrollback: settings.scrollback,
      macOptionIsMeta: !!settings.optionAsMeta, macOptionClickForcesSelection: true,
      allowTransparency: true,
      // the stage behind the terminal paints the background, so the glass effect shows through
      theme: { ...(THEMES[settings.theme] || THEMES.midnight), background: 'rgba(0,0,0,0)' },
    };
  }

  // Option-key editing that works even when Option types special characters (like Terminal.app).
  const OPTION_KEYS = { ArrowLeft: '\x1bb', ArrowRight: '\x1bf', Backspace: '\x1b\x7f', Delete: '\x1bd', Enter: '\x1b\r' };

  // file paths like src/a.ts:12:5, ./x, ../y, ~/z, /abs/path, or name.ext
  const PATH_RE = /(?:~\/|\.{1,2}\/|\/)?(?:[\w.@+-]+\/)*[\w@+-][\w.@+-]*\.[A-Za-z0-9]{1,10}(?::\d+){0,2}|(?:~|\.{1,2})?\/(?:[\w.@+-]+\/?)+(?::\d+){0,2}/g;

  function ensureTerminal(id) {
    if (state.terms.has(id)) return state.terms.get(id);
    const wrap = document.createElement('div');
    wrap.className = 'term-wrap';
    wrap.dataset.id = id;
    $('#terminals').appendChild(wrap);
    const term = new Terminal({ ...termOptions(), allowProposedApi: true });
    const fit = new FitAddon.FitAddon();
    const search = new SearchAddon.SearchAddon();
    const serial = new SerializeAddon.SerializeAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(serial);
    // Like other Mac terminals: ⌘-click opens a link.
    term.loadAddon(new WebLinksAddon.WebLinksAddon((ev, uri) => { if (ev.metaKey) window.open(uri, '_blank'); }));
    term.open(wrap);

    term.onData((d) => sb.write(id, d));
    term.onResize(({ cols, rows }) => sb.resize(id, cols, rows));
    term.onTitleChange((title) => { state.titles.set(id, title); render(); });
    term.onSelectionChange(() => { if (settings.copyOnSelect && term.hasSelection()) sb.copy(term.getSelection()); });
    term.onBell(() => onBell(id));
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (!settings.optionAsMeta && e.altKey && !e.ctrlKey && !e.metaKey && OPTION_KEYS[e.key]) {
        sb.write(id, OPTION_KEYS[e.key]);
        e.preventDefault();
        return false;
      }
      return true;
    });
    term.textarea && term.textarea.addEventListener('focus', () => {
      if (state.activeId !== id && isShown(id)) { state.activeId = id; clearAttention(id); renderAll(); }
    });

    // ⌘-click file paths to open them in your editor
    term.registerLinkProvider({
      provideLinks(y, cb) {
        const line = term.buffer.active.getLine(y - 1);
        if (!line) return cb(undefined);
        const text = line.translateToString(true);
        const found = [];
        for (const m of text.matchAll(PATH_RE)) {
          const raw = m[0].replace(/[.,:;)\]]+$/, '');
          if (raw.length < 3 || /^\d+(\.\d+)*$/.test(raw) || /^https?:/.test(text.slice(Math.max(0, m.index - 8), m.index + 1))) continue;
          found.push({ raw, index: m.index });
        }
        if (!found.length) return cb(undefined);
        sb.resolvePaths(id, found.map((f) => f.raw)).then((ok) => {
          const byText = new Map(ok.map((o) => [o.text, o]));
          cb(found.filter((f) => byText.has(f.raw)).map((f) => {
            const o = byText.get(f.raw);
            return {
              range: { start: { x: f.index + 1, y }, end: { x: f.index + f.raw.length, y } },
              text: f.raw,
              decorations: { pointerCursor: true, underline: true },
              activate: (ev) => { if (ev.metaKey) sb.openPath(o.abs, o.line, o.col); },
            };
          }));
        }).catch(() => cb(undefined));
      },
    });

    const t = { term, fit, search, serial, wrap };
    state.terms.set(id, t);
    if (pendingData.has(id)) { term.write(pendingData.get(id)); pendingData.delete(id); }
    return t;
  }

  function applySettingsToTerms() {
    const o = termOptions();
    for (const t of state.terms.values()) {
      for (const [k, v] of Object.entries(o)) t.term.options[k] = v;
    }
    applyGlass();
    fitVisible();
  }

  const shownIds = () => (state.split ? [state.split.a, state.split.b] : [state.activeId]).filter(Boolean);
  const isShown = (id) => state.view === 'session' && shownIds().includes(id);

  function layoutPanes() {
    const shown = state.view === 'session' ? shownIds() : [];
    $('#terminals').classList.toggle('split', !!state.split);
    for (const [tid, t] of state.terms) {
      t.wrap.classList.toggle('shown', shown.includes(tid));
      t.wrap.classList.toggle('pane-a', !!state.split && tid === state.split.a);
      t.wrap.classList.toggle('pane-b', !!state.split && tid === state.split.b);
      t.wrap.classList.toggle('focused', !!state.split && tid === state.activeId);
    }
    sb.setVisible(shown, state.activeId);
  }

  function fitVisible() {
    if (state.view !== 'session') return;
    for (const id of shownIds()) {
      const t = state.terms.get(id);
      if (t) { try { t.fit.fit(); } catch { /* not visible yet */ } }
    }
  }
  new ResizeObserver(() => fitVisible()).observe($('#terminals'));

  function select(id) {
    if (!state.sessions.has(id)) return;
    if (state.split && id !== state.split.a && id !== state.split.b) {
      // put it in the focused pane
      if (state.activeId === state.split.b) state.split.b = id; else state.split.a = id;
    }
    state.activeId = id;
    state.view = 'session';
    clearAttention(id);
    layoutPanes();
    renderAll();
    requestAnimationFrame(() => { fitVisible(); const t = state.terms.get(id); if (t) t.term.focus(); });
  }

  function clearAttention(id) {
    const s = state.sessions.get(id);
    if (s && s.attention && document.hasFocus()) { s.attention = null; sb.attention(id, null); }
  }

  function onBell(id) {
    if (settings.bell === 'off') return;
    if (settings.bell === 'sound') sb.beep();
    const t = state.terms.get(id);
    if (isShown(id) && document.hasFocus()) {
      if (t) { t.wrap.classList.remove('flash'); void t.wrap.offsetWidth; t.wrap.classList.add('flash'); }
      return;
    }
    const s = state.sessions.get(id);
    if (s) { s.attention = 'bell'; render(); }
    sb.attention(id, 'bell');
  }

  // ---------- sessions ----------
  function addSession(s, { show = true } = {}) {
    state.sessions.set(s.id, s);
    if (!state.order.includes(s.id)) state.order.push(s.id);
    ensureTerminal(s.id);
    sb.claim(s.id).then((early) => { if (early) state.terms.get(s.id)?.term.write(early); });
    if (show) select(s.id);
  }

  async function startSession(opts) {
    const r = await sb.createSession({ ...opts, cols: 100, rows: 30 });
    if (!r.ok) return r;
    addSession(r.session);
    return r;
  }

  function activeFolder() {
    const a = state.sessions.get(state.activeId);
    return a ? (a.cwdNow || a.cwd) : (recent()[0] || null);
  }

  async function newShell({ cwd, show = true } = {}) {
    const r = await sb.createShell({ cwd: cwd || activeFolder(), name: 'shell', cols: 100, rows: 30 });
    if (!r.ok) return null;
    // number shells so they're easy to tell apart
    const n = state.order.filter((id) => state.sessions.get(id)?.kind === 'shell').length;
    if (n > 0) { r.session.name = `shell-${n + 1}`; sb.rename(r.session.id, r.session.name); }
    addSession(r.session, { show });
    return r.session;
  }

  async function splitRight() {
    if (!state.activeId) { newShell(); return; }
    const keep = state.activeId;
    const s = await newShell({ cwd: activeFolder(), show: false });
    if (!s) return;
    state.split = { a: keep, b: s.id };
    select(s.id);
  }

  function unsplit() {
    if (!state.split) return;
    state.split = null;
    select(state.activeId);
  }

  async function closeSession(id) {
    const s = state.sessions.get(id);
    if (!s) return;
    const live = s.status === 'working' || s.status === 'waiting' || (isPlain(s) && s.command);
    const what = s.command && isPlain(s) ? `“${s.command.slice(0, 60)}” is still running` : `It is still ${s.status === 'working' ? 'working' : 'waiting on you'}`;
    if (live && !confirm(`Close “${s.name}”? ${what}.`)) return;
    await sb.kill(id);
    const t = state.terms.get(id);
    if (t) { t.term.dispose(); t.wrap.remove(); state.terms.delete(id); }
    state.sessions.delete(id);
    state.titles.delete(id);
    const i = state.order.indexOf(id);
    state.order.splice(i, 1);
    if (state.split && (state.split.a === id || state.split.b === id)) {
      const other = state.split.a === id ? state.split.b : state.split.a;
      state.split = null;
      if (state.sessions.has(other)) { select(other); return; }
    }
    const nextId = state.order[Math.min(i, state.order.length - 1)];
    if (nextId) select(nextId); else { state.activeId = null; layoutPanes(); renderAll(); }
  }

  function jumpNext() {
    const list = state.order.map((id) => state.sessions.get(id));
    const pick = (fn) => list.filter(fn).sort((a, b) => a.statusSince - b.statusSince);
    const queue = [...pick((s) => s.status === 'waiting'), ...pick((s) => s.status === 'error'), ...pick((s) => s.status === 'done'),
      ...pick((s) => s.attention && !['waiting', 'error', 'done'].includes(s.status))];
    if (!queue.length) return;
    const idx = queue.findIndex((s) => s.id === state.activeId);
    const target = queue[(idx + 1) % queue.length] || queue[0];
    select(target.id);
  }

  const pendingData = new Map(); // output that arrives before the terminal exists
  sb.onData((id, data) => {
    const t = state.terms.get(id);
    if (t) t.term.write(data);
    else pendingData.set(id, (pendingData.get(id) || '') + data);
  });
  sb.onUpdate((s) => {
    if (!state.sessions.has(s.id) && !state.order.includes(s.id)) return; // closed
    // keep a cleared attention cleared locally until main catches up
    state.sessions.set(s.id, s);
    if (s.attention && isShown(s.id) && document.hasFocus()) clearAttention(s.id);
    render();
  });
  sb.onFocusSession((id) => select(id));
  sb.onWindowFocus(() => { fitVisible(); if (state.activeId) clearAttention(state.activeId); });

  // ---------- collisions ----------
  function collisions() {
    const writers = new Map();
    for (const id of state.order) {
      const s = state.sessions.get(id);
      if (!s || s.status === 'exited' || s.kind === 'shell') continue;
      const root = (s.root || s.cwd || '').replace(/\/$/, '');
      for (const f of s.files) {
        if (!f.writes) continue;
        const rel = root && f.path.startsWith(root + '/') ? f.path.slice(root.length + 1) : f.path;
        const key = (s.repoKey || root) + '::' + rel;
        if (!writers.has(key)) writers.set(key, { rel, ids: new Set() });
        writers.get(key).ids.add(id);
      }
    }
    return [...writers.values()].filter((w) => w.ids.size > 1).map((w) => ({ path: w.rel, ids: [...w.ids] }));
  }

  // ---------- rendering ----------
  function subtitle(s) {
    const title = state.titles.get(s.id);
    if (isPlain(s) && !s.command && title && !/^(zsh|bash|fish|-?zsh)$/.test(title)) return title;
    return s.activity;
  }

  function renderAll() {
    const active = state.sessions.get(state.activeId);
    const all = state.order.map((id) => state.sessions.get(id)).filter(Boolean);
    const cols = collisions();

    document.title = active ? `${active.name} — Tmax` : 'Tmax';

    // safety frame follows the active session's permission mode (plain shells have none)
    const mode = active && !isPlain(active) ? active.permissionMode : 'default';
    $('#app').className = `safety-${mode}${$('#app').classList.contains('no-inspector') ? ' no-inspector' : ''}`;
    const pill = $('#safety');
    if (active && !isPlain(active)) {
      const sf = SAFETY[mode] || { text: mode, cls: 'warn' };
      pill.hidden = false;
      pill.className = `safety-pill ${sf.cls}`;
      pill.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/></svg>${esc(sf.text)}`;
    } else pill.hidden = true;

    // crumb
    $('#crumb').innerHTML = active
      ? (isPlain(active)
        ? `<b>${esc(active.name)}</b> <span style="color:#4E5170">·</span> ${esc(home(active.cwdNow || active.cwd))}`
        : `${esc(projectName(active))} <span style="color:#4E5170">/</span> <b>${esc(active.name)}</b>${active.branch ? ` <span style="color:#4E5170">⎇</span> ${esc(active.branch)}` : ''}`)
      : '';

    // next button
    const waiting = all.filter((s) => s.status === 'waiting').length;
    const yourTurn = all.filter((s) => s.status === 'done' || s.status === 'error').length;
    $('#next-count').textContent = waiting || yourTurn;
    $('#btn-next').firstChild.nextSibling.textContent = waiting ? ' waiting ' : ' your turn ';
    $('#btn-next').classList.toggle('hot', waiting > 0);
    $('#btn-mission').classList.toggle('active', state.view === 'mission');

    // today's spend across every session
    const tk = todayKey();
    let dayTok = 0, dayCost = 0, allCost = 0;
    for (const s of all) {
      const d = s.usage && s.usage.days && s.usage.days[tk];
      if (d) { dayTok += d.tokens; dayCost += d.cost; }
      if (s.usage) allCost += s.usage.cost;
    }
    const spend = $('#spend');
    spend.hidden = !dayTok;
    spend.innerHTML = `<span class="sp-k">today</span><b>${fmtTokens(dayTok)}</b><span class="sp-k">tokens</span><b class="sp-cost">≈ ${fmtCost(dayCost)}</b>`;
    spend.title = `Tokens used today by these sessions, priced at Anthropic API list rates (on a Claude plan this is the value used, not a bill). All-time for open sessions: ${fmtCost(allCost)}.`;

    // sidebar
    const shown = state.view === 'session' ? shownIds() : [];
    $('#side-count').textContent = all.length;
    $('#session-list').innerHTML = all.map((s, i) => {
      const st = STATUS[s.status] || STATUS.starting;
      const plain = isPlain(s);
      let badge = '';
      if (!plain && s.loginNeeded) badge = '<span class="badge error">sign in</span>';
      else if (!plain && s.stuck && s.status === 'working') badge = '<span class="badge error">stuck?</span>';
      else if (s.status === 'waiting' || s.status === 'done' || s.status === 'error') badge = `<span class="badge ${st.badge}">${st.label.toLowerCase()}</span>`;
      else if (s.attention === 'finished') badge = '<span class="badge done">finished</span>';
      else if (s.attention === 'bell') badge = '<span class="badge waiting">bell</span>';
      else badge = `<span class="s-num">⌘${i + 1}</span>`;
      const cls = [s.id === state.activeId && state.view === 'session' ? 'active' : '', shown.includes(s.id) && state.split ? 'in-split' : ''].join(' ');
      return `<div class="s-item ${cls}" data-id="${s.id}" role="button" tabindex="0" title="${esc(home(s.cwdNow || s.cwd))} · double-click to rename">
        <div class="s-top"><span class="dot ${plain ? 'shell' : s.status}${plain && s.command ? ' busy' : ''}"></span><span class="s-name">${esc(s.name)}</span>${badge}<button class="s-edit" data-rename="${s.id}" title="Rename (⌘⇧E)" aria-label="Rename ${esc(s.name)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button></div>
        ${!plain && s.branch ? `<div class="s-branch">⎇ ${esc(s.branch)}</div>` : ''}
        <div class="s-act">${esc(subtitle(s))}</div>
        ${!plain && s.pending && s.status === 'waiting' ? `<div class="s-ask">${s.pending.detail ? `<div class="s-ask-d mono">${esc(s.pending.detail.slice(0, 140))}</div>` : ''}<div class="s-ask-b"><button class="mini ok" data-allow="${s.id}" title="Allow (sends Enter to Claude's prompt)">Allow</button><button class="mini no" data-deny="${s.id}" title="Deny (sends Esc)">Deny</button></div></div>` : ''}
        ${!plain && (s.usage || s.context) ? meterRow(s) : ''}</div>`;
    }).join('');

    // stage
    const hasSessions = all.length > 0;
    $('#empty').hidden = hasSessions || state.view === 'mission';
    $('#mission').hidden = state.view !== 'mission';
    $('#terminals').style.visibility = state.view === 'session' ? 'visible' : 'hidden';
    if (state.view === 'mission') renderMission(all, cols);

    renderTimeline(active);
    renderInspector(active, cols);
  }

  function meterRow(s) {
    const ctx = ctxInfo(s);
    return `<div class="s-meter"><span class="bar ${ctx ? ctx.cls : ''}" title="Context ${ctx ? ctx.pct + '% full' : 'unknown'}"><div style="width:${ctx ? ctx.pct : 0}%"></div></span>
      <span>${ctx ? ctx.pct + '%' : ''}</span><span class="s-tok">${s.usage ? fmtTokens(totalTokens(s.usage)) + ' · ' + fmtCost(s.usage.cost) : ''}</span></div>`;
  }

  // The panel at the top of the inspector: what the agent needs from you, and a reply box.
  // Built once and updated in place so typing in the box survives live updates.
  function renderActions(s) {
    const box = $('#insp-actions');
    const agent = s && !isPlain(s);
    box.hidden = !agent;
    if (!agent) return;
    const ctx = ctxInfo(s);
    const parts = [];
    if (s.loginNeeded) parts.push(`<div class="act-card danger"><div class="act-h">Claude’s login expired</div><div class="act-p">Sign in again to keep this agent working.</div><div class="act-b"><button class="mini ok" data-cmd="/login">Sign in (/login)</button></div></div>`);
    if (s.pending && s.status === 'waiting') {
      parts.push(`<div class="act-card ask"><div class="act-h">${esc(s.name)} wants to ${s.pending.tool === 'Bash' ? 'run' : 'use'}</div>
        <div class="act-d mono">${esc(s.pending.detail || s.pending.label)}</div>
        <div class="act-b"><button class="mini ok" data-allow="${s.id}">Allow</button><button class="mini no" data-deny="${s.id}">Deny</button><span class="act-hint">or answer in the terminal for more choices</span></div></div>`);
    }
    if (s.stuck && s.status === 'working') parts.push(`<div class="act-card warn"><div class="act-h">Looks stuck</div><div class="act-p">${esc(s.stuck)}</div><div class="act-b"><button class="mini no" data-interrupt="${s.id}">Interrupt (Esc)</button></div></div>`);
    if (ctx && ctx.pct >= 80) parts.push(`<div class="act-card warn"><div class="act-h">Context ${ctx.pct}% full</div><div class="act-p">Compact now to keep the important parts and free up room.</div><div class="act-b"><button class="mini" data-cmd="/compact">Compact</button></div></div>`);
    const html = parts.join('');
    const alerts = $('#insp-alerts');
    if (alerts.dataset.html !== html) { alerts.innerHTML = html; alerts.dataset.html = html; }
    const ta = $('#reply-q');
    const dead = s.status === 'exited';
    ta.disabled = dead;
    ta.placeholder = dead ? 'Claude has exited' : s.status === 'working' ? 'Runs when it’s free…' : 'Message the agent…';
    $('#reply-for').textContent = s.status === 'working' ? 'Queue a message' : s.status === 'waiting' ? 'Answer' : 'Reply';
  }

  function renderTimeline(s) {
    const track = $('#tl-track');
    if (!s) { track.innerHTML = ''; return; }
    const evs = s.events.slice(-140);
    track.innerHTML = evs.map((e) => {
      const h = TICK_H[e.kind] || 10;
      return `<div class="tick" title="${esc(new Date(e.t).toLocaleTimeString())} · ${esc(e.label)}" style="height:${h}px;background:${TICK_COLOR[e.kind] || '#6B7A8F'}"></div>`;
    }).join('');
  }

  function renderInspector(s, cols) {
    renderActions(s);
    const el = $('#insp-body');
    if (!s) {
      el.innerHTML = `<div class="sec"><h3>Inspector</h3><div class="insp-empty">Start an agent to see its status, context use, files and activity here.</div></div>`;
      return;
    }
    const sessionSec = `
      <section class="sec">
        <h3>Session</h3>
        <div class="status-act mono" style="font-size:11px;color:#8E91AB">${esc(home(s.cwdNow || s.cwd))}${s.worktree ? '<br>worktree · ' + esc(s.branch || '') : ''}</div>
        <div class="actions-row" style="margin-top:10px">
          <button class="ghost-btn" data-act="reveal">Open folder</button>
          <button class="ghost-btn" data-act="shell-here">Shell here</button>
          <button class="ghost-btn" data-act="rename">Rename</button>
          <button class="danger-btn" data-act="close">Close</button>
        </div>
      </section>`;

    if (s.kind === 'shell') {
      el.innerHTML = `
        <section class="sec">
          <h3>Shell <span>${ago(s.createdAt)}</span></h3>
          <div class="status-line"><span class="dot shell${s.command ? ' busy' : ''}"></span>${s.command ? 'Running' : 'Idle'}</div>
          <div class="status-act mono" style="font-size:12px">${esc(s.command || 'Waiting for a command')}</div>
        </section>
        <section class="sec"><h3>Recent commands</h3>
          ${s.events.filter((e) => e.kind === 'shell').slice(-12).reverse().map((e) => `<div class="cmd-row"><span class="mono">${esc(e.label)}</span><span>${ago(e.t)}</span></div>`).join('') || '<div class="insp-empty">Commands you run show up here once they finish.</div>'}
        </section>
        ${sessionSec}`;
      return;
    }

    const st = STATUS[s.status] || STATUS.starting;
    const ctx = ctxInfo(s);
    const maxTouch = Math.max(1, ...s.files.map((f) => f.reads + f.writes));
    const mine = cols.filter((c) => c.ids.includes(s.id));

    el.innerHTML = `
      <section class="sec">
        <h3>Status <span>${ago(s.statusSince)}</span></h3>
        <div class="status-line"><span class="dot ${s.status}"></span>${st.label}</div>
        <div class="status-act">${esc(s.activity)}</div>
      </section>

      <section class="sec">
        <h3>Context ${ctx ? `<span>${fmtTokens(ctx.used)} / ${fmtTokens(ctx.win)}</span>` : ''}</h3>
        ${ctx
          ? `<div class="big">${ctx.pct}%</div><div class="bar ${ctx.cls}"><div style="width:${ctx.pct}%"></div></div>
             ${ctx.pct >= 65 ? `<div class="status-act">Getting full — consider <span class="mono">/compact</span> soon.</div>` : ''}`
          : `<div class="insp-empty">Shows up after Claude’s first reply.</div>`}
      </section>

      ${s.usage ? `<section class="sec">
        <h3>Tokens <span>${esc((s.usage.model || '').replace(/^claude-/, ''))}</span></h3>
        <div class="tok-row"><div class="big">${fmtTokens(totalTokens(s.usage))}</div><div class="tok-cost" title="At Anthropic API list prices. On a Claude plan this is the value used, not what you pay.">≈ ${fmtCost(s.usage.cost)}</div></div>
        <div class="tok-grid">
          <span>input</span><b>${fmtTokens(s.usage.input)}</b>
          <span>output</span><b>${fmtTokens(s.usage.output)}</b>
          <span>cache read</span><b>${fmtTokens(s.usage.cacheRead)}</b>
          <span>cache write</span><b>${fmtTokens(s.usage.cacheWrite)}</b>
        </div>
        <div class="status-act">${s.usage.replies} replies · ${s.usage.cacheRead ? Math.round((s.usage.cacheRead / Math.max(1, s.usage.input + s.usage.cacheRead + s.usage.cacheWrite)) * 100) : 0}% of input served from cache</div>
      </section>` : ''}

      <section class="sec">
        <div class="stats">
          <div class="stat"><b>${s.toolCount}</b><span>tool calls</span></div>
          <div class="stat"><b>${s.subagentsActive}<span style="font-size:12px;color:#6D7091"> / ${s.subagentsTotal}</span></b><span>subagents</span></div>
          <div class="stat"><b>${s.files.filter((f) => f.writes).length}</b><span>files edited</span></div>
        </div>
      </section>

      ${mine.length ? `<section class="sec"><h3>Collisions</h3>${mine.map((c) => {
        const others = c.ids.filter((x) => x !== s.id).map((x) => state.sessions.get(x)?.name).filter(Boolean);
        return `<div class="warn-box">⚠ <b>${esc(others.join(', '))}</b> also edited <span class="mono">${esc(c.path)}</span> — likely merge conflict.</div>`;
      }).join('')}</section>` : ''}

      <section class="sec">
        <h3>Files touched <span>${s.files.length}</span></h3>
        ${s.files.length ? `<div class="files">${s.files.slice(0, 14).map((f) => {
          const w = f.writes > 0;
          const pct = Math.round(((f.reads + f.writes) / maxTouch) * 100);
          const rel = s.root && f.path.startsWith(s.root + '/') ? f.path.slice(s.root.length + 1) : home(f.path);
          return `<button class="file" data-open="${esc(f.path)}" title="Open ${esc(f.path)}"><span class="tag ${w ? 'w' : ''}">${w ? 'W' : 'R'}</span><span class="p">${esc(rel)}</span><span class="heat"><i class="${w ? 'w' : ''}" style="width:${pct}%"></i></span></button>`;
        }).join('')}</div>` : `<div class="insp-empty">Nothing yet.</div>`}
      </section>

      ${s.lastMessage ? `<section class="sec"><h3>Last reply</h3><div class="prose">${esc(s.lastMessage)}</div></section>` : ''}
      ${sessionSec}`;
  }

  function renderMission(all, cols) {
    $('#collisions-banner').innerHTML = cols.map((c) => {
      const names = c.ids.map((x) => state.sessions.get(x)?.name).filter(Boolean);
      return `<div class="warn-box">⚠ <b>Collision ahead:</b> ${esc(names.join(' and '))} are both editing <span class="mono">${esc(c.path)}</span></div>`;
    }).join('');
    $('#mission-grid').innerHTML = all.map((s) => {
      const st = STATUS[s.status] || STATUS.starting;
      if (isPlain(s)) {
        return `<div class="card" role="button" tabindex="0" data-id="${s.id}">
          <div class="card-top"><span class="dot shell${s.command ? ' busy' : ''}"></span><span class="card-name">${esc(s.name)}</span><span class="badge exited">shell</span></div>
          <div class="card-branch">${esc(home(s.cwdNow || s.cwd))}</div>
          <div class="card-say">${esc(s.command ? 'Running ' + s.command : 'Idle')}</div>
          <div class="card-tool">${esc(s.command ? '▸ ' + s.command : '$ _')}</div></div>`;
      }
      const ctx = ctxInfo(s);
      const say = s.status === 'done' && s.lastMessage ? s.lastMessage : s.activity;
      return `<div class="card ${s.status}" role="button" tabindex="0" data-id="${s.id}">
        <div class="card-top"><span class="dot ${s.status}"></span><span class="card-name">${esc(s.name)}</span><span class="badge ${st.badge}">${st.label.toLowerCase()}</span></div>
        <div class="card-branch">${s.branch ? '⎇ ' + esc(s.branch) + ' · ' : ''}${ago(s.createdAt)}</div>
        <div class="card-say">${esc(say)}</div>
        <div class="card-tool">${esc(s.currentTool ? '▸ ' + s.currentTool : s.status === 'done' ? `✓ Finished ${ago(s.statusSince)} ago · ${s.files.filter((f) => f.writes).length} files edited` : s.activity)}</div>
        <div class="card-foot">
          <span style="display:flex;align-items:center;gap:6px">context <span class="bar ${ctx ? ctx.cls : ''}"><div style="width:${ctx ? ctx.pct : 0}%"></div></span> ${ctx ? ctx.pct + '%' : '—'}</span>
          <span>${s.toolCount} tools</span>
          ${s.subagentsActive ? `<span>${s.subagentsActive} subagent${s.subagentsActive > 1 ? 's' : ''}</span>` : ''}
          ${s.usage ? `<span class="card-cost">${fmtTokens(totalTokens(s.usage))} · ${fmtCost(s.usage.cost)}</span>` : ''}
        </div>
        ${s.pending && s.status === 'waiting' ? `<div class="card-ask"><span class="mono">${esc((s.pending.detail || s.pending.label).slice(0, 120))}</span><button class="mini ok" data-allow="${s.id}">Allow</button><button class="mini no" data-deny="${s.id}">Deny</button></div>` : ''}
        ${s.loginNeeded ? `<div class="card-ask"><span>Login expired</span><button class="mini ok" data-cmd-for="${s.id}" data-cmd="/login">Sign in</button></div>` : ''}
        </div>`;
    }).join('') + `<button class="card card-new" data-act="new">+ New agent session</button>`;
  }

  // ---------- rename ----------
  function renameSession(id) {
    const s = state.sessions.get(id);
    if (!s) return;
    const item = document.querySelector(`.s-item[data-id="${CSS.escape(id)}"] .s-name`);
    if (!item) return;
    const input = document.createElement('input');
    input.className = 'rename-input';
    input.value = s.name;
    item.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const finish = (save) => {
      if (done) return; done = true;
      const v = input.value.trim();
      if (save && v && v !== s.name) { s.name = v; sb.rename(id, v); }
      renderAll();
      const t = state.terms.get(state.activeId); if (t) t.term.focus();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); e.stopPropagation(); });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  // ---------- find (⌘F) ----------
  const findbar = $('#findbar');
  const findQ = $('#find-q');
  let findCase = false;
  const FIND_DECOR = { matchBackground: '#5A4A1A', matchOverviewRuler: '#8A6424', activeMatchBackground: '#F2A93B', activeMatchColorOverviewRuler: '#F2A93B' };
  let findSub = null;
  function findTerm() { return state.terms.get(state.activeId); }
  function openFind() {
    if (state.view !== 'session' || !findTerm()) return;
    findbar.hidden = false;
    const sel = findTerm().term.getSelection();
    if (sel && !sel.includes('\n')) findQ.value = sel;
    findQ.focus(); findQ.select();
    if (findQ.value) doFind(true);
  }
  function closeFind() {
    findbar.hidden = true;
    for (const t of state.terms.values()) t.search.clearDecorations();
    $('#find-count').textContent = '';
    const t = findTerm(); if (t) t.term.focus();
  }
  function doFind(forward = true, incremental = false) {
    const t = findTerm();
    if (!t) return;
    if (findSub) { findSub.dispose(); findSub = null; }
    findSub = t.search.onDidChangeResults(({ resultIndex, resultCount }) => {
      $('#find-count').textContent = resultCount ? `${resultIndex + 1} of ${resultCount}` : 'No matches';
    });
    const q = findQ.value;
    if (!q) { t.search.clearDecorations(); $('#find-count').textContent = ''; return; }
    const opts = { caseSensitive: findCase, incremental, decorations: FIND_DECOR };
    const hit = forward ? t.search.findNext(q, opts) : t.search.findPrevious(q, opts);
    if (!hit) $('#find-count').textContent = 'No matches';
  }
  findQ.addEventListener('input', () => doFind(true, true));
  findQ.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doFind(!e.shiftKey); }
    if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  $('#find-next').addEventListener('click', () => doFind(true));
  $('#find-prev').addEventListener('click', () => doFind(false));
  $('#find-close').addEventListener('click', closeFind);
  $('#find-case').addEventListener('click', () => {
    findCase = !findCase; $('#find-case').setAttribute('aria-pressed', String(findCase)); doFind(true);
  });

  function clearBuffer() {
    const t = state.terms.get(state.activeId);
    if (t) { t.term.clear(); t.search.clearDecorations(); }
  }

  // ---------- right-click menu ----------
  $('#terminals').addEventListener('contextmenu', async (e) => {
    const wrap = e.target.closest('.term-wrap');
    if (!wrap) return;
    e.preventDefault();
    const id = wrap.dataset.id;
    if (id !== state.activeId) select(id);
    const t = state.terms.get(id);
    const action = await sb.contextMenu({ hasSelection: t.term.hasSelection(), split: !!state.split });
    if (action === 'copy') sb.copy(t.term.getSelection());
    else if (action === 'paste') { const text = await sb.readClipboard(); if (text) t.term.paste(text); }
    else if (action === 'selectAll') t.term.selectAll();
    else if (action === 'clear') clearBuffer();
    else if (action === 'find') openFind();
    else if (action === 'splitRight') splitRight();
    else if (action === 'closeSplit') unsplit();
    else if (action === 'newShellHere') newShell();
    else if (action === 'reveal') sb.reveal(id);
    if (action && action !== 'find') t.term.focus();
  });

  // ---------- events ----------
  // Allow / Deny / interrupt / slash commands from anywhere in the UI
  async function answer(id, action) {
    const ok = await sb.answer(id, action);
    if (!ok) select(id); // the prompt isn't up any more (or never was): show the terminal
  }
  function handleQuickAction(e) {
    const a = e.target.closest('[data-allow],[data-deny],[data-interrupt],[data-cmd]');
    if (!a) return false;
    e.stopPropagation();
    if (a.dataset.allow) answer(a.dataset.allow, 'allow');
    else if (a.dataset.deny) answer(a.dataset.deny, 'deny');
    else if (a.dataset.interrupt) sb.write(a.dataset.interrupt, '\x1b');
    else if (a.dataset.cmd) {
      const id = a.dataset.cmdFor || state.activeId;
      if (id) { sb.reply(id, a.dataset.cmd); select(id); }
    }
    return true;
  }
  $('#session-list').addEventListener('click', (e) => {
    if (handleQuickAction(e)) return;
    const r = e.target.closest('[data-rename]');
    if (r) { e.stopPropagation(); renameSession(r.dataset.rename); return; }
    if (e.target.closest('.rename-input')) return;
    const b = e.target.closest('.s-item'); if (b) select(b.dataset.id);
  });
  $('#session-list').addEventListener('keydown', (e) => {
    const b = e.target.closest('.s-item');
    if (b && e.target === b && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(b.dataset.id); }
  });
  $('#session-list').addEventListener('dblclick', (e) => {
    const b = e.target.closest('.s-item'); if (b) renameSession(b.dataset.id);
  });
  $('#mission-grid').addEventListener('click', (e) => {
    if (handleQuickAction(e)) return;
    const c = e.target.closest('.card'); if (!c) return;
    if (c.dataset.act === 'new') quickStart(); else select(c.dataset.id);
  });
  $('#mission-grid').addEventListener('keydown', (e) => {
    const c = e.target.closest('.card');
    if (c && e.target === c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); if (c.dataset.act === 'new') quickStart(); else select(c.dataset.id); }
  });
  $('#insp-actions').addEventListener('click', (e) => { handleQuickAction(e); });
  async function sendReply() {
    const ta = $('#reply-q');
    const text = ta.value.trim();
    if (!text || !state.activeId) return;
    if (await sb.reply(state.activeId, text)) { ta.value = ''; ta.style.height = ''; }
  }
  $('#reply-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendReply(); }
    if (e.key === 'Escape') { const t = state.terms.get(state.activeId); if (t) t.term.focus(); }
  });
  $('#reply-q').addEventListener('input', (e) => { const ta = e.target; ta.style.height = ''; ta.style.height = Math.min(160, ta.scrollHeight) + 'px'; });
  $('#reply-send').addEventListener('click', sendReply);
  $('#inspector').addEventListener('click', (e) => {
    const f = e.target.closest('[data-open]');
    if (f) { sb.openPath(f.dataset.open, 0, 0); return; }
    const b = e.target.closest('button[data-act]'); if (!b || !state.activeId) return;
    if (b.dataset.act === 'reveal') sb.reveal(state.activeId);
    if (b.dataset.act === 'close') closeSession(state.activeId);
    if (b.dataset.act === 'shell-here') newShell();
    if (b.dataset.act === 'rename') renameSession(state.activeId);
  });
  $('#btn-next').addEventListener('click', jumpNext);
  $('#btn-mission').addEventListener('click', () => toggleMission());
  $('#btn-new').addEventListener('click', (e) => (e.shiftKey ? openNewDialog() : quickStart()));
  $('#btn-new-empty').addEventListener('click', (e) => (e.shiftKey ? openNewDialog() : quickStart()));
  $('#btn-shell').addEventListener('click', () => newShell());
  $('#btn-settings').addEventListener('click', () => openSettings());
  function showVoice() {
    $('#btn-voice').setAttribute('aria-pressed', String(state.voice));
    $('#btn-voice').title = `Spoken alerts (${state.voice ? 'on' : 'off'}): says when an agent needs you, finishes, or hits an error`;
  }
  $('#btn-voice').addEventListener('click', async () => {
    state.voice = await sb.setVoice(!state.voice);
    try { localStorage.setItem('sb.voice', state.voice ? '1' : '0'); } catch { /* ignore */ }
    showVoice();
  });
  // keep the voice setting across restarts (quietly — no "Voice on." at every launch)
  (async () => {
    let saved = false;
    try { saved = localStorage.getItem('sb.voice') === '1'; } catch { /* ignore */ }
    if (saved) { state.voice = await sb.setVoice(true, true); showVoice(); }
  })();

  function toggleMission() {
    state.view = state.view === 'mission' ? 'session' : 'mission';
    if (state.view === 'mission') closeFind();
    layoutPanes();
    renderAll();
    if (state.view === 'session' && state.activeId) select(state.activeId);
  }

  function setFont(delta) {
    const size = Math.max(9, Math.min(28, settings.fontSize + delta));
    sb.setSettings({ fontSize: size });
  }

  const dialogOpen = () => $('#new-dialog').open || $('#settings-dialog').open || $('#palette').open;

  sb.onMenu((action, arg) => {
    if (action === 'settings') { openSettings(); return; }
    if (dialogOpen()) return;
    if (action === 'new') quickStart();
    else if (action === 'new-options') openNewDialog();
    else if (action === 'open-folder') openFolder();
    else if (action === 'new-shell') newShell();
    else if (action === 'split') splitRight();
    else if (action === 'unsplit') unsplit();
    else if (action === 'next') jumpNext();
    else if (action === 'mission') toggleMission();
    else if (action === 'inspector') { $('#app').classList.toggle('no-inspector'); requestAnimationFrame(fitVisible); }
    else if (action === 'select') { const id = state.order[arg]; if (id) select(id); }
    else if (action === 'close') { if (state.activeId) closeSession(state.activeId); }
    else if (action === 'rename') { if (state.activeId) renameSession(state.activeId); }
    else if (action === 'palette') openPalette();
    else if (action === 'font') setFont(arg);
    else if (action === 'find') openFind();
    else if (action === 'find-next') { if (findbar.hidden) openFind(); else doFind(true); }
    else if (action === 'find-prev') { if (findbar.hidden) openFind(); else doFind(false); }
    else if (action === 'clear') clearBuffer();
  });

  // ---------- search all terminals (⌘P) ----------
  const pal = $('#palette');
  const palQ = $('#pal-q');
  let palItems = [];
  let palSel = 0;

  function openPalette() {
    if (pal.open) { palQ.select(); return; }
    palQ.value = '';
    pal.showModal();
    palQ.focus();
    runPalette();
  }
  function closePalette(refocus = true) {
    if (pal.open) pal.close();
    if (refocus) { const t = state.terms.get(state.activeId); if (t) t.term.focus(); }
  }

  // every line of a terminal's buffer (newest last), wrapped lines joined
  function bufferLines(term, max = 8000) {
    const buf = term.buffer.active;
    const out = [];
    const start = Math.max(0, buf.length - max);
    let cur = null;
    for (let y = start; y < buf.length; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && cur) cur.text += text;
      else { cur = { y, text }; out.push(cur); }
    }
    return out;
  }

  function hl(text, q) {
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return esc(text);
    return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
  }

  function runPalette() {
    const q = palQ.value.trim();
    const ql = q.toLowerCase();
    const items = [];
    for (const id of state.order) {
      const s = state.sessions.get(id);
      if (!s) continue;
      const where = home(s.cwdNow || s.cwd);
      const meta = [where, s.branch, s.command].filter(Boolean).join(' · ');
      const hay = `${s.name} ${meta} ${s.activity || ''}`.toLowerCase();
      if (!q || hay.includes(ql)) items.push({ kind: 'session', id, title: s.name, sub: meta || s.activity || '', score: s.name.toLowerCase().startsWith(ql) ? 0 : 1 });
    }
    items.sort((a, b) => a.score - b.score);
    if (q.length >= 2) {
      let total = 0;
      for (const id of state.order) {
        const t = state.terms.get(id);
        const s = state.sessions.get(id);
        if (!t || !s) continue;
        const lines = bufferLines(t.term);
        let n = 0;
        for (let i = lines.length - 1; i >= 0 && n < 6 && total < 60; i--) {
          const L = lines[i];
          const idx = L.text.toLowerCase().indexOf(ql);
          if (idx < 0) continue;
          // keep the match visible: trim long lines around it
          const from = Math.max(0, idx - 40);
          const snippet = (from ? '…' : '') + L.text.slice(from, from + 140).trim();
          items.push({ kind: 'line', id, y: L.y, title: snippet, sub: s.name, q });
          n++; total++;
        }
      }
    }
    palItems = items;
    palSel = 0;
    drawPalette(q);
  }

  function drawPalette(q) {
    const list = $('#pal-list');
    if (!palItems.length) {
      list.innerHTML = `<div class="pal-empty">${q ? 'Nothing matches “' + esc(q) + '”' : 'No sessions yet'}</div>`;
      return;
    }
    let lastKind = null;
    list.innerHTML = palItems.map((it, i) => {
      const head = it.kind !== lastKind ? `<div class="pal-head">${it.kind === 'session' ? 'Sessions' : 'In terminal output'}</div>` : '';
      lastKind = it.kind;
      const s = state.sessions.get(it.id);
      const icon = it.kind === 'session' ? `<span class="dot ${isPlain(s) ? 'shell' : s.status}"></span>` : '<span class="pal-line">›</span>';
      const title = it.kind === 'line' ? `<span class="mono">${hl(it.title, it.q)}</span>` : hl(it.title, q || '');
      return `${head}<div class="pal-item ${i === palSel ? 'sel' : ''}" data-i="${i}" role="option" aria-selected="${i === palSel}">
        ${icon}<div class="pal-text"><div class="pal-title">${title}</div><div class="pal-sub">${esc(it.sub)}</div></div></div>`;
    }).join('');
    const sel = list.querySelector('.pal-item.sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function choosePalette(i) {
    const it = palItems[i];
    if (!it) return;
    closePalette(false);
    select(it.id);
    if (it.kind === 'line') {
      const t = state.terms.get(it.id);
      setTimeout(() => {
        openFind();
        findQ.value = it.q;
        // start the search at this exact line so that match is the highlighted one
        t.term.select(0, it.y, 0);
        doFind(true);
        t.term.scrollToLine(Math.max(0, it.y - Math.floor(t.term.rows / 2)));
      }, 0);
    }
  }

  palQ.addEventListener('input', runPalette);
  palQ.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); palSel = Math.min(palItems.length - 1, palSel + 1); drawPalette(palQ.value.trim()); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); palSel = Math.max(0, palSel - 1); drawPalette(palQ.value.trim()); }
    else if (e.key === 'Enter') { e.preventDefault(); choosePalette(palSel); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  });
  $('#pal-list').addEventListener('click', (e) => { const it = e.target.closest('.pal-item'); if (it) choosePalette(Number(it.dataset.i)); });
  pal.addEventListener('click', (e) => { if (e.target === pal) closePalette(); });
  pal.addEventListener('cancel', (e) => { e.preventDefault(); closePalette(); });
  $('#btn-search').addEventListener('click', openPalette);

  // ---------- settings ----------
  const sdlg = $('#settings-dialog');
  const SKEYS = ['fontFamily', 'fontSize', 'lineHeight', 'theme', 'glass', 'cursorStyle', 'scrollback', 'optionAsMeta', 'bell', 'editor', 'cursorBlink', 'copyOnSelect', 'restore'];
  function openSettings() {
    for (const k of SKEYS) {
      const el = $(`#s-${k}`);
      if (el.type === 'checkbox') el.checked = !!settings[k];
      else el.value = String(settings[k]);
    }
    if (!sdlg.open) sdlg.showModal();
  }
  sdlg.addEventListener('change', (e) => {
    const el = e.target;
    const k = el.id && el.id.startsWith('s-') ? el.id.slice(2) : null;
    if (!k) return;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'number') { v = Number(v); if (!Number.isFinite(v)) return; v = Math.min(Number(el.max), Math.max(Number(el.min), v)); }
    if (k === 'optionAsMeta') v = v === 'true';
    sb.setSettings({ [k]: v });
  });
  $('#settings-form').addEventListener('submit', (e) => { e.preventDefault(); sdlg.close(); const t = state.terms.get(state.activeId); if (t) t.term.focus(); });
  sb.onSettings((s) => { settings = s; applySettingsToTerms(); });

  // ---------- new session dialog ----------
  const dlg = $('#new-dialog');
  const recent = () => { try { return JSON.parse(localStorage.getItem('sb.recent') || '[]'); } catch { return []; } };

  const remember = (cwd, mode) => {
    try {
      localStorage.setItem('sb.recent', JSON.stringify([cwd, ...recent().filter((p) => p !== cwd)].slice(0, 8)));
      if (mode) localStorage.setItem('sb.mode', mode);
    } catch { /* storage unavailable: defaults still work */ }
  };
  const lastMode = () => { try { return localStorage.getItem('sb.mode') || 'default'; } catch { return 'default'; } };

  // Agent sessions already open in this folder (by the folder the user picked, or by repo).
  function siblings(cwd, info) {
    return state.order.map((id) => state.sessions.get(id)).filter((s) => s && s.kind !== 'shell' && (
      (s.origin || s.cwd) === cwd || (info.isRepo && s.repoKey && s.repoKey === info.repoKey)));
  }

  // Auto name: folder name, then folder-2, folder-3… skipping names already in use.
  function autoName(cwd) {
    const base = cwd.split('/').filter(Boolean).pop() || 'agent';
    const taken = new Set(state.order.map((id) => state.sessions.get(id)?.name));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }

  // Default folder: the active session's folder, else the last one used.
  function defaultFolder() {
    const a = state.sessions.get(state.activeId);
    if (a) return a.kind === 'shell' ? (a.cwdNow || a.cwd) : (a.origin || a.cwd);
    return recent()[0] || null;
  }

  // ⌘T: start right away with sensible defaults; only ask for a folder the very first time.
  // ⌘O / drag-and-drop pass a folder explicitly.
  let quickBusy = false;
  async function quickStart(folder) {
    if (quickBusy) return;
    quickBusy = true;
    try {
      let cwd = (typeof folder === 'string' && folder) || defaultFolder();
      if (!cwd) { cwd = await sb.pickFolder(); if (!cwd) return; }
      const info = await sb.gitInfo(cwd);
      const opts = {
        cwd, name: autoName(cwd), prompt: '',
        // a second agent in the same repo gets its own worktree so they don't trample each other
        worktree: info.isRepo && siblings(cwd, info).length > 0,
        permissionMode: lastMode(),
      };
      const r = await startSession(opts);
      if (!r.ok) { openNewDialog(cwd); $('#f-error').textContent = r.error; $('#f-error').hidden = false; return; }
      remember(cwd);
    } finally { quickBusy = false; }
  }

  async function openFolder() {
    const cwd = await sb.pickFolder();
    if (cwd) quickStart(cwd);
  }
  $('#btn-open').addEventListener('click', openFolder);

  // Drop a folder from Finder anywhere on the window (outside a terminal) to start an agent in it.
  document.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    const paths = files.map((f) => sb.pathFor(f)).filter(Boolean);
    if (!paths.length) return;
    const wrap = e.target.closest && e.target.closest('.term-wrap');
    if (wrap) {
      // dropped onto a terminal: type the path(s), like Terminal.app does
      sb.write(wrap.dataset.id, paths.map((p) => p.replace(/([ '"()&;$`\\!*?<>|#~{}[\]])/g, '\\$1')).join(' ') + ' ');
      return;
    }
    const p = paths[0];
    sb.isDir(p).then((dir) => quickStart(dir ? p : p.replace(/\/[^/]*$/, '')));
  });

  async function onFolderChosen(cwd) {
    $('#f-cwd').value = cwd;
    if (!cwd) return;
    if (!$('#f-name').dataset.touched) $('#f-name').value = '';
    $('#f-name').placeholder = autoName(cwd);
    const info = await sb.gitInfo(cwd);
    const wt = $('#f-worktree');
    wt.disabled = !info.isRepo;
    if (!info.isRepo) wt.checked = false;
    else wt.checked = siblings(cwd, info).length > 0; // a second agent in the same repo → isolate it by default
    $('#f-repo-note').textContent = info.isRepo ? `(on ${info.branch || 'HEAD'})` : '(not a git repo)';
  }

  function openNewDialog(folder) {
    $('#f-error').hidden = true;
    $('#f-prompt').value = '';
    $('#f-name').value = '';
    delete $('#f-name').dataset.touched;
    $('#f-mode').value = lastMode();
    const r = recent();
    $('#f-recent').innerHTML = r.slice(0, 5).map((p) => `<button type="button" data-p="${esc(p)}">${esc(home(p).split('/').slice(-2).join('/'))}</button>`).join('');
    onFolderChosen((typeof folder === 'string' && folder) || defaultFolder() || '');
    dlg.showModal();
    $('#f-prompt').focus();
  }

  $('#f-recent').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) onFolderChosen(b.dataset.p); });
  $('#f-pick').addEventListener('click', async () => { const p = await sb.pickFolder(); if (p) onFolderChosen(p); });
  $('#f-cwd').addEventListener('change', (e) => onFolderChosen(e.target.value.trim()));
  $('#f-name').addEventListener('input', (e) => { e.target.dataset.touched = '1'; });
  $('#f-cancel').addEventListener('click', () => dlg.close());
  $('#f-prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('#new-form').requestSubmit(); }
  });

  $('#new-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    let cwd = $('#f-cwd').value.trim();
    if (!cwd) { cwd = await sb.pickFolder(); if (!cwd) return; onFolderChosen(cwd); }
    const name = $('#f-name').value.trim() || autoName(cwd);
    const btn = $('#f-start');
    btn.disabled = true; btn.textContent = 'Starting…';
    const r = await startSession({
      cwd, name,
      prompt: $('#f-prompt').value,
      worktree: $('#f-worktree').checked,
      permissionMode: $('#f-mode').value,
    });
    btn.disabled = false; btn.textContent = 'Start agent ↵';
    if (!r.ok) { $('#f-error').textContent = r.error; $('#f-error').hidden = false; return; }
    remember(cwd, $('#f-mode').value);
    dlg.close();
  });

  // ---------- keeping the screen across reloads and restarts ----------
  function serializeAll() {
    const out = {};
    for (const [id, t] of state.terms) {
      try { out[id] = t.serial.serialize({ scrollback: 2000 }); } catch { /* ignore */ }
    }
    return out;
  }
  window.addEventListener('beforeunload', () => { try { sb.stash(serializeAll()); } catch { /* ignore */ } });

  // Attach to this window's sessions (on load, after a reload, or after a restart).
  async function adopt(ids) {
    const list = await sb.listSessions();
    let restoredActive = null;
    for (const s of list) {
      if (ids && !ids.includes(s.id)) continue;
      const { _stash, _early, _restoredAt, ...snap } = s;
      state.sessions.set(snap.id, snap);
      if (!state.order.includes(snap.id)) state.order.push(snap.id);
      const t = ensureTerminal(snap.id);
      if (_stash) {
        t.term.write(_stash);
        if (_restoredAt) t.term.write(`\r\n\x1b[2m── restored · last seen ${new Date(_restoredAt).toLocaleString()} ──\x1b[0m\r\n`);
      }
      if (_early) t.term.write(_early);
      if (snap.restoredActive) restoredActive = snap.id;
    }
    if (restoredActive) select(restoredActive);
    else if (!state.activeId && state.order.length) select(state.order[0]);
    else { layoutPanes(); renderAll(); }
  }

  // Hooks for the headless smoke test (test/smoke-electron.js) and probes.
  window.__sbAdopt = adopt;
  window.__sbSelect = select;
  window.__sbMission = toggleMission;
  window.__sbOpenNew = openNewDialog;
  window.__sbQuick = quickStart;
  window.__sbShell = newShell;
  window.__sbSplit = splitRight;
  window.__sbFind = (q) => { openFind(); findQ.value = q; doFind(true); return $('#find-count').textContent; };
  window.__sbSettings = openSettings;
  window.__sbPalette = (q) => { openPalette(); palQ.value = q; runPalette(); return palItems.map((i) => ({ kind: i.kind, title: i.title, sub: i.sub })); };
  window.__sbPaletteChoose = (i) => choosePalette(i);
  window.__sbSerialize = serializeAll;
  window.__sbText = (id) => { const t = state.terms.get(id); return t ? bufferLines(t.term, 400).map((l) => l.text).join('\n') : ''; };
  window.__sbState = () => ({ order: state.order, activeId: state.activeId, split: state.split, view: state.view });
  window.__sbUsage = (map) => { const tk = todayKey(); for (const [id, [tok, cost]] of Object.entries(map)) { const s = state.sessions.get(id); if (s) s.usage = { input: tok * 0.01, output: tok * 0.04, cacheRead: tok * 0.85, cacheWrite: tok * 0.1, cost, replies: 42, model: 'claude-opus-5-5', days: { [tk]: { tokens: tok, cost } } }; } renderAll(); };
  window.__sbCtx = (map) => { for (const [id, used] of Object.entries(map)) { const s = state.sessions.get(id); if (s) s.context = { used }; } renderAll(); };

  // refresh relative times
  setInterval(render, 5000);
  (async () => {
    settings = await sb.getSettings();
    // carry over the text size from before settings existed
    try {
      const old = Number(localStorage.getItem('sb.fontSize'));
      if (old && old !== settings.fontSize && settings.fontSize === 13) { settings = await sb.setSettings({ fontSize: old }); }
      localStorage.removeItem('sb.fontSize');
    } catch { /* ignore */ }
    applySettingsToTerms();
    adopt();
  })();
})();
