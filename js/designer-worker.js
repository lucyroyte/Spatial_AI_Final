// Runs environments off the page's thread so the park keeps animating.
import { loadLayout } from './layout.js';
import { Model } from './model.js';
import { evaluate } from './designer.js';

const ready = loadLayout(new URL('../data/park.json', import.meta.url).href).then((L) => new Model(L));

self.onmessage = async (ev) => {
  const { id, env, steps } = ev.data;
  try {
    const model = await ready;
    const r = evaluate(model, env, steps);
    self.postMessage({ id, score: r.score, heat: r.heat }, [r.heat.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
