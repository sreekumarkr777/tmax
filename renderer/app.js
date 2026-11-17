/* Switchboard renderer. Plain JS, no build step. */
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
  };
  const SAFETY = {
    default: { text: 'Asks before acting', cls: '' },
    plan: { text: 'Plan mode · read-only', cls: '' },
    acceptEdits: { text: 'Auto-accepting edits', cls: 'warn' },
    auto: { text: 'Auto mode', cls: 'warn' },
    dontAsk: { text: 'Won’t ask · denies unknown', cls: 'warn' },
    bypassPermissions: { text: 'Bypass · no prompts', cls: 'danger' },
  };
  const TICK_COLOR = {
    read: '#8A8F98', edit: '#F2A93B', shell: '#6AA8FF', agent: '#B69CFF', ask: '#FFE08A',
    fail: '#FF7A6B', user: '#E8E6E1', stop: '#5CC8A8', mcp: '#6B7A8F', web: '#6B7A8F', other: '#6B7A8F',
  };
  const TICK_H = { edit: 16, agent: 14, ask: 18, fail: 14, user: 18, stop: 12 };

  const THEME = {
    background: '#0D0E11', foreground: '#E8E6E1', cursor: '#E8E6E1', cursorAccent: '#0D0E11',
    selectionBackground: '#33405A',
    black: '#1C1F24', red: '#FF7A6B', green: '#5CC8A8', yellow: '#F2A93B', blue: '#6AA8FF',
    magenta: '#B69CFF', cyan: '#7FD4E0', white: '#C9CBD0',
    brightBlack: '#5E626B', brightRed: '#FF9C90', brightGreen: '#7FDCC0', brightYellow: '#F5C477',
    brightBlue: '#9EC3FF', brightMagenta: '#D9CCFF', brightCyan: '#A8E6EF', brightWhite: '#F4F2EE',
  };

  const state = {
    order: [],               // session ids in creation order
    sessions: new Map(),     // id -> snapshot
    terms: new Map(),        // id -> { term, fit, wrap }
    activeId: null,
    view: 'session',         // 'session' | 'mission'
    voice: false,
    fontSize: Number(localStorage.getItem('sb.fontSize')) || 13,
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
  function fmtTokens(n) { return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n); }
  function ctxInfo(s) {
    if (!s.context) return null;
    const used = s.context.used;
    const win = used > 200000 || /\[1m\]/i.test(s.context.model || '') ? 1000000 : 200000;
    const pct = Math.min(100, Math.round((used / win) * 100));
    return { used, win, pct, cls: pct >= 85 ? 'crit' : pct >= 65 ? 'hot' : '' };
  }

  let raf = 0;
  function render() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; renderAll(); });
  }

  // ---------- terminals ----------
  function ensureTerminal(id) {
    if (state.terms.has(id)) return state.terms.get(id);
    const wrap = document.createElement('div');
    wrap.className = 'term-wrap';
    $('#terminals').appendChild(wrap);
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
      fontSize: state.fontSize, lineHeight: 1.2, cursorBlink: true, scrollback: 20000,
      macOptionIsMeta: true, allowProposedApi: true, theme: THEME,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon.WebLinksAddon());
    term.open(wrap);
    term.onData((d) => sb.write(id, d));
    term.onResize(({ cols, rows }) => sb.resize(id, cols, rows));
    const t = { term, fit, wrap };
    state.terms.set(id, t);
    if (pendingData.has(id)) { term.write(pendingData.get(id)); pendingData.delete(id); }
    return t;
  }

  function fitActive() {
    const t = state.terms.get(state.activeId);
    if (t && state.view === 'session') { try { t.fit.fit(); } catch { /* not visible yet */ } }
  }
  new ResizeObserver(() => fitActive()).observe($('#terminals'));

  function select(id) {
    if (!state.sessions.has(id)) return;
    state.activeId = id;
    state.view = 'session';
    for (const [tid, t] of state.terms) t.wrap.classList.toggle('active', tid === id);
    renderAll();
    requestAnimationFrame(() => { fitActive(); const t = state.terms.get(id); if (t) t.term.focus(); });
  }

  // ---------- sessions ----------
  async function startSession(opts) {
    const t0 = { cols: 100, rows: 30 };
    const r = await sb.createSession({ ...opts, ...t0 });
    if (!r.ok) return r;
    const s = r.session;
    state.sessions.set(s.id, s);
    state.order.push(s.id);
    ensureTerminal(s.id);
    select(s.id);
    return r;
  }

  async function closeSession(id) {
    const s = state.sessions.get(id);
    if (!s) return;
    const live = s.status === 'working' || s.status === 'waiting';
    if (live && !confirm(`Stop “${s.name}”? It is still ${s.status === 'working' ? 'working' : 'waiting on you'}.`)) return;
    await sb.kill(id);
    const t = state.terms.get(id);
    if (t) { t.term.dispose(); t.wrap.remove(); state.terms.delete(id); }
    state.sessions.delete(id);
    const i = state.order.indexOf(id);
    state.order.splice(i, 1);
    const nextId = state.order[Math.min(i, state.order.length - 1)];
    if (nextId) select(nextId); else { state.activeId = null; renderAll(); }
  }

  function jumpNext() {
    const list = state.order.map((id) => state.sessions.get(id));
    const pick = (status) => list.filter((s) => s.status === status).sort((a, b) => a.statusSince - b.statusSince);
    const queue = [...pick('waiting'), ...pick('error'), ...pick('done')];
    if (!queue.length) return;
    // cycle: if current is in queue, go to the one after it
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
    state.sessions.set(s.id, s);
    render();
  });
  sb.onFocusSession((id) => select(id));
  sb.onWindowFocus(() => fitActive());

  // ---------- collisions ----------
  function collisions() {
    const writers = new Map();
    for (const id of state.order) {
      const s = state.sessions.get(id);
      if (!s || s.status === 'exited') continue;
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
  function renderAll() {
    const active = state.sessions.get(state.activeId);
    const all = state.order.map((id) => state.sessions.get(id)).filter(Boolean);
    const cols = collisions();

    // safety frame follows the active session's permission mode
    const mode = active ? active.permissionMode : 'default';
    $('#app').className = `safety-${mode}${$('#app').classList.contains('no-inspector') ? ' no-inspector' : ''}`;
    const pill = $('#safety');
    if (active) {
      const sf = SAFETY[mode] || { text: mode, cls: 'warn' };
      pill.hidden = false;
      pill.className = `safety-pill ${sf.cls}`;
      pill.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/></svg>${esc(sf.text)}`;
    } else pill.hidden = true;

    // crumb
    $('#crumb').innerHTML = active
      ? `${esc(projectName(active))} <span style="color:#5E626B">/</span> <b>${esc(active.name)}</b>${active.branch ? ` <span style="color:#5E626B">⎇</span> ${esc(active.branch)}` : ''}`
      : '';

    // next button
    const waiting = all.filter((s) => s.status === 'waiting').length;
    const yourTurn = all.filter((s) => s.status === 'done' || s.status === 'error').length;
    $('#next-count').textContent = waiting || yourTurn;
    $('#btn-next').firstChild.nextSibling.textContent = waiting ? ' waiting ' : ' your turn ';
    $('#btn-next').classList.toggle('hot', waiting > 0);
    $('#btn-mission').classList.toggle('active', state.view === 'mission');

    // sidebar
    $('#side-count').textContent = all.length;
    $('#session-list').innerHTML = all.map((s, i) => {
      const st = STATUS[s.status] || STATUS.starting;
      const showBadge = s.status === 'waiting' || s.status === 'done' || s.status === 'error';
      return `<button class="s-item ${s.id === state.activeId && state.view === 'session' ? 'active' : ''}" data-id="${s.id}">
        <div class="s-top"><span class="dot ${s.status}"></span><span class="s-name">${esc(s.name)}</span>
        ${showBadge ? `<span class="badge ${st.badge}">${st.label.toLowerCase()}</span>` : `<span class="s-num">⌘${i + 1}</span>`}</div>
        ${s.branch ? `<div class="s-branch">⎇ ${esc(s.branch)}</div>` : ''}
        <div class="s-act">${esc(s.activity)}</div></button>`;
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
    const el = $('#inspector');
    if (!s) {
      el.innerHTML = `<div class="sec"><h3>Inspector</h3><div class="insp-empty">Start an agent to see its status, context use, files and activity here.</div></div>`;
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

      <section class="sec">
        <div class="stats">
          <div class="stat"><b>${s.toolCount}</b><span>tool calls</span></div>
          <div class="stat"><b>${s.subagentsActive}<span style="font-size:12px;color:#858993"> / ${s.subagentsTotal}</span></b><span>subagents</span></div>
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
          return `<div class="file" title="${esc(f.path)}"><span class="tag ${w ? 'w' : ''}">${w ? 'W' : 'R'}</span><span class="p">${esc(rel)}</span><span class="heat"><i class="${w ? 'w' : ''}" style="width:${pct}%"></i></span></div>`;
        }).join('')}</div>` : `<div class="insp-empty">Nothing yet.</div>`}
      </section>

      ${s.lastMessage ? `<section class="sec"><h3>Last reply</h3><div class="prose">${esc(s.lastMessage)}</div></section>` : ''}

      <section class="sec">
        <h3>Session</h3>
        <div class="status-act mono" style="font-size:11px;color:#9A9DA4">${esc(home(s.cwd))}${s.worktree ? '<br>worktree · ' + esc(s.branch || '') : ''}</div>
        <div class="actions-row" style="margin-top:10px">
          <button class="ghost-btn" data-act="reveal">Open folder</button>
          <button class="danger-btn" data-act="close">Close session</button>
        </div>
      </section>`;
  }

  function renderMission(all, cols) {
    $('#collisions-banner').innerHTML = cols.map((c) => {
      const names = c.ids.map((x) => state.sessions.get(x)?.name).filter(Boolean);
      return `<div class="warn-box">⚠ <b>Collision ahead:</b> ${esc(names.join(' and '))} are both editing <span class="mono">${esc(c.path)}</span></div>`;
    }).join('');
    $('#mission-grid').innerHTML = all.map((s) => {
      const st = STATUS[s.status] || STATUS.starting;
      const ctx = ctxInfo(s);
      const say = s.status === 'done' && s.lastMessage ? s.lastMessage : s.activity;
      return `<button class="card ${s.status}" data-id="${s.id}">
        <div class="card-top"><span class="dot ${s.status}"></span><span class="card-name">${esc(s.name)}</span><span class="badge ${st.badge}">${st.label.toLowerCase()}</span></div>
        <div class="card-branch">${s.branch ? '⎇ ' + esc(s.branch) + ' · ' : ''}${ago(s.createdAt)}</div>
        <div class="card-say">${esc(say)}</div>
        <div class="card-tool">${esc(s.currentTool ? '▸ ' + s.currentTool : s.status === 'done' ? `✓ Finished ${ago(s.statusSince)} ago · ${s.files.filter((f) => f.writes).length} files edited` : s.activity)}</div>
        <div class="card-foot">
          <span style="display:flex;align-items:center;gap:6px">context <span class="bar ${ctx ? ctx.cls : ''}"><div style="width:${ctx ? ctx.pct : 0}%"></div></span> ${ctx ? ctx.pct + '%' : '—'}</span>
          <span>${s.toolCount} tools</span>
          ${s.subagentsActive ? `<span>${s.subagentsActive} subagent${s.subagentsActive > 1 ? 's' : ''}</span>` : ''}
        </div></button>`;
    }).join('') + `<button class="card card-new" data-act="new">+ New agent session</button>`;
  }

  // ---------- events ----------
  $('#session-list').addEventListener('click', (e) => {
    const b = e.target.closest('.s-item'); if (b) select(b.dataset.id);
  });
  $('#mission-grid').addEventListener('click', (e) => {
    const c = e.target.closest('.card'); if (!c) return;
    if (c.dataset.act === 'new') openNewDialog(); else select(c.dataset.id);
  });
  $('#inspector').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]'); if (!b || !state.activeId) return;
    if (b.dataset.act === 'reveal') sb.reveal(state.activeId);
    if (b.dataset.act === 'close') closeSession(state.activeId);
  });
  $('#btn-next').addEventListener('click', jumpNext);
  $('#btn-mission').addEventListener('click', () => toggleMission());
  $('#btn-new').addEventListener('click', () => openNewDialog());
  $('#btn-new-empty').addEventListener('click', () => openNewDialog());
  $('#btn-voice').addEventListener('click', async () => {
    state.voice = await sb.setVoice(!state.voice);
    $('#btn-voice').setAttribute('aria-pressed', String(state.voice));
    $('#btn-voice').title = `Spoken alerts (${state.voice ? 'on' : 'off'})`;
  });

  function toggleMission() {
    state.view = state.view === 'mission' ? 'session' : 'mission';
    renderAll();
    if (state.view === 'session') select(state.activeId);
  }

  function setFont(delta) {
    state.fontSize = Math.max(9, Math.min(24, state.fontSize + delta));
    localStorage.setItem('sb.fontSize', state.fontSize);
    for (const t of state.terms.values()) t.term.options.fontSize = state.fontSize;
    fitActive();
  }

  sb.onMenu((action, arg) => {
    if (action === 'new') openNewDialog();
    else if (action === 'next') jumpNext();
    else if (action === 'mission') toggleMission();
    else if (action === 'inspector') { $('#app').classList.toggle('no-inspector'); requestAnimationFrame(fitActive); }
    else if (action === 'select') { const id = state.order[arg]; if (id) select(id); }
    else if (action === 'close') { if (state.activeId) closeSession(state.activeId); }
    else if (action === 'font') setFont(arg);
  });

  // ---------- new session dialog ----------
  const dlg = $('#new-dialog');
  const recent = () => { try { return JSON.parse(localStorage.getItem('sb.recent') || '[]'); } catch { return []; } };

  async function onFolderChosen(cwd) {
    $('#f-cwd').value = cwd;
    const base = cwd.split('/').filter(Boolean).pop() || 'agent';
    const n = state.order.filter((id) => state.sessions.get(id)?.cwd.includes(base)).length;
    if (!$('#f-name').dataset.touched) $('#f-name').value = n ? `${base}-${n + 1}` : base;
    const info = await sb.gitInfo(cwd);
    const wt = $('#f-worktree');
    wt.disabled = !info.isRepo;
    if (!info.isRepo) wt.checked = false;
    else if (n > 0) wt.checked = true; // a second agent in the same repo → isolate it by default
    $('#f-repo-note').textContent = info.isRepo ? `(on ${info.branch || 'HEAD'})` : '(not a git repo)';
  }

  function openNewDialog() {
    $('#f-error').hidden = true;
    $('#f-prompt').value = '';
    delete $('#f-name').dataset.touched;
    const r = recent();
    $('#f-recent').innerHTML = r.slice(0, 5).map((p) => `<button type="button" data-p="${esc(p)}">${esc(home(p).split('/').slice(-2).join('/'))}</button>`).join('');
    if (r[0]) onFolderChosen(r[0]); else { $('#f-cwd').value = ''; $('#f-name').value = ''; }
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
    const cwd = $('#f-cwd').value.trim();
    const name = $('#f-name').value.trim() || 'agent';
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
    localStorage.setItem('sb.recent', JSON.stringify([cwd, ...recent().filter((p) => p !== cwd)].slice(0, 8)));
    dlg.close();
  });

  // Re-attach to sessions the main process already has (e.g. after ⌘R reload).
  async function adopt(ids) {
    const list = await sb.listSessions();
    for (const s of list) {
      if (ids && !ids.includes(s.id)) continue;
      state.sessions.set(s.id, s);
      if (!state.order.includes(s.id)) state.order.push(s.id);
      ensureTerminal(s.id);
    }
    if (!state.activeId && state.order.length) select(state.order[0]); else renderAll();
  }

  // Hooks for the headless smoke test (test/smoke-electron.js).
  window.__sbAdopt = adopt;
  window.__sbSelect = select;
  window.__sbMission = toggleMission;
  window.__sbOpenNew = openNewDialog;
  window.__sbCtx = (map) => { for (const [id, used] of Object.entries(map)) { const s = state.sessions.get(id); if (s) s.context = { used }; } renderAll(); };

  // refresh relative times
  setInterval(render, 5000);
  adopt();
})();
