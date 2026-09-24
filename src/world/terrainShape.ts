import { ISLAND_SIZE } from '../island/grid';
import {
  Noise2D,
  fbm,
  fbmD,
  fbmEroded,
  hermiteSpline,
  mix,
  smoothstep,
  spline,
} from './noise';

/**
 * 大陸度 → 基準の高さ（m）。折れ点の平らな区間が平原と段を作り、
 * ゼロを跨ぐ位置が海陸比を決める。
 */
const SP_BASE: readonly (readonly [number, number, number])[] = [
  [-1.0, -58, 0],
  [-0.42, -30, 0],
  [-0.24, -7, 0],
  [-0.13, 3, 0],
  [0.04, 10, 0],
  [0.216, 16, 57],
  [0.442, 58, 174],
  [0.64, 90, 153],
  [1.0, 142, 134],
];

const baseHeight = (cont: number): number => hermiteSpline(SP_BASE, cont);

/** SP_BASE が海面を跨ぐ大陸度。島の輪郭（land = 0）をここに合わせる。 */
const COAST_CONT = -0.165;
/** 島の輪郭の値 1 あたりの大陸度。島の中心（land ≈ 1）で大陸度 0.8 前後になる。 */
const CONT_SPAN = 0.95;

/** 侵食度 → 起伏の振れ幅（m）。高いほど平ら。 */
const SP_RELIEF: readonly (readonly [number, number])[] = [
  [-1.0, 104],
  [-0.55, 68],
  [-0.28, 38],
  [-0.06, 13],
  [0.12, 5],
  [1.0, 4],
];

/**
 * 島のつまみから決まる係数。stroll の式はそのままに、ここだけを島ごとに変える。
 */
export interface ShapeConfig {
  /** 島の半径（島の一辺の半分に対する割合）。 */
  radius: number;
  /** 海岸線の入り組み。大きいほど入り江と沖の島が増える。 */
  coast: number;
  /** 山（丘陵・肩・山塊・峰）の高さの倍率。 */
  mountains: number;
  /** 谷の刻み（尾根と谷の起伏・細部）の倍率。 */
  relief: number;
}

// 高山は「広い丘陵 → 山地の肩と複数尾根 → 狭い峰」の順で作る。
// 狭い PEAK_SPIRE を主役にすると平地から一本だけ立つ針になる。
const PEAK_MASSIF = 100;
const PEAK_SPIRE = 32;
const UPLAND_RISE = 54;
const RUGGED_SHOULDER = 34;
const RUGGED_RIDGE = 24;
const RUGGED_CONT: [number, number] = [0.16, 0.5];
const RUGGED_ERO: [number, number] = [0, -0.54];
const RUGGED_PV: [number, number] = [-0.4, 0.66];
const PEAK_CONT: [number, number] = [0.38, 0.66];
const PEAK_ERO: [number, number] = [-0.42, -0.7];
const PEAK_PV: [number, number] = [0.15, 0.72];

/** 尾根と谷 → 起伏の中での高さの割合。左の平らな区間が歩ける谷底になる。 */
const SP_PV: readonly (readonly [number, number])[] = [
  [-1.0, -0.34],
  [-0.58, -0.34],
  [-0.22, -0.17],
  [0.3, 0.2],
  [1.0, 0.52],
];

// 海岸で起伏を抑えないと、海面線を何度も跨いでリアス式になる。
const COAST_FLAT_H = 12;
const COAST_FLAT_FLOOR = 0.15;

/**
 * 大陸度 → 起伏の効き方。低地は「歩く場所」として抑え、
 * 内陸は「見る場所」として山を立てる。
 */
const SP_RELIEF_GATE: readonly (readonly [number, number])[] = [
  [-1.0, 0.1],
  [-0.2, 0.2],
  [0.0, 0.3],
  [0.22, 0.44],
  [0.38, 1.0],
  [1.0, 1.0],
];

/** ねじれノイズを折り返して -1（谷底）〜 +1（稜線）にする。 */
function peaksValleys(w: number): number {
  return 1 - Math.abs(3 * Math.abs(w) - 2);
}

/**
 * domain warp。WARP_AMOUNT × WARP_FREQ × ノイズ勾配が 1 を超えると座標が
 * 折り返して指紋状になるので、振幅だけでなく勾配を守ること。
 */
const WARP_FREQ = 0.0007;
const WARP_AMOUNT = 170;

/**
 * 地域の性格。数 km の波長で「尖った岩峰の地域」と「丸く連なる丘陵の地域」を分ける。
 *
 * 以前は起伏の細部と尖った尾根が世界中に一律で掛かっていて、どの山も同じ
 * 岩峰になった。丘陵側では細部と峰を抑え、代わりに丸い高まりを置く。
 * 高さの帯（UPLAND・RUGGED・MASSIF）はそのままなので、陸の標高分布は大きく動かない。
 */
const STYLE_FREQ = 0.00022;
const ROLLING_DETAIL = 0.3;
const ROLLING_RIDGE = 0.35;
const ROLLING_SPIRE = 0.2;
const DOME_FREQ = 0.0021;
const DOME_HEIGHT = 30;

const BASE_JITTER_FREQ = 0.0004;
const BASE_JITTER_AMOUNT = 0.05;

// 連結したゼロ線を浅く彫る涸れ谷。深くすると海面固定の水が低地へ入り、
// 海岸が細切れになるため、川の水面を別に持つまでは 9m に保つ。
const RIVER_FREQ = 0.00055;
const RIVER_HALF = 62;
const RIVER_INNER = 0.25;
const RIVER_DEPTH = 9;

export const STEEPEST_RIVER_BANK =
  (1.5 * RIVER_DEPTH) / (RIVER_HALF * (1 - RIVER_INNER));

// 川の判定に使い回す。1 回ごとに配列を作らないため。
const RD = new Float32Array(3);

/**
 * 湖を入れる前の地形骨格。
 *
 * Terrain は水・気候・特殊区画を束ねる facade として残し、標高の全レイヤーは
 * このクラスへ集約する。湖は continentNoise / erosionNoise / baseHeightAt /
 * heightAt を使うため、同じ骨格を公開して二重実装を防ぐ。
 */
export class TerrainShape {
  readonly continentNoise: Noise2D;
  readonly erosionNoise: Noise2D;
  private readonly nRidge: Noise2D;
  private readonly nDetail: Noise2D;
  private readonly nWarp: Noise2D;
  private readonly nBaseJitter: Noise2D;
  private readonly nRiver: Noise2D;
  private readonly nStyle: Noise2D;
  private readonly nIslandWarp: Noise2D;

  constructor(
    a: number,
    b: number,
    c: number,
    d: number,
    private readonly config: ShapeConfig,
  ) {
    this.continentNoise = new Noise2D(a);
    this.erosionNoise = new Noise2D(b);
    this.nRidge = new Noise2D(c);
    this.nDetail = new Noise2D((a ^ 0x9e3779b9) >>> 0);
    this.nWarp = new Noise2D(d);
    this.nBaseJitter = new Noise2D((d ^ 0xa24baed5) >>> 0);
    this.nRiver = new Noise2D((a ^ 0x27220a95) >>> 0);
    this.nIslandWarp = new Noise2D((c ^ 0x7feb352d) >>> 0);
    this.nStyle = new Noise2D((b ^ 0x5851f42d) >>> 0);
  }

  /**
   * 大陸度。stroll では無限に続く大陸と海のノイズだったものを、1 つの島の形にする。
   * 島の中心で高く、海岸（COAST_CONT）を越えると海になる。輪郭は歪ませたうえで
   * 旧来の大陸度ノイズを足し、入り江と岬と沖の島を作る。島の一辺の縁は必ず海。
   */
  private continentalnessAt(x: number, z: number, octaves = 5): number {
    const half = ISLAND_SIZE / 2;
    const u = x / half;
    const v = z / half;
    const wu = u + this.nIslandWarp.noise(u * 1.3, v * 1.3) * 0.25;
    const wv = v + this.nIslandWarp.noise(u * 1.3 + 17.3, v * 1.3 - 9.1) * 0.25;
    const r = Math.sqrt(wu * wu + wv * wv);
    let land = 1 - r / this.config.radius + fbm(this.continentNoise, x, z, octaves, 0.00035) * this.config.coast;
    land -= smoothstep(0.82, 1.0, Math.sqrt(u * u + v * v)) * 2;
    return COAST_CONT + land * CONT_SPAN;
  }

  private erosionAt(x: number, z: number): number {
    return fbm(this.erosionNoise, x, z, 4, 0.0011);
  }

  private weirdnessAt(x: number, z: number): number {
    return fbm(this.nRidge, x, z, 4, 0.0028);
  }

  /**
   * 粗い山塊の高さ。雨陰専用なので細部・warp・谷・台地を省き、
   * 大陸 3 オクターブ、侵食 2 オクターブだけを見る。
   */
  readonly massAt = (x: number, z: number): number => {
    const cont = this.continentalnessAt(x, z, 3);
    const ero = fbm(this.erosionNoise, x, z, 2, 0.0011);
    return (
      this.baseHeightAt(x, z, cont) +
      spline(SP_RELIEF, ero) * spline(SP_RELIEF_GATE, cont) * 0.5
    );
  };

  /** 海岸線を固定したまま、内陸の標高帯だけを場所ごとにずらす。 */
  readonly baseHeightAt = (x: number, z: number, cont: number): number => {
    const inland = smoothstep(0.1, 0.28, cont);
    const jitter =
      this.nBaseJitter.noise(x * BASE_JITTER_FREQ, z * BASE_JITTER_FREQ) *
      BASE_JITTER_AMOUNT *
      inland;
    return baseHeight(cont + jitter);
  };

  /** 湖を入れる前の標高。 */
  readonly heightAt = (x: number, z: number): number => {
    // 大きくゆっくり座標をゆがめ、丸いノイズを蛇行する谷と尾根へ変える。
    const wx = x + this.nWarp.noise(x * WARP_FREQ, z * WARP_FREQ) * WARP_AMOUNT;
    const wz =
      z +
      this.nWarp.noise(x * WARP_FREQ + 137.2, z * WARP_FREQ - 91.7) * WARP_AMOUNT;

    const cont = this.continentalnessAt(x, z);
    const ero = this.erosionAt(wx, wz);
    const pv = peaksValleys(this.weirdnessAt(wx, wz));

    const base = this.baseHeightAt(x, z, cont);
    const coastFlat = mix(COAST_FLAT_FLOOR, 1, smoothstep(0, COAST_FLAT_H, base));
    const relief =
      spline(SP_RELIEF, ero) * spline(SP_RELIEF_GATE, cont) * coastFlat * this.config.relief;
    let h = base + spline(SP_PV, pv) * relief;
    const valley = smoothstep(-0.1, -0.72, pv);

    // 山塊には 2 オクターブの km 単位の骨格だけを使う。細部を混ぜると、
    // 100m ほどで山体が崩れて一点だけの針になる。
    const contBroad = this.continentalnessAt(x, z, 2);
    const eroBroad = fbm(this.erosionNoise, wx, wz, 2, 0.0011);
    const massif =
      smoothstep(PEAK_CONT[0], PEAK_CONT[1], contBroad) *
      smoothstep(PEAK_ERO[0], PEAK_ERO[1], eroBroad);
    const upland =
      smoothstep(0.08, 0.46, contBroad) *
      smoothstep(0.02, -0.5, eroBroad);
    const rugged =
      smoothstep(RUGGED_CONT[0], RUGGED_CONT[1], contBroad) *
      smoothstep(RUGGED_ERO[0], RUGGED_ERO[1], eroBroad);
    // 0 が岩峰の地域、1 が丘陵の地域。
    const rolling = smoothstep(
      -0.25,
      0.25,
      this.nStyle.noise(x * STYLE_FREQ, z * STYLE_FREQ),
    );
    const mt = this.config.mountains;
    h += upland * UPLAND_RISE * mt;
    h +=
      mt *
      rugged *
      (RUGGED_SHOULDER +
        smoothstep(RUGGED_PV[0], RUGGED_PV[1], pv) *
          RUGGED_RIDGE *
          mix(1, ROLLING_RIDGE, rolling));
    if (massif > 0) {
      h += massif * PEAK_MASSIF * mt;
      h +=
        mt *
        massif *
        smoothstep(PEAK_PV[0], PEAK_PV[1], pv) *
        PEAK_SPIRE *
        mix(1, ROLLING_SPIRE, rolling);
    }
    // 丘陵の丸い高まり。高地の上にだけ乗せ、低地と海岸には触らない。
    const hills = rolling * Math.max(upland, rugged);
    if (hills > 0) {
      const dome =
        this.nStyle.noise(wx * DOME_FREQ + 71.3, wz * DOME_FREQ - 29.1) * 0.5 +
        0.5;
      h += hills * dome * dome * DOME_HEIGHT;
    }

    // 谷底では細部を抑え、歩く面を常にがたつかせない。
    h +=
      fbmEroded(this.nDetail, wx, wz, 4, 0.0055) *
      relief *
      0.6 *
      mix(1, ROLLING_DETAIL, rolling) *
      (1 - valley * 0.82);

    // 専用ノイズのゼロ線までの距離で、連結した涸れ谷を彫る。
    fbmD(this.nRiver, x, z, 3, RIVER_FREQ, RD);
    const gradR = Math.hypot(RD[1], RD[2]);
    const toRiver = Math.abs(RD[0]) / Math.max(gradR, 1e-9);
    const calm = 1 - smoothstep(26, 62, relief);
    const river =
      smoothstep(RIVER_HALF, RIVER_HALF * RIVER_INNER, toRiver) *
      smoothstep(-0.04, 0.1, cont) *
      calm;
    if (river > 0) {
      h -= river * RIVER_DEPTH * mix(0.25, 1, smoothstep(2, 22, base));
    }

    return h;
  };
}
