import { hashSeed } from '../core/rng';
import type { IslandParams } from '../island/params';
import { Climate } from './climate';
import type { IslandWater } from './islandWater';
import { Noise2D, clamp, mix } from './noise';
import { type SpecialHit, specialAt } from './special';
import { shadeTerrain } from './surfaceShade';
import { type ShapeConfig, TerrainShape } from './terrainShape';

export const SEA_LEVEL = 0;

/**
 * 四角形をどちらの対角線で 2 つの三角形に割るか。true なら h00-h11。
 *
 * chunk.ts と heightOnGrid は必ずこの同じ関数を使う。高低差が小さい方を
 * 選ぶことで遠景の山肌に同じ向きの斜め縞が出るのを防ぐ。
 */
export function splitsAlongMainDiagonal(
  h00: number,
  h10: number,
  h01: number,
  h11: number,
): boolean {
  return Math.abs(h00 - h11) <= Math.abs(h01 - h10);
}

/** つまみ（0..100）→ stroll の式の係数。 */
export function shapeConfig(p: IslandParams): ShapeConfig {
  return {
    radius: mix(0.34, 0.8, p.size / 100),
    coast: mix(0.25, 0.95, p.shape / 100),
    mountains: mix(0.25, 2.2, p.mountains / 100),
    relief: mix(0.45, 1.6, p.erosion / 100),
  };
}

/**
 * 島の地形の公開窓口。stroll の Terrain と同じ API（描画・植生・プレイヤーはこれだけを見る）。
 *
 * 標高は stroll の式（terrainShape.ts）を島の形にしたもの。湖と川は島全体の格子で
 * 求めた水（islandWater.ts）を重ねる。水を渡さなければ、水を計算する前の地形になる
 * （島全体の水を求めるときに使う）。
 */
export class Terrain {
  readonly params: IslandParams;
  private readonly shape: TerrainShape;
  private readonly climate: Climate;
  private readonly nSpecialEdge: Noise2D;
  private readonly specialSalt: number;
  private readonly nPatch: Noise2D;
  private readonly moistureBias: number;
  private readonly warmthBias: number;

  constructor(
    params: IslandParams,
    private readonly water: IslandWater | null = null,
  ) {
    this.params = params;
    const [a, b, c, d] = hashSeed(params.seed);
    this.shape = new TerrainShape(a, b, c, d, shapeConfig(params));
    this.climate = new Climate(a, b, c, d, this.shape.massAt);
    // 区画抽選にもシードを混ぜる。忘れると全部の島で宝物の位置が同じになる。
    this.nSpecialEdge = new Noise2D((a ^ 0x165667b1) >>> 0);
    this.specialSalt = (b ^ 0x9e3779b1) >>> 0;
    this.nPatch = new Noise2D((d ^ 0x61c88647) >>> 0);
    this.moistureBias = mix(-0.3, 0.3, params.wetness / 100);
    this.warmthBias = mix(-0.35, 0.35, params.warmth / 100);
  }

  /**
   * 地面のむら -1..1。数十 m の波長で、草の色味と雪線・岩線の位置を揺らす。
   * 色にしか使わないので標高・植生の配置には影響しない。
   */
  patchAt(x: number, z: number): number {
    return (
      this.nPatch.noise(x * 0.011, z * 0.011) * 0.65 +
      this.nPatch.noise(x * 0.037 + 31.7, z * 0.037 - 17.3) * 0.35
    );
  }

  /** 宝物区画の判定。詳しくは special.ts。 */
  specialAt(x: number, z: number): SpecialHit {
    return specialAt(x, z, this.nSpecialEdge, this.specialSalt);
  }

  /** 森のかたまり 0..1.4。植生の密度に掛ける。 */
  groveAt(x: number, z: number): number {
    return this.climate.groveAt(x, z);
  }

  /** 湿り気 0..1。独立ノイズへ山塊による雨陰を重ね、湿り気のつまみでずらす。 */
  moistureAt(x: number, z: number): number {
    return clamp(this.climate.moistureAt(x, z) + this.moistureBias, 0, 1);
  }

  /** 気温 0..1（0 が寒い、1 が暑い）。標高が上がるほど冷え、暖かさのつまみでずらす。 */
  temperatureAt(x: number, z: number, h: number): number {
    return clamp(this.climate.temperatureAt(x, z, h) + this.warmthBias, 0, 1);
  }

  /** 内陸の水面（湖・川）。無ければ -Infinity。海は render/water.ts の板が担当する。 */
  waterLevelAt(x: number, z: number): number {
    return this.water ? this.water.levelAt(x, z) : -Infinity;
  }

  /** 標高。海面は 0。川に合わせて彫った量を足す。 */
  heightAt(x: number, z: number): number {
    const h = this.shape.heightAt(x, z);
    return this.water ? h + this.water.carveAt(x, z) : h;
  }

  /**
   * チャンクメッシュと同じ三角形分割で標高を補間する。
   * プレイヤーの足元が見た目の地面とズレないようにするため。
   */
  heightOnGrid(x: number, z: number, step: number): number {
    const x0 = Math.floor(x / step) * step;
    const z0 = Math.floor(z / step) * step;
    const u = (x - x0) / step;
    const v = (z - z0) / step;

    const h00 = this.heightAt(x0, z0);
    const h10 = this.heightAt(x0 + step, z0);
    const h01 = this.heightAt(x0, z0 + step);
    const h11 = this.heightAt(x0 + step, z0 + step);

    if (splitsAlongMainDiagonal(h00, h10, h01, h11)) {
      if (v >= u) return h00 * (1 - v) + h01 * (v - u) + h11 * u;
      return h00 * (1 - u) + h10 * (u - v) + h11 * v;
    }
    if (u + v <= 1) return h00 * (1 - u - v) + h01 * v + h10 * u;
    return h01 * (1 - u) + h10 * (1 - v) + h11 * (u + v - 1);
  }

  /**
   * 面の色。気温 × 湿り気へ標高・傾き・特殊区画の効果を重ねる。
   * out に 0..1 のリニア RGB を書き込む。
   */
  shade(
    h: number,
    slope: number,
    temp: number,
    moisture: number,
    special: SpecialHit,
    patch: number,
    out: Float32Array,
    o: number,
  ): void {
    shadeTerrain(h, slope, temp, moisture, special, patch, out, o);
  }
}
