import { hashSeed } from '../core/rng';
import { Noise2D, fbm, mix, ridged, smoothstep } from '../world/noise';
import { NEIGHBORS8, makeGrid } from './grid';
import type { IslandParams } from './params';

/**
 * 島の大きな形。**隆起させた山を、川が削って作る。**
 *
 * stroll の標高の式は、無限の世界に「歩ける平地」を広げるためのもので、島にすると
 * 平らな土台にたまに山が載る形になった。ここでは土台そのものを動かす。
 *   1. 隆起の設計図: 島の輪郭の内側を、中心ほど高い山の形に持ち上げる。
 *      尾根のノイズで峰の数と連なりを変える
 *   2. 侵食（FastScape 型、Braun & Willett 2013）: 川の侵食 dh/dt = U − K·√A·S を陰的に解く。
 *      流れの向き → 上流からの並び → 集水面積 → 下流から解く、を繰り返す。
 *      枝分かれした谷と尾根、川の網が同じ計算から出る
 *   3. 斜面の拡散: 尾根を少し丸める
 *
 * 決定性の決まり（grid.ts）: 四則演算と sqrt だけ。集水面積の指数を 0.5 にしてあるのは sqrt で済ませるため。
 */

/** 侵食の繰り返し回数。少ないと侵食が内陸に届かず、中央に平らな台が残る。 */
const ITERATIONS = 140;
/** 一番深い海（m）。 */
const SEA_DEPTH = 70;
/**
 * 斜面の拡散の強さ（1 回あたり、格子 1 本分の係数）。0.25 を越えると不安定。
 * 0.06 では尾根が丸まりすぎ、谷の枝分かれが消えて丸い凸凹になった。
 */
const DIFFUSION = 0.015;

export interface Landscape {
  n: number;
  /** 侵食した後の大きな地形（m）。海面が 0。 */
  height: Float32Array;
}

export function buildLandscape(p: IslandParams, n: number): Landscape {
  const grid = makeGrid(n);
  const { cell } = grid;
  const [a, b, c, d] = hashSeed(p.seed);
  const nWarp = new Noise2D(a);
  const nCoast = new Noise2D(b);
  const nRidge = new Noise2D(c);
  const nPeaks = new Noise2D(d);

  const size = p.size / 100;
  const shape = p.shape / 100;
  const mountains = p.mountains / 100;
  const erosion = p.erosion / 100;

  const radius = mix(0.42, 0.86, size);
  const coastNoise = mix(0.18, 0.75, shape);
  /** 山の高さ（m）。二乗で持ち上げ、つまみの上半分で急に険しくなる。 */
  const peak = mix(120, 900, mountains * mountains);
  /** 峰の散らばり。まとまった島は 1 つの山、多島海ほど峰が散らばる。 */
  const scatter = mix(0.25, 0.85, shape);

  const N = n * n;
  const h = new Float64Array(N);
  const uplift = new Float64Array(N);
  const base = new Uint8Array(N);

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const u = (i / (n - 1)) * 2 - 1;
      const v = (j / (n - 1)) * 2 - 1;
      const wu = u + fbm(nWarp, u, v, 3, 1.2) * 0.22;
      const wv = v + fbm(nWarp, u + 17.3, v - 9.1, 3, 1.2) * 0.22;
      const r = Math.sqrt(wu * wu + wv * wv);
      let land = 1 - r / radius + fbm(nCoast, u, v, 5, 2.0) * coastNoise;
      land -= smoothstep(0.86, 1.0, Math.sqrt(u * u + v * v)) * 3;

      if (land <= 0 || i === 0 || j === 0 || i === n - 1 || j === n - 1) {
        base[k] = 1;
        h[k] = -SEA_DEPTH * smoothstep(0, 0.5, -land);
        continue;
      }
      // 山の形: 輪郭から内側へ上がる丸い山（dome）に、尾根の筋（ridge）と峰の散らばり（peaks）。
      const dome = smoothstep(0, 0.9, land);
      const ridge = ridged(nRidge, u, v, 4, 1.7);
      const peaks = smoothstep(0.35, 0.9, fbm(nPeaks, u, v, 3, 1.6) * 0.5 + 0.5);
      const profile = dome * mix(1, 0.35 + ridge * 0.9, scatter) * mix(1, 0.4 + peaks, scatter * 0.6);
      uplift[k] = profile;
      // 始めは設計図どおりの山。侵食がここから谷を刻む。
      h[k] = 2 + peak * profile;
    }
  }

  // 侵食の強さ（谷の刻みのつまみ）。隆起は山の高さに比例させ、侵食で山が消え切らないように保つ。
  // 0.0022 以下では谷が浅く、谷の刻みのつまみを動かしても見分けがつかなかった。
  const K = mix(0.004, 0.03, erosion);
  const U = peak * 0.0035;
  erode(h, uplift, base, n, cell, K, U);

  const out = new Float32Array(N);
  for (let k = 0; k < N; k++) out[k] = h[k];
  return { n, height: out };
}

/** FastScape 型の侵食と斜面の拡散。h を書き換える。 */
function erode(
  h: Float64Array,
  uplift: Float64Array,
  base: Uint8Array,
  n: number,
  cell: number,
  K: number,
  U: number,
): void {
  const N = n * n;
  const rec = new Int32Array(N);
  const dist = new Float64Array(N);
  const area = new Float64Array(N);
  const stack = new Int32Array(N);
  const donorCount = new Int32Array(N);
  const donors = new Int32Array(N * 8);
  const next = new Float64Array(N);
  const todo = new Int32Array(N);
  // 格子の細かさが変わっても谷の深さが揃うよう、面積は m² で数え、K は 1m あたりにする。
  const cellArea = cell * cell;

  for (let it = 0; it < ITERATIONS; it++) {
    // 1. 流れていく先（一番下る隣）。同じ下り具合なら先に見た方（NEIGHBORS8 の順）。
    for (let k = 0; k < N; k++) {
      rec[k] = k;
      dist[k] = 1;
      donorCount[k] = 0;
      if (base[k]) continue;
      const i = k % n;
      const j = (k / n) | 0;
      let best = 0;
      for (const [di, dj, dd] of NEIGHBORS8) {
        const m = (j + dj) * n + (i + di);
        const s = (h[k] - h[m]) / dd;
        if (s > best) {
          best = s;
          rec[k] = m;
          dist[k] = dd * cell;
        }
      }
    }
    for (let k = 0; k < N; k++) {
      const r = rec[k];
      if (r !== k) donors[r * 8 + donorCount[r]++] = k;
    }

    // 2. 下流から上流への並び（海と、窪みの底から）。
    let top = 0;
    for (let s = 0; s < N; s++) {
      if (rec[s] !== s) continue;
      let sp = 0;
      todo[sp++] = s;
      while (sp > 0) {
        const c = todo[--sp];
        stack[top++] = c;
        for (let q = 0; q < donorCount[c]; q++) todo[sp++] = donors[c * 8 + q];
      }
    }

    // 3. 集水面積（上流から足す）。
    for (let k = 0; k < N; k++) area[k] = cellArea;
    for (let s = N - 1; s >= 0; s--) {
      const k = stack[s];
      if (rec[k] !== k) area[rec[k]] += area[k];
    }

    // 4. 隆起と、陰的な川の侵食（下流から）。窪みの底は隆起だけで埋まっていく。
    for (let s = 0; s < N; s++) {
      const k = stack[s];
      if (base[k]) continue;
      h[k] += U * uplift[k];
      const r = rec[k];
      if (r === k) continue;
      const f = (K * Math.sqrt(area[k])) / dist[k];
      h[k] = (h[k] + f * h[r]) / (1 + f);
    }

    // 5. 斜面の拡散（尾根を丸める）。海は動かさない。
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) {
        const k = j * n + i;
        next[k] = base[k]
          ? h[k]
          : h[k] + DIFFUSION * (h[k + 1] + h[k - 1] + h[k + n] + h[k - n] - 4 * h[k]);
      }
    }
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) h[j * n + i] = next[j * n + i];
    }
  }
}
