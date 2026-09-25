import { ISLAND_SIZE } from '../island/grid';
import { WATER_LAKE, WATER_RIVER } from '../island/hydrology';

/**
 * 島全体の格子で求めた水（湖と川）を、世界座標で引く窓口。
 *
 * 水は島全体を見て計算する（海から水を満たして湖を決め、流れを集めて川にする。
 * island/hydrology.ts）。細かい地形（1 点ずつの式）には、ここから
 *   - 川に合わせて彫った量（carve、双一次で補間）
 *   - 水面の高さ（湖は一定、川は下流へ下がる）
 * を渡す。stroll の丸い湖と、周りを削いだ縁はもう使わない。
 */
export interface IslandWaterArrays {
  n: number;
  /** 地形を川に合わせて彫った量（m、0 以下）。 */
  carve: Float32Array;
  /** 水面の高さ（m）。水が無ければ NaN。 */
  level: Float32Array;
  /** 1 = 川、2 = 湖。 */
  kind: Uint8Array;
}

/** 水らしさがこれ以上なら水面を張る。地形が高ければ地形が隠すので、少し広めに取る。 */
const WET_EDGE = 0.2;

export class IslandWater {
  constructor(readonly data: IslandWaterArrays) {}

  private toGrid(v: number): number {
    return (v / ISLAND_SIZE + 0.5) * (this.data.n - 1);
  }

  /** 彫った量。島の外は 0。 */
  carveAt(x: number, z: number): number {
    const { n, carve } = this.data;
    const u = this.toGrid(x);
    const v = this.toGrid(z);
    if (u < 0 || v < 0 || u >= n - 1 || v >= n - 1) return 0;
    const i = u | 0;
    const j = v | 0;
    const fu = u - i;
    const fv = v - j;
    const a = carve[j * n + i];
    const b = carve[j * n + i + 1];
    const c = carve[(j + 1) * n + i];
    const d = carve[(j + 1) * n + i + 1];
    return (a + (b - a) * fu) * (1 - fv) + (c + (d - c) * fu) * fv;
  }

  /** 一番近い格子点の水の種類（0 = 無し、1 = 川、2 = 湖）。 */
  kindAt(x: number, z: number): number {
    const { n, kind } = this.data;
    const i = Math.round(this.toGrid(x));
    const j = Math.round(this.toGrid(z));
    if (i < 0 || j < 0 || i >= n || j >= n) return 0;
    return kind[j * n + i];
  }

  /**
   * 水らしさ 0..1。囲む 4 点の水の有無を双一次で混ぜる。
   * 近い 1 点だけで決めると、水の形が格子（16m）の四角の並びになってガタガタに見える。
   */
  wetAt(x: number, z: number): number {
    const { n, kind } = this.data;
    const u = this.toGrid(x);
    const v = this.toGrid(z);
    if (u < 0 || v < 0 || u >= n - 1 || v >= n - 1) return 0;
    const i = u | 0;
    const j = v | 0;
    const fu = u - i;
    const fv = v - j;
    const w = (k: number) => (kind[k] === WATER_LAKE || kind[k] === WATER_RIVER ? 1 : 0);
    const a = w(j * n + i);
    const b = w(j * n + i + 1);
    const c = w((j + 1) * n + i);
    const d = w((j + 1) * n + i + 1);
    return (a + (b - a) * fu) * (1 - fv) + (c + (d - c) * fu) * fv;
  }

  /**
   * 内陸の水面。水が無ければ -Infinity。
   * 囲む 4 点のうち水のある点の水面を、近さで重み付けして混ぜる。水らしさが
   * WET_EDGE に届かない所は水にしない。水の縁は丸く、川の水面はなめらかに下る。
   */
  levelAt(x: number, z: number): number {
    const { n, kind, level } = this.data;
    const u = this.toGrid(x);
    const v = this.toGrid(z);
    if (u < 0 || v < 0 || u >= n - 1 || v >= n - 1) return -Infinity;
    const i = u | 0;
    const j = v | 0;
    const fu = u - i;
    const fv = v - j;
    let weight = 0;
    let sum = 0;
    const add = (k: number, wgt: number) => {
      if (kind[k] !== WATER_LAKE && kind[k] !== WATER_RIVER) return;
      weight += wgt;
      sum += level[k] * wgt;
    };
    add(j * n + i, (1 - fu) * (1 - fv));
    add(j * n + i + 1, fu * (1 - fv));
    add((j + 1) * n + i, (1 - fu) * fv);
    add((j + 1) * n + i + 1, fu * fv);
    if (weight < WET_EDGE) return -Infinity;
    return sum / weight;
  }
}
