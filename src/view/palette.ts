/**
 * 地面の色。stroll の気候帯の色（気温 3 段 × 湿り気 3 段を双一次で混ぜる）を引き継ぐ。
 * 表示にしか使わないので、決定性の決まり（grid.ts）の外にある。
 */

type RGB = [number, number, number];

/** sRGB の 16 進を 0..1 のリニアへ。 */
function srgb(hex: number): RGB {
  const f = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return [f(((hex >> 16) & 255) / 255), f(((hex >> 8) & 255) / 255), f((hex & 255) / 255)];
}

const C_SAND = srgb(0xd3c49a);
const C_ROCK = srgb(0x8a8479);
const C_ROCK_DARK = srgb(0x6b6760);
const C_SNOW = srgb(0xeef2f4);

const TEMP_STOPS = [0.15, 0.45, 0.78] as const;
const MOIST_STOPS = [0.18, 0.45, 0.7] as const;

// [湿り気の段 * 3 + 気温の段]。気温は寒→温→暑、湿り気は乾→中→湿。
const CLIMATE: readonly RGB[] = [
  srgb(0x87958d), // 寒・乾: ツンドラ
  srgb(0xb4b56d), // 温・乾: 乾いた草原
  srgb(0xd5bd82), // 暑・乾: 砂漠
  srgb(0x58756b), // 寒・中: タイガ
  srgb(0x6f9850), // 温・中: 森
  srgb(0xb8974e), // 暑・中: サバンナ
  srgb(0xdfe6ea), // 寒・湿: 雪原
  srgb(0x427744), // 温・湿: 深い森
  srgb(0x3f8e42), // 暑・湿: 密林
];

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

function segment(stops: readonly number[], t: number): [number, number] {
  if (t <= stops[1]) return [0, smooth(stops[0], stops[1], t)];
  return [1, smooth(stops[1], stops[2], t)];
}

/** 陸の面の色（リニア RGB）を out に書く。slope は 1 m 進むあたりの上り。 */
export function landColor(
  h: number,
  slope: number,
  temp: number,
  moisture: number,
  out: Float32Array,
): void {
  const [ti, tk] = segment(TEMP_STOPS, temp);
  const [mi, mk] = segment(MOIST_STOPS, moisture);
  const o = mi * 3 + ti;
  const c00 = CLIMATE[o];
  const c10 = CLIMATE[o + 1];
  const c01 = CLIMATE[o + 3];
  const c11 = CLIMATE[o + 4];
  let r = mix(mix(c00[0], c10[0], tk), mix(c01[0], c11[0], tk), mk);
  let g = mix(mix(c00[1], c10[1], tk), mix(c01[1], c11[1], tk), mk);
  let b = mix(mix(c00[2], c10[2], tk), mix(c01[2], c11[2], tk), mk);

  // 浜辺。
  const beach = 1 - smooth(1, 4, h);
  r = mix(r, C_SAND[0], beach);
  g = mix(g, C_SAND[1], beach);
  b = mix(b, C_SAND[2], beach);

  // 急な面は岩。高いほど暗い。
  const rocky = smooth(0.55, 0.95, slope);
  const dark = smooth(150, 450, h);
  r = mix(r, mix(C_ROCK[0], C_ROCK_DARK[0], dark), rocky);
  g = mix(g, mix(C_ROCK[1], C_ROCK_DARK[1], dark), rocky);
  b = mix(b, mix(C_ROCK[2], C_ROCK_DARK[2], dark), rocky);

  // 寒い所の、急すぎない面に雪。
  const snow = smooth(0.14, 0.04, temp) * (1 - smooth(0.7, 1.1, slope));
  r = mix(r, C_SNOW[0], snow);
  g = mix(g, C_SNOW[1], snow);
  b = mix(b, C_SNOW[2], snow);

  out[0] = r;
  out[1] = g;
  out[2] = b;
}

export const WATER_SHALLOW = srgb(0x5fb3b8);
export const WATER_DEEP = srgb(0x1d4f78);
export const WATER_FRESH = srgb(0x3d8fb8);

/** リニア → sRGB の 0..255。 */
export function toByte(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}
