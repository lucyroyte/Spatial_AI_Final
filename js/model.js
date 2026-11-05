// The semantic model: entities, their attributes, and the rules that change
// them. The view (view.js) only reads from this; the toolbar calls the
// action methods at the bottom.
import * as G from './geometry.js';
import { buildLayout, validateLayout } from './layout.js';

// Tunable constants for every rule. Rates are per time step.
export const RULES = {
  SPEED: { person: 3.5, mower: 5, mowerWork: 8, steward: 5, skimmer: 3, boat: 2.5 },
  PERSON_MAX_WATER: 3,       // in; people won't enter deeper water
  ROBOT_MAX_WATER: 6,        // in; robots wait until it drains
  DOG_LEASH: 6,              // ft
  LAWN_SQFT_PER_PERSON: 10,
  FENCE_BREAK_CHANCE: 0.004, // per walking person next to an intact fence
  FENCE_NEAR: 2.2,           // ft
  LITTER_CHANCE: 0.0015,      // per person
  LAKE_EDGE_NEAR: 3,         // ft; "at the lake edge"
  GRASS_GROWTH: 0.03, GRASS_MIN: 2, GRASS_MAX: 20, NEEDS_MOWING: 15, MOW_TO: 5,
  WEAR_PER_PERSON: 0.015, NEEDS_RESEEDING: 70, RESEED_CLOSED_STEPS: 60,
  RAIN_WATER: { none: 0, light: 0.08, heavy: 0.3 },     // in on medium ground
  COLLECT: { low: 1.6, medium: 1.0, high: 0.5 },         // pluvial multiplier
  DRAIN: { low: 0.08, medium: 0.15, high: 0.25 },        // in per step when dry
  LAKE_RAIN: { none: 0, light: 0.12, heavy: 0.4 },
  LAKE_FALL_ABOVE: 0.25, LAKE_FALL_BELOW: 0.03, LAKE_BASE: -2, LAKE_MAX: 14,
  MEDIUM_OVERFLOW_AT: 4,     // in above rim before medium ground floods
  WATER_MAX: 12,
  WEED_GROWTH: 0.02, WEED_PER_BROKEN: 0.015, WEEDING_RATE: 0.6, WEED_TRIGGER: 30, WEED_DONE: 15,
  DUCK_BASE: 0.002, DUCK_SPREAD: 0.006, SKIM_RATE: 8,
  SKIMMER_BOAT_GAP: 10,
  STEWARD_LAKE_REACH: 3,
  REPAIR_STEPS: 4,
  BOAT_TRIP: 160,
  AMBIENT_ACTIVITY: 0.005,   // chance a walker on a lawn sits, or a sitter gets up
};
const PERSON_ACTIVITIES = ['walking', 'standing', 'sitting'];

export class Model {
  constructor() {
    this.layout = buildLayout();
    this.problems = validateLayout(this.layout);
    if (this.problems.length) console.warn('Layout problems:', this.problems);
    this.reset();
  }

  // ---------- setup ----------
  reset() {
    const L = this.layout;
    this.rand = G.mulberry32(20261105);
    this.time = 0;
    this.ids = {};
    this.log = [];
    this.alerts = [];
    this.weather = { kind: 'weather', id: 'weather', rainIntensity: 'none' };

    this.lake = { ...L.lake, waterLevel: -2 };
    this.woods = { ...L.woods, weedCover: 40 };
    this.paths = L.paths.map((p) => ({ ...p, standingWater: 0, overflow: false }));
    const lawnStart = { 'lawn-big': [16.5, 15], 'lawn-small': [11, 60] };
    this.lawns = L.lawns.map((l) => ({
      ...l, grassHeight: lawnStart[l.id][0], wear: lawnStart[l.id][1],
      standingWater: 0, status: 'open', overflow: false, reseedTimer: 0, pendingReseed: false,
    }));
    this.regions = [this.lake, this.woods, ...this.paths, ...this.lawns];
    this.byId = Object.fromEntries(this.regions.map((r) => [r.id, r]));

    const brokenAtStart = new Set([this.nearestFence({ x: -91, y: 40 }).id, this.nearestFence({ x: -125, y: 72 }).id]);
    this.fences = L.fences.map((f) => ({ ...f, kind: 'fence', status: brokenAtStart.has(f.id) ? 'broken' : 'intact', repair: 0 }));
    this.gate = L.gate;
    this.landing = L.landing;

    // Duckweed in a few clustered patches, scaled to 20% average cover.
    const blobs = [[-50, 40, 22], [45, -45, 18], [-20, -50, 14], [55, 35, 12], [-60, -20, 10]];
    const cov = L.grid.cells.map((c) => {
      let v = 0;
      for (const [bx, by, br] of blobs) v += Math.exp(-((c.x - bx) ** 2 + (c.y - by) ** 2) / (2 * br * br));
      return v < 0.12 ? 0 : Math.min(1, v) * (0.75 + 0.25 * this.rand());
    });
    const mean = cov.reduce((a, b) => a + b, 0) / cov.length;
    this.duckweed = Float32Array.from(cov, (v) => Math.min(100, (v * 20) / mean));
    for (let k = 0; k < 4; k++) this.duckweed = Float32Array.from(this.duckweed, (v) => Math.min(100, v * (20 / this.duckweedCover())));

    this.people = []; this.dogs = []; this.boats = []; this.litter = [];
    this.mowers = []; this.stewards = []; this.skimmers = [];

    const walk = (x, y, dog) => { const p = this.makePerson({ x, y }, 'walking'); if (dog) this.giveDog(p); return p; };
    walk(-40, 76, true); walk(60, 76); walk(-86, 30); walk(86, -10, true); walk(-30, -85); walk(130, -42);
    this.makePerson({ x: 120, y: 35 }, 'sitting');
    this.makePerson({ x: 112, y: -70 }, 'sitting');
    this.makePerson({ x: 140, y: -58 }, 'sitting');
    this.giveDog(this.makePerson({ x: 128, y: -78 }, 'standing'));
    walk(-130, 20); walk(-115, -55);
    const rowers = [this.makePerson({ x: 10, y: 10 }, 'walking'), this.makePerson({ x: 10, y: 10 }, 'walking')];
    const boat = this.makeBoat({ x: -15, y: 15 }, 0.6, rowers);
    boat.trip = 40;

    [[125, 50, 'lawn-big'], [120, -70, 'lawn-small'], [-86, -50, 'path-west'], [-130, 30, 'woods'], [-110, -65, 'woods'], [-25, 30, 'lake']]
      .forEach(([x, y]) => this.makeLitter({ x, y }));

    this.addRobot('mower', { x: 100, y: -42 });
    this.addRobot('steward', { x: -86, y: -10 });
    this.addRobot('skimmer', { x: 35, y: 15 });
    this.note('Example scene loaded.');
  }

  newId(prefix) { this.ids[prefix] = (this.ids[prefix] || 0) + 1; return `${prefix}${this.ids[prefix]}`; }
  note(text, alert = false) {
    this.log.unshift({ t: this.time, text });
    if (this.log.length > 40) this.log.length = 40;
    if (alert) this.alerts.push(text);
  }

  makePerson(pos, activity) {
    const p = { kind: 'person', id: this.newId('P'), x: pos.x, y: pos.y, activity, dogId: null, route: [], goal: null, wait: 0, boatId: null };
    p.location = this.regionIdAt(p) || 'path-north';
    p.prev = { x: p.x, y: p.y };
    this.people.push(p);
    return p;
  }
  giveDog(p) {
    const d = { kind: 'dog', id: this.newId('D'), ownerId: p.id, x: p.x - 2, y: p.y - 1.5 };
    if (!this.landRegionAt(d)) { d.x = p.x; d.y = p.y; }
    d.location = this.landRegionAt(d) || p.location;
    p.dogId = d.id;
    this.dogs.push(d);
    return d;
  }
  makeBoat(pos, heading, rowers) {
    const b = { kind: 'boat', id: this.newId('B'), x: pos.x, y: pos.y, heading, speed: RULES.SPEED.boat, rowers: rowers.map((r) => r.id), trip: 0, state: 'rowing', trail: [] };
    rowers.forEach((r, i) => { r.activity = 'boating'; r.boatId = b.id; r.location = b.id; r.route = []; r.goal = null; r.x = b.x; r.y = b.y; r.seat = i; });
    this.boats.push(b);
    return b;
  }
  makeLitter(pos) {
    const l = { kind: 'litter', id: this.newId('L'), x: pos.x, y: pos.y };
    l.location = this.regionIdAt(l) || 'path-north';
    this.litter.push(l);
    return l;
  }

  // ---------- lookups ----------
  get(id) {
    return this.byId[id] || this.people.find((e) => e.id === id) || this.dogs.find((e) => e.id === id)
      || this.boats.find((e) => e.id === id) || this.litter.find((e) => e.id === id) || this.fences.find((e) => e.id === id)
      || this.robots().find((e) => e.id === id) || (id === 'gate' ? this.gate : id === 'landing' ? this.landing : id === 'weather' ? this.weather : null);
  }
  robots() { return [...this.mowers, ...this.stewards, ...this.skimmers]; }
  person(id) { return this.people.find((p) => p.id === id); }
  dog(id) { return this.dogs.find((d) => d.id === id); }
  boat(id) { return this.boats.find((b) => b.id === id); }

  regionIdAt(p) {
    if (G.pointInPolygon(p, this.layout.lake.boundary)) return 'lake';
    for (const r of this.layout.regions) if (r.kind !== 'lake' && G.pointInPolygon(p, r.boundary)) return r.id;
    return null;
  }
  landRegionAt(p) { const id = this.regionIdAt(p); return id && id !== 'lake' ? id : null; }
  nearestFence(p) {
    let best = null, bd = Infinity;
    for (const f of this.layout.fences) { const d = G.closestOnSegment(p, f.a, f.b).d; if (d < bd) { bd = d; best = f; } }
    return best;
  }
  peopleIn(regionId) { return this.people.filter((p) => p.location === regionId && p.activity !== 'boating'); }
  dogsIn(regionId) { return this.dogs.filter((d) => d.location === regionId); }
  woodsOccupied() { return this.people.some((p) => p.location === 'woods'); }
  lakeOverflowing() { return this.lake.waterLevel > 0; }
  duckweedCover() { let s = 0; for (const v of this.duckweed) s += v; return s / this.duckweed.length; }
  lawnCapacity(l) { return Math.floor(l.area / RULES.LAWN_SQFT_PER_PERSON); }
  cellAt(p) {
    const g = this.layout.grid;
    const c = Math.floor((p.x - g.x0) / g.CELL), r = Math.floor((p.y - g.y0) / g.CELL);
    if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return -1;
    return g.cellIndex[r * g.cols + c];
  }

  // ---------- movement rules ----------
  // Can this agent be in (enter) the region?
  allowed(agent, regionId) {
    const r = this.byId[regionId];
    if (!r) return false;
    const k = agent.kind;
    if (k === 'skimmer') return r.kind === 'lake';
    if (r.kind === 'lake') return false;
    if (k === 'person') {
      if (r.kind === 'woods') return true;
      if (r.standingWater > RULES.PERSON_MAX_WATER) return false;
      if (r.kind === 'lawn') {
        // People also keep off a lawn while a robot is mowing it.
        if (this.mowers.some((m) => m.targetLawn === r.id && m.state === 'mowing')) return false;
        return r.status === 'open' && this.peopleIn(r.id).length < this.lawnCapacity(r);
      }
      return true;
    }
    if (k === 'mower' && r.kind === 'woods') return false;
    if (r.kind === 'woods') return true;
    return r.standingWater <= RULES.ROBOT_MAX_WATER;
  }
  portalOpen(agent, portal) {
    if (!portal.via) return true;
    if (portal.via.gate) return agent.kind === 'steward';
    if (agent.kind !== 'person') return false;
    return this.fences.find((f) => f.id === portal.via.fence).status === 'broken';
  }

  // Shortest route over the region/portal graph. Regions are convex, so a
  // straight line between two points in one region stays inside it.
  route(agent, goal, goalRegion) {
    const L = this.layout, P = L.portals, N = P.length;
    const startRegion = agent.location;
    if (!goalRegion) goalRegion = this.regionIdAt(goal);
    if (!goalRegion) return null;
    if (startRegion === goalRegion) return [{ x: goal.x, y: goal.y }];
    if (!this.allowed(agent, goalRegion)) return null;
    const S = 2 * N, T = 2 * N + 1;
    const pos = (u) => (u === S ? agent : u === T ? goal : u < N ? P[u].pa : P[u - N].pb);
    const regionOf = (u) => (u === S ? startRegion : u === T ? goalRegion : u < N ? P[u].from : P[u - N].to);
    const distTo = new Float64Array(2 * N + 2).fill(Infinity), prev = new Int32Array(2 * N + 2).fill(-1);
    const done = new Uint8Array(2 * N + 2);
    const ok = new Map();
    const canUse = (rid) => { if (rid === startRegion) return true; if (!ok.has(rid)) ok.set(rid, this.allowed(agent, rid)); return ok.get(rid); };
    distTo[S] = 0;
    for (;;) {
      let u = -1, best = Infinity;
      for (let i = 0; i < distTo.length; i++) if (!done[i] && distTo[i] < best) { best = distTo[i]; u = i; }
      if (u < 0 || u === T) break;
      done[u] = 1;
      const relax = (v, w) => { const d = distTo[u] + w; if (d < distTo[v]) { distTo[v] = d; prev[v] = u; } };
      const pu = pos(u), ru = regionOf(u);
      if (u < N) { if (this.portalOpen(agent, P[u]) && canUse(P[u].to)) relax(u + N, G.dist(pu, P[u].pb)); }
      if (!canUse(ru)) continue;
      for (const i of L.exits[ru]) if (i !== u) relax(i, G.dist(pu, P[i].pa));
      if (ru === goalRegion) relax(T, G.dist(pu, goal));
    }
    if (!isFinite(distTo[T])) return null;
    const out = [];
    for (let u = T; u !== S; u = prev[u]) out.push(u === T ? { x: goal.x, y: goal.y } : u < N ? { ...P[u].pa } : { ...P[u - N].pb });
    out.reverse();
    out.length_ft = distTo[T];
    return out;
  }

  // Can the agent take a step to point q from where it stands?
  canStep(agent, q) {
    const r = this.regionIdAt(q);
    if (!r) return agent.kind !== 'skimmer';
    if (agent.kind === 'boat') return r === 'lake';
    if (r !== agent.location && !this.allowed(agent, r)) return false;
    const crossesWoods = (agent.location === 'woods') !== (r === 'woods');
    if (crossesWoods) {
      if (agent.kind === 'person') return this.fences.some((f) => f.status === 'broken' && G.segmentsIntersect(agent, q, f.a, f.b));
      if (agent.kind === 'steward') return G.segmentsIntersect(agent, q, this.gate.a, this.gate.b);
      return false;
    }
    return true;
  }

  // Move up to `speed` feet along the agent's route. Returns 'blocked' if the
  // next step is not allowed.
  moveAlong(agent, speed) {
    let budget = speed;
    while (budget > 1e-6 && agent.route && agent.route.length) {
      const t = agent.route[0];
      const d = G.dist(agent, t);
      let q;
      if (d <= budget || t.hop) { q = { x: t.x, y: t.y }; budget -= d; } else { q = { x: agent.x + ((t.x - agent.x) / d) * budget, y: agent.y + ((t.y - agent.y) / d) * budget }; budget = 0; }
      if (!this.canStep(agent, q)) return 'blocked';
      agent.x = q.x; agent.y = q.y;
      if (q.x === t.x && q.y === t.y) agent.route.shift();
      agent.location = this.regionIdAt(agent) || agent.location;
    }
    return 'ok';
  }

  // Route an agent to the nearest point of the nearest region that passes `filter`.
  routeToNearest(agent, filter) {
    let best = null;
    for (const r of this.layout.regions) {
      if (r.id === agent.location || !filter(this.byId[r.id])) continue;
      const goal = G.insideNear(agent, r.boundary, 1.5);
      const rt = this.route(agent, goal, r.id);
      if (rt && (!best || rt.length_ft < best.length_ft)) best = rt;
    }
    return best;
  }

  // ---------- time step ----------
  advance() {
    this.time++;
    this.alerts = [];
    this.stepWater();
    for (const p of this.people) this.stepPerson(p);
    for (const d of this.dogs) this.stepDog(d);
    for (const b of [...this.boats]) this.stepBoat(b);
    for (const m of this.mowers) this.stepMower(m);
    for (const s of this.stewards) this.stepSteward(s);
    for (const k of this.skimmers) this.stepSkimmer(k);
    this.stepGrowth();
    this.stepChances();
    this.stepLitter();
  }

  stepWater() {
    const rain = this.weather.rainIntensity;
    const lake = this.lake;
    if (rain !== 'none') lake.waterLevel += RULES.LAKE_RAIN[rain];
    else if (lake.waterLevel > 0) lake.waterLevel = Math.max(0, lake.waterLevel - RULES.LAKE_FALL_ABOVE);
    else if (lake.waterLevel > RULES.LAKE_BASE) lake.waterLevel = Math.max(RULES.LAKE_BASE, lake.waterLevel - RULES.LAKE_FALL_BELOW);
    lake.waterLevel = Math.min(RULES.LAKE_MAX, lake.waterLevel);
    const level = lake.waterLevel;
    for (const r of [...this.paths, ...this.lawns]) {
      const before = r.standingWater;
      if (rain !== 'none') r.standingWater += RULES.RAIN_WATER[rain] * RULES.COLLECT[r.elevation];
      const tier = this.layout.overflowTier[r.id];
      r.overflow = false;
      if (tier === 1 && level > 0) { r.standingWater += 0.15 + level * 0.06; r.overflow = true; }
      if (tier === 2 && level > RULES.MEDIUM_OVERFLOW_AT) { r.standingWater += 0.1 + (level - RULES.MEDIUM_OVERFLOW_AT) * 0.05; r.overflow = true; }
      if (rain === 'none' && !r.overflow) r.standingWater = Math.max(0, r.standingWater - RULES.DRAIN[r.elevation]);
      r.standingWater = Math.min(RULES.WATER_MAX, r.standingWater);
      if (before <= RULES.PERSON_MAX_WATER && r.standingWater > RULES.PERSON_MAX_WATER) this.note(`${r.name} has over 3″ of water: closed to people.`, true);
      if (before > RULES.PERSON_MAX_WATER && r.standingWater <= RULES.PERSON_MAX_WATER) this.note(`${r.name} drained below 3″.`);
    }
  }

  stepPerson(p) {
    if (p.activity === 'boating') return;
    p.prev = { x: p.x, y: p.y };
    const here = this.byId[p.location];
    if (here && (here.kind === 'lawn' || here.kind === 'path')) {
      const flooded = here.standingWater > RULES.PERSON_MAX_WATER;
      const closed = here.kind === 'lawn' && here.status !== 'open';
      if ((flooded || closed) && !p.evacuating) {
        const rt = this.routeToNearest(p, (r) => (r.kind === 'path' || (!closed && r.kind === 'lawn')) && this.allowed(p, r.id));
        if (p.activity !== 'walking') p.activity = 'walking';
        p.goal = null; p.waitingBoat = false;
        if (rt) { p.route = rt; p.evacuating = true; p.stranded = false; } else { p.route = []; p.stranded = true; }
      }
    }
    if (p.evacuating) {
      this.moveAlong(p, RULES.SPEED.person);
      if (!p.route.length) p.evacuating = false;
      return;
    }
    if (p.stranded) { p.stranded = !!(here && here.standingWater > RULES.PERSON_MAX_WATER); if (p.stranded) return; }
    if (p.activity !== 'walking') {
      if (this.rand() < RULES.AMBIENT_ACTIVITY) { p.activity = 'walking'; p.route = []; }
      return;
    }
    if (!p.route.length) {
      if (p.goal && p.goal.type === 'boat') return this.tryBoard(p);
      if (p.goal && p.goal.type === 'activity') { p.activity = p.goal.activity; p.goal = null; return; }
      if (here && here.kind === 'lawn' && this.rand() < RULES.AMBIENT_ACTIVITY * 6) { p.activity = this.rand() < 0.5 ? 'sitting' : 'standing'; return; }
      if (p.wait > 0) { p.wait--; return; }
      this.pickWander(p);
    }
    if (this.moveAlong(p, RULES.SPEED.person) === 'blocked') {
      p.route = [];
      if (p.goal && p.goal.type === 'boat') {
        const rt = this.route(p, this.landing.pathPoint, this.landing.pathId);
        if (rt) p.route = rt; else { p.goal = null; this.note(`${p.id} can't reach the boat landing.`, true); }
      } else if (p.goal) p.goal = null;
    }
  }

  pickWander(p) {
    const inWoods = p.location === 'woods';
    for (let tries = 0; tries < 6; tries++) {
      const x = this.rand();
      let r;
      if (inWoods) r = x < 0.7 ? this.woods : this.paths[Math.floor(this.rand() * this.paths.length)];
      else if (x < 0.65) r = this.paths[Math.floor(this.rand() * this.paths.length)];
      else if (x < 0.95) r = this.lawns[Math.floor(this.rand() * this.lawns.length)];
      else r = this.woods;
      if (r.id !== p.location && !this.allowed(p, r.id)) continue;
      // People wander off a lawn that a robot is working on.
      if (r.kind === 'lawn' && this.mowers.some((m) => m.targetLawn === r.id && (m.state !== 'traveling' || !m.route.length))) continue;
      const goal = G.randomPointInPolygon(r.boundary, this.rand, 1);
      const rt = this.route(p, goal, r.id);
      if (rt) { p.route = rt; p.wait = Math.floor(this.rand() * 4); return; }
    }
    p.wait = 3;
  }

  tryBoard(p) {
    if (G.dist(p, this.landing.pathPoint) > 1.5) { p.goal = null; return; }
    if (this.lakeOverflowing()) {
      if (!p.waitingBoat) this.note(`${p.id} is waiting: boats can't launch while the lake overflows.`, true);
      p.waitingBoat = true;
      return;
    }
    const waiting = this.people.filter((q) => q.goal && q.goal.type === 'boat' && q.activity === 'walking' && !q.route.length && G.dist(q, this.landing.pathPoint) <= 1.5);
    const crew = waiting.slice(0, 2);
    const wp = this.landing.waterPoint;
    const heading = Math.atan2(this.lake.center.y - wp.y, this.lake.center.x - wp.x);
    this.makeBoat(wp, heading, crew);
    crew.forEach((q) => { q.waitingBoat = false; });
    this.note(`${crew.map((q) => q.id).join(' and ')} launched a boat.`);
  }

  stepDog(d) {
    const o = this.person(d.ownerId);
    if (!o) return;
    let q;
    if (G.dist(o, o.prev) > 0.1) {
      const back = { x: o.prev.x - o.x, y: o.prev.y - o.y }, l = Math.hypot(back.x, back.y) || 1;
      q = { x: o.prev.x + (back.x / l) * 0.5 + (this.rand() - 0.5) * 0.8, y: o.prev.y + (back.y / l) * 0.5 + (this.rand() - 0.5) * 0.8 };
    } else {
      const a = this.rand() * Math.PI * 2;
      q = { x: o.x + Math.cos(a) * 2.5, y: o.y + Math.sin(a) * 2.5 };
      if (this.landRegionAt(q) !== o.location) q = { x: d.x, y: d.y };
    }
    if (G.dist(q, o) > RULES.DOG_LEASH - 0.5) {
      const l = G.dist(q, o);
      q = { x: o.x + ((q.x - o.x) / l) * (RULES.DOG_LEASH - 0.5), y: o.y + ((q.y - o.y) / l) * (RULES.DOG_LEASH - 0.5) };
    }
    if (!this.landRegionAt(q)) q = G.dist(o.prev, o) < RULES.DOG_LEASH && this.landRegionAt(o.prev) ? { ...o.prev } : { x: o.x, y: o.y };
    d.x = q.x; d.y = q.y;
    d.location = this.landRegionAt(d) || d.location;
  }

  insideLake(p, margin) {
    return G.pointInPolygon(p, this.lake.boundary) && G.closestOnPolygon(p, this.lake.boundary).d >= margin;
  }

  stepBoat(b) {
    b.trip++;
    if (b.state === 'rowing' && b.trip > RULES.BOAT_TRIP) { b.state = 'returning'; }
    let goal = null;
    if (b.state === 'returning') {
      goal = this.landing.waterPoint;
      if (G.dist(b, goal) < 3) return this.dockBoat(b);
      const want = Math.atan2(goal.y - b.y, goal.x - b.x);
      let dh = Math.atan2(Math.sin(want - b.heading), Math.cos(want - b.heading));
      b.heading += Math.max(-0.35, Math.min(0.35, dh));
    } else {
      b.heading += (this.rand() - 0.5) * 0.4;
    }
    let next = null;
    for (let tries = 0; tries < 10; tries++) {
      const q = { x: b.x + Math.cos(b.heading) * b.speed, y: b.y + Math.sin(b.heading) * b.speed };
      if (this.insideLake(q, b.state === 'returning' && G.dist(q, goal) < 8 ? 1.5 : 5)) { next = q; break; }
      const toC = Math.atan2(this.lake.center.y - b.y, this.lake.center.x - b.x);
      b.heading = toC + (this.rand() - 0.5) * 1.6;
    }
    if (!next) return;
    // Push duckweed aside, leaving a trail of open water.
    const steps = Math.ceil(G.dist(b, next) / 1.5);
    const px = -Math.sin(b.heading), py = Math.cos(b.heading);
    const g = this.layout.grid.CELL;
    for (let i = 1; i <= steps; i++) {
      const s = { x: b.x + ((next.x - b.x) * i) / steps, y: b.y + ((next.y - b.y) * i) / steps };
      for (const off of [-1.2, 1.2]) {
        const c = this.cellAt({ x: s.x + px * off, y: s.y + py * off });
        if (c < 0 || this.duckweed[c] <= 0) continue;
        const side = Math.sign(off);
        const nb = this.cellAt({ x: s.x + px * (off + side * g), y: s.y + py * (off + side * g) });
        const amt = this.duckweed[c];
        this.duckweed[c] = 0;
        if (nb >= 0) this.duckweed[nb] = Math.min(100, this.duckweed[nb] + amt);
      }
    }
    b.trail.unshift({ x: b.x, y: b.y, h: b.heading });
    if (b.trail.length > 14) b.trail.length = 14;
    b.x = next.x; b.y = next.y;
    b.rowers.forEach((id) => { const r = this.person(id); if (r) { r.x = b.x; r.y = b.y; } });
  }

  dockBoat(b) {
    const pp = this.landing.pathPoint;
    for (const id of b.rowers) {
      const r = this.person(id);
      if (!r) continue;
      r.activity = 'walking'; r.boatId = null; r.x = pp.x + (this.rand() - 0.5) * 2; r.y = pp.y; r.prev = { x: r.x, y: r.y };
      r.location = this.landing.pathId; r.route = []; r.wait = 2;
    }
    this.boats = this.boats.filter((x) => x !== b);
    this.note(`Boat ${b.id} returned to the landing.`);
  }

  // ---------- robots ----------
  addRobot(kind, pos) {
    const r = { kind, id: this.newId(kind === 'mower' ? 'M' : kind === 'steward' ? 'S' : 'K'), x: pos.x, y: pos.y, state: 'idle', route: [], target: null, note: '' };
    r.location = this.regionIdAt(r);
    if (kind === 'mower') { r.targetLawn = null; r.task = null; this.mowers.push(r); }
    if (kind === 'steward') { r.work = 0; this.stewards.push(r); }
    if (kind === 'skimmer') this.skimmers.push(r);
    return r;
  }

  robotMove(r, speed) {
    const here = this.byId[r.location];
    if (here && here.standingWater > RULES.ROBOT_MAX_WATER) { r.note = 'waiting for water to drain'; return 'blocked'; }
    const res = this.moveAlong(r, speed);
    r.note = res === 'blocked' ? 'waiting for water to drain' : '';
    return res;
  }

  lawnEdgePoint(robot, lawn) {
    // The nearest point on a path bordering the lawn: where the mower waits.
    let best = null;
    for (const P of this.layout.portals) {
      if (P.to !== lawn.id || this.byId[P.from].kind !== 'path') continue;
      const d = G.dist(robot, P.pa);
      if (!best || d < best.d) best = { d, p: P.pa, region: P.from };
    }
    return best;
  }

  sendMower(m, lawn, task) {
    const edge = this.lawnEdgePoint(m, lawn);
    const rt = edge && (m.location === lawn.id ? [] : this.route(m, edge.p, edge.region));
    if (!rt) return false;
    m.targetLawn = lawn.id; m.task = task; m.route = rt; m.state = 'traveling'; m.note = '';
    this.note(`${m.id} heading to ${task} ${lawn.name}.`);
    return true;
  }

  stepMower(m) {
    if (m.state === 'idle') {
      const taken = new Set(this.mowers.filter((x) => x !== m && x.targetLawn).map((x) => x.targetLawn));
      const free = this.lawns.filter((l) => !taken.has(l.id));
      const reseed = free.filter((l) => l.wear > RULES.NEEDS_RESEEDING && l.status !== 'reseeding');
      const mow = free.filter((l) => l.grassHeight > RULES.NEEDS_MOWING && l.status !== 'reseeding').sort((a, b) => b.grassHeight - a.grassHeight);
      if (reseed.length) this.sendMower(m, reseed[0], 'reseed');
      else if (mow.length) this.sendMower(m, mow[0], 'mow');
      return;
    }
    const lawn = this.byId[m.targetLawn];
    if (m.state === 'traveling') {
      if (m.route.length) { this.robotMove(m, RULES.SPEED.mower); if (m.route.length) return; }
      // At the edge of the lawn: wait until it is ready.
      if (m.task === 'reseed' && lawn.status !== 'reseeding') {
        lawn.status = 'reseeding'; lawn.pendingReseed = true; lawn.reseedTimer = 0;
        this.note(`${lawn.name} closed for reseeding; people move to the nearest path.`, true);
      }
      const occupied = this.peopleIn(lawn.id).length + this.dogsIn(lawn.id).length > 0;
      const wet = m.task === 'mow' ? lawn.standingWater > 0.05 : lawn.standingWater > RULES.ROBOT_MAX_WATER;
      if (occupied || wet) { m.note = occupied ? 'waiting: people or dogs on the lawn' : 'waiting: standing water on the lawn'; return; }
      m.note = '';
      m.route = this.sweepPattern(lawn, m);
      m.state = m.task === 'mow' ? 'mowing' : 'reseeding';
      if (m.task === 'reseed') { lawn.wear = 0; lawn.grassHeight = RULES.GRASS_MIN; lawn.pendingReseed = false; }
      return;
    }
    if (m.state === 'mowing' || m.state === 'reseeding') {
      if (m.state === 'mowing' && this.peopleIn(lawn.id).length + this.dogsIn(lawn.id).length > 0) { m.note = 'paused: people on the lawn'; return; }
      if (m.state === 'mowing' && lawn.standingWater > 0.05) { m.note = 'paused: standing water'; return; }
      m.note = '';
      this.robotMove(m, RULES.SPEED.mowerWork);
      if (!m.route.length) {
        if (m.state === 'mowing') { lawn.grassHeight = RULES.MOW_TO; this.note(`${m.id} mowed ${lawn.name} to 5″.`); }
        else { lawn.reseedTimer = RULES.RESEED_CLOSED_STEPS; this.note(`${m.id} reseeded ${lawn.name}; it stays closed for ${RULES.RESEED_CLOSED_STEPS} steps.`); }
        m.state = 'idle'; m.targetLawn = null; m.task = null;
      }
    }
  }

  sweepPattern(lawn, from) {
    const b = G.bounds(lawn.boundary);
    const inset = 3, lane = 13;
    const xs = [];
    for (let x = b.x0 + inset; x <= b.x1 - inset + 0.01; x += lane) xs.push(x);
    if (xs[xs.length - 1] < b.x1 - inset - 2) xs.push(b.x1 - inset);
    const startTop = Math.abs(from.y - b.y1) < Math.abs(from.y - b.y0);
    const pts = [];
    xs.forEach((x, i) => {
      const down = (i % 2 === 0) === startTop;
      pts.push({ x, y: down ? b.y1 - inset : b.y0 + inset }, { x, y: down ? b.y0 + inset : b.y1 - inset });
    });
    if (Math.abs(from.x - b.x1) < Math.abs(from.x - b.x0)) pts.forEach((p) => { p.x = b.x0 + b.x1 - p.x; });
    // Step onto the lawn from the edge, then drive to the first lane.
    const entry = { ...G.insideNear(from, lawn.boundary, 1), hop: true };
    return [entry, ...pts];
  }

  stepSteward(s) {
    const R2 = RULES;
    if (s.state === 'idle') return this.chooseStewardTask(s);
    const t = s.target;
    if (t.type === 'litter' && !this.litter.find((l) => l.id === t.id)) { s.state = 'idle'; s.target = null; s.route = []; return; }
    if (t.type === 'fence' && this.fences.find((f) => f.id === t.id).status === 'intact') { s.state = 'idle'; s.target = null; return; }
    if (s.state === 'traveling') {
      if (s.route.length) { this.robotMove(s, R2.SPEED.steward); if (s.route.length) return; }
      s.state = t.type === 'fence' ? 'repairing' : t.type === 'woods' ? 'weeding' : 'collecting';
      s.work = 0;
      return;
    }
    if (s.state === 'repairing') {
      if (this.woodsOccupied()) { s.note = 'waiting: people in the woods'; return; }
      s.note = '';
      if (++s.work >= R2.REPAIR_STEPS) {
        this.fences.find((f) => f.id === t.id).status = 'intact';
        this.note(`${s.id} repaired fence ${t.id}.`);
        s.state = 'idle'; s.target = null;
      }
      return;
    }
    if (s.state === 'collecting') {
      this.litter = this.litter.filter((l) => l.id !== t.id);
      this.note(`${s.id} collected litter ${t.id}.`);
      s.state = 'idle'; s.target = null;
      return;
    }
    if (s.state === 'weeding') {
      if (s.location === 'woods') this.woods.weedCover = Math.max(0, this.woods.weedCover - R2.WEEDING_RATE);
      s.work++;
      const urgent = s.work % 15 === 0 && (this.repairableFence(s) || this.nearestLandLitter(s));
      if (this.woods.weedCover <= R2.WEED_DONE || urgent) { s.state = 'idle'; s.target = null; s.route = []; return; }
      if (!s.route.length) { const g = G.randomPointInPolygon(this.woods.boundary, this.rand, 3); s.route = this.route(s, g, 'woods') || []; }
      this.robotMove(s, R2.SPEED.steward * 0.5);
    }
  }

  repairableFence(s) {
    if (this.woodsOccupied()) return null;
    const taken = new Set(this.stewards.filter((x) => x !== s && x.target && x.target.type === 'fence').map((x) => x.target.id));
    let best = null;
    for (const f of this.fences) {
      if (f.status !== 'broken' || taken.has(f.id)) continue;
      const m = { x: (f.a.x + f.b.x) / 2, y: (f.a.y + f.b.y) / 2 };
      // Work from the path side if there is one, otherwise from inside the woods.
      const out = this.layout.portals.find((p) => p.via && p.via.fence === f.id && p.from !== 'woods');
      const spot = out ? { p: out.pa, region: out.from } : { p: G.insideNear(m, this.woods.boundary, 1.5), region: 'woods' };
      const rt = this.route(s, spot.p, spot.region);
      if (rt && (!best || rt.length_ft < best.rt.length_ft)) best = { f, rt };
    }
    return best;
  }

  nearestLandLitter(s, includeShore = false) {
    const taken = new Set([...this.stewards, ...this.skimmers].filter((x) => x !== s && x.target && x.target.type === 'litter').map((x) => x.target.id));
    let best = null;
    for (const l of this.litter) {
      if (taken.has(l.id)) continue;
      let spot;
      if (l.location !== 'lake') spot = { p: { x: l.x, y: l.y }, region: l.location };
      else {
        if (!includeShore) continue;
        const shore = G.closestOnPolygon(l, this.lake.boundary);
        if (shore.d > RULES.STEWARD_LAKE_REACH) continue;
        const d = shore.d || 1;
        const q = { x: shore.x + ((shore.x - l.x) / d) * 2.5, y: shore.y + ((shore.y - l.y) / d) * 2.5 };
        const region = this.landRegionAt(q);
        if (!region) continue;
        spot = { p: q, region };
      }
      const rt = this.route(s, spot.p, spot.region);
      if (rt && (!best || rt.length_ft < best.rt.length_ft)) best = { l, rt };
    }
    return best;
  }

  chooseStewardTask(s) {
    const fence = this.repairableFence(s);
    if (fence) { s.target = { type: 'fence', id: fence.f.id }; s.route = fence.rt; s.state = 'traveling'; this.note(`${s.id} going to repair fence ${fence.f.id}.`); return; }
    const lit = this.nearestLandLitter(s) || this.nearestLandLitter(s, true);
    if (lit) { s.target = { type: 'litter', id: lit.l.id }; s.route = lit.rt; s.state = 'traveling'; return; }
    if (this.woods.weedCover > RULES.WEED_TRIGGER && !this.stewards.some((x) => x !== s && x.target && x.target.type === 'woods')) {
      const g = G.randomPointInPolygon(this.woods.boundary, this.rand, 3);
      const rt = this.route(s, g, 'woods');
      if (rt) { s.target = { type: 'woods', id: 'woods' }; s.route = rt; s.state = 'traveling'; this.note(`${s.id} going to weed the woods (through the gate).`); }
    }
  }

  stepSkimmer(k) {
    // Collect floating litter it passes over.
    for (const l of [...this.litter]) {
      if (l.location === 'lake' && G.dist(l, k) < 2.5) { this.litter = this.litter.filter((x) => x !== l); this.note(`${k.id} picked up floating litter ${l.id}.`); }
    }
    const nearBoat = (p) => this.boats.some((b) => G.dist(p, b) < RULES.SKIMMER_BOAT_GAP);
    if (nearBoat(k)) {
      // Back away from the nearest boat.
      const b = this.boats.reduce((a, c) => (G.dist(c, k) < G.dist(a, k) ? c : a));
      const d = G.dist(k, b) || 1;
      for (const turn of [0, 0.6, -0.6, 1.2, -1.2]) {
        const a = Math.atan2(k.y - b.y, k.x - b.x) + turn;
        const q = { x: k.x + Math.cos(a) * RULES.SPEED.skimmer, y: k.y + Math.sin(a) * RULES.SPEED.skimmer };
        if (this.insideLake(q, 2)) { k.x = q.x; k.y = q.y; break; }
      }
      k.note = 'keeping 10 ft from boats';
      if (k.state === 'eating') k.state = 'traveling';
      return;
    }
    k.note = '';
    const cells = this.layout.grid.cells;
    if (k.state === 'idle') {
      let best = -1, bv = -1;
      for (let i = 0; i < cells.length; i++) {
        const v = this.duckweed[i];
        if (v < 5 || nearBoat(cells[i])) continue;
        const score = v - G.dist(cells[i], k) * 0.05;
        if (score > bv) { bv = score; best = i; }
      }
      if (best >= 0) { k.target = { type: 'cell', id: best }; k.state = 'traveling'; }
      return;
    }
    const c = cells[k.target.id];
    if (k.state === 'traveling') {
      const d = G.dist(k, c);
      if (d < 0.5) { k.state = 'eating'; return; }
      const step = Math.min(d, RULES.SPEED.skimmer);
      const q = { x: k.x + ((c.x - k.x) / d) * step, y: k.y + ((c.y - k.y) / d) * step };
      if (nearBoat(q)) { k.note = 'waiting for a boat to pass'; return; }
      if (this.insideLake(q, 0.5)) { k.x = q.x; k.y = q.y; }
      else { k.state = 'idle'; }
      return;
    }
    if (k.state === 'eating') {
      const i = k.target.id;
      this.duckweed[i] = Math.max(0, this.duckweed[i] - RULES.SKIM_RATE);
      if (this.duckweed[i] <= 0.5) {
        // Move on to the densest neighboring cell, or pick a new patch.
        const n = cells[i].nbrs.filter((j) => this.duckweed[j] > 5).sort((a, b) => this.duckweed[b] - this.duckweed[a])[0];
        if (n !== undefined) { k.target = { type: 'cell', id: n }; k.state = 'traveling'; } else { k.state = 'idle'; k.target = null; }
      }
    }
  }

  // ---------- growth ----------
  stepGrowth() {
    const Rr = RULES;
    for (const l of this.lawns) {
      const n = this.peopleIn(l.id).length + 2 * this.dogsIn(l.id).length;
      const mult = l.overflow ? 3 : l.standingWater > 0.05 ? 2 : 1;
      const before = l.wear;
      l.wear = Math.min(100, l.wear + Rr.WEAR_PER_PERSON * n * mult);
      if (before <= Rr.NEEDS_RESEEDING && l.wear > Rr.NEEDS_RESEEDING) this.note(`${l.name} is over 70% worn and needs reseeding.`, true);
      if (l.wear <= Rr.NEEDS_RESEEDING) {
        const g = l.grassHeight;
        l.grassHeight = Math.min(Rr.GRASS_MAX, l.grassHeight + Rr.GRASS_GROWTH);
        if (g <= Rr.NEEDS_MOWING && l.grassHeight > Rr.NEEDS_MOWING) this.note(`${l.name} grass is over 15″ and needs mowing.`);
      }
      if (l.status === 'reseeding' && !l.pendingReseed && l.reseedTimer > 0) {
        if (--l.reseedTimer === 0) { l.status = 'open'; this.note(`${l.name} reopened after reseeding.`); }
      }
    }
    const broken = this.fences.filter((f) => f.status === 'broken').length;
    this.woods.weedCover = Math.min(100, this.woods.weedCover + Rr.WEED_GROWTH + Rr.WEED_PER_BROKEN * broken);

    const cells = this.layout.grid.cells, dw = this.duckweed, next = new Float32Array(dw.length);
    for (let i = 0; i < cells.length; i++) {
      const c = dw[i];
      let more = 0;
      for (const j of cells[i].nbrs) more = Math.max(more, dw[j] - c);
      next[i] = Math.min(100, c + (Rr.DUCK_BASE * c + Rr.DUCK_SPREAD * more) * (1 - c / 100) * 1.0);
    }
    this.duckweed = next;
  }

  stepChances() {
    for (const p of this.people) {
      if (p.activity === 'walking' && p.location !== 'lake') {
        for (const f of this.fences) {
          if (f.status === 'intact' && G.closestOnSegment(p, f.a, f.b).d < RULES.FENCE_NEAR && this.rand() < RULES.FENCE_BREAK_CHANCE) {
            f.status = 'broken'; f.repair = 0;
            this.note(`${p.id} broke fence ${f.id}.`, true);
            break;
          }
        }
      }
      if (this.rand() < RULES.LITTER_CHANCE) this.dropLitterBy(p, true);
    }
  }

  dropLitterBy(p, chance = false) {
    const boat = p.boatId && this.boat(p.boatId);
    let pos;
    if (boat) pos = { x: boat.x + (this.rand() - 0.5) * 3, y: boat.y + (this.rand() - 0.5) * 3 };
    else if (chance && G.closestOnPolygon(p, this.lake.boundary).d < RULES.LAKE_EDGE_NEAR + 2 && this.rand() < 0.5) pos = G.insideNear(p, this.lake.boundary, 1.5);
    else if (chance) pos = { x: p.x, y: p.y };
    else {
      for (let i = 0; i < 20 && !pos; i++) {
        const a = this.rand() * Math.PI * 2, r = 1 + this.rand() * 3;
        const q = { x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r };
        if (this.regionIdAt(q)) pos = q;
      }
      pos = pos || { x: p.x, y: p.y };
    }
    const l = this.makeLitter(pos);
    if (!this.regionIdAt(pos)) l.location = p.location;
    this.note(`${p.id} dropped litter ${l.id}${l.location === 'lake' ? ' into the lake' : ''}.`);
    return l;
  }

  stepLitter() {
    for (const l of this.litter) {
      const r = this.byId[l.location];
      if (r && (r.kind === 'lawn' || r.kind === 'path') && r.standingWater > RULES.PERSON_MAX_WATER) {
        const s = G.closestOnPolygon(l, this.lake.boundary);
        const d = s.d || 1, step = Math.min(3, d + 1.5);
        l.x += ((s.x - l.x) / d) * step; l.y += ((s.y - l.y) / d) * step;
        const now = this.regionIdAt(l);
        if (now) l.location = now;
        if (l.location === 'lake') this.note(`Litter ${l.id} washed into the lake.`);
      } else if (l.location === 'lake') {
        const q = { x: l.x + (this.rand() - 0.5) * 0.6, y: l.y + (this.rand() - 0.5) * 0.6 };
        if (this.insideLake(q, 0.5)) { l.x = q.x; l.y = q.y; }
      }
    }
  }

  // ---------- toolbar actions ----------
  // Each returns { ok, msg } so the UI can explain a refusal.
  addPerson() {
    const path = this.paths.filter((p) => this.allowed({ kind: 'person' }, p.id));
    if (!path.length) return { ok: false, msg: 'Every path is flooded; no one can be placed.' };
    const r = path[Math.floor(this.rand() * path.length)];
    const p = this.makePerson(G.randomPointInPolygon(r.boundary, this.rand, 1), 'walking');
    this.note(`${p.id} entered on ${r.name}.`);
    return { ok: true, entity: p };
  }
  removePerson(p) {
    if (p.dogId) this.dogs = this.dogs.filter((d) => d.id !== p.dogId);
    if (p.boatId) {
      const b = this.boat(p.boatId);
      b.rowers = b.rowers.filter((id) => id !== p.id);
      if (!b.rowers.length) this.boats = this.boats.filter((x) => x !== b);
    }
    this.people = this.people.filter((x) => x !== p);
    this.note(`${p.id} left the park${p.dogId ? ' with their dog' : ''}.`);
    return { ok: true };
  }
  addDog(p) {
    if (p.activity === 'boating') return { ok: false, msg: 'A person in a boat cannot be given a dog.' };
    if (p.dogId) return { ok: false, msg: `${p.id} already has a dog.` };
    if (p.goal && p.goal.type === 'boat') p.goal = null;
    const d = this.giveDog(p);
    this.note(`${p.id} is now walking dog ${d.id}.`);
    return { ok: true, entity: d };
  }
  changeActivity(p) {
    if (p.activity === 'boating') return { ok: false, msg: 'People in a boat keep rowing until the boat returns.' };
    const current = p.goal && p.goal.type === 'activity' ? p.goal.activity : p.activity;
    const next = PERSON_ACTIVITIES[(PERSON_ACTIVITIES.indexOf(current) + 1) % 3];
    p.goal = null; p.evacuating = false; p.waitingBoat = false;
    if (next === 'walking') { p.activity = 'walking'; p.route = []; return { ok: true, msg: `${p.id} is walking.` }; }
    const here = this.byId[p.location];
    if (here.kind === 'lawn' || here.kind === 'woods') { p.activity = next; p.route = []; return { ok: true, msg: `${p.id} is ${next}.` }; }
    // On a path: walk to the nearest open lawn (or the woods, through a broken fence) first.
    const rt = this.routeToNearest(p, (r) => (r.kind === 'lawn' || r.kind === 'woods') && this.allowed(p, r.id));
    if (!rt) return { ok: false, msg: `No open, dry lawn ${p.id} can reach to be ${next} on.` };
    p.activity = 'walking'; p.route = rt; p.goal = { type: 'activity', activity: next };
    return { ok: true, msg: `${p.id} is walking to a lawn to be ${next}.` };
  }
  goBoating(p) {
    if (p.activity === 'boating') return { ok: false, msg: `${p.id} is already in a boat.` };
    if (p.dogId) return { ok: false, msg: 'A person with a dog cannot board a boat.' };
    if (this.lakeOverflowing()) return { ok: false, msg: 'Boats cannot launch while the lake is overflowing.' };
    const rt = G.dist(p, this.landing.pathPoint) < 1.5 ? [] : this.route(p, this.landing.pathPoint, this.landing.pathId);
    if (!rt) return { ok: false, msg: `${p.id} can't reach the boat landing (flooded, closed or fenced in).` };
    p.activity = 'walking'; p.route = rt; p.goal = { type: 'boat' }; p.evacuating = false;
    return { ok: true, msg: `${p.id} is heading to the boat landing.` };
  }
  breakFence(f) {
    if (f.status === 'broken') return { ok: false, msg: `Fence ${f.id} is already broken.` };
    f.status = 'broken';
    this.note(`Fence ${f.id} was broken.`);
    return { ok: true };
  }
  dropLitter(p) { return { ok: true, entity: this.dropLitterBy(p, false) }; }
  cycleRain() {
    const order = ['none', 'light', 'heavy'];
    this.weather.rainIntensity = order[(order.indexOf(this.weather.rainIntensity) + 1) % 3];
    this.note(`Rain: ${this.weather.rainIntensity}.`);
    return { ok: true };
  }
  addRobotAction(kind) {
    let pos;
    if (kind === 'skimmer') pos = G.randomPointInPolygon(this.lake.boundary, this.rand, 8);
    else {
      const ok = this.paths.filter((p) => p.standingWater <= RULES.ROBOT_MAX_WATER);
      if (!ok.length) return { ok: false, msg: 'Every path is under more than 6″ of water.' };
      pos = G.randomPointInPolygon(ok[Math.floor(this.rand() * ok.length)].boundary, this.rand, 1.5);
    }
    const r = this.addRobot(kind, pos);
    this.note(`Added ${kind} robot ${r.id}.`);
    return { ok: true, entity: r };
  }
  nearestIdleMower(lawn) {
    return this.mowers.filter((m) => m.state === 'idle').sort((a, b) => G.dist(a, lawn.center) - G.dist(b, lawn.center))[0];
  }
  mowLawn(lawn) {
    if (lawn.status === 'reseeding') return { ok: false, msg: `${lawn.name} is being reseeded.` };
    if (this.mowers.some((m) => m.targetLawn === lawn.id)) return { ok: false, msg: `A mower is already assigned to ${lawn.name}.` };
    const m = this.nearestIdleMower(lawn);
    if (!m) return { ok: false, msg: 'No idle mower robot. Add one, or wait for one to finish.' };
    if (!this.sendMower(m, lawn, 'mow')) return { ok: false, msg: `${m.id} can't reach ${lawn.name} right now.` };
    return { ok: true, msg: `${m.id} sent to mow ${lawn.name}. It waits at the edge until the lawn is empty and dry.` };
  }
  reseedLawn(lawn) {
    if (lawn.status === 'reseeding') return { ok: false, msg: `${lawn.name} is already being reseeded.` };
    if (this.mowers.some((m) => m.targetLawn === lawn.id)) return { ok: false, msg: `A mower is already assigned to ${lawn.name}.` };
    const m = this.nearestIdleMower(lawn);
    if (!m) return { ok: false, msg: 'No idle mower robot. Add one, or wait for one to finish.' };
    if (!this.sendMower(m, lawn, 'reseed')) return { ok: false, msg: `${m.id} can't reach ${lawn.name} right now.` };
    return { ok: true, msg: `${m.id} sent to reseed ${lawn.name}.` };
  }
  toggleLawn(lawn) {
    if (lawn.status === 'reseeding') return { ok: false, msg: `${lawn.name} is closed for reseeding and reopens on its own.` };
    lawn.status = lawn.status === 'open' ? 'closed' : 'open';
    this.note(`${lawn.name} is now ${lawn.status}.${lawn.status === 'closed' ? ' People move to the nearest path.' : ''}`);
    return { ok: true };
  }
}
