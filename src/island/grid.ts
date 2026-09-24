/**
 * 島の格子。島全体を 1 枚の高さの格子として一度に計算する。
 *
 * 無限の世界（stroll）では 1 点ずつの関数に縛られ、侵食も川も作れなかった。
 * 有限の島なら、周りを見る計算（水を満たす・流れを集める・雨陰）を普通に書ける。
 *
 * **決定性の決まり**: 生成には四則演算・Math.sqrt・Math.floor・Math.min/max だけを使う。
 * Math.sin / exp / pow などは JavaScript エンジンごとに結果がわずかに違いうる。
 * 侵食のような繰り返しの計算はその差を増幅するので、同じ URL でも端末ごとに別の島になる。
 */

/** 島の一辺（m）。鳥の巡航 78m/s で端から端まで約 80 秒。 */
export const ISLAND_SIZE = 6144;

/** 本番の格子の点数（1 辺）。12m 間隔。 */
export const FULL_RES = 513;
/** つまみを動かしている間の下見用。24m 間隔。 */
export const PREVIEW_RES = 257;

export interface Grid {
  /** 1 辺の点数。 */
  n: number;
  /** 点の間隔（m）。 */
  cell: number;
}

export function makeGrid(n: number): Grid {
  return { n, cell: ISLAND_SIZE / (n - 1) };
}

/** 8 近傍。[di, dj, 距離] */
export const NEIGHBORS8: readonly (readonly [number, number, number])[] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

/** 高さ順の最小ヒープ（priority-flood 用）。 */
export class MinHeap {
  private keys: Float64Array;
  private vals: Int32Array;
  size = 0;

  constructor(capacity: number) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
  }

  push(key: number, val: number): void {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.keys.length * 2);
      const v = new Int32Array(this.vals.length * 2);
      k.set(this.keys);
      v.set(this.vals);
      this.keys = k;
      this.vals = v;
    }
    const k = this.keys;
    const v = this.vals;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      // 同じ高さは番号の小さい方を先に出す。並びを入力だけで決め、端末差を入れない。
      if (k[p] < key || (k[p] === key && v[p] <= val)) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }

  /** 最小の値を取り出す。先に topKey() で高さを読むこと。 */
  pop(): number {
    const k = this.keys;
    const v = this.vals;
    const top = v[0];
    const n = --this.size;
    const lastK = k[n];
    const lastV = v[n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && (k[c + 1] < k[c] || (k[c + 1] === k[c] && v[c + 1] < v[c]))) c++;
      if (k[c] > lastK || (k[c] === lastK && v[c] >= lastV)) break;
      k[i] = k[c];
      v[i] = v[c];
      i = c;
    }
    k[i] = lastK;
    v[i] = lastV;
    return top;
  }

  topKey(): number {
    return this.keys[0];
  }
}
