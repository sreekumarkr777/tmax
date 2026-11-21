// Dust in a beam of light: soft particles drifting slowly upward, with depth,
// leaning away from the cursor and sliding gently as you scroll.
import * as THREE from '../vendor/three.module.min.js';

const canvas = document.getElementById('dust');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'low-power' });
} catch (e) {
  document.documentElement.classList.add('no-webgl');
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
camera.position.z = 14;

const COUNT = innerWidth < 700 ? 1400 : 3200;
const pos = new Float32Array(COUNT * 3);
const seed = new Float32Array(COUNT * 4); // size, speed, phase, brightness
for (let i = 0; i < COUNT; i++) {
  pos[i * 3] = (Math.random() - 0.5) * 34;
  pos[i * 3 + 1] = (Math.random() - 0.5) * 22;
  pos[i * 3 + 2] = (Math.random() - 0.5) * 20;
  const big = Math.random() < 0.04;
  seed[i * 4] = big ? 3 + Math.random() * 5 : 0.6 + Math.random() * 1.8;
  seed[i * 4 + 1] = 0.08 + Math.random() * 0.35;
  seed[i * 4 + 2] = Math.random() * Math.PI * 2;
  seed[i * 4 + 3] = big ? 0.18 + Math.random() * 0.2 : 0.25 + Math.random() * 0.75;
}
const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
geo.setAttribute('seed', new THREE.BufferAttribute(seed, 4));

const uniforms = {
  uTime: { value: 0 },
  uScroll: { value: 0 },
  uMouse: { value: new THREE.Vector2(10, 10) },
  uPixel: { value: renderer.getPixelRatio() },
};
const mat = new THREE.ShaderMaterial({
  uniforms,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  vertexShader: /* glsl */`
    attribute vec4 seed;
    uniform float uTime, uScroll, uPixel;
    uniform vec2 uMouse;
    varying float vAlpha;
    void main() {
      vec3 p = position;
      // drift up, wrap around, sway
      p.y = mod(p.y + uTime * seed.y + 11.0 + uScroll * (0.6 + seed.y * 2.0), 22.0) - 11.0;
      p.x += sin(uTime * 0.3 * seed.y + seed.z) * 0.6;
      p.z += cos(uTime * 0.2 + seed.z) * 0.4;
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      vec4 clip = projectionMatrix * mv;
      // lean away from the cursor
      vec2 ndc = clip.xy / clip.w;
      vec2 d = ndc - uMouse;
      float f = exp(-dot(d, d) * 18.0);
      clip.xy += normalize(d + 1e-4) * f * 0.06 * clip.w;
      gl_Position = clip;
      float depth = clamp(1.0 - (-mv.z - 4.0) / 26.0, 0.15, 1.0);
      gl_PointSize = seed.x * uPixel * (10.0 / -mv.z) * 2.2;
      // light falls in from the upper left
      float beam = smoothstep(1.6, -0.4, ndc.x * 0.55 - ndc.y * 0.45 + 0.35);
      float twinkle = 0.7 + 0.3 * sin(uTime * (0.6 + seed.y * 3.0) + seed.z * 5.0);
      vAlpha = seed.w * depth * (0.25 + beam * 0.95) * twinkle + f * 0.5;
    }`,
  fragmentShader: /* glsl */`
    varying float vAlpha;
    void main() {
      vec2 c = gl_PointCoord - 0.5;
      float r = length(c);
      float a = smoothstep(0.5, 0.0, r);
      a *= a;
      gl_FragColor = vec4(vec3(0.92, 0.93, 0.95), a * vAlpha * 0.8);
    }`,
});
const points = new THREE.Points(geo, mat);
scene.add(points);

const mouse = { x: 10, y: 10, tx: 10, ty: 10 };
addEventListener('pointermove', (e) => { mouse.tx = (e.clientX / innerWidth) * 2 - 1; mouse.ty = -((e.clientY / innerHeight) * 2 - 1); }, { passive: true });
addEventListener('pointerleave', () => { mouse.tx = 10; mouse.ty = 10; });

let scrollT = 0, scrollE = 0;
addEventListener('scroll', () => { scrollT = scrollY / innerHeight; }, { passive: true });

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

const clock = new THREE.Clock();
let running = true;
document.addEventListener('visibilitychange', () => { running = !document.hidden; if (running) { clock.getDelta(); loop(); } });

function loop() {
  if (!running) return;
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!reduced) uniforms.uTime.value += dt;
  scrollE += (scrollT - scrollE) * Math.min(1, dt * 4);
  uniforms.uScroll.value = scrollE;
  mouse.x += (mouse.tx - mouse.x) * Math.min(1, dt * 5);
  mouse.y += (mouse.ty - mouse.y) * Math.min(1, dt * 5);
  uniforms.uMouse.value.set(mouse.x, mouse.y);
  points.rotation.y = (mouse.x < 5 ? mouse.x : 0) * 0.05;
  points.rotation.x = (mouse.y < 5 ? -mouse.y : 0) * 0.03;
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
loop();
document.documentElement.classList.add('dust-ready');
