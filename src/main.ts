import './style.css';
import { FULL_RES, PREVIEW_RES } from './island/grid';
import {
  type IslandParams,
  PARAM_SPECS,
  cleanSeed,
  decodeParams,
  encodeParams,
  randomSeed,
} from './island/params';
import type { GenerateRequest, GenerateResult } from './island/worker';
import { drawIsland } from './view/mapView';

/**
 * 箱庭の島を作る画面。つまみを動かすと、上から見た島がその場で変わる。
 * つまみと種は URL の `#` に載るので、URL を送れば同じ島を渡せる。
 */

const panel = document.getElementById('panel')!;
const canvas = document.getElementById('island') as HTMLCanvasElement;
const status = document.getElementById('status')!;

let params: IslandParams = decodeParams(location.hash);

// ── 計算 ───────────────────────────────────────────────
// Worker は 1 つ。計算中に新しい依頼が来たら最新の 1 件だけを取っておき、終わったら流す。
// つまみを速く動かしても古い計算が積み上がらない。
const worker = new Worker(new URL('./island/worker.ts', import.meta.url), { type: 'module' });
let nextId = 1;
let busy = false;
let pending: GenerateRequest | null = null;
let drawnId = 0;

function request(n: number): void {
  const req: GenerateRequest = { id: nextId++, params: { ...params }, n };
  if (busy) {
    pending = req;
    return;
  }
  busy = true;
  worker.postMessage(req);
}

worker.onmessage = (ev: MessageEvent<GenerateResult>) => {
  const { id, island, ms } = ev.data;
  if (id > drawnId) {
    drawnId = id;
    drawIsland(canvas, island);
    const parts = Object.entries(island.timings)
      .map(([name, t]) => `${name} ${t.toFixed(0)}`)
      .join(' · ');
    status.textContent = `${island.n === FULL_RES ? '' : '下見 · '}${ms.toFixed(0)}ms（${parts}）`;
  }
  busy = false;
  if (pending) {
    const req = pending;
    pending = null;
    busy = true;
    worker.postMessage(req);
  }
};

function commit(): void {
  history.replaceState(null, '', `#${encodeParams(params)}`);
  request(FULL_RES);
}

// ── つまみ ─────────────────────────────────────────────
const seedInput = document.createElement('input');
seedInput.className = 'seed';
seedInput.value = params.seed;
seedInput.spellcheck = false;
seedInput.addEventListener('change', () => {
  params.seed = cleanSeed(seedInput.value) || params.seed;
  seedInput.value = params.seed;
  commit();
});

const reroll = document.createElement('button');
reroll.textContent = '別の島';
reroll.addEventListener('click', () => {
  params.seed = randomSeed();
  seedInput.value = params.seed;
  commit();
});

const seedRow = document.createElement('div');
seedRow.className = 'row seed-row';
seedRow.append(seedInput, reroll);
panel.append(seedRow);

for (const spec of PARAM_SPECS) {
  const wrap = document.createElement('label');
  wrap.className = 'slider';
  const title = document.createElement('div');
  title.className = 'slider-title';
  title.textContent = spec.label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = '0';
  input.max = '100';
  input.value = String(params[spec.key]);
  const ends = document.createElement('div');
  ends.className = 'ends';
  ends.innerHTML = `<span>${spec.low}</span><span>${spec.high}</span>`;
  // 動かしている間は粗い格子で下見し、離したら細かい格子で描き直す。
  input.addEventListener('input', () => {
    params[spec.key] = Number(input.value);
    request(PREVIEW_RES);
  });
  input.addEventListener('change', () => {
    params[spec.key] = Number(input.value);
    commit();
  });
  wrap.append(title, input, ends);
  panel.append(wrap);
}

const share = document.createElement('button');
share.className = 'share';
share.textContent = 'この島の URL をコピー';
share.addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}#${encodeParams(params)}`;
  try {
    await navigator.clipboard.writeText(url);
    share.textContent = 'コピーしました';
  } catch {
    share.textContent = url;
  }
  setTimeout(() => (share.textContent = 'この島の URL をコピー'), 2000);
});
panel.append(share, status);

addEventListener('hashchange', () => {
  params = decodeParams(location.hash);
  location.reload();
});

commit();
