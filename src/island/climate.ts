import { hashSeed } from '../core/rng';
import { Noise2D, clamp, fbm, mix, smoothstep } from './noise';
import type { Grid } from './grid';
import type { IslandParams } from './params';

/**
 * 気温と湿り気。どちらも地形から決める。
 *   - 気温: 暖かさのつまみから、標高が上がるほど下げる
 *   - 湿り気: 湿り気のつまみに、海や水辺の近さを足し、風上の山の陰（雨陰）で乾かす
 */

/** 気温が標高で下がり始める高さ（m）と、1m あたりの下がり方。 */
const LAPSE_FROM = 30;
const LAPSE_RATE = 0.0011;
/** 雨陰: 風上を調べる距離（m）と歩幅。 */
const RAIN_REACH = 2400;
const RAIN_STEP = 150;
const RAIN_LOW = 25;
const RAIN_HIGH = 160;

export interface Climate {
  /** 0 が寒い、1 が暑い。 */
  temperature: Float32Array;
  /** 0 が乾燥、1 が湿潤。 */
  moisture: Float32Array;
}

/** 雨の降り方（川の水量の重み）。湿り気と同じ素から作る。 */
export function rainfall(p: IslandParams, grid: Grid, h: Float32Array): Float32Array {
  const m = baseMoisture(p, grid);
  const shadow = rainShadow(p, grid, h);
  const out = new Float32Array(h.length);
  for (let k = 0; k < h.length; k++) out[k] = 0.25 + clamp(m[k] - shadow[k] * 0.45, 0, 1);
  return out;
}

export function climate(
  p: IslandParams,
  grid: Grid,
  h: Float32Array,
  waterNear: Float32Array,
): Climate {
  const { n } = grid;
  const warm = mix(0.08, 0.92, p.warmth / 100);
  const base = baseMoisture(p, grid);
  const shadow = rainShadow(p, grid, h);
  const temperature = new Float32Array(n * n);
  const moisture = new Float32Array(n * n);
  for (let k = 0; k < n * n; k++) {
    const lapse = Math.max(0, h[k] - LAPSE_FROM) * LAPSE_RATE;
    temperature[k] = clamp(warm - lapse, 0, 1);
    moisture[k] = clamp(base[k] + waterNear[k] * 0.22 - shadow[k] * 0.45, 0, 1);
  }
  return { temperature, moisture };
}

/** 湿り気のつまみに、島の中での揺らぎを足したもの。 */
function baseMoisture(p: IslandParams, grid: Grid): Float32Array {
  const [, b] = hashSeed(`${p.seed}:moisture`);
  const noise = new Noise2D(b);
  const wet = mix(0.08, 0.82, p.wetness / 100);
  const { n } = grid;
  const out = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = (i / (n - 1)) * 2 - 1;
      const v = (j / (n - 1)) * 2 - 1;
      out[j * n + i] = wet + fbm(noise, u, v, 3, 1.8) * 0.18;
    }
  }
  return out;
}

/** 風上に自分より高い山があるほど 1 に近づく。風向きは種で決まる。 */
function rainShadow(p: IslandParams, grid: Grid, h: Float32Array): Float32Array {
  const [a] = hashSeed(`${p.seed}:wind`);
  // 8 方位から選ぶ（三角関数を使わない。決定性の決まり、grid.ts）。
  const dirs = [
    [1, 0],
    [0.7071, 0.7071],
    [0, 1],
    [-0.7071, 0.7071],
    [-1, 0],
    [-0.7071, -0.7071],
    [0, -1],
    [0.7071, -0.7071],
  ];
  const [wx, wz] = dirs[a % 8];
  const { n, cell } = grid;
  const steps = Math.floor(RAIN_REACH / RAIN_STEP);
  const out = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const here = h[j * n + i];
      if (here <= 0) continue;
      let worst = 0;
      for (let s = 1; s <= steps; s++) {
        const d = (s * RAIN_STEP) / cell;
        const si = Math.round(i - wx * d);
        const sj = Math.round(j - wz * d);
        if (si < 0 || sj < 0 || si >= n || sj >= n) break;
        const reach = 1 - (s - 1) / steps;
        const blocked = smoothstep(RAIN_LOW, RAIN_HIGH, h[sj * n + si] - here) * reach;
        if (blocked > worst) worst = blocked;
      }
      out[j * n + i] = worst;
    }
  }
  return out;
}
