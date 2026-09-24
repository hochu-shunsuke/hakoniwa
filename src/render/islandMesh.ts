import * as THREE from 'three';
import type { Island } from '../island/generate';
import { gridToWorld } from '../island/ground';
import { landColor } from '../view/palette';
import { RENDER_ORDER } from './order';

/**
 * 島の 3D。地形 1 枚と、湖・川の水面 1 枚。
 *
 * 地形は格子をそのまま三角形にする。四角形は (0,0)-(1,1) の対角線で割る
 * （ground.ts の高さの補間と同じ切り方）。面ごとの陰影（flatShading）で
 * stroll と同じローポリの見た目にする。
 */

const SEABED = new THREE.Color().setHex(0x3f6b6a, THREE.SRGBColorSpace);
const SEABED_DEEP = new THREE.Color().setHex(0x1f3d52, THREE.SRGBColorSpace);

export function buildTerrain(island: Island): THREE.BufferGeometry {
  const { n, cell, height, temperature, moisture } = island;
  const position = new Float32Array(n * n * 3);
  const color = new Float32Array(n * n * 3);
  const c = new Float32Array(3);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const h = height[k];
      position[k * 3] = gridToWorld(i, n);
      position[k * 3 + 1] = h;
      position[k * 3 + 2] = gridToWorld(j, n);

      if (h <= 0) {
        const deep = Math.min(1, -h / 60);
        c[0] = SEABED.r + (SEABED_DEEP.r - SEABED.r) * deep;
        c[1] = SEABED.g + (SEABED_DEEP.g - SEABED.g) * deep;
        c[2] = SEABED.b + (SEABED_DEEP.b - SEABED.b) * deep;
      } else {
        const hx = height[j * n + Math.min(n - 1, i + 1)] - height[j * n + Math.max(0, i - 1)];
        const hz = height[Math.min(n - 1, j + 1) * n + i] - height[Math.max(0, j - 1) * n + i];
        const slope = Math.sqrt(hx * hx + hz * hz) / (2 * cell);
        landColor(h, slope, temperature[k], moisture[k], c);
      }
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
      // (0,0)-(0,1)-(1,1) と (0,0)-(1,1)-(1,0)。ground.ts と同じ切り方。
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
 *
 * 水の無い角は、同じ四角形の水のある角の高さの平均に置く。水面は岸の下まで
 * 伸びて地形に隠れ、水際の線は地形との交わりで決まる（格子の階段にならない）。
 * 川は角ごとに高さが違うので、流れに沿って下る斜めの水面になる。
 */
export function buildWater(island: Island): THREE.BufferGeometry | null {
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

/** 格子の外に敷く海底の深さ（m）。格子の縁（ground.ts の OPEN_SEA）より少し下げて重ならないようにする。 */
const OUTER_SEABED = -80.5;

/** 島の 3D を 1 つにまとめる。作り直すときは dispose してから差し替える。 */
export class IslandMesh {
  readonly group = new THREE.Group();
  private terrain: THREE.Mesh | null = null;
  private water: THREE.Mesh | null = null;
  private readonly terrainMaterial = new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
  });

  constructor(private readonly waterMaterial: THREE.Material) {
    // 格子の外にも海底が無いと、島のまわりに格子の四角い境目が透けて見える。
    const seabed = new THREE.Mesh(
      new THREE.PlaneGeometry(80000, 80000).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: SEABED_DEEP }),
    );
    seabed.position.y = OUTER_SEABED;
    this.group.add(seabed);
  }

  set(island: Island): void {
    this.clear();
    this.terrain = new THREE.Mesh(buildTerrain(island), this.terrainMaterial);
    this.group.add(this.terrain);
    const waterGeo = buildWater(island);
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
