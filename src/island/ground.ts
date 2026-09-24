import type { Terrain } from '../world/terrain';
import { ISLAND_SIZE } from './grid';

export { SEA_LEVEL } from '../world/terrain';

/** プレイヤーが地形に求めるもの。 */
export interface Ground {
  heightAt(x: number, z: number): number;
  /** 内陸の水面（湖・川）。無ければ -Infinity。海は SEA_LEVEL で別に扱う。 */
  waterLevelAt(x: number, z: number): number;
}

/**
 * プレイヤーの足元。近くのチャンク（最も細かい 2m 格子）と同じ三角形の切り方で
 * 高さを補間する。ずれると足元が見た目の地面に沈むか浮く（stroll で踏んだ）。
 * つまみで島を作り直したら terrain を差し替える。
 */
export class IslandGround implements Ground {
  constructor(public terrain: Terrain) {}

  heightAt(x: number, z: number): number {
    return this.terrain.heightOnGrid(x, z, 2);
  }

  waterLevelAt(x: number, z: number): number {
    return this.terrain.waterLevelAt(x, z);
  }
}

/** 島の格子の番号 → 世界座標（島の中心が原点、単位 m）。 */
export function gridToWorld(i: number, n: number): number {
  return (i / (n - 1) - 0.5) * ISLAND_SIZE;
}
