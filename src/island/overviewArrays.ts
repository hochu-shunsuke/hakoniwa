import { SURFACE_STRIDE } from '../world/islandSurface';
import { type Terrain, splitsAlongMainDiagonal } from '../world/terrain';
import type { Island } from './generate';
import { gridToWorld } from './ground';

/**
 * 見渡す島の 1 枚（render/overviewMesh.ts）の中身を、生の配列として作る。
 * **Worker で作る**（island/worker.ts）。59 万頂点の色付けは 1 秒近くかかり、画面側で作ると
 * その間 画面が止まっていた。three.js に頼らない形にしてあるのは Worker で動かすため。
 */

export interface OverviewArrays {
  position: Float32Array;
  normal: Float32Array;
  /** 地面の層（world/islandSurface.ts）。color = 土台、rock = 岩の色、surf = 岩の量・雪の量・凹みの明暗。 */
  color: Float32Array;
  rock: Float32Array;
  surf: Float32Array;
  index: Uint32Array;
}

export function buildOverviewArrays(island: Island, terrain: Terrain): OverviewArrays {
  const { n, cell, height, temperature, moisture } = island;
  const position = new Float32Array(n * n * 3);
  const normal = new Float32Array(n * n * 3);
  const color = new Float32Array(n * n * 3);
  const rock = new Float32Array(n * n * 3);
  const surf = new Float32Array(n * n * 3);
  const layers = new Float32Array(SURFACE_STRIDE);
  const at = (i: number, j: number) =>
    height[Math.max(0, Math.min(n - 1, j)) * n + Math.max(0, Math.min(n - 1, i))];
  for (let j = 0; j < n; j++) {
    const z = gridToWorld(j, n);
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const x = gridToWorld(i, n);
      const h = height[k];
      position[k * 3] = x;
      position[k * 3 + 1] = h;
      position[k * 3 + 2] = z;
      // 法線と傾きは chunk.ts と同じ中心差分で取る。
      const dx = (at(i + 1, j) - at(i - 1, j)) / (2 * cell);
      const dz = (at(i, j + 1) - at(i, j - 1)) / (2 * cell);
      const len = Math.sqrt(dx * dx + 1 + dz * dz);
      normal[k * 3] = -dx / len;
      normal[k * 3 + 1] = 1 / len;
      normal[k * 3 + 2] = -dz / len;
      const slope = Math.min(1, Math.sqrt(dx * dx + dz * dz));
      terrain.surface(x, z, h, slope, temperature[k], moisture[k], terrain.specialAt(x, z), terrain.patchAt(x, z), layers, 0);
      for (let c = 0; c < 3; c++) {
        color[k * 3 + c] = layers[c];
        rock[k * 3 + c] = layers[3 + c];
        surf[k * 3 + c] = layers[6 + c];
      }
    }
  }

  const index = new Uint32Array((n - 1) * (n - 1) * 6);
  let o = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const b = a + 1;
      const d = a + n;
      const e = d + 1;
      // チャンクと同じ割り方（高低差の小さい対角線）。
      if (splitsAlongMainDiagonal(height[a], height[b], height[d], height[e])) {
        index[o++] = a;
        index[o++] = d;
        index[o++] = e;
        index[o++] = a;
        index[o++] = e;
        index[o++] = b;
      } else {
        index[o++] = a;
        index[o++] = d;
        index[o++] = b;
        index[o++] = d;
        index[o++] = e;
        index[o++] = b;
      }
    }
  }
  return { position, normal, color, rock, surf, index };
}

/**
 * 湖と川の水面。水のある格子に角が 1 つでも触れる四角形に張る。
 * 水の無い角は、同じ四角形の水のある角の高さの平均に置く。水面は岸の下まで伸びて
 * 地形に隠れ、水際の線は地形との交わりで決まる。川は下流へ下る斜めの水面になる。
 */
export function buildOverviewWaterArray(island: Island): Float32Array | null {
  const { n, waterLevel } = island;
  const pos: number[] = [];
  const lv = new Float32Array(4);
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const ks = [j * n + i, j * n + i + 1, (j + 1) * n + i, (j + 1) * n + i + 1];
      let sum = 0;
      let wet = 0;
      for (let q = 0; q < 4; q++) {
        const v = waterLevel[ks[q]];
        if (Number.isFinite(v)) {
          sum += v;
          wet++;
        }
      }
      if (wet === 0) continue;
      const fill = sum / wet;
      for (let q = 0; q < 4; q++) {
        const v = waterLevel[ks[q]];
        lv[q] = Number.isFinite(v) ? v : fill;
      }
      const x0 = gridToWorld(i, n);
      const x1 = gridToWorld(i + 1, n);
      const z0 = gridToWorld(j, n);
      const z1 = gridToWorld(j + 1, n);
      pos.push(x0, lv[0], z0, x0, lv[2], z1, x1, lv[3], z1);
      pos.push(x0, lv[0], z0, x1, lv[3], z1, x1, lv[1], z0);
    }
  }
  return pos.length === 0 ? null : new Float32Array(pos);
}

