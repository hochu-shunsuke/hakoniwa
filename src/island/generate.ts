import { Terrain } from '../world/terrain';
import { gridToWorld } from './ground';
import { makeGrid } from './grid';
import { routeWater } from './hydrology';
import type { IslandParams } from './params';

/**
 * 島全体の格子。stroll の地形の式（1 点ずつ）で島全体を引き、そこへ湖と川を求める。
 *
 * 細かい地形（近くのチャンク）は 1 点ずつの式で描くが、湖と川は島全体を見ないと
 * 決まらない。そこでこの格子で一度だけ水を求め、彫った量と水面を islandWater.ts 経由で
 * 1 点ずつの式に戻す（「周りが要る量は格子で一度だけ」）。
 */
export interface Island {
  n: number;
  cell: number;
  /** 地面の高さ（m）。川に合わせて彫った後。海面が 0。 */
  height: Float32Array;
  /** 彫った量（m、0 以下）。細かい地形へ戻すのに使う。 */
  carve: Float32Array;
  /** 水面の高さ（m）。水が無ければ NaN。 */
  waterLevel: Float32Array;
  /** 1 = 川、2 = 湖。 */
  waterKind: Uint8Array;
  temperature: Float32Array;
  moisture: Float32Array;
  /** 工程ごとの時間（ms）。 */
  timings: Record<string, number>;
}

/** 湿り気は雨陰の計算で重い（1 回 10µs）。この間隔ごとに引いて補間する。 */
const MOISTURE_EVERY = 4;

export function generateIsland(p: IslandParams, n: number): Island {
  const grid = makeGrid(n);
  const terrain = new Terrain(p);
  const timings: Record<string, number> = {};
  let t = performance.now();
  const lap = (name: string) => {
    const now = performance.now();
    timings[name] = now - t;
    t = now;
  };

  const height = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = gridToWorld(j, n);
    for (let i = 0; i < n; i++) height[j * n + i] = terrain.heightAt(gridToWorld(i, n), z);
  }
  lap('地形');

  // 湿り気を粗く引いて補間する。
  const m = Math.ceil((n - 1) / MOISTURE_EVERY) + 1;
  const coarse = new Float32Array(m * m);
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      const gi = Math.min(n - 1, i * MOISTURE_EVERY);
      const gj = Math.min(n - 1, j * MOISTURE_EVERY);
      coarse[j * m + i] = terrain.moistureAt(gridToWorld(gi, n), gridToWorld(gj, n));
    }
  }
  const moisture = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = Math.min(m - 1.0001, i / MOISTURE_EVERY);
      const v = Math.min(m - 1.0001, j / MOISTURE_EVERY);
      const ci = u | 0;
      const cj = v | 0;
      const fu = u - ci;
      const fv = v - cj;
      const a = coarse[cj * m + ci];
      const b = coarse[cj * m + ci + 1];
      const c = coarse[(cj + 1) * m + ci];
      const d = coarse[(cj + 1) * m + ci + 1];
      moisture[j * n + i] = (a + (b - a) * fu) * (1 - fv) + (c + (d - c) * fu) * fv;
    }
  }
  lap('湿り気');

  // 雨は湿った所ほど多く降る。川の水量の重み。
  const rain = new Float32Array(n * n);
  for (let k = 0; k < n * n; k++) rain[k] = 0.3 + moisture[k];
  const before = height.slice();
  const water = routeWater(height, rain, p, grid);
  const carve = new Float32Array(n * n);
  for (let k = 0; k < n * n; k++) carve[k] = height[k] - before[k];
  lap('水');

  const temperature = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = gridToWorld(j, n);
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      temperature[k] = terrain.temperatureAt(gridToWorld(i, n), z, height[k]);
    }
  }
  lap('気温');

  return {
    n,
    cell: grid.cell,
    height,
    carve,
    waterLevel: water.level,
    waterKind: water.kind,
    temperature,
    moisture,
    timings,
  };
}
