import { MinHeap, NEIGHBORS8, type Grid } from './grid';
import { mix, smoothstep } from '../world/noise';
import type { IslandParams } from './params';

/**
 * 水。**流れを先に決め、地形を川に合わせる。**
 *
 * stroll では地形に後から川を彫ろうとして 3 回失敗した（川筋に沿って地面が上下し、
 * 水面を下流へ下げ続けられない）。ここでは島全体を見て、
 *   1. 海から水を満たしていき（priority-flood）、窪みに溜まる水位＝湖を決める
 *   2. わずかな傾きを足して満たした面の上で流れる向きを決め、上流から水を集める
 *   3. 集まった水が多い所を川にし、川の水面は満たした面そのもの（下流へ必ず下がる）
 *   4. 地形は川の水面より少し低く彫る（地形を川に合わせる）
 */

/** 水が溜まったとみなす深さ（m）。これより浅い窪みは湿地のまま。 */
const LAKE_MIN_DEPTH = 0.6;
/** 湖として残す最小の面積（m²）。小さな水たまりを湖にしない。 */
const LAKE_MIN_AREA = 40_000;
/** 流れを決めるために、満たした面に足す 1 格子あたりの傾き（m）。 */
const FLOW_EPSILON = 0.001;
/** 川の水面を、満たした面からどれだけ下げるか（m）。 */
const RIVER_SURFACE_DROP = 0.4;

export interface Water {
  /** 水面の高さ（m）。水が無ければ NaN。湖は区画で一定、川は下流へ必ず下がる。 */
  level: Float32Array;
  /** 上流から集まった水の量（格子の数、雨の多さで重み付け済み）。 */
  flow: Float32Array;
  /** 流れていく先の格子番号。海や格子の縁は -1。 */
  down: Int32Array;
  /** 川の格子（1）と湖の格子（2）。 */
  kind: Uint8Array;
}

export const WATER_RIVER = 1;
export const WATER_LAKE = 2;

export function routeWater(
  h: Float32Array,
  rain: Float32Array,
  p: IslandParams,
  grid: Grid,
): Water {
  const { n, cell } = grid;
  const count = n * n;

  const flat = fill(h, n, 0);
  const tilted = fill(h, n, FLOW_EPSILON);

  // 流れる向き: 傾けた面の上で一番下る隣。
  const down = new Int32Array(count).fill(-1);
  for (let j = 1; j < n - 1; j++) {
    for (let i = 1; i < n - 1; i++) {
      const k = j * n + i;
      if (h[k] <= 0) continue;
      let best = -1;
      let bestDrop = 0;
      for (const [di, dj, dist] of NEIGHBORS8) {
        const m = (j + dj) * n + (i + di);
        const drop = (tilted[k] - tilted[m]) / dist;
        if (drop > bestDrop) {
          bestDrop = drop;
          best = m;
        }
      }
      down[k] = best;
    }
  }

  // 上流から集める。傾けた面の高い順に流していけば、上流が必ず先に終わる。
  const order = new Int32Array(count);
  for (let k = 0; k < count; k++) order[k] = k;
  order.sort((a, b) => tilted[b] - tilted[a] || a - b);
  const flow = new Float32Array(count);
  for (let k = 0; k < count; k++) flow[k] = h[k] > 0 ? rain[k] : 0;
  for (let o = 0; o < count; o++) {
    const k = order[o];
    const d = down[k];
    if (d >= 0) flow[d] += flow[k];
  }

  const level = new Float32Array(count).fill(Number.NaN);
  const kind = new Uint8Array(count);

  // 湖: 満たした面が地面より十分高く、十分広いものだけ。
  const lakeCells = floodComponents(flat, h, n, cell);
  for (const k of lakeCells) {
    level[k] = flat[k];
    kind[k] = WATER_LAKE;
  }

  // 川: 集まった水が閾値を越えた所。湿り気が多いほど細い沢まで川になる。
  const wet = p.wetness / 100;
  const threshold = mix(1_200_000, 150_000, wet) / (cell * cell);
  for (let k = 0; k < count; k++) {
    if (h[k] <= 0 || kind[k] === WATER_LAKE || flow[k] < threshold) continue;
    const size = smoothstep(threshold, threshold * 40, flow[k]);
    const depth = mix(1.2, 4.5, size);
    level[k] = tilted[k] - RIVER_SURFACE_DROP;
    kind[k] = WATER_RIVER;
    // 地形を川に合わせる。水面より深く彫り、岸が必ず水面より上に残るようにする。
    h[k] = Math.min(h[k], tilted[k] - depth);
  }

  return { level, flow, down, kind };
}

/**
 * 海と格子の縁から水を満たした面（priority-flood）。
 * epsilon > 0 なら、満たした窪みの中にもわずかな傾きを付け、流れる向きが必ず決まるようにする。
 */
function fill(h: Float32Array, n: number, epsilon: number): Float32Array {
  const out = new Float32Array(h.length).fill(Number.POSITIVE_INFINITY);
  const done = new Uint8Array(h.length);
  const heap = new MinHeap(n * 8);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (h[k] <= 0 || i === 0 || j === 0 || i === n - 1 || j === n - 1) {
        out[k] = h[k];
        heap.push(h[k], k);
      }
    }
  }
  while (heap.size > 0) {
    const k = heap.pop();
    if (done[k]) continue;
    done[k] = 1;
    const i = k % n;
    const j = (k / n) | 0;
    for (const [di, dj] of NEIGHBORS8) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
      const m = nj * n + ni;
      if (done[m]) continue;
      const v = Math.max(h[m], out[k] + epsilon);
      if (v < out[m]) {
        out[m] = v;
        heap.push(v, m);
      }
    }
  }
  return out;
}

/** 満たした面のうち、十分深く広い水たまりの格子を返す。海面より上のものだけ。 */
function floodComponents(flat: Float32Array, h: Float32Array, n: number, cell: number): number[] {
  const count = n * n;
  const seen = new Uint8Array(count);
  const minCells = LAKE_MIN_AREA / (cell * cell);
  const result: number[] = [];
  const stack: number[] = [];
  for (let s = 0; s < count; s++) {
    if (seen[s] || h[s] <= 0 || flat[s] - h[s] < LAKE_MIN_DEPTH) continue;
    // 同じ水位でつながった窪みを 1 つの湖として集める。
    const cells: number[] = [];
    let deepest = 0;
    seen[s] = 1;
    stack.push(s);
    while (stack.length > 0) {
      const k = stack.pop()!;
      cells.push(k);
      deepest = Math.max(deepest, flat[k] - h[k]);
      const i = k % n;
      const j = (k / n) | 0;
      for (const [di, dj] of NEIGHBORS8) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
        const m = nj * n + ni;
        if (seen[m] || h[m] <= 0 || flat[m] - h[m] <= 0.01 || flat[m] !== flat[k]) continue;
        seen[m] = 1;
        stack.push(m);
      }
    }
    // 湖は陸の格子（海面より上）だけで作り、水位も海面より上に保つ。
    // 湖の中に海の板が見えて水面が二重になるのを防ぐ（stroll で踏んだ）。
    if (cells.length >= minCells && deepest >= 1.2 && flat[s] > 1) result.push(...cells);
  }
  return result;
}
