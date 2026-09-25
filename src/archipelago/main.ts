import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import '../style.css';
import '../touch.css';
import type { Island } from '../island/generate';
import { EROSION_PREVIEW_RES, EROSION_RES, FULL_RES, PREVIEW_RES } from '../island/grid';
import { IslandGround } from '../island/ground';
import { cleanSeed, randomSeed } from '../island/params';
import type { GenerateRequest, GenerateResult, LightResult } from '../island/worker';
import { Player } from '../player/controller';
import { ChunkManager } from '../render/chunkManager';
import { FarForest } from '../render/farForest';
import { setIslandLight, updateIslandLight } from '../render/islandLight';
import { OverviewMesh, outerSeabed } from '../render/overviewMesh';
import { MORNING, Sky } from '../render/sky';
import { Water } from '../render/water';
import { type TouchControls, createTouchControls, isTouchDevice } from '../ui/touch';
import { IslandWater } from '../world/islandWater';
import { Terrain } from '../world/terrain';
import { ArchipelagoGround } from './ground';
import { ARCH_EXTENT, type IslandSlot, planArchipelago, slotAt } from './layout';
import { RegionMaps } from './regionMaps';

/**
 * 群島の試作。hakoniwa の島を海に 3×3 並べ、見渡したり飛んで回ったりする。
 * stroll の世界を「無限の海に並ぶ島々」にしたら綺麗か、単調にならないかを確かめるためのもの。
 *
 * 島ごとの計算は hakoniwa と同じ（island/worker.ts）。まず全部の島を粗い格子で下見し、
 * それから近い島から順に本番の格子で作り直す。飛んでいる間は、いる島だけチャンクで細かく描く。
 */

const LOOK_SENSITIVITY = 0.0022;
/** 霧。群島は島どうしが数 km 離れているので、島 1 つのときより薄くして次の島が見えるようにする。 */
const FOG_VIEW = 0.00003;
const FOG_FLY = 0.00009;
/** 遠目の木を描く距離（m）。これより遠い島の木は、塊にしか見えないので描かない。 */
const FOREST_RANGE = 9000;
/** 見渡す島の間引き。本番の格子（約 5m）を 3 点ごと（約 16m）に。近くはチャンクが描く。 */
const OVERVIEW_STEP = 3;

const canvas = document.getElementById('view') as HTMLCanvasElement;
const status = document.getElementById('status')!;
const flyButton = document.getElementById('fly') as HTMLButtonElement;
const backButton = document.getElementById('back') as HTMLButtonElement;
const touch = isTouchDevice();
document.documentElement.dataset.input = touch ? 'touch' : 'keys';

const seed = cleanSeed(decodeURIComponent(location.hash.slice(1))) || randomSeed();
if (location.hash.slice(1) !== seed) history.replaceState(null, '', `#${seed}`);

// ── 描画 ───────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 1, 0.5, 60000);
camera.rotation.order = 'YXZ';
const sky = new Sky(scene, MORNING);
const fog = scene.fog as THREE.FogExp2;
fog.density = FOG_VIEW;
const water = new Water(scene, sky.sunDirection, MORNING.horizon, MORNING.sun);
scene.add(outerSeabed());

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0, 0);
camera.position.set(0, ARCH_EXTENT * 0.32, ARCH_EXTENT * 0.5);
controls.enableDamping = true;
controls.maxPolarAngle = 1.45;
controls.minDistance = 250;
controls.maxDistance = ARCH_EXTENT * 2;
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

// ── 島 ─────────────────────────────────────────────────
interface IslandView {
  slot: IslandSlot;
  /** 島の中心に置いたグループ。島の格子・遠目の木・チャンクはこの下に置く。 */
  root: THREE.Group;
  overview: OverviewMesh;
  forest: FarForest;
  island: Island | null;
  terrain: Terrain | null;
  ground: IslandGround | null;
}

const slots = planArchipelago(seed);
const views: IslandView[] = slots.map((slot) => {
  const root = new THREE.Group();
  root.position.set(slot.x, 0, slot.z);
  const overview = new OverviewMesh(water.material, { step: OVERVIEW_STEP, seabed: false });
  const forest = new FarForest();
  root.add(overview.group, forest.group);
  scene.add(root);
  return { slot, root, overview, forest, island: null, terrain: null, ground: null };
});
const grounds: (IslandGround | null)[] = views.map(() => null);
const ground = new ArchipelagoGround(slots, grounds);
const maps = new RegionMaps(slots);

function showIsland(k: number, island: Island, forest: GenerateResult['forest']): void {
  const view = views[k];
  view.island = island;
  view.terrain = new Terrain(view.slot.params, island.landscape, new IslandWater(island.water));
  view.ground = new IslandGround(view.terrain);
  grounds[k] = view.ground;
  view.overview.set(island, view.terrain, island.n === FULL_RES ? OVERVIEW_STEP : 1);
  if (forest) view.forest.set(forest);
  maps.writeHeight(view.slot, island);
  water.setHeightMap(maps.height, maps.heightN, ARCH_EXTENT);
}

// ── 島の計算（Worker を何本か並べる） ─────────────────
interface Job {
  k: number;
  n: number;
  erosionN: number;
}
const byDistance = views.map((_, k) => k).sort((a, b) => Math.hypot(slots[a].x, slots[a].z) - Math.hypot(slots[b].x, slots[b].z));
// まず全部の島を下見で、それから近い島から本番で。
const jobs: Job[] = [
  ...byDistance.map((k) => ({ k, n: PREVIEW_RES, erosionN: EROSION_PREVIEW_RES })),
  ...byDistance.map((k) => ({ k, n: FULL_RES, erosionN: EROSION_RES })),
];
const jobOf = new Map<number, Job>();
let nextId = 1;
let doneFull = 0;
const started = performance.now();
const workerCount = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
const sun = sky.sunDirection;

function dispatch(worker: Worker): void {
  const job = jobs.shift();
  if (!job) return;
  const id = nextId++;
  jobOf.set(id, job);
  const req: GenerateRequest = {
    id,
    params: slots[job.k].params,
    n: job.n,
    erosionN: job.erosionN,
    sun: [sun.x, sun.y, sun.z],
  };
  worker.postMessage(req);
}

for (let w = 0; w < workerCount; w++) {
  const worker = new Worker(new URL('../island/worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<GenerateResult | LightResult>) => {
    const msg = ev.data;
    const job = jobOf.get(msg.id);
    if (!job) return;
    const view = views[job.k];
    // 下見が本番より後に届いたら捨てる。
    const stale = view.island !== null && view.island.n > job.n;
    if (msg.type === 'island') {
      if (!stale) showIsland(job.k, msg.island, msg.forest);
      return;
    }
    if (!stale) {
      maps.writeLight(view.slot, msg.lighting);
      setIslandLight({ n: maps.lightN, data: maps.light }, ARCH_EXTENT);
    }
    jobOf.delete(msg.id);
    if (job.n === FULL_RES) doneFull++;
    status.textContent =
      doneFull < views.length
        ? `島 ${doneFull} / ${views.length}`
        : `${views.length} 島 · ${((performance.now() - started) / 1000).toFixed(1)}s`;
    dispatch(worker);
  };
  dispatch(worker);
}

// ── 飛ぶ ───────────────────────────────────────────────
let mode: 'view' | 'fly' = 'view';
let player: Player | null = null;
let touchControls: TouchControls | null = null;
/** チャンクで細かく描いている島（views の番号）。 */
let activeIsland = -1;
let chunks: ChunkManager | null = null;

function dropChunks(): void {
  chunks?.dispose();
  chunks = null;
  if (activeIsland >= 0) {
    views[activeIsland].overview.setCoverage(null);
    views[activeIsland].forest.setCoverage(null);
  }
  activeIsland = -1;
}

/** 今いる島だけチャンクで細かく描く。別の島に入ったら作り直す（島の間は海なので途切れない）。 */
function followIsland(x: number, z: number): void {
  const k = slotAt(slots, x, z);
  if (k >= 0 && k !== activeIsland && views[k].island?.n === FULL_RES) {
    dropChunks();
    const view = views[k];
    const island = view.island!;
    chunks = new ChunkManager(
      view.root,
      { params: view.slot.params, landscape: island.landscape, water: island.water },
      water.material,
    );
    view.overview.setCoverage(chunks.coverage, view.slot.x, view.slot.z);
    view.forest.setCoverage(chunks.coverage, view.slot.x, view.slot.z);
    activeIsland = k;
  }
  if (chunks && activeIsland >= 0) {
    chunks.update(x - slots[activeIsland].x, z - slots[activeIsland].z);
  }
}

function startFlying(): void {
  // 真ん中の島の上から、隣の島の方を向いて飛び始める。
  const start = slots[(slots.length - 1) / 2];
  const x = start.x - 900;
  const z = start.z + 1400;
  const y = Math.max(0, ground.heightAt(x, z)) + 220;
  if (!player) player = new Player(ground, x, z);
  player.restore({ x, y, z, yaw: Math.atan2(900, -1400) + Math.PI, pitch: -0.12, flying: true });
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
  mode = 'view';
  dropChunks();
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  controls.target.copy(camera.position).addScaledVector(dir, 600);
  controls.target.y = Math.max(0, ground.heightAt(controls.target.x, controls.target.z));
  controls.enabled = true;
  controls.update();
  fog.density = FOG_VIEW;
  document.body.classList.remove('flying');
  touchControls?.setActive(false);
  if (document.pointerLockElement) document.exitPointerLock();
}

flyButton.addEventListener('click', startFlying);
backButton.addEventListener('click', stopFlying);
document.addEventListener('pointerlockchange', () => {
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

/** near を見ている距離に合わせる（main.ts の fitNearPlane と同じ考え）。 */
function fitNearPlane(): void {
  const near =
    mode === 'fly'
      ? Math.min(8, Math.max(0.5, (player?.altitudeAboveGround ?? 0) * 0.02))
      : Math.min(30, Math.max(0.5, camera.position.distanceTo(controls.target) * 0.003));
  if (Math.abs(near - camera.near) > camera.near * 0.1) {
    camera.near = near;
    camera.updateProjectionMatrix();
  }
}

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
    followIsland(player.position.x, player.position.z);
  } else {
    controls.update();
  }
  for (const view of views) {
    const d = Math.hypot(camera.position.x - view.slot.x, camera.position.z - view.slot.z);
    view.forest.group.visible = d < FOREST_RANGE;
  }
  fitNearPlane();
  sky.update(camera, elapsed);
  updateIslandLight(dt);
  water.update(camera, elapsed);
  renderer.render(scene, camera);
});

addEventListener('hashchange', () => location.reload());

if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__arch = {
    camera,
    controls,
    renderer,
    views,
    slots,
    player: () => player,
    ground,
    done: () => doneFull === views.length,
  };
}
