import { hashSeed } from '../core/rng';
import { Noise2D, fbm, mix, ridged, smoothstep } from './noise';
import type { Grid } from './grid';
import type { IslandParams } from './params';

/**
 * 侵食する前の島の形。輪郭（どこが陸か）と、山脈の骨格を作る。
 *
 * 座標は島の中心を原点に -1..1 へ正規化してから引く。格子の細かさ（下見と本番）が
 * 違っても同じ島の形になるように、ノイズは格子の番号ではなく正規化座標で引く。
 */

/** 陸の平地が上がる高さ（m）。 */
const PLAIN_RISE = 26;
/** 一番深い海（m）。 */
const SEA_DEPTH = 80;

export function shapeIsland(p: IslandParams, grid: Grid): Float32Array {
  const [a, b, c, d] = hashSeed(p.seed);
  const nWarp = new Noise2D(a);
  const nCoast = new Noise2D(b);
  const nRidge = new Noise2D(c);
  const nMass = new Noise2D(d);
  const nHills = new Noise2D((a ^ 0x9e3779b9) >>> 0);

  const size = p.size / 100;
  const shape = p.shape / 100;
  const mountains = p.mountains / 100;

  // 島の半径（正規化座標）と、海岸線の入り組み。
  const radius = mix(0.3, 0.74, size);
  const coastNoise = mix(0.16, 0.8, shape);
  // 山の高さ。二乗で持ち上げ、つまみの上半分で急に険しくなるようにする。
  const peak = mix(35, 560, mountains * mountains);

  const { n } = grid;
  const h = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = (i / (n - 1)) * 2 - 1;
      const v = (j / (n - 1)) * 2 - 1;

      // 丸い島の輪郭をゆがめ、入り江と岬を作る。
      const wu = u + fbm(nWarp, u, v, 3, 1.3) * 0.28;
      const wv = v + fbm(nWarp, u + 17.3, v - 9.1, 3, 1.3) * 0.28;
      const r = Math.sqrt(wu * wu + wv * wv);
      let land = 1 - r / radius + fbm(nCoast, u, v, 5, 2.2) * coastNoise;
      // 島の外周（格子の縁）は必ず海にする。
      const edge = Math.sqrt(u * u + v * v);
      land -= smoothstep(0.84, 1.0, edge) * 2;

      let height: number;
      if (land >= 0) {
        const t = Math.min(land / 0.7, 1);
        height = PLAIN_RISE * (1 - (1 - t) * (1 - t));
      } else {
        height = -SEA_DEPTH * smoothstep(0, 0.45, -land);
      }

      // 山は陸の内側にだけ。地方（mass）が山を持つ所と平地の所を分け、
      // 尾根ノイズが稜線を作る。
      const inland = smoothstep(0.02, 0.32, land);
      if (inland > 0) {
        const mass = smoothstep(0.38, 0.78, fbm(nMass, u, v, 3, 1.5) * 0.5 + 0.5);
        const ridge = ridged(nRidge, u, v, 5, 2.6);
        const hills = fbm(nHills, u, v, 4, 6) * 0.5 + 0.5;
        height += inland * (peak * mass * ridge + 22 * hills * (1 - mass * 0.6));
      }
      h[j * n + i] = height;
    }
  }
  return h;
}
