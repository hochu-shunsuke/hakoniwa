import type { Island } from '../island/generate';
import { ISLAND_SIZE } from '../island/grid';
import type { IslandLighting } from '../island/lighting';
import { ARCH_EXTENT, type IslandSlot, slotAt } from './layout';

/**
 * 群島全体の 2 枚の地図。海のシェーダーと地面の材質は「原点を中心にした 1 枚の格子」を
 * 引く作りなので（render/water.ts・render/islandLight.ts）、島ごとの格子をここへ写す。
 *   - 高さ（川に合わせて彫った後の大きな形）: 水深で海の色と岸の泡を決める。16m 格子
 *   - 光（太陽の影・空の見え方）: 地面と木に掛ける。10m 格子
 * 島の格子の外は外洋（深さ -70m、光は遮られない）。
 */

const HEIGHT_STEP = 16;
const LIGHT_STEP = 10;
const OPEN_SEA = -70;

export class RegionMaps {
  readonly heightN = Math.round(ARCH_EXTENT / HEIGHT_STEP) + 1;
  readonly height = new Float32Array(this.heightN * this.heightN).fill(OPEN_SEA);
  readonly lightN = Math.round(ARCH_EXTENT / LIGHT_STEP) + 1;
  readonly light = new Uint8Array(this.lightN * this.lightN * 2).fill(255);

  constructor(private readonly slots: readonly IslandSlot[]) {}

  /** 島の高さを写す。 */
  writeHeight(slot: IslandSlot, island: Island): void {
    const { n, height } = island.landscape;
    const carve = island.water.carve;
    this.paint(slot, this.heightN, (u, v, k) => {
      this.height[k] = bilinear(n, u, v, (idx) => height[idx] + carve[idx]);
    });
  }

  /** 島の光を写す。 */
  writeLight(slot: IslandSlot, lighting: IslandLighting): void {
    const { n, data } = lighting;
    this.paint(slot, this.lightN, (u, v, k) => {
      this.light[k * 2] = Math.round(bilinear(n, u, v, (idx) => data[idx * 2]));
      this.light[k * 2 + 1] = Math.round(bilinear(n, u, v, (idx) => data[idx * 2 + 1]));
    });
  }

  /** 島の格子に入る地図の点ごとに、島の格子での位置 (u, v)（0..1）と地図の番号 k を渡す。 */
  private paint(slot: IslandSlot, mapN: number, write: (u: number, v: number, k: number) => void): void {
    const step = ARCH_EXTENT / (mapN - 1);
    const toIndex = (w: number) => (w + ARCH_EXTENT / 2) / step;
    const half = ISLAND_SIZE / 2;
    const i0 = Math.max(0, Math.ceil(toIndex(slot.x - half)));
    const i1 = Math.min(mapN - 1, Math.floor(toIndex(slot.x + half)));
    const j0 = Math.max(0, Math.ceil(toIndex(slot.z - half)));
    const j1 = Math.min(mapN - 1, Math.floor(toIndex(slot.z + half)));
    const self = this.slots.indexOf(slot);
    for (let j = j0; j <= j1; j++) {
      const z = j * step - ARCH_EXTENT / 2;
      const v = (z - slot.z) / ISLAND_SIZE + 0.5;
      for (let i = i0; i <= i1; i++) {
        const x = i * step - ARCH_EXTENT / 2;
        // 隣の島の格子と重なる所は、中心が近い方の島が受け持つ（足元の判定と同じ）。
        if (slotAt(this.slots, x, z) !== self) continue;
        const u = (x - slot.x) / ISLAND_SIZE + 0.5;
        write(u, v, j * mapN + i);
      }
    }
  }
}

/** n×n の格子を (u, v)（0..1）で双一次に引く。値は at(番号) で読む。 */
function bilinear(n: number, u: number, v: number, at: (k: number) => number): number {
  const x = Math.max(0, Math.min(n - 1, u * (n - 1)));
  const y = Math.max(0, Math.min(n - 1, v * (n - 1)));
  const i = Math.min(n - 2, x | 0);
  const j = Math.min(n - 2, y | 0);
  const fx = x - i;
  const fy = y - j;
  const k = j * n + i;
  return (at(k) + (at(k + 1) - at(k)) * fx) * (1 - fy) + (at(k + n) + (at(k + n + 1) - at(k + n)) * fx) * fy;
}
