// A neural network behind the whole page: nodes drift, link up when they're close,
// and signals hop from node to node along the links. A few larger "agent" nodes
// glow in the app's status colours. The cursor joins the network; scrolling
// slides it and makes it busier; a click fires signals out from where you clicked.
(() => {
  const canvas = document.getElementById('net');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const VIOLET = [139, 92, 246], INDIGO = [111, 124, 248], CYAN = [34, 211, 238];
  const STATE = { work: [34, 211, 238], wait: [245, 181, 68], done: [52, 211, 153] };
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const tint = (x) => { const t = Math.min(1, Math.max(0, x)); return t < 0.5 ? mix(VIOLET, INDIGO, t * 2) : mix(INDIGO, CYAN, t * 2 - 1); };
  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

  let W, H, DPR, LINK, nodes = [], signals = [];
  const mouse = { x: -9999, y: -9999, on: false };
  let scrollV = 0, lastScroll = scrollY, busy = 0;

  function setup() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    canvas.width = W * DPR; canvas.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    LINK = W < 700 ? 115 : 165;
    const count = Math.round(Math.min(230, (W * H) / (W < 700 ? 6500 : 7000)));
    const states = ['work', 'work', 'wait', 'done', 'work', 'done'];
    nodes = Array.from({ length: count }, (_, i) => {
      const hub = i < 6;
      return {
        x: Math.random() * W, y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.18, vy: (Math.random() - 0.5) * 0.18,
        r: hub ? 2.6 : 0.8 + Math.random() * 1.3,
        hub, state: hub ? states[i] : null, fire: 0, phase: Math.random() * 6.28,
      };
    });
  }

  // links are found fresh every frame with a coarse grid, so the network keeps reshaping
  let links = [];
  function findLinks() {
    const cell = LINK, cols = Math.ceil(W / cell) + 1, grid = new Map();
    nodes.forEach((n, i) => {
      const k = Math.floor(n.x / cell) + Math.floor(n.y / cell) * cols;
      (grid.get(k) || grid.set(k, []).get(k)).push(i);
    });
    links = [];
    const adj = nodes.map(() => []);
    nodes.forEach((n, i) => {
      const cx = Math.floor(n.x / cell), cy = Math.floor(n.y / cell);
      for (let dx = 0; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy < 0) continue;
        const list = grid.get(cx + dx + (cy + dy) * cols);
        if (!list) continue;
        for (const j of list) {
          if (j <= i && dx === 0 && dy === 0) continue;
          const m = nodes[j], d = Math.hypot(n.x - m.x, n.y - m.y);
          if (d < LINK) { links.push([i, j, d]); adj[i].push(j); adj[j].push(i); }
        }
      }
    });
    return adj;
  }

  function spawn(from, adj, color) {
    const nb = adj[from];
    if (!nb || !nb.length) return;
    const to = nb[(Math.random() * nb.length) | 0];
    signals.push({ a: from, b: to, t: 0, hops: 2 + ((Math.random() * 5) | 0), speed: 0.018 + Math.random() * 0.02, color });
  }

  addEventListener('pointermove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; mouse.on = true; }, { passive: true });
  document.addEventListener('pointerleave', () => { mouse.on = false; mouse.x = mouse.y = -9999; });
  let burstAt = null;
  addEventListener('pointerdown', (e) => { if (!e.target.closest('a,button,summary,input')) burstAt = { x: e.clientX, y: e.clientY }; });
  addEventListener('scroll', () => { const d = scrollY - lastScroll; lastScroll = scrollY; scrollV += d; busy = Math.min(1, busy + Math.abs(d) / 400); }, { passive: true });
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(setup, 150); });

  let t = 0, spawnClock = 0;
  function frame() {
    t += 1;
    ctx.clearRect(0, 0, W, H);

    // move: drift, slide with the scroll, lean toward the cursor
    const slide = reduced ? 0 : scrollV * 0.12;
    scrollV *= 0.9;
    for (const n of nodes) {
      if (!reduced) {
        n.x += n.vx; n.y += n.vy - slide * (n.hub ? 0.6 : 1) * (0.5 + n.r * 0.3);
        if (mouse.on) {
          const dx = mouse.x - n.x, dy = mouse.y - n.y, d = Math.hypot(dx, dy);
          if (d < 220 && d > 30) { n.x += dx / d * 0.25; n.y += dy / d * 0.25; }
        }
      }
      if (n.x < -20) n.x += W + 40; else if (n.x > W + 20) n.x -= W + 40;
      if (n.y < -20) n.y += H + 40; else if (n.y > H + 20) n.y -= H + 40;
      n.fire *= 0.94;
    }
    const adj = findLinks();

    // links
    ctx.lineWidth = 1;
    for (const [i, j, d] of links) {
      const a = nodes[i], b = nodes[j];
      const k = 1 - d / LINK;
      const lit = Math.max(a.fire, b.fire);
      ctx.strokeStyle = rgba(tint((a.x + b.x) / 2 / W), k * (0.3 + lit * 0.55));
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    // the cursor joins the network
    if (mouse.on) {
      for (const n of nodes) {
        const d = Math.hypot(n.x - mouse.x, n.y - mouse.y);
        if (d < 190) {
          ctx.strokeStyle = rgba(tint(n.x / W), (1 - d / 190) * 0.45);
          ctx.beginPath(); ctx.moveTo(mouse.x, mouse.y); ctx.lineTo(n.x, n.y); ctx.stroke();
          n.fire = Math.max(n.fire, (1 - d / 190) * 0.5);
        }
      }
    }

    // signals hop along the links
    if (!reduced) {
      spawnClock -= 1;
      if (spawnClock <= 0) {
        spawnClock = Math.max(3, 12 - busy * 9);
        const hubs = nodes.filter((n) => n.hub);
        const fromHub = Math.random() < 0.4;
        const from = fromHub ? nodes.indexOf(hubs[(Math.random() * hubs.length) | 0]) : (Math.random() * nodes.length) | 0;
        if (signals.length < 60) spawn(from, adj, fromHub ? STATE[nodes[from].state] : null);
      }
      busy *= 0.985;
      if (burstAt) {
        let best = 0, bd = Infinity;
        nodes.forEach((n, i) => { const d = Math.hypot(n.x - burstAt.x, n.y - burstAt.y); if (d < bd) { bd = d; best = i; } });
        nodes[best].fire = 1;
        for (let k = 0; k < 10; k++) spawn(best, adj, null);
        burstAt = null;
      }
    }
    for (let s = signals.length - 1; s >= 0; s--) {
      const g = signals[s];
      const a = nodes[g.a], b = nodes[g.b];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d > LINK * 1.3) { signals.splice(s, 1); continue; } // the link broke
      g.t += g.speed * (LINK / Math.max(30, d));
      const x = a.x + (b.x - a.x) * Math.min(1, g.t), y = a.y + (b.y - a.y) * Math.min(1, g.t);
      const c = g.color || tint(x / W);
      // a short glowing trail
      const tx = a.x + (b.x - a.x) * Math.max(0, g.t - 0.35), ty = a.y + (b.y - a.y) * Math.max(0, g.t - 0.35);
      const grad = ctx.createLinearGradient(tx, ty, x, y);
      grad.addColorStop(0, rgba(c, 0)); grad.addColorStop(1, rgba(c, 0.8));
      ctx.strokeStyle = grad; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(x, y); ctx.stroke();
      ctx.fillStyle = rgba(c, 0.95);
      ctx.beginPath(); ctx.arc(x, y, 2.2, 0, 6.283); ctx.fill();
      if (g.t >= 1) {
        b.fire = 1;
        if (--g.hops > 0) {
          const nb = adj[g.b].filter((j) => j !== g.a);
          if (nb.length) { g.a = g.b; g.b = nb[(Math.random() * nb.length) | 0]; g.t = 0; continue; }
        }
        signals.splice(s, 1);
      }
    }

    // nodes
    for (const n of nodes) {
      const c = n.hub ? STATE[n.state] : tint(n.x / W);
      if (n.hub) {
        const pulse = n.state === 'wait' ? 0.6 + 0.4 * Math.sin(t * 0.12 + n.phase) : 0.8 + 0.2 * Math.sin(t * 0.03 + n.phase);
        const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, 18 + n.fire * 14);
        g.addColorStop(0, rgba(c, 0.45 * pulse)); g.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(n.x, n.y, 18 + n.fire * 14, 0, 6.283); ctx.fill();
        ctx.fillStyle = rgba(c, 0.95);
        ctx.fillRect(n.x - n.r, n.y - n.r, n.r * 2, n.r * 2); // square, like the app's status lights
      } else {
        ctx.fillStyle = rgba(c, 0.6 + n.fire * 0.4);
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + n.fire * 1.2, 0, 6.283); ctx.fill();
      }
    }

    if (!document.hidden) requestAnimationFrame(frame);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) requestAnimationFrame(frame); });

  setup();
  // occasionally an agent changes state, like in the app
  if (!reduced) setInterval(() => {
    const hubs = nodes.filter((n) => n.hub);
    const h = hubs[(Math.random() * hubs.length) | 0];
    h.state = h.state === 'wait' ? 'work' : h.state === 'work' ? (Math.random() < 0.5 ? 'done' : 'wait') : 'work';
    h.fire = 1;
  }, 2600);
  requestAnimationFrame(frame);
  document.documentElement.classList.add('net-ready');
})();
