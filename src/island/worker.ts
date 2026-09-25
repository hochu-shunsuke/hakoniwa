/// <reference lib="webworker" />
import { type ForestBatch, plantForest } from './forest';
import { type Island, generateIsland } from './generate';
import { IslandWater } from '../world/islandWater';
import { Terrain } from '../world/terrain';
import { FULL_RES } from './grid';
import type { IslandParams } from './params';

/**
 * 島の計算は数百 ms かかるので Worker で行う。つまみを動かしても画面が固まらない。
 */

export interface GenerateRequest {
  id: number;
  params: IslandParams;
  /** 見渡す島の格子と、侵食の格子（1 辺の点数）。 */
  n: number;
  erosionN: number;
}

export interface GenerateResult {
  id: number;
  island: Island;
  /** この島を作ったときのつまみ。計算中につまみが動いても、島と地形の式を食い違わせない。 */
  params: IslandParams;
  /** 島全体の木。下見（粗い格子）では null。 */
  forest: ForestBatch[] | null;
  ms: number;
}

self.onmessage = (ev: MessageEvent<GenerateRequest>) => {
  const { id, params, n, erosionN } = ev.data;
  const started = performance.now();
  const island = generateIsland(params, n, erosionN);
  // 木は指を離して本番の格子で作ったときだけ。下見の間は地形の形だけを見せる。
  const forest = n === FULL_RES
    ? plantForest(new Terrain(params, island.landscape, new IslandWater(island.water)), island)
    : null;
  const result: GenerateResult = { id, island, params, forest, ms: performance.now() - started };
  (self as unknown as Worker).postMessage(result, [
    island.height.buffer,
    island.waterLevel.buffer,
    island.waterKind.buffer,
    island.temperature.buffer,
    island.moisture.buffer,
    island.landscape.height.buffer,
    island.water.carve.buffer,
    island.water.level.buffer,
    island.water.kind.buffer,
    ...(forest ?? []).flatMap((b) => [b.matrices.buffer, b.colors.buffer]),
  ]);
};
