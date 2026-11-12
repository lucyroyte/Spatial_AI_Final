// The environment designer panel: the primary function of the simulation.
//
// Manual: two variations of the current environment run side by side; keep
// one and two new variations are made from it.
// Automated: for a number of epochs, make two variations, run them and the
// current environment on the same conditions, keep the best, repeat.
// Every environment runs in a web worker, so the park keeps animating.
import { baseEnv, designSpace, mutate, randomEnv, seeded, DESIGN } from './designer.js';
import { drawParkBase } from './monitor.js';

const $ = (id) => document.getElementById(id);
const W = 320, H = 300;

export function setupDesigner({ model, openInPark, toast }) {
  const L = model.layout;
  const space = designSpace(model);
  const lawnName = Object.fromEntries(space.lawns.map((l) => [l.id, l.name]));
  const rand = seeded(424242);
  const kcols = Math.ceil(L.cols / 2);

  // ---------- workers ----------
  const POOL = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 1));
  const workers = [], idle = [], queue = [], waiting = new Map();
  let nextId = 1;
  function worker() {
    const w = new Worker(new URL('./designer-worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (ev) => {
      const job = waiting.get(ev.data.id); waiting.delete(ev.data.id);
      idle.push(w); pump();
      if (ev.data.error) job.reject(new Error(ev.data.error)); else job.resolve(ev.data);
    };
    w.onerror = (ev) => { toast(`The designer could not run: ${ev.message || 'worker error'}`); };
    return w;
  }
  function pump() {
    while (idle.length && queue.length) {
      const w = idle.pop(), job = queue.shift();
      waiting.set(job.id, job);
      w.postMessage({ id: job.id, env: job.env, steps: job.steps });
    }
  }
  function run(env, steps) {
    if (!workers.length) for (let i = 0; i < POOL; i++) { const w = worker(); workers.push(w); idle.push(w); }
    return new Promise((resolve, reject) => { queue.push({ id: nextId++, env, steps, resolve, reject }); pump(); });
  }

  // ---------- state ----------
  const test = () => ({ steps: Number($('des-steps').value), visitors: Math.max(5, Math.min(80, Number($('des-visitors').value) || 30)), rain: $('des-rain').value });
  let current = { env: baseEnv(model), label: 'Example park', change: 'the example scene', score: null, heat: null };
  let round = 0, pair = null, busy = false, stopAuto = false;
  const tried = [];   // every environment run: { n, label, change, env, score, heat }
  const lineage = []; // the choices that led to the current environment

  // Every environment runs on the same test: the same visitors, arriving at
  // the same entrances with the same personalities, and the same weather. So
  // a difference in score comes from the layout, and scores compare across
  // rounds and epochs.
  const SEED = 1;
  const testKey = () => JSON.stringify(test());
  const withTest = (env) => { const t = test(); return { ...env, visitors: t.visitors, rain: t.rain, seed: SEED }; };
  async function evaluate(item) {
    const r = await run(withTest(item.env), test().steps);
    item.score = r.score; item.heat = r.heat; item.test = testKey(); item.seed = SEED;
    tried.push({ n: tried.length + 1, ...item, env: withTest(item.env) });
    if (tried.length > 80) delete tried[tried.length - 81].heat;
    renderTried();
    return item;
  }

  // ---------- drawing ----------
  function drawMap(canvas, item) {
    const g = canvas.getContext('2d');
    const T = drawParkBase(g, L, W, H, 8);
    const s = T.s, cell = L.cell * 2;
    if (item.heat) {
      let max = 0;
      for (const v of item.heat) if (v > max) max = v;
      const lm = Math.log1p(max || 1);
      for (let k = 0; k < item.heat.length; k++) {
        const v = item.heat[k];
        if (!v) continue;
        const x = L.x0 + (k % kcols) * cell, y = L.y0 + Math.floor(k / kcols) * cell;
        g.fillStyle = `rgba(251, 113, 133, ${0.15 + 0.85 * Math.log1p(v) / lm})`;
        g.fillRect(T.X(x), T.Y(y + cell), Math.max(1, cell * s), Math.max(1, cell * s));
      }
    }
    // Closed lawns: hatched in red.
    g.strokeStyle = '#ef4444'; g.lineWidth = 1.5;
    for (const id of item.env.closed) {
      const l = model.layout.byId[id];
      for (const poly of l.polygons) {
        g.beginPath();
        for (const ring of poly) ring.forEach((p, i) => (i ? g.lineTo(T.X(p.x), T.Y(p.y)) : g.moveTo(T.X(p.x), T.Y(p.y))));
        g.fillStyle = 'rgba(239, 68, 68, 0.35)'; g.fill('evenodd'); g.stroke();
      }
    }
    // Signposts: green when standing, a faint ring where one could go.
    space.signs.forEach((sp, i) => {
      g.beginPath(); g.arc(T.X(sp.x), T.Y(sp.y), item.env.signs[i] ? 3.2 : 2.4, 0, Math.PI * 2);
      if (item.env.signs[i]) { g.fillStyle = '#4ade80'; g.fill(); g.strokeStyle = '#052e16'; g.lineWidth = 1; g.stroke(); }
      else { g.strokeStyle = 'rgba(226, 232, 240, 0.45)'; g.lineWidth = 1; g.stroke(); }
    });
    const c = model.center.position;
    g.strokeStyle = '#facc15'; g.lineWidth = 2; g.beginPath(); g.arc(T.X(c.x), T.Y(c.y), 5, 0, Math.PI * 2); g.stroke();
  }

  const bar = (v, cls = '') => `<span class="bar"><i class="${cls}" style="width:${Math.max(0, Math.min(100, v))}%"></i></span>`;
  function card(el, item, opts = {}) {
    const sc = item.score, signs = item.env.signs.filter(Boolean).length;
    const closed = item.env.closed.map((id) => lawnName[id]).join(', ') || 'none';
    const vs = opts.vs && sc && opts.vs.score ? sc.total - opts.vs.score.total : null;
    el.innerHTML = `
      <div class="des-card-head"><b>${item.label}</b>${sc ? `<span class="des-total">${sc.total.toFixed(1)}${vs != null ? `<small class="${vs >= 0 ? 'up' : 'down'}">${vs >= 0 ? '+' : ''}${vs.toFixed(1)}</small>` : ''}</span>` : '<span class="des-run">running…</span>'}</div>
      <div class="des-change">${item.change}</div>
      <canvas width="${W}" height="${H}"></canvas>
      <div class="des-env">${signs} signposts · closed: ${closed} · $${item.env.budget}k budget</div>
      ${sc ? `<div class="des-scores">
        <div><span>Visitors</span>${bar(sc.visitors)}<b>${sc.visitors}</b><small>${sc.places}% of places seen, ${sc.onTime}% on time, ${sc.left} visits</small></div>
        <div><span>Park</span>${bar(sc.park)}<b>${sc.park}</b><small>presentable: lawns ${sc.lawns}%, woods ${sc.woods}%, lake ${sc.lake}%</small></div>
        <div><span>Spent</span>${bar(sc.spent / 3.2, 'cost')}<b>$${sc.spent}k</b><small>${sc.robots.mower} mowers, ${sc.robots.steward} stewards, ${sc.robots.skimmer} skimmers, ${sc.signs} signs</small></div>
      </div>` : '<div class="des-scores muted">Running the park with this layout…</div>'}
      <div class="des-actions">${opts.keep ? `<button data-keep="${opts.keep}" ${sc ? '' : 'disabled'}>Keep this one</button>` : ''}<button data-open="${opts.key}">Open in park</button></div>`;
    drawMap(el.querySelector('canvas'), item);
    el._item = item;
  }

  function renderLineage() {
    $('des-lineage').innerHTML = lineage.length
      ? lineage.map((s) => `<li>${s}</li>`).join('')
      : '<li class="muted">Nothing kept yet: the variations start from the example park.</li>';
  }
  function renderTried() {
    $('des-tried-n').textContent = tried.length;
    $('des-tried').tBodies[0].innerHTML = tried.slice().reverse().map((t) => `<tr><td>${t.n}</td><td>${t.label}</td><td>${t.change}</td><td>${t.score.total.toFixed(1)}</td><td>${t.score.visitors}</td><td>${t.score.park}</td><td>$${t.score.spent}k</td></tr>`).join('');
  }

  // ---------- manual: side by side ----------
  async function newRound() {
    if (busy) return;
    busy = true; round++;
    const a = mutate(current.env, space, rand), b = mutate(current.env, space, rand);
    pair = {
      a: { env: a.env, change: a.change, label: `Round ${round} · A` },
      b: { env: b.env, change: b.change, label: `Round ${round} · B` },
    };
    $('des-man-note').textContent = `Round ${round}: two variations of ${current.label.toLowerCase()}, each run for ${test().steps / 60} hours with the same ${test().visitors} visitors and ${test().rain === 'dry' ? 'dry weather' : `a ${test().rain}`}, so any difference comes from the layout.`;
    card($('card-a'), pair.a, { key: 'a' }); card($('card-b'), pair.b, { key: 'b' });
    try {
      await Promise.all([evaluate(pair.a), evaluate(pair.b), scoreCurrent()]);
      card($('card-a'), pair.a, { key: 'a', keep: 'a', vs: current }); card($('card-b'), pair.b, { key: 'b', keep: 'b', vs: current });
      $('des-man-note').textContent += ` The small number is the change from the environment they came from (${current.score.total.toFixed(1)}).`;
    } catch (err) { toast(err.message); }
    busy = false;
  }
  function keep(k) {
    if (busy || !pair) return;
    const it = pair[k];
    current = { ...it, label: `${it.label} (kept)` };
    lineage.push(`${it.label}: ${it.change} → ${it.score.total.toFixed(1)}`);
    renderLineage();
    newRound();
  }

  // The current environment only needs running again when the test changes.
  async function scoreCurrent() {
    if (current.score && current.test === testKey()) return;
    await evaluate(current);
  }

  // ---------- automated: epochs ----------
  const epochs = [];
  async function evolve() {
    if (busy) { stopAuto = true; return; }
    busy = true; stopAuto = false;
    const n = Math.max(1, Math.min(50, Number($('des-epochs').value) || 8));
    $('des-evolve').textContent = 'Stop';
    for (let e = 1; e <= n && !stopAuto; e++) {
      const k = epochs.length + 1;
      $('des-progress').textContent = `Epoch ${e} of ${n}: running two variations…`;
      const kids = [mutate(current.env, space, rand), mutate(current.env, space, rand)].map((m, i) => ({ env: m.env, change: m.change, label: `Epoch ${k} · ${'AB'[i]}` }));
      try { await Promise.all([scoreCurrent(), ...kids.map((it) => evaluate(it))]); } catch (err) { toast(err.message); break; }
      const parent = current;
      const best = [parent, ...kids].sort((x, y) => y.score.total - x.score.total)[0];
      epochs.push({ k, scores: [parent, ...kids].map((it) => it.score.total), best: best.score.total, kept: best === parent ? 'parent' : best.label, change: best === parent ? 'kept the parent' : best.change });
      if (best !== parent) { lineage.push(`${best.label}: ${best.change} → ${best.score.total.toFixed(1)}`); current = { ...best, label: `${best.label} (kept)` }; }
      renderLineage(); drawChart(); renderEpochs();
      card($('card-best'), current, { key: 'best' });
    }
    $('des-progress').textContent = stopAuto ? 'Stopped.' : `Done: ${epochs.length} epochs, ${epochs.length * 2} variations run.`;
    $('des-evolve').textContent = 'Evolve';
    busy = false;
  }
  function drawChart() {
    const c = $('des-chart'), g = c.getContext('2d'), w = c.width, h = c.height, pad = 28;
    const cs = getComputedStyle(document.documentElement);
    g.clearRect(0, 0, w, h);
    if (!epochs.length) return;
    const all = epochs.flatMap((e) => e.scores);
    let lo = Math.floor(Math.min(...all) - 1), hi = Math.ceil(Math.max(...all) + 1);
    const X = (i) => pad + (epochs.length === 1 ? (w - pad * 2) / 2 : (i * (w - pad * 2)) / (epochs.length - 1));
    const Y = (v) => h - 18 - ((v - lo) / (hi - lo)) * (h - 30);
    g.strokeStyle = cs.getPropertyValue('--border'); g.lineWidth = 1;
    g.fillStyle = cs.getPropertyValue('--muted'); g.font = '11px system-ui, sans-serif';
    for (const v of [lo, (lo + hi) / 2, hi]) { g.beginPath(); g.moveTo(pad, Y(v)); g.lineTo(w - 6, Y(v)); g.stroke(); g.fillText(v.toFixed(0), 2, Y(v) + 4); }
    g.fillText('epoch', w - 40, h - 3);
    epochs.forEach((e, i) => e.scores.forEach((v, j) => { g.fillStyle = j ? 'rgba(148, 163, 184, 0.7)' : 'rgba(250, 204, 21, 0.9)'; g.beginPath(); g.arc(X(i), Y(v), 2.6, 0, 7); g.fill(); }));
    g.strokeStyle = cs.getPropertyValue('--accent'); g.lineWidth = 2.2; g.beginPath();
    epochs.forEach((e, i) => (i ? g.lineTo(X(i), Y(e.best)) : g.moveTo(X(i), Y(e.best)))); g.stroke();
  }
  function renderEpochs() {
    $('des-epochs-list').innerHTML = epochs.slice().reverse().map((e) => `<li><b>Epoch ${e.k}</b>: ${e.best.toFixed(1)} · ${e.kept === 'parent' ? 'no variation beat the parent' : e.change}</li>`).join('');
  }

  // ---------- wiring ----------
  function open(show = true) {
    $('designer').hidden = !show;
    $('btn-design').classList.toggle('on', show);
    if (show && !round && !busy) newRound();
  }
  $('btn-design').addEventListener('click', () => open($('designer').hidden));
  $('designer-close').addEventListener('click', () => open(false));
  for (const b of document.querySelectorAll('#designer [data-tab]')) b.addEventListener('click', () => {
    for (const o of document.querySelectorAll('#designer [data-tab]')) o.classList.toggle('on', o === b);
    $('des-manual').hidden = b.dataset.tab !== 'manual';
    $('des-auto').hidden = b.dataset.tab !== 'auto';
    if (b.dataset.tab === 'auto' && current.score) card($('card-best'), { ...current, label: `Current: ${current.label}` }, { key: 'best' });
  });
  $('designer').addEventListener('click', (ev) => {
    const kb = ev.target.closest('[data-keep]'); if (kb) return keep(kb.dataset.keep);
    const ob = ev.target.closest('[data-open]');
    if (ob) {
      const it = ob.dataset.open === 'best' ? current : pair && pair[ob.dataset.open];
      if (it) { openInPark(withTest(it.env), it.label); open(false); }
    }
  });
  $('des-next').addEventListener('click', () => newRound());
  $('des-restart').addEventListener('click', () => {
    if (busy) return;
    const t = test();
    current = $('des-from').value === 'random'
      ? { env: randomEnv(space, t, rand), label: 'Random park', change: 'a random layout', score: null }
      : { env: baseEnv(model), label: 'Example park', change: 'the example scene', score: null };
    lineage.length = 0; renderLineage();
    newRound();
  });
  $('des-evolve').addEventListener('click', evolve);
  $('des-download').addEventListener('click', () => {
    const data = { scoring: `total = 50 × visitors + 50 × park − ${DESIGN.SPEND_WEIGHT} × $k spent`, lineage, epochs, environments: tried.map(({ heat, ...t }) => t) };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = 'environments.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  renderLineage();
  return { open };
}
