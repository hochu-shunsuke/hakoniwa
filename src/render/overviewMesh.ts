import * as THREE from 'three';
import type { Island } from '../island/generate';
import { gridToWorld } from '../island/ground';
import { CHUNK_SIZE } from '../world/chunk';
import type { Terrain } from '../world/terrain';
import { COVERAGE_OFFSET, COVERAGE_SIZE } from './chunkManager';
import { RENDER_ORDER } from './order';

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
}

const COVERAGE_GLSL = /* glsl */ `
  uniform sampler2D uCoverage;
  uniform float uCoverageOn;
  bool coveredByChunk(vec2 xz) {
    if (uCoverageOn < 0.5) return false;
    vec2 c = floor(xz / ${CHUNK_SIZE.toFixed(1)}) + ${COVERAGE_OFFSET.toFixed(1)};
    if (c.x < 0.0 || c.y < 0.0 || c.x >= ${COVERAGE_SIZE.toFixed(1)} || c.y >= ${COVERAGE_SIZE.toFixed(1)}) return false;
    return texture2D(uCoverage, (c + 0.5) / ${COVERAGE_SIZE.toFixed(1)}).r > 0.25;
  }
`;

export function buildOverviewTerrain(island: Island, terrain: Terrain): THREE.BufferGeometry {
  const { n, cell, height, temperature, moisture } = island;
  const position = new Float32Array(n * n * 3);
  const color = new Float32Array(n * n * 3);
  const c = new Float32Array(3);
  for (let j = 0; j < n; j++) {
    const z = gridToWorld(j, n);
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const x = gridToWorld(i, n);
      const h = height[k];
      position[k * 3] = x;
      position[k * 3 + 1] = h;
      position[k * 3 + 2] = z;
      // 傾きは chunk.ts と同じ「四角形の高低差 ÷ 対角」で測る。
      const i1 = Math.min(n - 1, i + 1);
      const j1 = Math.min(n - 1, j + 1);
      const hs = [h, height[j * n + i1], height[j1 * n + i], height[j1 * n + i1]];
      const slope = Math.min(1, (Math.max(...hs) - Math.min(...hs)) / (cell * 1.4142));
      terrain.shade(x, z, h, slope, temperature[k], moisture[k], terrain.specialAt(x, z), terrain.patchAt(x, z), c, 0);
      color[k * 3] = c[0];
      color[k * 3 + 1] = c[1];
      color[k * 3 + 2] = c[2];
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
      index[o++] = a;
      index[o++] = d;
      index[o++] = e;
      index[o++] = a;
      index[o++] = e;
      index[o++] = b;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeVertexNormals();
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
  };
  private readonly terrainMaterial: THREE.MeshLambertMaterial;
  private readonly waterMaterial: THREE.ShaderMaterial;

  constructor(sharedWater: THREE.ShaderMaterial) {
    this.terrainMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.terrainMaterial.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vOverviewXZ;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvOverviewXZ = (modelMatrix * vec4(transformed, 1.0)).xz;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec2 vOverviewXZ;\n${COVERAGE_GLSL}`)
        .replace('void main() {', 'void main() {\n  if (coveredByChunk(vOverviewXZ)) discard;');
    };

    // 水の材質は海・近くの川と共有しているので、遠景の水面だけ複製して「描かない所」を足す。
    this.waterMaterial = sharedWater.clone();
    this.waterMaterial.uniforms = { ...sharedWater.uniforms, ...this.uniforms };
    this.waterMaterial.fragmentShader = sharedWater.fragmentShader
      .replace('varying vec3 vWorld;', `varying vec3 vWorld;\n${COVERAGE_GLSL}`)
      .replace('void main() {', 'void main() {\n    if (coveredByChunk(vWorld.xz)) discard;');

    // 格子の外にも海底が無いと、島のまわりに格子の四角い境目が透けて見える。
    const seabed = new THREE.Mesh(
      new THREE.PlaneGeometry(80000, 80000).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: SEABED_DEEP }),
    );
    seabed.position.y = OUTER_SEABED;
    this.group.add(seabed);
  }

  /** 飛んでいる間は、近くのチャンクができている所を描かない。null で全部描く。 */
  setCoverage(texture: THREE.Texture | null): void {
    this.uniforms.uCoverage.value = texture;
    this.uniforms.uCoverageOn.value = texture ? 1 : 0;
  }

  set(island: Island, terrain: Terrain): void {
    this.clear();
    this.terrain = new THREE.Mesh(buildOverviewTerrain(island, terrain), this.terrainMaterial);
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
