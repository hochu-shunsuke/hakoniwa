import type { Island } from '../island/generate';
import { gridToWorld } from '../island/ground';
import { WATER_LAKE, WATER_RIVER } from '../island/hydrology';
import type { Terrain } from '../world/terrain';

/**
 * 島を真上から描く小さな地図。地面の色は 3D と同じ Terrain.shade。
 * 北西からの光で陰影を付け、海の深さと川・湖を重ねる。
 */

const toByte = (v: number) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
};

/** 地図の画素（RGBA）。Worker で作って画面へ渡す。 */
export interface IslandMap {
  size: number;
  pixels: Uint8ClampedArray;
}

/** 地図の画素を作る。画面の部品に触らないので Worker で動く（島 1 つで 15 万点の色付け）。 */
export function renderIslandMap(island: Island, terrain: Terrain): IslandMap {
  // 地図は小さいので 2 点に 1 点で足りる。
  const step = island.n > 300 ? 2 : 1;
  const { n, cell, height, waterKind, temperature, moisture } = island;
  const size = Math.floor((n - 1) / step) + 1;
  const px = new Uint8ClampedArray(size * size * 4);
  const color = new Float32Array(3);
  const at = (i: number, j: number) =>
    height[Math.max(0, Math.min(n - 1, j)) * n + Math.max(0, Math.min(n - 1, i))];

  for (let pj = 0; pj < size; pj++) {
    for (let pi = 0; pi < size; pi++) {
      const i = pi * step;
      const j = pj * step;
      const k = j * n + i;
      const h = height[k];
      const dx = (at(i + 1, j) - at(i - 1, j)) / (2 * cell);
      const dz = (at(i, j + 1) - at(i, j - 1)) / (2 * cell);
      const nx = -dx * 2;
      const nz = -dz * 2;
      const len = Math.sqrt(nx * nx + 1 + nz * nz);
      const light = (-nx * 0.6 + 0.75 - nz * 0.6) / (len * 1.1325);
      let shade = 0.62 + 0.55 * Math.max(0, light);

      if (waterKind[k] === WATER_LAKE || waterKind[k] === WATER_RIVER) {
        color[0] = 0.05;
        color[1] = 0.28;
        color[2] = 0.48;
        shade = 1;
      } else if (h <= 0) {
        const deep = Math.min(1, -h / 60);
        color[0] = 0.12 * (1 - deep) + 0.02 * deep;
        color[1] = 0.45 * (1 - deep) + 0.1 * deep;
        color[2] = 0.5 * (1 - deep) + 0.25 * deep;
        shade = 0.9 + shade * 0.1;
      } else {
        const x = gridToWorld(i, n);
        const z = gridToWorld(j, n);
        const slope = Math.min(1, Math.sqrt(dx * dx + dz * dz));
        terrain.shade(x, z, h, slope, temperature[k], moisture[k], terrain.specialAt(x, z), terrain.patchAt(x, z), color, 0);
      }
      const o = (pj * size + pi) * 4;
      px[o] = toByte(color[0] * shade);
      px[o + 1] = toByte(color[1] * shade);
      px[o + 2] = toByte(color[2] * shade);
      px[o + 3] = 255;
    }
  }
  return { size, pixels: px };
}

/** 地図を canvas に描く。 */
export function drawIslandMap(canvas: HTMLCanvasElement, map: IslandMap): void {
  canvas.width = map.size;
  canvas.height = map.size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(map.size, map.size);
  img.data.set(map.pixels);
  ctx.putImageData(img, 0, 0);
}
