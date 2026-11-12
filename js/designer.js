// The environment designer's half of the simulation, with no page code, so
// it runs in the page and in the web workers (designer-worker.js).
//
// An environment is the part of the park a designer can change:
//   signs   which of the candidate signposts stand (affordances: a visitor who
//           reads one learns where nearby places are)
//   closed  lawns closed for restoration (obstacles to walkers, but no wear)
//   budget  the total budget in $k; signposts cost $2k each, the rest buys robots
// plus the test conditions every candidate in a round shares: visitors,
// weather and the random seed.
//
// Each environment is scored by running it: half for the visitors (did they
// see the places they came for, in the time they had) and half for the park
// (how much of the time the lawns, woods and lake were presentable), less a
// little for the money spent.
import { RULES } from './model.js';
import { mulberry32 } from './geometry.js';

export const DESIGN = {
  MAX_CLOSED: 5,          // lawns closed at once
  BUDGET: [80, 320],      // $k
  SPEND_WEIGHT: 0.04,     // score points per $1k spent
  RAIN: ['dry', 'shower', 'storm'],
};

// The example scene's arrangement, as an environment.
export function baseEnv(model, test = {}) {
  return {
    signs: model.allSignposts.map(() => true),
    closed: [],
    budget: (RULES.BUDGET + model.allSignposts.length * RULES.SIGN_PRICE) / 1000,
    visitors: test.visitors ?? 30, rain: test.rain ?? 'dry', seed: test.seed ?? 1,
  };
}

// What a designer can change, for building and describing variations.
export function designSpace(model) {
  return {
    signs: model.allSignposts.map((sp) => ({ id: sp.id, x: sp.x, y: sp.y })),
    lawns: model.lawns.map((l) => ({ id: l.id, name: l.name, area: l.area })),
  };
}

// A variation: one to three changes to the parent. Returns the child and a
// note on what changed.
export function mutate(env, space, rand) {
  const e = { ...env, signs: [...env.signs], closed: [...env.closed] };
  const notes = [];
  const n = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) {
    const r = rand();
    if (r < 0.55) {
      const k = Math.floor(rand() * e.signs.length);
      e.signs[k] = !e.signs[k];
      notes.push(`${e.signs[k] ? 'added' : 'removed'} signpost ${k + 1}`);
    } else if (r < 0.8) {
      const l = space.lawns[Math.floor(rand() * space.lawns.length)];
      if (e.closed.includes(l.id)) { e.closed = e.closed.filter((id) => id !== l.id); notes.push(`opened ${l.name}`); }
      else if (e.closed.length < DESIGN.MAX_CLOSED) { e.closed.push(l.id); notes.push(`closed ${l.name}`); }
    } else {
      const d = (rand() < 0.5 ? -1 : 1) * 20;
      const b = Math.max(DESIGN.BUDGET[0], Math.min(DESIGN.BUDGET[1], e.budget + d));
      if (b !== e.budget) { notes.push(`budget ${b > e.budget ? 'up' : 'down'} to $${b}k`); e.budget = b; }
    }
  }
  return { env: e, change: notes.join(', ') || 'no change' };
}

// A fresh random environment, for starting over.
export function randomEnv(space, test, rand) {
  const e = baseEnv({ allSignposts: space.signs }, test);
  e.signs = e.signs.map(() => rand() < 0.5);
  e.budget = DESIGN.BUDGET[0] + Math.round((rand() * (DESIGN.BUDGET[1] - DESIGN.BUDGET[0])) / 20) * 20;
  const k = Math.floor(rand() * 3);
  for (let i = 0; i < k; i++) { const l = space.lawns[Math.floor(rand() * space.lawns.length)]; if (!e.closed.includes(l.id)) e.closed.push(l.id); }
  return e;
}

export function score(model) {
  const v = model.visitorStats(), d = model.dayShares();
  const visitors = v.left ? 0.6 * v.places + 0.4 * v.onTime : 0;
  const park = (d.lawns + d.woods + d.lake) / 3;
  const spent = (model.fleetCost() + model.signCost()) / 1000;
  const total = 100 * (0.5 * visitors + 0.5 * park) - DESIGN.SPEND_WEIGHT * spent;
  return {
    total: Math.round(total * 10) / 10,
    visitors: Math.round(visitors * 100), park: Math.round(park * 100), spent,
    places: Math.round(v.places * 100), onTime: Math.round(v.onTime * 100), left: v.left,
    minutes: Math.round(v.minutes), distance: Math.round(v.distance),
    lawns: Math.round(d.lawns * 100), woods: Math.round(d.woods * 100), lake: Math.round(d.lake * 100),
    robots: { mower: model.mowers.length, steward: model.stewards.length, skimmer: model.skimmers.length },
    signs: model.signposts.length,
  };
}

// Run one environment for `steps` minutes and score it. The heat map is
// where agents walked, on the agents' 10 ft knowledge grid.
export function evaluate(model, env, steps) {
  model.reset(env);
  for (let i = 0; i < steps; i++) model.advance();
  return { score: score(model), heat: Float32Array.from(model.heat) };
}

export const seeded = mulberry32;
