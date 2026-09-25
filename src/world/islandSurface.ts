import { clamp, mix, smoothstep } from './noise';
import type { SurfaceFields } from './islandShape';
import { SPECIAL_BIOMES, type SpecialHit, srgb } from './special';

/**
 * 島の地面の色。stroll の気候帯の色（気温 3 段 × 湿り気 3 段）を土台に、
 * **侵食が作った地形の性質**で塗り分ける。
 *
 * stroll では「急なら岩」の 1 本の規則だったので、山の斜面がどこも同じ茶色になった
 * （利用者の指摘）。ここでは次を効かせる。
 *   - 谷筋（曲がりが負・水が集まる）: 湿って緑が濃い。雪も溜まる
 *   - 尾根（曲がりが正）: 乾いて明るい。岩が出やすく、雪は飛ばされる
 *   - 乾いた斜面は低木と枯れ草の色、湿った斜面は緑のまま急な所まで上がる
 *   - 岩は地方ごとに種類が違う（灰色の花崗岩・赤みの砂岩・黒い玄武岩・白っぽい石灰岩）。地層の縞も入る
 *   - 崖の下の緩んだ所には崖錐（明るい礫）
 *
 * 傾きは大きな地形（16m）のものを主に使う。細部（2m）の傾きで切り替えると、
 * 雪と岩が四角いドットの模様になった。表示専用なので決定性の決まりの外（三角関数を使ってよい）。
 */

const C_SAND = srgb(0xd8c79c);
const C_SNOW = srgb(0xeef2f4);
const C_SCRUB = srgb(0x8a8052);
const C_DRY = srgb(0xbcae78);
const C_LUSH = srgb(0x3c6a3a);
const C_SCREE = srgb(0x9d988c);
/** 水の中の地面。浅瀬は砂が透けて見え、深くなるほど青緑に沈む。 */
const C_SEABED = srgb(0x2f5b5c);

/** 岩の種類。[明るい面, 暗い面]。rockTone（-1..1）で地方ごとに混ぜる。 */
const ROCKS: readonly (readonly [readonly number[], readonly number[]])[] = [
  [srgb(0x93918b), srgb(0x62615d)], // 花崗岩
  [srgb(0xab7c5d), srgb(0x75503d)], // 砂岩
  [srgb(0x5e5956), srgb(0x3b3735)], // 玄武岩
  [srgb(0xbfb8a7), srgb(0x8f887a)], // 石灰岩
];

const TEMP_STOPS = [0.14, 0.45, 0.76] as const;
const MOIST_STOPS = [0.15, 0.42, 0.66] as const;
const CLIMATE = [
  srgb(0x87958d), // 寒・乾: ツンドラ
  srgb(0xb4b56d), // 温・乾: 乾いた草原
  srgb(0xd5bd82), // 暑・乾: 砂漠
  srgb(0x58756b), // 寒・中: タイガ
  srgb(0x6f9850), // 温・中: 森
  srgb(0xb8974e), // 暑・中: サバンナ
  C_SNOW, //         寒・湿: 雪
  srgb(0x427744), // 温・湿: 深い森
  srgb(0x3f8e42), // 暑・湿: 密林
] as const;

function segment(stops: readonly number[], t: number): [number, number] {
  if (t <= stops[1]) return [0, smoothstep(stops[0], stops[1], t)];
  return [1, smoothstep(stops[1], stops[2], t)];
}

const RGB = new Float32Array(3);

function blend(target: ArrayLike<number>, t: number): void {
  if (t <= 0) return;
  RGB[0] = mix(RGB[0], target[0], t);
  RGB[1] = mix(RGB[1], target[1], t);
  RGB[2] = mix(RGB[2], target[2], t);
}

/** rockTone（-1..1）から岩の明るい面・暗い面を混ぜて RGB に書く。 */
function rockColor(rockTone: number, dark: number, out: Float32Array): void {
  // -1..1 を 4 種類の間の位置 0..3 に。
  const pos = clamp((rockTone * 0.5 + 0.5) * 3, 0, 3);
  const a = Math.min(2, pos | 0);
  const t = smoothstep(0, 1, pos - a);
  for (let c = 0; c < 3; c++) {
    const light = mix(ROCKS[a][0][c], ROCKS[a + 1][0][c], t);
    const shadow = mix(ROCKS[a][1][c], ROCKS[a + 1][1][c], t);
    out[c] = mix(light, shadow, dark);
  }
}

const ROCK = new Float32Array(3);

export function shadeIsland(
  h: number,
  slopeLocal: number,
  f: SurfaceFields,
  temp: number,
  moisture: number,
  special: SpecialHit,
  patch: number,
  rockTone: number,
  out: Float32Array,
  o: number,
): void {
  // 気候帯の地面色。
  const [ti, tk] = segment(TEMP_STOPS, temp);
  const [mi, mk] = segment(MOIST_STOPS, moisture);
  const c0 = mi * 3 + ti;
  for (let c = 0; c < 3; c++) {
    RGB[c] = mix(
      mix(CLIMATE[c0][c], CLIMATE[c0 + 1][c], tk),
      mix(CLIMATE[c0 + 3][c], CLIMATE[c0 + 4][c], tk),
      mk,
    );
  }
  // 草地のむら。明るい側は少し黄みへ、暗い側は少し青みへ。
  RGB[0] *= 1 + patch * 0.08;
  RGB[1] *= 1 + patch * 0.07;
  RGB[2] *= 1 - patch * 0.04;

  if (special.index >= 0) blend(SPECIAL_BIOMES[special.index].ground, special.strength);

  const slope = f.slope;
  const ridge = smoothstep(0.015, 0.12, f.curvature);
  const gully = Math.max(smoothstep(0.015, 0.14, -f.curvature), smoothstep(0.35, 0.8, f.drainage));
  const wet = clamp(moisture * 0.85 + gully * 0.3, 0, 1);

  // 斜面の植生: 乾いた斜面と尾根は低木と枯れ草、湿った谷筋は濃い緑。
  blend(C_SCRUB, (smoothstep(0.28, 0.7, slope) * 0.75 + ridge * 0.3) * (1 - wet));
  blend(C_LUSH, gully * wet * 0.55);
  blend(C_DRY, ridge * 0.35 * (1 - wet));

  // 崖錐: 急な斜面のすぐ下の、窪んで緩んだ所に明るい礫。
  blend(
    C_SCREE,
    smoothstep(0.5, 0.8, slope) * (1 - smoothstep(0.85, 1.1, slope)) *
      smoothstep(0.005, 0.06, -f.curvature) * (1 - moisture * 0.6) * 0.7,
  );

  // 岩: 大きな地形が急な所。尾根では出やすく、谷筋では土と植生に覆われる。
  // 細部の傾きは少しだけ足し、局所の崖を拾う（主にすると四角いドットになる）。
  const rocky = clamp(
    smoothstep(0.78, 1.2, slope + Math.max(0, slopeLocal - slope) * 0.2 + patch * 0.06) +
      ridge * smoothstep(0.55, 0.9, slope) * 0.45 +
      smoothstep(0.24, 0.12, temp) * smoothstep(0.4, 0.8, slope) * 0.5,
    0,
    1,
  ) * (1 - gully * 0.55);
  if (rocky > 0) {
    // 暗い面は高い所と谷側、明るい面は尾根。地層の縞で水平の帯を入れる。
    const dark = clamp(0.35 + smoothstep(150, 450, h) * 0.3 - ridge * 0.35 + gully * 0.2, 0, 1);
    rockColor(rockTone, dark, ROCK);
    const strata = 1 + 0.1 * Math.sin(h * 0.45 + patch * 0.9) + 0.06 * Math.sin(h * 0.13 + 1.7);
    ROCK[0] *= strata;
    ROCK[1] *= strata;
    ROCK[2] *= strata;
    blend(ROCK, rocky);
  }

  // 浜辺と、水の中の砂地。
  blend(C_SAND, 1 - smoothstep(1.2, 4, h));
  blend(C_SEABED, smoothstep(-1.5, -22, h));

  // 雪: 寒い所の、急すぎない面。谷筋に溜まり、尾根では飛ばされる。
  const snow =
    smoothstep(0.16, 0.03, temp + patch * 0.03 + ridge * 0.04 - gully * 0.04) *
    (1 - smoothstep(0.95, 1.35, slope));
  blend(C_SNOW, snow);

  out[o] = RGB[0];
  out[o + 1] = RGB[1];
  out[o + 2] = RGB[2];
}
