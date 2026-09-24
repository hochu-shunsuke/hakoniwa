import type { Island } from '../island/generate';
import { WATER_LAKE, WATER_RIVER } from '../island/hydrology';
import { WATER_DEEP, WATER_FRESH, WATER_SHALLOW, landColor, toByte } from './palette';

/**
 * 島を真上から描く。北西からの光で陰影を付け、地面の色・海の深さ・川と湖を重ねる。
 * つまみの効き目をすぐ見るための画面で、3D の前に形を決める場所。
 */
export function drawIsland(canvas: HTMLCanvasElement, island: Island): void {
  const { n, cell, height, waterKind, waterLevel, temperature, moisture } = island;
  canvas.width = n;
  canvas.height = n;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(n, n);
  const px = img.data;
  const color = new Float32Array(3);

  const at = (i: number, j: number) =>
    height[Math.max(0, Math.min(n - 1, j)) * n + Math.max(0, Math.min(n - 1, i))];

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const h = height[k];
      const dx = (at(i + 1, j) - at(i - 1, j)) / (2 * cell);
      const dz = (at(i, j + 1) - at(i, j - 1)) / (2 * cell);
      const slope = Math.sqrt(dx * dx + dz * dz);

      // 北西からの光。起伏を読みやすくするため縦を 2 倍に誇張する。
      const nx = -dx * 2;
      const nz = -dz * 2;
      const len = Math.sqrt(nx * nx + 1 + nz * nz);
      const light = (-nx * 0.6 + 0.75 - nz * 0.6) / (len * 1.1325);
      let shade = 0.6 + 0.55 * Math.max(0, light);

      if (waterKind[k] === WATER_LAKE || waterKind[k] === WATER_RIVER) {
        const deep = waterKind[k] === WATER_LAKE ? Math.min(1, (waterLevel[k] - h) / 8) : 0.3;
        color[0] = WATER_FRESH[0] * (1 - deep * 0.4);
        color[1] = WATER_FRESH[1] * (1 - deep * 0.4);
        color[2] = WATER_FRESH[2] * (1 - deep * 0.3);
        shade = 1;
      } else if (h <= 0) {
        const deep = Math.min(1, -h / 60);
        color[0] = WATER_SHALLOW[0] * (1 - deep) + WATER_DEEP[0] * deep;
        color[1] = WATER_SHALLOW[1] * (1 - deep) + WATER_DEEP[1] * deep;
        color[2] = WATER_SHALLOW[2] * (1 - deep) + WATER_DEEP[2] * deep;
        shade = 0.85 + shade * 0.15;
      } else {
        landColor(h, slope, temperature[k], moisture[k], color);
      }

      const o = k * 4;
      px[o] = toByte(color[0] * shade);
      px[o + 1] = toByte(color[1] * shade);
      px[o + 2] = toByte(color[2] * shade);
      px[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
