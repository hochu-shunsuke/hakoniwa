import * as THREE from 'three';
import type { Island } from '../island/generate';
import { gridToWorld } from '../island/ground';
import { CHUNK_SIZE } from '../world/chunk';
import { SURFACE_STRIDE } from '../world/islandSurface';
import { type Terrain, splitsAlongMainDiagonal } from '../world/terrain';
import { COVERAGE_OFFSET, COVERAGE_SIZE } from './chunkManager';
import { RENDER_ORDER } from './order';
import { createTerrainMaterial } from './terrainMaterial';

/**
 * 島全体を 1 枚で描く（12m 格子）。「つくる」で見渡す島であり、飛んでいる間の遠景でもある。
 *
 * 地面の色は近くのチャンクと同じ Terrain.shade（stroll の気候帯の色）。
 * 飛んでいる間は、近くのチャンクができている所を描かない（coverage）。
 * 重ねて描くと 2 枚の地面が深度を奪い合ってチラつき、消すと読み込み中に穴が開くため。
 */

const SEABED_DEEP = new THREE.Color().setHex(0x1f3d52, THREE.SRGBColorSpace);
/** 格子の外に敷く海底の深さ（m）。島の縁の海の深さより少し下げて重ならないようにする。 */
const OUTER_SEABED = -80.5;

interface CoverageUniforms {
  uCoverage: { value: THREE.Texture | null };
  uCoverageOn: { value: number };
  /** チャンクを作っている島の中心（世界座標）。coverage の番号はここから数える。 */
  uCoverageOrigin: { value: THREE.Vector2 };
}

const COVERAGE_GLSL = /* glsl */ `
  uniform sampler2D uCoverage;
  uniform float uCoverageOn;
  uniform vec2 uCoverageOrigin;
  bool coveredByChunk(vec2 xz) {
    if (uCoverageOn < 0.5) return false;
    vec2 c = floor((xz - uCoverageOrigin) / ${CHUNK_SIZE.toFixed(1)}) + ${COVERAGE_OFFSET.toFixed(1)};
    if (c.x < 0.0 || c.y < 0.0 || c.x >= ${COVERAGE_SIZE.toFixed(1)} || c.y >= ${COVERAGE_SIZE.toFixed(1)}) return false;
    return texture2D(uCoverage, (c + 0.5) / ${COVERAGE_SIZE.toFixed(1)}).r > 0.25;
  }
`;

/** 見渡す島の地面。step 点ごとに間引いた格子で作る（1 で島の格子そのもの）。 */
export function buildOverviewTerrain(island: Island, terrain: Terrain, step = 1): THREE.BufferGeometry {
  const { n, cell, height, temperature, moisture } = island;
  const m = Math.floor((n - 1) / step) + 1;
  const count = m * m;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const color = new Float32Array(count * 3);
  const rock = new Float32Array(count * 3);
  const surf = new Float32Array(count * 3);
  const layers = new Float32Array(SURFACE_STRIDE);
  const at = (i: number, j: number) =>
    height[Math.max(0, Math.min(n - 1, j)) * n + Math.max(0, Math.min(n - 1, i))];
  const span = cell * step;
  for (let b = 0; b < m; b++) {
    const j = Math.min(n - 1, b * step);
    const z = gridToWorld(j, n);
    for (let a = 0; a < m; a++) {
      const i = Math.min(n - 1, a * step);
      const k = j * n + i;
      const v = b * m + a;
      const x = gridToWorld(i, n);
      const h = height[k];
      position[v * 3] = x;
      position[v * 3 + 1] = h;
      position[v * 3 + 2] = z;
      // 法線と傾きは chunk.ts と同じ中心差分で取る（間引いた間隔で）。
      const dx = (at(i + step, j) - at(i - step, j)) / (2 * span);
      const dz = (at(i, j + step) - at(i, j - step)) / (2 * span);
      const len = Math.sqrt(dx * dx + 1 + dz * dz);
      normal[v * 3] = -dx / len;
      normal[v * 3 + 1] = 1 / len;
      normal[v * 3 + 2] = -dz / len;
      const slope = Math.min(1, Math.sqrt(dx * dx + dz * dz));
      terrain.surface(x, z, h, slope, temperature[k], moisture[k], terrain.specialAt(x, z), terrain.patchAt(x, z), layers, 0);
      for (let c = 0; c < 3; c++) {
        color[v * 3 + c] = layers[c];
        rock[v * 3 + c] = layers[3 + c];
        surf[v * 3 + c] = layers[6 + c];
      }
    }
  }

  const index = new Uint32Array((m - 1) * (m - 1) * 6);
  let o = 0;
  for (let b = 0; b < m - 1; b++) {
    for (let a = 0; a < m - 1; a++) {
      const v00 = b * m + a;
      const v10 = v00 + 1;
      const v01 = v00 + m;
      const v11 = v01 + 1;
      // チャンクと同じ割り方（高低差の小さい対角線）。
      if (splitsAlongMainDiagonal(position[v00 * 3 + 1], position[v10 * 3 + 1], position[v01 * 3 + 1], position[v11 * 3 + 1])) {
        index[o++] = v00;
        index[o++] = v01;
        index[o++] = v11;
        index[o++] = v00;
        index[o++] = v11;
        index[o++] = v10;
      } else {
        index[o++] = v00;
        index[o++] = v01;
        index[o++] = v10;
        index[o++] = v01;
        index[o++] = v11;
        index[o++] = v10;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
  geo.setAttribute('rock', new THREE.BufferAttribute(rock, 3));
  geo.setAttribute('surf', new THREE.BufferAttribute(surf, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeBoundingSphere();
  return geo;
}

/**
 * 湖と川の水面。水のある格子に角が 1 つでも触れる四角形に張る。
 * 水の無い角は、同じ四角形の水のある角の高さの平均に置く。水面は岸の下まで伸びて
 * 地形に隠れ、水際の線は地形との交わりで決まる。川は下流へ下る斜めの水面になる。
 */
export function buildOverviewWater(island: Island): THREE.BufferGeometry | null {
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
  if (pos.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.computeBoundingSphere();
  return geo;
}

/** 島全体の 1 枚と、その水面。飛んでいる間は近くのチャンクの所を描かない。 */
export class OverviewMesh {
  readonly group = new THREE.Group();
  private terrain: THREE.Mesh | null = null;
  private water: THREE.Mesh | null = null;
  private readonly uniforms: CoverageUniforms = {
    uCoverage: { value: null },
    uCoverageOn: { value: 0 },
    uCoverageOrigin: { value: new THREE.Vector2() },
  };
  private readonly terrainMaterial: THREE.MeshLambertMaterial;
  private readonly waterMaterial: THREE.ShaderMaterial;

  /**
   * step は見渡す島の格子を何点ごとに使うか。1 で約 5m。群島のように島を何個も描くときは
   * 粗くして三角形を減らす（近くはチャンクが描く）。seabed は格子の外に海底を敷くか
   * （群島では全体に 1 枚だけ敷く）。
   */
  constructor(
    sharedWater: THREE.ShaderMaterial,
    private readonly options: { step?: number; seabed?: boolean } = {},
  ) {
    this.terrainMaterial = createTerrainMaterial({
      uniforms: this.uniforms as unknown as Record<string, THREE.IUniform>,
      fragmentPars: COVERAGE_GLSL,
      fragmentStart: '  if (coveredByChunk(vTerrainPos.xz)) discard;',
      cacheKey: 'overview',
    });

    // 水の材質は海・近くの川と共有しているので、遠景の水面だけ複製して「描かない所」を足す。
    this.waterMaterial = sharedWater.clone();
    this.waterMaterial.uniforms = { ...sharedWater.uniforms, ...this.uniforms };
    this.waterMaterial.fragmentShader = sharedWater.fragmentShader
      .replace('varying vec3 vWorld;', `varying vec3 vWorld;\n${COVERAGE_GLSL}`)
      .replace('void main() {', 'void main() {\n    if (coveredByChunk(vWorld.xz)) discard;');

    // 格子の外にも海底が無いと、島のまわりに格子の四角い境目が透けて見える。
    if (options.seabed !== false) this.group.add(outerSeabed());
  }

  /** 飛んでいる間は、近くのチャンクができている所を描かない。null で全部描く。 */
  setCoverage(texture: THREE.Texture | null, originX = 0, originZ = 0): void {
    this.uniforms.uCoverage.value = texture;
    this.uniforms.uCoverageOn.value = texture ? 1 : 0;
    this.uniforms.uCoverageOrigin.value.set(originX, originZ);
  }

  /** step を渡すと、この島だけ間引き方を変える（下見の粗い島は間引かない、など）。 */
  set(island: Island, terrain: Terrain, step = this.options.step ?? 1): void {
    this.clear();
    this.terrain = new THREE.Mesh(buildOverviewTerrain(island, terrain, step), this.terrainMaterial);
    this.group.add(this.terrain);
    const waterGeo = buildOverviewWater(island);
    if (waterGeo) {
      this.water = new THREE.Mesh(waterGeo, this.waterMaterial);
      this.water.renderOrder = RENDER_ORDER.water;
      this.group.add(this.water);
    }
  }

  private clear(): void {
    for (const mesh of [this.terrain, this.water]) {
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this.terrain = null;
    this.water = null;
  }
}

/** 格子の外に敷く海底（巨大な三角形 2 枚にすると深度の補間誤差が大きいので、400m 四方に分ける）。 */
export function outerSeabed(): THREE.Mesh {
  const seabed = new THREE.Mesh(
    new THREE.PlaneGeometry(80000, 80000, 200, 200).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: SEABED_DEEP }),
  );
  seabed.position.y = OUTER_SEABED;
  return seabed;
}
