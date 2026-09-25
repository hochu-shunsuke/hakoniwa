import type { Ground } from '../island/ground';
import { type IslandSlot, slotAt } from './layout';

/** 外洋の海底（m）。島の格子の外の深さ（world/islandShape.ts の OPEN_SEA）と揃える。 */
const OPEN_SEA = -70;

/**
 * 群島の足元。(x, z) を格子に含む島の地面を、その島の中心からの座標で引く。
 * 島の外は外洋の海底。まだ計算できていない島も外洋として扱う。
 */
export class ArchipelagoGround implements Ground {
  constructor(
    private readonly slots: readonly IslandSlot[],
    private readonly grounds: readonly (Ground | null)[],
  ) {}

  heightAt(x: number, z: number): number {
    const k = slotAt(this.slots, x, z);
    const g = k < 0 ? null : this.grounds[k];
    return g ? g.heightAt(x - this.slots[k].x, z - this.slots[k].z) : OPEN_SEA;
  }

  waterLevelAt(x: number, z: number): number {
    const k = slotAt(this.slots, x, z);
    const g = k < 0 ? null : this.grounds[k];
    return g ? g.waterLevelAt(x - this.slots[k].x, z - this.slots[k].z) : -Infinity;
  }
}
