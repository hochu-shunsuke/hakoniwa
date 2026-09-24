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

  /** 内陸の水面。水が無ければ -Infinity。一番近い格子点の値を使う。 */
  levelAt(x: number, z: number): number {
    const { n, kind, level } = this.data;
    const i = Math.round(this.toGrid(x));
    const j = Math.round(this.toGrid(z));
    if (i < 0 || j < 0 || i >= n || j >= n) return -Infinity;
    const k = j * n + i;
    if (kind[k] !== WATER_LAKE && kind[k] !== WATER_RIVER) return -Infinity;
    return level[k];
  }
}
