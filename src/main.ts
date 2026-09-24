import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import './style.css';
import './touch.css';
import type { Island } from './island/generate';
import { FULL_RES, ISLAND_SIZE, PREVIEW_RES } from './island/grid';
import { IslandGround } from './island/ground';
import {
  type IslandParams,
  PARAM_SPECS,
  cleanSeed,
  decodeParams,
  encodeParams,
  randomSeed,
} from './island/params';
import type { GenerateRequest, GenerateResult } from './island/worker';
import { Player } from './player/controller';
import { IslandMesh } from './render/islandMesh';
import { MORNING, Sky } from './render/sky';
import { Water } from './render/water';
import { type TouchControls, createTouchControls, isTouchDevice } from './ui/touch';
import { drawIsland } from './view/mapView';

/**
 * 箱庭。「つくる」では島を見渡しながらつまみで形を変え、「飛ぶ」では鳥になって島を飛ぶ。
 * つまみと種は URL の `#` に載るので、URL を送れば同じ島を渡せる。
 */

const LOOK_SENSITIVITY = 0.0022;
/** 霧。見渡すときは島全体が見えるよう薄く、飛ぶときは奥行きが出るよう少し濃く。 */
const FOG_MAKE = 0.00007;
const FOG_FLY = 0.0002;

const canvas = document.getElementById('view') as HTMLCanvasElement;
const panel = document.getElementById('panel')!;
const status = document.getElementById('status')!;
const minimap = document.getElementById('minimap') as HTMLCanvasElement;
const flyButton = document.getElementById('fly') as HTMLButtonElement;
const backButton = document.getElementById('back') as HTMLButtonElement;

const touch = isTouchDevice();
document.documentElement.dataset.input = touch ? 'touch' : 'keys';

let params: IslandParams = decodeParams(location.hash);

// ── 描画 ───────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
  // reversedDepthBuffer は使わない。three r185 で有効にすると、遠くの陸の上に海の板が
  // かぶって島の奥半分が白く覆われた（polygonOffset の向きを直しても消えず、原因は未特定）。
});
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 1, 0.5, 60000);
camera.rotation.order = 'YXZ';

const sky = new Sky(scene, MORNING);
const fog = scene.fog as THREE.FogExp2;
fog.density = FOG_MAKE;
const water = new Water(scene, sky.sunDirection, MORNING.horizon, MORNING.sun);
const islandMesh = new IslandMesh(water.material);
scene.add(islandMesh.group);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 40, 0);
camera.position.set(0, ISLAND_SIZE * 0.55, ISLAND_SIZE * 0.85);
controls.enableDamping = true;
controls.maxPolarAngle = 1.45;
controls.minDistance = 250;
controls.maxDistance = ISLAND_SIZE * 2;
controls.update();

function resize(): void {
  const w = Math.max(1, innerWidth);
  const h = Math.max(1, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, touch ? 1.5 : 2));
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
resize();
addEventListener('resize', resize);

// ── 島の計算 ───────────────────────────────────────────
// Worker は 1 つ。計算中に新しい依頼が来たら最新の 1 件だけを取っておき、終わったら流す。
const worker = new Worker(new URL('./island/worker.ts', import.meta.url), { type: 'module' });
let nextId = 1;
let busy = false;
let pending: GenerateRequest | null = null;
let drawnId = 0;
let ground: IslandGround | null = null;
let player: Player | null = null;

function request(n: number): void {
  const req: GenerateRequest = { id: nextId++, params: { ...params }, n };
  if (busy) {
    pending = req;
    return;
  }
  busy = true;
  worker.postMessage(req);
}

function show(island: Island): void {
  islandMesh.set(island);
  drawIsland(minimap, island);
  if (ground) ground.island = island;
  else ground = new IslandGround(island);
  flyButton.disabled = false;
}

worker.onmessage = (ev: MessageEvent<GenerateResult>) => {
  const { id, island, ms } = ev.data;
  if (id > drawnId) {
    drawnId = id;
    show(island);
    status.textContent = `${island.n === FULL_RES ? '' : '下見 · '}${ms.toFixed(0)}ms`;
  }
  busy = false;
  if (pending) {
    const req = pending;
    pending = null;
    busy = true;
    worker.postMessage(req);
  }
};

function commit(): void {
  history.replaceState(null, '', `#${encodeParams(params)}`);
  request(FULL_RES);
}

// ── つまみ ─────────────────────────────────────────────
const seedInput = document.createElement('input');
seedInput.className = 'seed';
seedInput.value = params.seed;
seedInput.spellcheck = false;
seedInput.addEventListener('change', () => {
  params.seed = cleanSeed(seedInput.value) || params.seed;
  seedInput.value = params.seed;
  commit();
});
const reroll = document.createElement('button');
reroll.textContent = '別の島';
reroll.addEventListener('click', () => {
  params.seed = randomSeed();
  seedInput.value = params.seed;
  commit();
});
const seedRow = document.createElement('div');
seedRow.className = 'row';
seedRow.append(seedInput, reroll);
panel.insertBefore(seedRow, minimap);

for (const spec of PARAM_SPECS) {
  const wrap = document.createElement('label');
  wrap.className = 'slider';
  const title = document.createElement('div');
  title.className = 'slider-title';
  title.textContent = spec.label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = '0';
  input.max = '100';
  input.value = String(params[spec.key]);
  const ends = document.createElement('div');
  ends.className = 'ends';
  ends.innerHTML = `<span>${spec.low}</span><span>${spec.high}</span>`;
  // 動かしている間は粗い格子で下見し、離したら細かい格子で作り直す。
  input.addEventListener('input', () => {
    params[spec.key] = Number(input.value);
    request(PREVIEW_RES);
  });
  input.addEventListener('change', () => {
    params[spec.key] = Number(input.value);
    commit();
  });
  wrap.append(title, input, ends);
  panel.insertBefore(wrap, minimap);
}

const share = document.getElementById('share') as HTMLButtonElement;
share.addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}#${encodeParams(params)}`;
  try {
    await navigator.clipboard.writeText(url);
    share.textContent = 'コピーしました';
  } catch {
    share.textContent = url;
  }
  setTimeout(() => (share.textContent = 'この島の URL をコピー'), 2000);
});

// ── 飛ぶ ───────────────────────────────────────────────
let mode: 'make' | 'fly' = 'make';

// タッチ操作はプレイヤーを受け取って作るので、最初に飛ぶときに作る。
let touchControls: TouchControls | null = null;

function startFlying(): void {
  if (!ground) return;
  // 見渡していた視点の注視点の手前、少し高い所から飛び始める。
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const flat = Math.hypot(dir.x, dir.z) || 1;
  const fx = dir.x / flat;
  const fz = dir.z / flat;
  const x = controls.target.x - fx * 350;
  const z = controls.target.z - fz * 350;
  const y = Math.max(0, ground.heightAt(x, z)) + 160;
  if (!player) player = new Player(ground, x, z);
  player.restore({ x, y, z, yaw: Math.atan2(-fx, -fz), pitch: -0.18, flying: true });
  if (touch && !touchControls) {
    touchControls = createTouchControls({
      root: document.body,
      surface: canvas,
      player,
      lookSensitivity: LOOK_SENSITIVITY,
      isPlaying: () => mode === 'fly',
      onPause: () => stopFlying(),
    });
  }

  mode = 'fly';
  controls.enabled = false;
  fog.density = FOG_FLY;
  document.body.classList.add('flying');
  touchControls?.setActive(true);
  if (!touch) canvas.requestPointerLock();
}

function stopFlying(): void {
  if (mode !== 'fly') return;
  mode = 'make';
  // 飛んでいた場所の前方を注視点にして、見渡す視点へ戻る。
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  controls.target.copy(camera.position).addScaledVector(dir, 400);
  if (ground) controls.target.y = Math.max(0, ground.heightAt(controls.target.x, controls.target.z));
  controls.enabled = true;
  controls.update();
  fog.density = FOG_MAKE;
  document.body.classList.remove('flying');
  touchControls?.setActive(false);
  if (document.pointerLockElement) document.exitPointerLock();
}

flyButton.addEventListener('click', startFlying);
backButton.addEventListener('click', stopFlying);

document.addEventListener('pointerlockchange', () => {
  // Esc でロックが外れたら「つくる」に戻る。
  if (!document.pointerLockElement && mode === 'fly' && !touch) stopFlying();
});
canvas.addEventListener('click', () => {
  if (mode === 'fly' && !touch && !document.pointerLockElement) canvas.requestPointerLock();
});
addEventListener('keydown', (e: KeyboardEvent) => {
  if (mode !== 'fly' || !player) return;
  player.onKey(e.code, true, e.repeat);
  if (e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e: KeyboardEvent) => {
  if (mode !== 'fly' || !player) return;
  player.onKey(e.code, false);
});
addEventListener('mousemove', (e: MouseEvent) => {
  if (mode !== 'fly' || !player || document.pointerLockElement !== canvas) return;
  player.onLook(e.movementX, e.movementY, LOOK_SENSITIVITY);
});

// ── 毎フレーム ─────────────────────────────────────────
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const timer = new THREE.Timer();
let elapsed = 0;
renderer.setAnimationLoop(() => {
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.1);
  elapsed += dt;
  if (mode === 'fly' && player) {
    player.update(dt, camera, reducedMotion);
    touchControls?.update();
  } else {
    controls.update();
  }
  sky.update(camera, elapsed);
  water.update(camera, elapsed);
  renderer.render(scene, camera);
});

addEventListener('hashchange', () => location.reload());
flyButton.disabled = true;
commit();
