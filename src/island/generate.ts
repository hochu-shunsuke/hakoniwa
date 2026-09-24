import { climate, rainfall } from './climate';
import { erodeIsland } from './erosion';
import { NEIGHBORS8, makeGrid } from './grid';
import { WATER_LAKE, WATER_RIVER, routeWater } from './hydrology';
import type { IslandParams } from './params';
import { shapeIsland } from './shape';

/** 島 1 つ分の計算結果。すべて n×n の格子（行優先、j*n+i）。 */
export interface Island {
  n: number;
  cell: number;
  /** 地面の高さ（m）。海面が 0。 */
  height: Float32Array;
  /** 水面の高さ（m）。水が無ければ NaN。 */
  waterLevel: Float32Array;
  /** 1 = 川、2 = 湖。 */
  waterKind: Uint8Array;
  /** 上流から集まった水の量。川の太さに使う。 */
  flow: Float32Array;
  temperature: Float32Array;
  moisture: Float32Array;
  /** 工程ごとの時間（ms）。 */
  timings: Record<string, number>;
}

/** 水辺の近さを数える距離（格子ではなく m）。 */
const WATER_NEAR = 300;

export function generateIsland(p: IslandParams, n: number): Island {
  const grid = makeGrid(n);
  const timings: Record<string, number> = {};
  let t = performance.now();
  const lap = (name: string) => {
    const now = performance.now();
    timings[name] = now - t;
    t = now;
  };

  const height = shapeIsland(p, grid);
  lap('形');
  erodeIsland(height, p, grid);
  lap('侵食');
  const rain = rainfall(p, grid, height);
  const water = routeWater(height, rain, p, grid);
  lap('水');
  const near = waterProximity(height, water.kind, n, grid.cell);
  const { temperature, moisture } = climate(p, grid, height, near);
  lap('気候');

  return {
    n,
    cell: grid.cell,
    height,
    waterLevel: water.level,
    waterKind: water.kind,
    flow: water.flow,
    temperature,
    moisture,
    timings,
  };
}

/** 海・湖・川からの近さ 0..1（1 が水際）。格子の BFS で測る。 */
function waterProximity(h: Float32Array, kind: Uint8Array, n: number, cell: number): Float32Array {
  const maxSteps = Math.ceil(WATER_NEAR / cell);
  const dist = new Int32Array(n * n).fill(-1);
  const queue: number[] = [];
  for (let k = 0; k < n * n; k++) {
    if (h[k] <= 0 || kind[k] === WATER_RIVER || kind[k] === WATER_LAKE) {
      dist[k] = 0;
      queue.push(k);
    }
  }
  for (let q = 0; q < queue.length; q++) {
    const k = queue[q];
    if (dist[k] >= maxSteps) continue;
    const i = k % n;
    const j = (k / n) | 0;
    for (let o = 0; o < 4; o++) {
      const [di, dj] = NEIGHBORS8[o];
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
      const m = nj * n + ni;
      if (dist[m] >= 0) continue;
      dist[m] = dist[k] + 1;
      queue.push(m);
    }
  }
  const out = new Float32Array(n * n);
  for (let k = 0; k < n * n; k++) out[k] = dist[k] < 0 ? 0 : 1 - dist[k] / maxSteps;
  return out;
}
