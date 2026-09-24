/// <reference lib="webworker" />
import { type Island, generateIsland } from './generate';
import type { IslandParams } from './params';

/**
 * 島の計算は数百 ms かかるので Worker で行う。つまみを動かしても画面が固まらない。
 */

export interface GenerateRequest {
  id: number;
  params: IslandParams;
  n: number;
}

export interface GenerateResult {
  id: number;
  island: Island;
  /** この島を作ったときのつまみ。計算中につまみが動いても、島と地形の式を食い違わせない。 */
  params: IslandParams;
  ms: number;
}

self.onmessage = (ev: MessageEvent<GenerateRequest>) => {
  const { id, params, n } = ev.data;
  const started = performance.now();
  const island = generateIsland(params, n);
  const result: GenerateResult = { id, island, params, ms: performance.now() - started };
  (self as unknown as Worker).postMessage(result, [
    island.height.buffer,
    island.carve.buffer,
    island.waterLevel.buffer,
    island.waterKind.buffer,
    island.temperature.buffer,
    island.moisture.buffer,
  ]);
};
