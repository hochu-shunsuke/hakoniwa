import { hashSeed, mulberry32 } from '../core/rng';
import { mix } from './noise';
import type { Grid } from './grid';
import type { IslandParams } from './params';

/**
 * 水滴による侵食。陸に雨粒を落とし、斜面を下りながら土を削って運び、
 * 流れが緩んだ所に落とす。これを何万回も繰り返すと、枝分かれした谷と細い尾根ができる。
 *
 * ノイズを足すだけでは作れない「水が削った形」がこれで出る。有限の島だから、
 * 島全体に対して素直に回せる（無限の世界では 1 点の関数に縛られてできなかった）。
 *
 * 高さは HEIGHT_REF で割った無次元の値で扱い、1 格子を 1 とする。
 * 係数はこの尺度で広く使われている値（重力 4、運べる量 4 など）に合わせてある。
 * 格子の細かさ（下見と本番）が変わっても谷の見た目が揃うよう、水滴の数と半径は格子に比例させる。
 */

const HEIGHT_REF = 600;
const INERTIA = 0.05;
const CAPACITY = 4;
const MIN_CAPACITY = 0.01;
const DEPOSIT = 0.3;
const ERODE = 0.3;
const EVAPORATE = 0.02;
const GRAVITY = 4;
const MAX_STEPS = 64;

export function erodeIsland(h: Float32Array, p: IslandParams, grid: Grid): void {
  const { n } = grid;
  const strength = p.erosion / 100;
  if (strength <= 0) return;

  // 格子 1 本あたりの水滴の数。本番（513）と下見（257）で、面積あたりの削られ方を揃える。
  const drops = Math.round(n * n * mix(0.08, 1.1, strength));
  // 削る刷毛の半径（格子）。本番は 12m 間隔なので 3 格子 ≒ 36m。
  const radius = n > 300 ? 3 : 2;
  const brush = makeBrush(radius);
  const scale = 1 / HEIGHT_REF;
  // 格子が粗いと 1 歩で下る高さが大きくなる。1 格子あたりの傾きを本番に揃える。
  const stepScale = (n - 1) / 512;

  const hs = new Float32Array(h.length);
  for (let k = 0; k < h.length; k++) hs[k] = h[k] * scale;

  const [seedA] = hashSeed(`${p.seed}:erosion`);
  const rand = mulberry32(seedA);

  for (let d = 0; d < drops; d++) {
    // 陸の上に落とす。海に落ちた雨は何もしないので、数回引き直す。
    let x = 0;
    let z = 0;
    let found = false;
    for (let t = 0; t < 4 && !found; t++) {
      x = 1 + rand() * (n - 3);
      z = 1 + rand() * (n - 3);
      found = hs[(z | 0) * n + (x | 0)] > 0;
    }
    if (!found) continue;

    let dx = 0;
    let dz = 0;
    let speed = 1;
    let water = 1;
    let sediment = 0;

    for (let step = 0; step < MAX_STEPS; step++) {
      const ix = x | 0;
      const iz = z | 0;
      const fx = x - ix;
      const fz = z - iz;
      const k = iz * n + ix;
      const h00 = hs[k];
      const h10 = hs[k + 1];
      const h01 = hs[k + n];
      const h11 = hs[k + n + 1];
      const gx = ((h10 - h00) * (1 - fz) + (h11 - h01) * fz) * stepScale;
      const gz = ((h01 - h00) * (1 - fx) + (h11 - h10) * fx) * stepScale;
      const here = h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) + h01 * (1 - fx) * fz + h11 * fx * fz;

      dx = dx * INERTIA - gx * (1 - INERTIA);
      dz = dz * INERTIA - gz * (1 - INERTIA);
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 1e-9) break;
      dx /= len;
      dz /= len;
      x += dx;
      z += dz;
      if (x < 1 || z < 1 || x >= n - 2 || z >= n - 2) break;

      const jx = x | 0;
      const jz = z | 0;
      const gx2 = x - jx;
      const gz2 = z - jz;
      const m = jz * n + jx;
      const next =
        hs[m] * (1 - gx2) * (1 - gz2) +
        hs[m + 1] * gx2 * (1 - gz2) +
        hs[m + n] * (1 - gx2) * gz2 +
        hs[m + n + 1] * gx2 * gz2;
      const deltaH = (next - here) * stepScale;

      // 海に入ったら、運んでいた土を河口に置いて終える（三角州のもと）。
      if (next <= 0) {
        deposit(hs, k, fx, fz, n, sediment);
        break;
      }

      const capacity = Math.max(-deltaH, MIN_CAPACITY) * speed * water * CAPACITY;
      if (sediment > capacity || deltaH > 0) {
        // 上り坂なら窪みを埋めるだけ置く。流れが遅くて運びきれない分も置く。
        const amount =
          deltaH > 0 ? Math.min(deltaH / stepScale, sediment) : (sediment - capacity) * DEPOSIT;
        sediment -= amount;
        deposit(hs, k, fx, fz, n, amount);
      } else {
        // 削る量は、その場の高低差より深く掘らない。穴を作ると水が止まる。
        const amount = Math.min((capacity - sediment) * ERODE, -deltaH / stepScale);
        for (let b = 0; b < brush.di.length; b++) {
          const bx = ix + brush.di[b];
          const bz = iz + brush.dj[b];
          if (bx < 0 || bz < 0 || bx >= n || bz >= n) continue;
          const c = bz * n + bx;
          const take = Math.min(hs[c], amount * brush.w[b]);
          // 海面より下は削らない（海岸が崩れて入り江だらけになるのを防ぐ）。
          if (hs[c] - take < 0) continue;
          hs[c] -= take;
          sediment += take;
        }
      }

      speed = Math.sqrt(Math.max(0, speed * speed - deltaH * GRAVITY));
      water *= 1 - EVAPORATE;
    }
  }

  for (let k = 0; k < h.length; k++) h[k] = hs[k] * HEIGHT_REF;
}

/** 位置 (ix+fx, iz+fz) の周り 4 点へ、近さに応じて土を置く。 */
function deposit(
  hs: Float32Array,
  k: number,
  fx: number,
  fz: number,
  n: number,
  amount: number,
): void {
  hs[k] += amount * (1 - fx) * (1 - fz);
  hs[k + 1] += amount * fx * (1 - fz);
  hs[k + n] += amount * (1 - fx) * fz;
  hs[k + n + 1] += amount * fx * fz;
}

interface Brush {
  di: Int32Array;
  dj: Int32Array;
  w: Float32Array;
}

/** 半径 r の円錐形の刷毛。重みの合計は 1。 */
function makeBrush(r: number): Brush {
  const di: number[] = [];
  const dj: number[] = [];
  const w: number[] = [];
  let sum = 0;
  for (let j = -r; j <= r; j++) {
    for (let i = -r; i <= r; i++) {
      const d = Math.sqrt(i * i + j * j);
      if (d >= r) continue;
      const weight = 1 - d / r;
      di.push(i);
      dj.push(j);
      w.push(weight);
      sum += weight;
    }
  }
  return {
    di: Int32Array.from(di),
    dj: Int32Array.from(dj),
    w: Float32Array.from(w.map((v) => v / sum)),
  };
}
