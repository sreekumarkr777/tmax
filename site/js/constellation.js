// Agent constellation: Tmax at the core, agents on tilted orbits, every agent
// wired to the core and briefly to its neighbours, signals running along the
// wires. Agent colours follow their state, and the mock terminal drives them.
import * as THREE from '../vendor/three.module.min.js';

const canvas = document.getElementById('orbit');
const stage = document.getElementById('orbit-stage');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
} catch (e) {
  document.documentElement.classList.add('no-webgl');
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
const system = new THREE.Group();
scene.add(system);

const COL = {
  core: new THREE.Color('#a78bfa'),
  work: new THREE.Color('#22d3ee'),
  wait: new THREE.Color('#f5b544'),
  done: new THREE.Color('#34d399'),
  line: new THREE.Color('#6f7cf8'),
};

// soft round glow used by the core, agents and signals
function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.18, 'rgba(255,255,255,.75)');
  r.addColorStop(0.45, 'rgba(255,255,255,.18)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
const GLOW = glowTexture();
const glow = (color, size, opacity = 1) => {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending }));
  s.scale.setScalar(size);
  return s;
};

// ---------- the core ----------
const core = new THREE.Group();
const coreHalo = glow(COL.core, 5.2, 0.55);
const coreMid = glow(new THREE.Color('#c4b5fd'), 2.2, 0.9);
const coreDot = new THREE.Mesh(new THREE.SphereGeometry(0.32, 32, 16), new THREE.MeshBasicMaterial({ color: '#f4f2ff' }));
core.add(coreHalo, coreMid, coreDot);
// two thin rings hugging the core
for (const [rx, ry] of [[1.2, 0.3], [-0.6, 0.9]]) {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.008, 6, 96), new THREE.MeshBasicMaterial({ color: '#c4b5fd', transparent: true, opacity: 0.45 }));
  ring.rotation.set(rx, ry, 0);
  core.add(ring);
}
system.add(core);

// ---------- orbits and agents ----------
const AGENTS = [
  { name: 'auth-refactor', state: 'work', a: 2.6, b: 2.1, tilt: [1.15, 0.2, 0.3], speed: 0.32 },
  { name: 'api-tests', state: 'wait', a: 3.4, b: 2.9, tilt: [1.35, -0.5, -0.2], speed: 0.24 },
  { name: 'docs-pass', state: 'done', a: 4.3, b: 3.6, tilt: [1.0, 0.7, 0.1], speed: 0.17 },
  { name: '', state: 'work', a: 3.0, b: 2.6, tilt: [0.5, 1.1, 0.6], speed: 0.28 },
  { name: '', state: 'work', a: 5.0, b: 4.3, tilt: [1.45, 0.1, -0.7], speed: 0.13 },
  { name: '', state: 'done', a: 3.9, b: 3.5, tilt: [0.25, -1.0, 0.4], speed: 0.2 },
];
const agents = AGENTS.map((d, i) => {
  const plane = new THREE.Group();
  plane.rotation.set(...d.tilt);
  system.add(plane);
  // the orbit itself: a faint ellipse
  const pts = [];
  for (let k = 0; k <= 160; k++) { const t = (k / 160) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(t) * d.a, Math.sin(t) * d.b, 0)); }
  const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: COL.line, transparent: true, opacity: 0.16 }));
  plane.add(ring);
  const body = new THREE.Group();
  const halo = glow(COL[d.state], 1.5, 0.85);
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 8), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
  body.add(halo, dot);
  plane.add(body);
  return { ...d, plane, ring, body, halo, phase: (i / AGENTS.length) * Math.PI * 2 + Math.random(), world: new THREE.Vector3(), flash: 0, boost: 1, color: COL[d.state].clone() };
});

// ---------- the network ----------
const MAX_LINKS = agents.length + 15;
const linkPos = new Float32Array(MAX_LINKS * 6);
const linkCol = new Float32Array(MAX_LINKS * 6);
const linkGeo = new THREE.BufferGeometry();
linkGeo.setAttribute('position', new THREE.BufferAttribute(linkPos, 3).setUsage(THREE.DynamicDrawUsage));
linkGeo.setAttribute('color', new THREE.BufferAttribute(linkCol, 3).setUsage(THREE.DynamicDrawUsage));
const links = new THREE.LineSegments(linkGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }));
system.add(links);

// ---------- signals ----------
const signals = [];
function signal(from, to, color, speed = 1) {
  const s = glow(color, 0.55, 1);
  system.add(s);
  signals.push({ s, from, to, t: 0, speed: 0.6 * speed + Math.random() * 0.3 });
}
const corePos = new THREE.Vector3();
const posOf = (x) => (x === 'core' ? corePos : x.world);

// ---------- dust ----------
{
  const n = innerWidth < 760 ? 260 : 600;
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = 6 + Math.random() * 14, th = Math.random() * Math.PI * 2, ph = Math.acos(Math.random() * 2 - 1);
    p.set([r * Math.sin(ph) * Math.cos(th), r * Math.sin(ph) * Math.sin(th) * 0.6, r * Math.cos(ph)], i * 3);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  const dust = new THREE.Points(g, new THREE.PointsMaterial({ map: GLOW, color: '#8b8fd8', size: 0.12, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
  system.add(dust);
}

// ---------- labels for the named agents (HTML, follow the 3D positions) ----------
const labelBox = document.getElementById('orbit-labels');
for (const a of agents) {
  if (!a.name || !labelBox) continue;
  const el = document.createElement('span');
  el.className = 'olabel'; el.textContent = a.name;
  labelBox.appendChild(el);
  a.label = el;
}

// ---------- the mock terminal talks to us ----------
const byName = (n) => agents.find((a) => a.name === n);
window.tmaxOrbit = {
  setState(name, state) {
    const a = byName(name); if (!a) return;
    a.state = state; a.flash = 1;
    if (state === 'work') a.boost = 2.2;
  },
  prompt(name) { const a = byName(name); if (a) signal('core', a, COL.core, 1.4); },
  report(name) { const a = byName(name); if (a) signal(a, 'core', COL[a.state], 1.2); },
};

// ---------- layout: the system sits in #orbit-stage ----------
const SYSTEM_R = 4.1;
let W = 0, H = 0;
function layout() {
  W = innerWidth; H = innerHeight;
  renderer.setSize(W, H, false);
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
}
function frame(scrollP) {
  const r = stage.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const size = Math.min(r.width, r.height);
  // distance so the system fills the stage, then shift the projection centre onto it
  const d = (SYSTEM_R * H) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * size * 0.5);
  camera.position.set(0, 0, d * (1 + scrollP * 0.9));
  camera.lookAt(0, 0, 0);
  camera.setViewOffset(W, H, W / 2 - cx, H / 2 - cy, W, H);
}
addEventListener('resize', layout);
layout();

const mouse = { x: 0, y: 0, ex: 0, ey: 0, px: -9999, py: -9999 };
addEventListener('pointermove', (e) => { mouse.x = e.clientX / innerWidth - 0.5; mouse.y = e.clientY / innerHeight - 0.5; mouse.px = e.clientX; mouse.py = e.clientY; }, { passive: true });

// ---------- loop ----------
const clock = new THREE.Clock();
const tmp = new THREE.Vector3();
let nextSignal = 0.5, running = true;
document.addEventListener('visibilitychange', () => { running = !document.hidden; if (running) { clock.getDelta(); loop(); } });

function loop() {
  if (!running) return;
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  const move = reduced ? 0 : 1;
  const scrollP = Math.min(1, scrollY / (innerHeight * 0.9));
  frame(scrollP);
  canvas.style.opacity = String(Math.max(0, 1 - scrollP * 1.15));

  mouse.ex += (mouse.x - mouse.ex) * Math.min(1, dt * 2.5);
  mouse.ey += (mouse.y - mouse.ey) * Math.min(1, dt * 2.5);
  system.rotation.y = mouse.ex * 0.7 + t * 0.04 * move;
  system.rotation.x = 0.18 + mouse.ey * 0.45;

  // core breathes
  const b = 1 + Math.sin(t * 1.6) * 0.06 * move;
  coreHalo.scale.setScalar(5.2 * b); coreMid.scale.setScalar(2.2 * (2 - b));

  // agents travel their orbits; colour eases toward their state
  for (const a of agents) {
    a.boost += (1 - a.boost) * Math.min(1, dt * 0.8);
    a.phase += dt * a.speed * a.boost * move;
    a.body.position.set(Math.cos(a.phase) * a.a, Math.sin(a.phase) * a.b, 0);
    a.body.getWorldPosition(a.world);
    system.worldToLocal(a.world);
    a.color.lerp(COL[a.state], Math.min(1, dt * 3));
    a.flash = Math.max(0, a.flash - dt * 0.9);
    const blink = a.state === 'wait' ? 0.75 + 0.25 * Math.sin(t * 6) : 1;
    a.halo.material.color.copy(a.color);
    a.halo.material.opacity = 0.85 * blink;
    a.halo.scale.setScalar(1.5 + a.flash * 2.4 + (a.state === 'wait' ? 0.35 : 0));
    a.ring.material.opacity = 0.12 + (a.state === 'wait' ? 0.16 : 0) + a.flash * 0.3;
  }

  // links: every agent to the core, and neighbours to each other while they're close
  let n = 0;
  const put = (p, q, cp, cq, k) => {
    linkPos.set([p.x, p.y, p.z, q.x, q.y, q.z], n * 6);
    linkCol.set([cp.r * k, cp.g * k, cp.b * k, cq.r * k, cq.g * k, cq.b * k], n * 6);
    n++;
  };
  // hovering near an agent lights its wires
  for (const a of agents) {
    tmp.copy(a.world).applyMatrix4(system.matrixWorld).project(camera);
    const sx = (tmp.x * 0.5 + 0.5) * W, sy = (-tmp.y * 0.5 + 0.5) * H;
    a.hover = Math.hypot(sx - mouse.px, sy - mouse.py) < 46 ? 1 : 0;
    if (a.label) {
      a.label.style.transform = `translate(${sx + 14}px, ${sy - 8}px)`;
      a.label.style.opacity = String((tmp.z < 1 ? 1 : 0) * (0.55 + a.hover * 0.45 + a.flash * 0.45));
      a.label.dataset.state = a.state;
    }
  }
  for (const a of agents) put(corePos, a.world, COL.core, a.color, 0.22 + a.flash * 0.5 + a.hover * 0.5);
  for (let i = 0; i < agents.length; i++) for (let j = i + 1; j < agents.length; j++) {
    const d = agents[i].world.distanceTo(agents[j].world);
    if (d < 2.6 && n < MAX_LINKS) put(agents[i].world, agents[j].world, agents[i].color, agents[j].color, (1 - d / 2.6) * 0.45);
  }
  linkGeo.setDrawRange(0, n * 2);
  linkGeo.attributes.position.needsUpdate = true;
  linkGeo.attributes.color.needsUpdate = true;

  // background chatter: agents report in, the core sends work, neighbours talk
  if (move && (nextSignal -= dt) < 0) {
    nextSignal = 0.35 + Math.random() * 0.9;
    const a = agents[Math.floor(Math.random() * agents.length)];
    const r = Math.random();
    if (r < 0.45) signal(a, 'core', a.color);
    else if (r < 0.8) signal('core', a, COL.core);
    else { const o = agents.find((x) => x !== a && x.world.distanceTo(a.world) < 2.6); if (o) signal(a, o, a.color, 1.4); }
  }
  for (let i = signals.length - 1; i >= 0; i--) {
    const s = signals[i];
    s.t += dt * s.speed;
    const p = posOf(s.from), q = posOf(s.to);
    s.s.position.lerpVectors(p, q, s.t);
    s.s.material.opacity = Math.sin(Math.min(1, s.t) * Math.PI);
    if (s.t >= 1) {
      if (s.to !== 'core') s.to.flash = Math.max(s.to.flash, 0.35);
      else coreMid.scale.setScalar(2.8);
      system.remove(s.s); s.s.material.dispose(); signals.splice(i, 1);
    }
  }

  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
loop();
document.documentElement.classList.add('orbit-ready');
