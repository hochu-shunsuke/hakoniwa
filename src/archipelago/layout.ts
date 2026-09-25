import { hashSeed, mulberry32 } from '../core/rng';
import { ISLAND_SIZE } from '../island/grid';
import type { IslandParams } from '../island/params';

/**
 * 群島の並び（試作）。無限の海に hakoniwa の島を並べたら綺麗か、単調にならないかを確かめる。
 *
 * 島は ARCH_CELL 四方のマスに 1 つずつ、位置を少しずらして置く。島と島の間は必ず海なので、
 * 侵食・川・湖・焼き込んだ光を島ごとに計算しても継ぎ目が出ない（stroll の大陸では
 * これが壁だった）。島ごとのつまみは種とマスの番号から決める。同じ種なら同じ群島。
 */

/** マスの一辺（m）。島の格子（4096m）どうしは少し重なりうるが、陸は中心から 1.8km 以内なので海で隔たる。 */
export const ARCH_CELL = 5200;
/** マスの数（一辺）。試作は 3×3。 */
export const ARCH_GRID = 3;
/** マスの中で島の中心をずらす幅（m、±）。 */
const JITTER = 900;
/**
 * 群島全体の一辺（m）。原点が中心。いちばん外の島の中心（半マスずらし＋揺らし込み）から
 * 島の格子の半分までが収まるように取る。
 */
export const ARCH_EXTENT =
  2 * Math.ceil((ARCH_CELL * ((ARCH_GRID - 1) / 2 + 0.5) + JITTER + ISLAND_SIZE / 2) / 100) * 100;

export interface IslandSlot {
  /** マスの番号（-1..1）。 */
  i: number;
  j: number;
  /** 島の中心（世界座標、m）。 */
  x: number;
  z: number;
  /** 島の型（記録用）。 */
  kind: string;
  params: IslandParams;
}

type Range = readonly [number, number];

/**
 * 島の型。つまみを全部ばらばらに振ると、どの島も「茶色い岩山に雪」の似た島になった。
 * 型ごとにつまみの範囲を決めて、見た目の違う島が並ぶようにする。
 */
const KINDS: readonly {
  name: string;
  size: Range;
  shape: Range;
  mountains: Range;
  erosion: Range;
  wetness: Range;
  warmth: Range;
}[] = [
  // 南の環礁: 低く平らで、暖かく湿った島。浅瀬とサンゴ礁が広がる。
  { name: '南の島', size: [30, 70], shape: [45, 90], mountains: [5, 25], erosion: [30, 60], wetness: [65, 95], warmth: [85, 100] },
  // 雪の峰: 高く険しく、寒い。
  { name: '雪の峰', size: [45, 80], shape: [15, 50], mountains: [75, 95], erosion: [45, 80], wetness: [40, 80], warmth: [0, 18] },
  // 緑の丘: なだらかで湿った、森と湖の島。
  { name: '緑の丘', size: [55, 90], shape: [20, 60], mountains: [25, 50], erosion: [35, 70], wetness: [70, 95], warmth: [40, 65] },
  // 乾いた台地: 乾いて暖かく、谷が深く刻まれる。
  { name: '乾いた島', size: [40, 80], shape: [20, 60], mountains: [40, 70], erosion: [65, 95], wetness: [0, 20], warmth: [65, 90] },
  // 火山: 小さく尖った 1 つの山。
  { name: '火山', size: [22, 42], shape: [0, 20], mountains: [85, 100], erosion: [20, 45], wetness: [20, 60], warmth: [45, 80] },
  // 群れ島: 入り組んだ小島の集まり。
  { name: '群れ島', size: [45, 75], shape: [80, 100], mountains: [20, 55], erosion: [40, 70], wetness: [40, 80], warmth: [30, 75] },
];

/** a..b の一様な整数。 */
function range(rand: () => number, [a, b]: Range): number {
  return Math.round(a + (b - a) * rand());
}

export function planArchipelago(seed: string): IslandSlot[] {
  const half = (ARCH_GRID - 1) / 2;
  const slots: IslandSlot[] = [];
  // 同じ型が続かないよう、型の並びを種から混ぜて順に配る。
  const order = KINDS.map((_, k) => k);
  const shuffle = mulberry32(hashSeed(`${seed}:kinds`)[0]);
  for (let k = order.length - 1; k > 0; k--) {
    const r = Math.floor(shuffle() * (k + 1));
    [order[k], order[r]] = [order[r], order[k]];
  }
  let next = 0;
  for (let j = -half; j <= half; j++) {
    for (let i = -half; i <= half; i++) {
      const rand = mulberry32(hashSeed(`${seed}:${i}:${j}`)[0]);
      const center = i === 0 && j === 0;
      // 真ん中（飛び始める島）は、見どころのある雪の峰か緑の丘にする。
      const kind = center ? KINDS[rand() < 0.5 ? 1 : 2] : KINDS[order[next++ % order.length]];
      // 行ごとに半マスずらして、升目に見えないようにする。
      const shift = (j & 1) !== 0 ? ARCH_CELL * 0.5 : 0;
      slots.push({
        i,
        j,
        x: i * ARCH_CELL + shift + (center ? 0 : (rand() * 2 - 1) * JITTER),
        z: j * ARCH_CELL + (center ? 0 : (rand() * 2 - 1) * JITTER),
        kind: kind.name,
        params: {
          seed: `${seed}${i + half}${j + half}`,
          size: range(rand, kind.size),
          shape: range(rand, kind.shape),
          mountains: range(rand, kind.mountains),
          erosion: range(rand, kind.erosion),
          wetness: range(rand, kind.wetness),
          warmth: range(rand, kind.warmth),
        },
      });
    }
  }
  return slots;
}

/**
 * (x, z) の島の番号。中心がいちばん近い島の格子に入っていればその島、入っていなければ -1（外洋）。
 * 島の格子どうしは端で少し重なりうるが、重なる所は両方とも外洋なので、近い方を取れば足りる。
 */
export function slotAt(slots: readonly IslandSlot[], x: number, z: number): number {
  let best = -1;
  let bestD = Infinity;
  for (let k = 0; k < slots.length; k++) {
    const d = Math.max(Math.abs(x - slots[k].x), Math.abs(z - slots[k].z));
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return bestD < ISLAND_SIZE / 2 ? best : -1;
}
