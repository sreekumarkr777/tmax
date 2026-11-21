// The hall: colossal pillars receding into warm light, circuit traces on the floor,
// small figures walking, data falling like rain. Scrolling walks the camera through it,
// and at the end it looks up between the towers.
import * as THREE from '../vendor/three.module.min.js';

const canvas = document.getElementById('hall');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (e) {
  document.documentElement.classList.add('no-webgl');
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.35;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const C = {
  night: new THREE.Color('#1b1a2c'),
  dusk: new THREE.Color('#2a2840'),
  bronze: new THREE.Color('#c79f78'),
  sand: new THREE.Color('#ead9c2'),
  light: new THREE.Color('#f6efe4'),
  ink: new THREE.Color('#141320'),
};

const scene = new THREE.Scene();
// Far away everything dissolves into warm light, like a corridor opening onto the sun.
scene.fog = new THREE.Fog(new THREE.Color('#d8c1a4'), 18, 175);

// Sky: navy overhead, glowing toward the horizon (screen-space gradient).
{
  const c = document.createElement('canvas');
  c.width = 4; c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#161526');
  grad.addColorStop(0.45, '#3a3450');
  grad.addColorStop(0.78, '#c9ad8e');
  grad.addColorStop(1, '#f2e7d8');
  g.fillStyle = grad; g.fillRect(0, 0, 4, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  scene.background = tex;
}

const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 600);

// ---------- light ----------
scene.add(new THREE.HemisphereLight('#6d6694', '#2a2438', 1.7));
const sun = new THREE.DirectionalLight('#ffd3a3', 5.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = -60; sc.right = 60; sc.top = 60; sc.bottom = -60; sc.near = 1; sc.far = 260;
sun.shadow.bias = -0.0004;
scene.add(sun, sun.target);
const SUN_OFFSET = new THREE.Vector3(60, 38, -55); // low and from the side: long diagonal shadows

// the light at the end of the hall
const glow = new THREE.Mesh(
  new THREE.PlaneGeometry(900, 400),
  new THREE.MeshBasicMaterial({ color: C.light, fog: false, toneMapped: false })
);
glow.position.set(0, 120, -300);
scene.add(glow);

// ---------- floor ----------
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 700),
  new THREE.MeshStandardMaterial({ color: '#5d4f5f', roughness: 0.9, metalness: 0.05 })
);
floor.rotation.x = -Math.PI / 2;
floor.position.z = -200;
floor.receiveShadow = true;
scene.add(floor);

// ---------- pillars ----------
const PILLAR_H = 90;
const pillarGeo = new THREE.CylinderGeometry(2.4, 2.4, PILLAR_H, 64, 1);
const pillarMat = new THREE.MeshStandardMaterial({ color: '#a8846e', roughness: 0.72, metalness: 0.06 });
const rows = [
  { x: -11, step: 13, r: 1 }, { x: 11, step: 13, r: 1 },
  { x: -26, step: 15, r: 1.3 }, { x: 26, step: 15, r: 1.3 },
  { x: -44, step: 17, r: 1.6 }, { x: 44, step: 17, r: 1.6 },
];
const spots = [];
for (const row of rows) for (let z = 4; z > -260; z -= row.step) spots.push({ x: row.x + (Math.random() - 0.5) * 0.6, z: z + (Math.random() - 0.5) * 1.5, r: row.r });
const pillars = new THREE.InstancedMesh(pillarGeo, pillarMat, spots.length);
pillars.castShadow = true;
pillars.receiveShadow = true;
{
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  spots.forEach((s, i) => {
    m.compose(new THREE.Vector3(s.x, PILLAR_H / 2, s.z), q, new THREE.Vector3(s.r, 1, s.r));
    pillars.setMatrixAt(i, m);
  });
}
scene.add(pillars);

// low drums and bollards on the floor
{
  const g = new THREE.CylinderGeometry(0.55, 0.55, 0.7, 32);
  const mat = new THREE.MeshStandardMaterial({ color: '#2a2638', roughness: 0.6 });
  const n = 16;
  const drums = new THREE.InstancedMesh(g, mat, n);
  drums.castShadow = true; drums.receiveShadow = true;
  const m = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    const s = 0.6 + Math.random() * 1.1;
    m.compose(new THREE.Vector3((Math.random() < 0.5 ? -1 : 1) * (4.5 + Math.random() * 4), 0.35 * s, -20 - Math.random() * 220),
      new THREE.Quaternion(), new THREE.Vector3(s, s, s));
    drums.setMatrixAt(i, m);
  }
  scene.add(drums);
}

// ---------- circuit traces ----------
const traceMat = new THREE.MeshBasicMaterial({ color: C.bronze, transparent: true, opacity: 0.85, toneMapped: false });
const nodeMat = new THREE.MeshBasicMaterial({ color: C.sand, toneMapped: false });
const traces = [];
function ribbon(points, width) {
  // flat strip on the floor along a polyline
  const pos = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * width / 2, nz = (dx / len) * width / 2;
    pos.push(a.x + nx, 0.02, a.z + nz, a.x - nx, 0.02, a.z - nz, b.x + nx, 0.02, b.z + nz,
      a.x - nx, 0.02, a.z - nz, b.x - nx, 0.02, b.z - nz, b.x + nx, 0.02, b.z + nz);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return new THREE.Mesh(g, traceMat);
}
function makeTrace(x0, z0, length) {
  const pts = [new THREE.Vector2(x0, z0)].map((v) => ({ x: v.x, z: v.y }));
  let x = x0, z = z0;
  while (z0 - z < length) {
    const run = 4 + Math.random() * 14;
    z -= run; pts.push({ x, z });
    if (Math.random() < 0.6) {
      const jog = (Math.random() < 0.5 ? -1 : 1) * (0.8 + Math.random() * 2.2);
      x = THREE.MathUtils.clamp(x + jog, -7.5, 7.5); z -= Math.abs(jog); pts.push({ x, z });
    }
  }
  const mesh = ribbon(pts, 0.07 + Math.random() * 0.08);
  scene.add(mesh);
  for (const p of [pts[0], pts[pts.length - 1]]) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.24, 24), nodeMat);
    ring.rotation.x = -Math.PI / 2; ring.position.set(p.x, 0.03, p.z);
    scene.add(ring);
  }
  // cumulative lengths so pulses can travel along the trace
  const segs = []; let total = 0;
  for (let i = 0; i < pts.length - 1; i++) { const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z); segs.push({ a: pts[i], b: pts[i + 1], s: total, l }); total += l; }
  traces.push({ segs, total });
}
for (let i = 0; i < 16; i++) makeTrace(-7 + Math.random() * 14, -6 - Math.random() * 110, 30 + Math.random() * 90);

// light pulses running along the traces
const pulseGeo = new THREE.SphereGeometry(0.06, 12, 8);
const pulseMat = new THREE.MeshBasicMaterial({ color: '#fff3df', toneMapped: false });
const pulses = [];
for (let i = 0; i < 26; i++) {
  const m = new THREE.Mesh(pulseGeo, pulseMat);
  scene.add(m);
  pulses.push({ m, t: traces[i % traces.length], d: Math.random(), v: 0.04 + Math.random() * 0.08 });
}
function placeOnTrace(p) {
  const target = p.d * p.t.total;
  const seg = p.t.segs.find((s) => target <= s.s + s.l) || p.t.segs[p.t.segs.length - 1];
  const k = seg.l ? (target - seg.s) / seg.l : 0;
  p.m.position.set(seg.a.x + (seg.b.x - seg.a.x) * k, 0.08, seg.a.z + (seg.b.z - seg.a.z) * k);
}

// ---------- falling data ----------
const RAIN = 90;
const rainPos = new Float32Array(RAIN * 6);
const rain = [];
for (let i = 0; i < RAIN; i++) rain.push({ x: (Math.random() - 0.5) * 34, z: 8 - Math.random() * 170, y: Math.random() * 40, len: 1.5 + Math.random() * 4, v: 2 + Math.random() * 5 });
const rainGeo = new THREE.BufferGeometry();
rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
const rainLines = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: '#efe0c8', transparent: true, opacity: 0.55, toneMapped: false }));
scene.add(rainLines);
const dropGeo = new THREE.BufferGeometry();
const dropPos = new Float32Array(RAIN * 3);
dropGeo.setAttribute('position', new THREE.BufferAttribute(dropPos, 3));
const drops = new THREE.Points(dropGeo, new THREE.PointsMaterial({ color: '#fff6e8', size: 0.16, transparent: true, opacity: 0.95, toneMapped: false }));
scene.add(drops);
function updateRain(dt) {
  for (let i = 0; i < RAIN; i++) {
    const r = rain[i];
    r.y -= r.v * dt;
    if (r.y < 0) { r.y = 30 + Math.random() * 20; r.x = (Math.random() - 0.5) * 34; }
    // keep the rain in front of the walker: streaks right at the lens cut across the text
    if (r.z > camera.position.z - 12) r.z = camera.position.z - 14 - Math.random() * 150;
    rainPos.set([r.x, r.y + r.len, r.z, r.x, r.y, r.z], i * 6);
    dropPos.set([r.x, r.y, r.z], i * 3);
  }
  rainGeo.attributes.position.needsUpdate = true;
  dropGeo.attributes.position.needsUpdate = true;
}

// ---------- walkers ----------
const walkerMat = new THREE.MeshStandardMaterial({ color: C.ink, roughness: 1 });
const walkers = [];
function figure() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.95, 4, 10), walkerMat);
  body.position.y = 0.95;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 10), walkerMat);
  head.position.y = 1.72;
  const legL = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.6, 3, 6), walkerMat);
  const legR = legL.clone();
  legL.position.set(-0.08, 0.36, 0); legR.position.set(0.08, 0.36, 0);
  for (const m of [body, head, legL, legR]) m.castShadow = true;
  g.add(body, head, legL, legR);
  g.userData = { legL, legR };
  return g;
}
for (let i = 0; i < 9; i++) {
  const f = figure();
  const standing = i % 4 === 3;
  f.position.set((Math.random() < 0.5 ? -1 : 1) * (1.5 + Math.random() * 5), 0, -10 - Math.random() * 150);
  f.rotation.y = Math.PI + (Math.random() - 0.5) * 0.4;
  scene.add(f);
  walkers.push({ f, v: standing ? 0 : 0.9 + Math.random() * 0.8, phase: Math.random() * 6 });
}

// ---------- camera path ----------
let progress = 0, eased = 0;
const mouse = { x: 0, y: 0, ex: 0, ey: 0 };
function readScroll() {
  const max = document.documentElement.scrollHeight - innerHeight;
  progress = max > 0 ? THREE.MathUtils.clamp(scrollY / max, 0, 1) : 0;
}
addEventListener('scroll', readScroll, { passive: true });
addEventListener('pointermove', (e) => { mouse.x = e.clientX / innerWidth - 0.5; mouse.y = e.clientY / innerHeight - 0.5; }, { passive: true });

const look = new THREE.Vector3();
function placeCamera() {
  const p = eased;
  const z = 12 - p * 150;
  const x = Math.sin(p * Math.PI * 1.6) * 1.6 + mouse.ex * 0.8;
  const y = 1.75 + Math.sin(p * Math.PI) * 0.6 - mouse.ey * 0.3;
  camera.position.set(x, y, z);
  // at the end, tilt up between the towers
  const up = THREE.MathUtils.smoothstep(p, 0.78, 1);
  look.set(x * 0.3 + mouse.ex * 3, y + 3 + up * 80, z - 60 + up * 50);
  camera.lookAt(look);
  camera.rotateZ(Math.sin(p * Math.PI * 2) * 0.012);
  sun.position.copy(camera.position).add(SUN_OFFSET);
  sun.target.position.set(camera.position.x, 0, camera.position.z - 30);
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = w < 700 ? 62 : 48;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
readScroll();
eased = progress;

// ---------- loop ----------
const clock = new THREE.Clock();
let running = true;
document.addEventListener('visibilitychange', () => { running = !document.hidden; if (running) { clock.getDelta(); tick(); } });

function tick() {
  if (!running) return;
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  eased += (progress - eased) * (reduced ? 1 : Math.min(1, dt * 3.2));
  mouse.ex += (mouse.x - mouse.ex) * Math.min(1, dt * 2);
  mouse.ey += (mouse.y - mouse.ey) * Math.min(1, dt * 2);

  if (!reduced) {
    updateRain(dt);
    for (const p of pulses) { p.d = (p.d + p.v * dt * 10 / p.t.total) % 1; placeOnTrace(p); }
    for (const w of walkers) {
      if (!w.v) continue;
      w.f.position.z -= w.v * dt;
      if (w.f.position.z < -160) w.f.position.z = 6;
      const s = Math.sin(t * 6 * w.v + w.phase);
      w.f.userData.legL.rotation.x = s * 0.45;
      w.f.userData.legR.rotation.x = -s * 0.45;
      w.f.children[0].position.y = 0.95 + Math.abs(s) * 0.03;
    }
  }
  placeCamera();
  // keep things out of the lens: figures and sparks right next to the camera become giant blobs
  const cz = camera.position.z, cx = camera.position.x;
  for (const w of walkers) { const d = cz - w.f.position.z; w.f.visible = d > 9 || d < -2; }
  for (const p of pulses) { const d = cz - p.m.position.z; p.m.visible = d > 6 || Math.abs(p.m.position.x - cx) > 4; }
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
if (reduced) { placeCamera(); updateRain(0); pulses.forEach(placeOnTrace); }
tick();
document.documentElement.classList.add('hall-ready');
