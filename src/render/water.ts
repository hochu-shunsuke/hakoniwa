import * as THREE from 'three';
import { SEA_LEVEL } from '../island/ground';
import { ISLAND_SIZE } from '../island/grid';
import { RENDER_ORDER } from './order';

const vert = /* glsl */ `
  varying vec3 vWorld;

  #include <fog_pars_vertex>

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;

    #include <fog_vertex>
  }
`;

/** 海の板の大きさと、三角形 1 枚の大きさ（m）。 */
const SEA_SIZE = 80000;
const SEA_CELL = 400;

const frag = /* glsl */ `
  uniform float uTime;
  uniform vec3 uShallow;
  uniform vec3 uMid;
  uniform vec3 uDeep;
  uniform vec3 uSkyColor;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  uniform sampler2D uHeightMap;
  uniform float uHeightN;
  uniform float uIslandSize;
  varying vec3 vWorld;

  #include <fog_pars_fragment>

  // 向きと速さの違う波を重ね、周期が読めないようにする。
  float waveHeight(vec2 p) {
    float h = 0.0;
    h += sin(dot(p, vec2(0.062, 0.031)) + uTime * 0.55) * 0.55;
    h += sin(dot(p, vec2(-0.041, 0.074)) + uTime * 0.42) * 0.45;
    h += sin(dot(p, vec2(0.121, -0.096)) + uTime * 0.83) * 0.20;
    h += sin(dot(p, vec2(0.198, 0.164)) + uTime * 1.15) * 0.10;
    return h;
  }

  // 島の大きな形の高さ（m）。格子の 4 点を読んで双一次で補間する（浮動小数のテクスチャは
  // 端末によって線形補間できないため、自分で混ぜる）。島の外は外洋の深さ。
  float groundAt(vec2 xz) {
    if (uHeightN < 2.0) return -70.0;
    vec2 g = (xz / uIslandSize + 0.5) * (uHeightN - 1.0);
    if (g.x < 0.0 || g.y < 0.0 || g.x > uHeightN - 1.0 || g.y > uHeightN - 1.0) return -70.0;
    vec2 i = min(floor(g), vec2(uHeightN - 2.0));
    vec2 f = g - i;
    ivec2 c = ivec2(i);
    float a = texelFetch(uHeightMap, c, 0).r;
    float b = texelFetch(uHeightMap, c + ivec2(1, 0), 0).r;
    float d = texelFetch(uHeightMap, c + ivec2(0, 1), 0).r;
    float e = texelFetch(uHeightMap, c + ivec2(1, 1), 0).r;
    return mix(mix(a, b, f.x), mix(d, e, f.x), f.y);
  }

  // 泡の粒。小さい座標だけで引く（スマホ GPU の精度でも崩れないように）。
  float hash12(vec2 p) {
    p = mod(p, 97.0);
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
               mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  void main() {
    vec2 p = vWorld.xz;

    // 高さ場の差分から法線を作る。細かいさざ波はここだけで表現する。
    float e = 1.2;
    float hx = waveHeight(p + vec2(e, 0.0)) - waveHeight(p - vec2(e, 0.0));
    float hz = waveHeight(p + vec2(0.0, e)) - waveHeight(p - vec2(0.0, e));
    vec3 n = normalize(vec3(-hx * 0.55, 1.0, -hz * 0.55));

    vec3 viewDir = normalize(cameraPosition - vWorld);
    float facing = clamp(dot(n, viewDir), 0.0, 1.0);
    float fres = pow(1.0 - facing, 3.0);

    // 水深で色を変える。浅瀬は明るいエメラルドで底が透け、深みは濃い青に沈む。
    float depth = max(0.0, vWorld.y - groundAt(p));
    vec3 body = mix(uShallow, uMid, smoothstep(0.4, 7.0, depth));
    body = mix(body, uDeep, smoothstep(7.0, 45.0, depth));
    body *= mix(0.85, 1.0, facing);
    vec3 col = mix(body, uSkyColor, clamp(fres * 1.1, 0.0, 0.85));

    // 太陽の細い帯。穏やかさを壊さない程度に。
    vec3 h = normalize(uSunDir + viewDir);
    float spec = pow(max(dot(n, h), 0.0), 220.0);
    col += uSunColor * spec * 1.6;

    // 波打ち際の泡: 水際から少し沖（水深 0.1〜1.3m）の帯と、岸へ寄せてくる白波の筋。
    // 水深 0 のちょうど上に置くと、地面との描き合いで泡ごとちらつく。
    float grain = vnoise(p * 0.18 + vec2(uTime * 0.25, -uTime * 0.18));
    float band = smoothstep(0.08, 0.3, depth) * (1.0 - smoothstep(0.7 + grain * 0.6, 1.4 + grain * 0.6, depth));
    float surf = sin(depth * 2.6 - uTime * 1.3 + grain * 3.0);
    float lines = smoothstep(0.78, 0.97, surf) * smoothstep(0.3, 0.8, depth) * (1.0 - smoothstep(0.8, 3.2, depth));
    float foam = clamp(max(band * (0.55 + 0.45 * grain), lines * 0.55), 0.0, 1.0);
    col = mix(col, vec3(0.95, 0.97, 0.98), foam * 0.85);

    // 浅いほど透けて底が見える。深い所と、斜めから見た所は映り込みで不透明に近づく。
    float alpha = mix(0.45, 0.94, smoothstep(0.3, 10.0, depth));
    alpha = max(alpha, fres * 0.95);
    alpha = max(alpha, foam * 0.9);
    // 水深 0 に近づくほど透明にする。水面と地面の深度がほぼ同じ帯は、どちらが手前か
    // 描くたびに入れ替わる。そこで水を消しておけば、ちらつきが見えない。
    alpha *= smoothstep(0.0, 0.12, depth);
    gl_FragColor = vec4(col, alpha);

    // three の標準マテリアルと同じ順序。霧の色は出力色空間で渡ってくるため最後。
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

function col(hex: number): THREE.Color {
  return new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
}

/**
 * 海面と湖面。1 枚の大きな面をカメラに追従させて無限に見せる。
 * 波は法線だけで作るので、面の分割は粗くてよい。
 */
/**
 * 水の材質。海の板と、チャンクごとの内陸水面（湖）が**同じものを共有する**。
 *
 * 別々に作ると、波・色・透明度・描画順のどれかがいつかずれる。
 * この材質は頂点の世界座標だけから波と映り込みを作るので、
 * カメラ追従の板でも、湖の形をした三角形でも、そのまま動く。
 */
let shared: THREE.ShaderMaterial | null = null;

export function waterMaterial(
  sunDirection: THREE.Vector3,
  skyHorizon: number,
  sunHex: number,
): THREE.ShaderMaterial {
  if (!shared) {
    shared = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        // 浅瀬のエメラルド → 中くらいの青緑 → 深い青。
        uShallow: { value: col(0x5fd3c4) },
        uMid: { value: col(0x1f9bb0) },
        uDeep: { value: col(0x1a4f7c) },
        // 島の大きな形の高さ（水深を求める）。島ができるまでは空で、全部を深い海として描く。
        uHeightMap: { value: null as THREE.Texture | null },
        uHeightN: { value: 0 },
        uIslandSize: { value: ISLAND_SIZE },
        uSkyColor: { value: col(skyHorizon) },
        uSunColor: { value: col(sunHex) },
        uSunDir: { value: sunDirection.clone() },
        ...THREE.UniformsLib.fog,
      },
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
      // **深度をずらす補正（polygonOffset）は使わない。** stroll では水際のちらつきを
      // 抑えるため水を奥へずらしていたが、ずらし量は斜めから見るほど大きくなる。
      // 広い海の板を見渡すと数 m ぶん奥へずれ、水深 1〜5m の浅瀬の海底が水面を
      // 突き抜けてちらついた（利用者の指摘）。代わりにシェーダーが自分の下の水深を知り、
      // 水深 0 に近づくほど透明にして、水と地面が描き合う帯そのものを見えなくする。
    });
  }
  return shared;
}

/** 時間を進める。材質を共有しているので、呼ぶのは 1 か所でよい。 */
export function updateWaterTime(elapsed: number): void {
  if (shared) shared.uniforms.uTime.value = elapsed;
}

export class Water {
  /** チャンクごとの内陸水面（湖）も同じものを使う。 */
  readonly material: THREE.ShaderMaterial;
  private mesh: THREE.Mesh;

  constructor(scene: THREE.Scene, sunDirection: THREE.Vector3, skyHorizon: number, sunHex: number) {
    this.material = waterMaterial(sunDirection, skyHorizon, sunHex);

    // 島を遠くから見渡しても海が切れないよう、霧で消える距離より十分大きく取る。
    // **1 枚の巨大な三角形にしないこと。** 80km の三角形 2 枚では画素ごとの深度の補間誤差が
    // 大きく、浅瀬で水面と海底の勝ち負けが揺れた。SEA_CELL 四方の三角形に分ける。
    const segments = Math.round(SEA_SIZE / SEA_CELL);
    const geo = new THREE.PlaneGeometry(SEA_SIZE, SEA_SIZE, segments, segments);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.position.y = SEA_LEVEL;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = RENDER_ORDER.water;
    scene.add(this.mesh);
  }

  /** 島の大きな形の高さを渡す（水深で色と泡を変えるため）。島を作り直すたびに呼ぶ。 */
  setHeightMap(height: Float32Array, n: number): void {
    const u = this.material.uniforms;
    (u.uHeightMap.value as THREE.Texture | null)?.dispose();
    const tex = new THREE.DataTexture(height, n, n, THREE.RedFormat, THREE.FloatType);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    u.uHeightMap.value = tex;
    u.uHeightN.value = n;
  }

  update(camera: THREE.Camera, elapsed: number): void {
    updateWaterTime(elapsed);
    // 波は世界座標で計算しているので、面をずらしても模様は動かない。
    // 三角形の大きさの刻みでだけ動かす。少しずつ動かすと、三角形の中の深度の誤差の出方が
    // 毎フレーム変わり、動いている間だけ水際がガタついた（止まると直った）。
    this.mesh.position.x = Math.round(camera.position.x / SEA_CELL) * SEA_CELL;
    this.mesh.position.z = Math.round(camera.position.z / SEA_CELL) * SEA_CELL;
  }

}
