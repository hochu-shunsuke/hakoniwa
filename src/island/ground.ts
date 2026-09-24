import type { Island } from './generate';
import { ISLAND_SIZE } from './grid';
import { WATER_LAKE, WATER_RIVER } from './hydrology';

export const SEA_LEVEL = 0;

/** 島の外（格子の外）の海の深さ（m）。 */
const OPEN_SEA = -80;

/** プレイヤーが地形に求めるもの。stroll の Terrain と同じ 2 つだけ。 */
export interface Ground {
  heightAt(x: number, z: number): number;
  /** 内陸の水面（湖・川）。無ければ -Infinity。海は SEA_LEVEL で別に扱う。 */
  waterLevelAt(x: number, z: number): number;
}

/**
 * 島の格子を、世界座標（島の中心が原点、単位 m）で引く窓口。
 *
 * **高さは 3D のメッシュと同じ三角形の切り方で補間する**（格子の四角形を
 * (0,0)-(1,1) の対角線で割る。render/islandMesh.ts と揃える）。ずれると足元が
 * 見た目の地面に沈むか浮く（stroll で踏んだ）。
 */
export class IslandGround implements Ground {
  /** つまみで島を作り直したら差し替える。飛んでいる最中でも足元がすぐ新しい島になる。 */
  constructor(public island: Island) {}

  /** 世界座標 → 格子座標（小数）。 */
  private toGrid(v: number): number {
    return (v / ISLAND_SIZE + 0.5) * (this.island.n - 1);
  }

  heightAt(x: number, z: number): number {
    const { n, height } = this.island;
    const u = this.toGrid(x);
    const v = this.toGrid(z);
    if (u < 0 || v < 0 || u > n - 1 || v > n - 1) return OPEN_SEA;
    const i = Math.min(n - 2, u | 0);
    const j = Math.min(n - 2, v | 0);
    const fu = u - i;
    const fv = v - j;
    const h00 = height[j * n + i];
    const h10 = height[j * n + i + 1];
    const h01 = height[(j + 1) * n + i];
    const h11 = height[(j + 1) * n + i + 1];
    if (fv >= fu) return h00 * (1 - fv) + h01 * (fv - fu) + h11 * fu;
    return h00 * (1 - fu) + h10 * (fu - fv) + h11 * fv;
  }

  waterLevelAt(x: number, z: number): number {
    const { n, waterKind, waterLevel } = this.island;
    const i = Math.round(this.toGrid(x));
    const j = Math.round(this.toGrid(z));
    if (i < 0 || j < 0 || i >= n || j >= n) return -Infinity;
    const k = j * n + i;
    if (waterKind[k] !== WATER_LAKE && waterKind[k] !== WATER_RIVER) return -Infinity;
    return waterLevel[k];
  }
}

/** 格子 (i,j) の世界座標。 */
export function gridToWorld(i: number, n: number): number {
  return (i / (n - 1) - 0.5) * ISLAND_SIZE;
}
