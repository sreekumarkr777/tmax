// One cloud of particles that keeps changing shape as you scroll:
// the word TMAX, a branching tree of agents, a terminal window, a rising token
// meter, a question mark, and TMAX again at the end. The cursor pushes them away.
import * as THREE from '../vendor/three.module.min.js';

const canvas = document.getElementById('dust');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const small = innerWidth < 760;

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance' });
} catch (e) {
  document.documentElement.classList.add('no-webgl');
  throw e;
}
const DPR = Math.min(window.devicePixelRatio || 1, 2);
renderer.setPixelRatio(DPR);
renderer.setClearColor(0x000000, 0);
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(0, 1, 0, 1, -10, 10); // pixel space, y down

const N_SHAPE = small ? 2600 : 5200;   // particles that build the shapes
const N_FREE = small ? 500 : 1100;     // ambient dust that never joins a shape
const N = N_SHAPE + N_FREE;
const pos = new Float32Array(N * 3);
const vel = new Float32Array(N * 2);
const tgt = new Float32Array(N * 2);   // target in document coordinates
const attr = new Float32Array(N * 3);  // size, spring, tint
const home = new Float32Array(N * 2);  // free particles: drifting anchor

for (let i = 0; i < N; i++) {
  pos[i * 3] = Math.random() * innerWidth;
  pos[i * 3 + 1] = Math.random() * innerHeight;
  const free = i >= N_SHAPE;
  attr[i * 3] = free ? 1 + Math.random() * 2.2 : 1.9 + Math.random() * 1.8;
  attr[i * 3 + 1] = 0.035 + Math.random() * 0.05;
  attr[i * 3 + 2] = Math.random();
  home[i * 2] = Math.random();
  home[i * 2 + 1] = Math.random();
}
const geo = new THREE.BufferGeometry();
const posAttr = new THREE.BufferAttribute(pos, 3);
posAttr.setUsage(THREE.DynamicDrawUsage);
geo.setAttribute('position', posAttr);
geo.setAttribute('attr', new THREE.BufferAttribute(attr, 3));
const tintAttr = new Float32Array(N); // 0 = violet … 1 = cyan, follows x within the shape
geo.setAttribute('tint', new THREE.BufferAttribute(tintAttr, 1).setUsage(THREE.DynamicDrawUsage));
const glowAttr = new Float32Array(N).fill(0.6);
geo.setAttribute('glow', new THREE.BufferAttribute(glowAttr, 1).setUsage(THREE.DynamicDrawUsage));

const mat = new THREE.ShaderMaterial({
  uniforms: { uDpr: { value: DPR }, uTime: { value: 0 } },
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: /* glsl */`
    attribute vec3 attr; attribute float tint; attribute float glow;
    uniform float uDpr, uTime;
    varying vec3 vCol; varying float vA;
    void main() {
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = attr.x * uDpr * (1.0 + glow * 0.9);
      vec3 violet = vec3(0.545, 0.361, 0.965), indigo = vec3(0.435, 0.486, 0.973), cyan = vec3(0.133, 0.827, 0.933);
      vCol = tint < 0.5 ? mix(violet, indigo, tint * 2.0) : mix(indigo, cyan, tint * 2.0 - 1.0);
      vA = (0.5 + glow * 0.7) * (0.75 + 0.25 * sin(uTime * 2.0 + attr.z * 40.0));
    }`,
  fragmentShader: /* glsl */`
    varying vec3 vCol; varying float vA;
    void main() {
      float r = length(gl_PointCoord - 0.5);
      float a = smoothstep(0.5, 0.05, r);
      gl_FragColor = vec4(mix(vCol, vec3(1.0), 0.18), a * vA);
    }`,
});
scene.add(new THREE.Points(geo, mat));

// ---------- shapes, drawn on a hidden canvas and sampled into points ----------
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function sample(rect, draw, n) {
  const scale = 0.5;
  const w = Math.max(2, Math.round(rect.width * scale)), h = Math.max(2, Math.round(rect.height * scale));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.strokeStyle = '#fff';
  draw(g, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const pts = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 120) pts.push(x, y);
  const out = new Float32Array(n * 2);
  const count = pts.length / 2;
  if (!count) return null;
  for (let i = 0; i < n; i++) {
    const k = Math.floor(Math.random() * count) * 2;
    out[i * 2] = rect.left + (pts[k] + Math.random()) / scale;
    out[i * 2 + 1] = rect.top + scrollY + (pts[k + 1] + Math.random()) / scale;
  }
  return out;
}

const SHAPES = {
  word: (text, weight = 700) => (g, w, h) => {
    let size = h;
    g.font = `${weight} ${size}px "Chakra Petch"`;
    const m = g.measureText(text);
    size = Math.min(h * 1.15, size * (w / m.width));
    g.font = `${weight} ${size}px "Chakra Petch"`;
    g.textBaseline = 'middle'; g.textAlign = 'left';
    g.fillText(text, 0, h * 0.53);
  },
  outline: (text) => (g, w, h) => {
    let size = h;
    g.font = `700 ${size}px "Chakra Petch"`;
    size = size * (w / g.measureText(text).width);
    g.font = `700 ${size}px "Chakra Petch"`;
    g.textBaseline = 'middle'; g.lineWidth = Math.max(1.5, size * 0.012);
    g.strokeText(text, 0, h * 0.5);
  },
  tree: (g, w, h) => {
    const lw = Math.max(2, w * 0.012);
    g.lineWidth = lw; g.lineCap = 'round';
    const x0 = w * 0.12, y0 = h * 0.12, y1 = h * 0.9;
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0, y1); g.stroke();
    const branches = [[0.28, 0.42, 0.62], [0.45, 0.62, 0.8], [0.6, 0.88, 0.45]];
    for (const [ys, xe, ye] of branches) {
      g.beginPath(); g.moveTo(x0, h * ys); g.bezierCurveTo(x0 + w * 0.2, h * ys, w * xe - w * 0.2, h * ye, w * xe, h * ye); g.lineTo(w * xe, h * Math.min(0.9, ye + 0.08)); g.stroke();
      g.beginPath(); g.arc(w * xe, h * ye, lw * 2.6, 0, Math.PI * 2); g.fill();
    }
    for (const yy of [0.12, 0.28, 0.45, 0.6, 0.9]) { g.beginPath(); g.arc(x0, h * yy, lw * 2.2, 0, Math.PI * 2); g.fill(); }
  },
  terminal: (g, w, h) => {
    const lw = Math.max(2, w * 0.007);
    g.lineWidth = lw;
    const r = Math.min(w, h) * 0.04;
    g.beginPath(); g.roundRect(lw, lw, w - lw * 2, h - lw * 2, r); g.stroke();
    g.beginPath(); g.moveTo(lw, h * 0.16); g.lineTo(w - lw, h * 0.16); g.stroke();
    for (let i = 0; i < 3; i++) { g.beginPath(); g.arc(w * 0.05 + i * w * 0.04, h * 0.08, Math.min(w, h) * 0.018, 0, Math.PI * 2); g.fill(); }
    g.font = `500 ${h * 0.1}px "JetBrains Mono"`; g.textBaseline = 'middle';
    g.fillText('❯ claude', w * 0.06, h * 0.33);
    g.globalAlpha = 1;
    for (const [y, len] of [[0.5, 0.62], [0.63, 0.44], [0.76, 0.53]]) g.fillRect(w * 0.06, h * y, w * len, h * 0.035);
    g.fillRect(w * 0.06, h * 0.86, w * 0.035, h * 0.08);
  },
  meter: (g, w, h) => {
    const n = 7, gap = w * 0.035, bw = (w - gap * (n - 1)) / n;
    for (let i = 0; i < n; i++) {
      const hh = h * (0.18 + 0.78 * Math.pow((i + 1) / n, 1.4));
      g.fillRect(i * (bw + gap), h - hh, bw, hh);
    }
  },
  question: (g, w, h) => {
    g.font = `700 ${h}px "Chakra Petch"`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('?', w / 2, h * 0.54);
  },
};

// each section names where its shape forms and what it is
function anchors() {
  const list = [];
  const mega = document.querySelector('.mega-text');
  if (mega) list.push({ el: mega, draw: SHAPES.word('TMAX'), rectOf: textRect });
  for (const el of document.querySelectorAll('[data-shape]')) list.push({ el, draw: SHAPES[el.dataset.shape] });
  const giant = document.querySelector('.giant');
  if (giant) list.push({ el: giant, draw: SHAPES.outline('TMAX'), rectOf: textRect, outline: true });
  return list;
}
function textRect(el) {
  const r = document.createRange(); r.selectNodeContents(el);
  const b = r.getBoundingClientRect();
  return { left: b.left, top: b.top + b.height * 0.08, width: b.width, height: b.height * 0.84 };
}

let shapes = []; // { top, bottom, pts, minX, maxX }
function build() {
  shapes = anchors().map((a) => {
    const rect = a.rectOf ? a.rectOf(a.el) : a.el.getBoundingClientRect();
    const pts = sample(rect, a.draw, N_SHAPE);
    return pts && { top: rect.top + scrollY, bottom: rect.top + scrollY + rect.height, pts, minX: rect.left, maxX: rect.left + rect.width };
  }).filter(Boolean);
  pick(true);
}

let current = -1;
function pick(force) {
  if (!shapes.length) return;
  const mid = scrollY + innerHeight * 0.5;
  let best = 0, bestD = Infinity;
  shapes.forEach((s, i) => { const d = Math.abs((s.top + s.bottom) / 2 - mid); if (d < bestD) { bestD = d; best = i; } });
  if (best === current && !force) return;
  current = best;
  const s = shapes[best];
  // shuffle which particle goes where, so every change of shape is a real flight
  const order = new Uint32Array(N_SHAPE).map((_, i) => i);
  for (let i = N_SHAPE - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  for (let i = 0; i < N_SHAPE; i++) {
    const k = order[i];
    tgt[i * 2] = s.pts[k * 2]; tgt[i * 2 + 1] = s.pts[k * 2 + 1];
    tintAttr[i] = (s.pts[k * 2] - s.minX) / Math.max(1, s.maxX - s.minX);
    if (!reduced && !force) { vel[i * 2] += (Math.random() - 0.5) * 18; vel[i * 2 + 1] += (Math.random() - 0.5) * 18; }
  }
  geo.attributes.tint.needsUpdate = true;
  if (reduced) for (let i = 0; i < N_SHAPE; i++) { pos[i * 3] = tgt[i * 2]; pos[i * 3 + 1] = tgt[i * 2 + 1] - scrollY; }
}

// ---------- input ----------
const mouse = { x: -9999, y: -9999 };
addEventListener('pointermove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; }, { passive: true });
document.addEventListener('pointerleave', () => { mouse.x = mouse.y = -9999; });
addEventListener('pointerdown', (e) => { // a click scatters the shape for a moment
  if (reduced || e.target.closest('a,button,summary,input')) return;
  for (let i = 0; i < N_SHAPE; i++) {
    const dx = pos[i * 3] - e.clientX, dy = pos[i * 3 + 1] - e.clientY;
    const d = Math.hypot(dx, dy) + 1;
    if (d < 260) { const f = (260 - d) / 260 * 22; vel[i * 2] += dx / d * f; vel[i * 2 + 1] += dy / d * f; }
  }
});
addEventListener('scroll', () => pick(false), { passive: true });

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.right = innerWidth; camera.bottom = innerHeight; camera.updateProjectionMatrix();
}
let rt;
addEventListener('resize', () => { resize(); clearTimeout(rt); rt = setTimeout(build, 200); });
resize();

// ---------- loop ----------
const clock = new THREE.Clock();
let running = true;
document.addEventListener('visibilitychange', () => { running = !document.hidden; if (running) { clock.getDelta(); loop(); } });

function loop() {
  if (!running) return;
  const dt = Math.min(clock.getDelta(), 0.05);
  const step = dt * 60;
  const t = (mat.uniforms.uTime.value += dt);
  const sy = scrollY, R = small ? 70 : 110;
  for (let i = 0; i < N; i++) {
    const ix = i * 3, iv = i * 2;
    let x = pos[ix], y = pos[ix + 1];
    let tx, ty, k;
    if (i < N_SHAPE && shapes.length) {
      tx = tgt[iv]; ty = tgt[iv + 1] - sy; k = attr[ix + 1];
      // a little life even when settled
      tx += Math.sin(t * 1.3 + i) * 0.8; ty += Math.cos(t * 1.1 + i * 1.7) * 0.8;
    } else {
      // dust: slow drift over the whole screen
      home[iv + 1] = (home[iv + 1] - dt * 0.006 * (0.5 + attr[ix + 2]) + 1) % 1;
      tx = home[iv] * innerWidth + Math.sin(t * 0.2 + i) * 30; ty = home[iv + 1] * innerHeight; k = 0.01;
    }
    if (reduced) { if (i >= N_SHAPE) { pos[ix] = tx; pos[ix + 1] = ty; } continue; }
    let ax = (tx - x) * k, ay = (ty - y) * k;
    const dx = x - mouse.x, dy = y - mouse.y, d2 = dx * dx + dy * dy;
    let g = 0;
    if (d2 < R * R) { const d = Math.sqrt(d2) + 0.01, f = (1 - d / R) * 2.4; ax += dx / d * f; ay += dy / d * f; g = 1 - d / R; }
    let vx = (vel[iv] + ax * step) * Math.pow(0.86, step), vy = (vel[iv + 1] + ay * step) * Math.pow(0.86, step);
    vel[iv] = vx; vel[iv + 1] = vy;
    pos[ix] = x + vx * step; pos[ix + 1] = y + vy * step;
    // particles glow while they move and near the cursor
    glowAttr[i] = Math.min(1, glowAttr[i] * 0.92 + (Math.hypot(vx, vy) * 0.05 + g) * 0.3 + (i < N_SHAPE ? 0.04 : 0));
  }
  posAttr.needsUpdate = true;
  geo.attributes.glow.needsUpdate = true;
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

// wait for the fonts, so the word is drawn in the real typeface
Promise.all([
  document.fonts.load('700 200px "Chakra Petch"'),
  document.fonts.load('500 40px "JetBrains Mono"'),
]).catch(() => {}).finally(() => {
  build();
  document.documentElement.classList.add('shapes-ready');
  loop();
});
