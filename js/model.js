// The semantic model: entities, their attributes, and the rules that change
// them, on a real section of Central Park. The view (view.js) only reads
// from this; the toolbar calls the action methods near the bottom.
import * as G from './geometry.js';
import { Nav } from './nav.js';

// Tunable constants for every rule. One time step is one minute.
export const RULES = {
  DAY_START_MIN: 6 * 60, DAY_STEPS: 16 * 60,            // the park day runs 6:00 to 22:00
  SPEED: { person: 30, mower: 30, steward: 30, skimmer: 14, boat: 16 },   // ft per step
  PERSON_MAX_WATER: 3, ROBOT_MAX_WATER: 6,              // in
  DOG_LEASH: 6,                                         // ft
  LAWN_SQFT_PER_PERSON: 10,
  FENCE_BREAK_CHANCE: 0.002, FENCE_NEAR: 7,             // per walking person next to an intact fence
  LITTER_CHANCE: 0.0006,                                 // per person per step, before personality
  LAKE_EDGE_NEAR: 8,                                    // ft from the water counts as "at the lake edge"
  GRASS_GROWTH: 0.003, GRASS_MIN: 2, GRASS_MAX: 20, NEEDS_MOWING: 15, MOW_TO: 5,
  WEAR_PER_PERSON: 0.02, NEEDS_RESEEDING: 70, RESEED_CLOSED_STEPS: 120,
  RAIN_WATER: { none: 0, light: 0.05, heavy: 0.2 },     // in per step on medium ground
  COLLECT: { low: 1.6, medium: 1.0, high: 0.5 },
  DRAIN: { low: 0.04, medium: 0.08, high: 0.14 },
  LAKE_RAIN: { none: 0, light: 0.06, heavy: 0.25 },
  LAKE_FALL_ABOVE: 0.12, LAKE_FALL_BELOW: 0.02, LAKE_BASE: -2, LAKE_MAX: 14,
  MEDIUM_OVERFLOW_AT: 4, WATER_MAX: 12,
  WEED_GROWTH: 0.02, WEED_PER_BROKEN: 0.01, WEEDING_RATE: 0.5, WEED_TRIGGER: 30, WEED_DONE: 15,
  DUCK_BASE: 0.0006, DUCK_SPREAD: 0.002, SKIM_RATE: 12,
  SKIMMER_BOAT_GAP: 10, STEWARD_LAKE_REACH: 3, REPAIR_STEPS: 4, FILL_STEPS: 2,
  BOAT_TRIP: 90,
  AMBIENT_ACTIVITY: 0.004,
  // Personalities.
  DUCK_FEED_CHANCE: 0.06, DUCK_FEED_BOOST: 6, POOP_CHANCE: 0.004, DIG_CHANCE: 0.004,
  // Robots, batteries and the controller.
  BATTERY: { move: 0.22, work: 0.22, idle: 0.03, charge: 3, reserve: 8 },
  PRICE: { mower: 18000, steward: 12000, skimmer: 15000 },
  BUDGET: 150000,
  CONTROLLER_EVERY: 5,
  // The daily goal.
  GOAL_SHARE: 0.6,
  LAWNS_OK_SHARE: 0.8,      // share of lawn area that must look good
  WOODS_OK: { weeds: 50, broken: 3, mess: 3 },
  LAKE_OK: { duckweed: 35, litter: 3 },
};
const PERSON_ACTIVITIES = ['walking', 'standing', 'sitting'];
const STEWARD_ROLES = ['general', 'fence', 'litter', 'weeds'];

export class Model {
  constructor(layout) {
    this.layout = layout;
    this.nav = new Nav(layout);
    this.problems = this.validate();
    if (this.problems.length) console.warn('Layout problems:', this.problems);
    this.reset();
  }

  validate() {
    const L = this.layout, out = [];
    for (const r of [...L.lawns, L.woods, L.lake]) {
      if (![...L.adj[r.id]].some((id) => L.byId[id].kind === 'path')) out.push(`${r.name} does not border a path`);
    }
    for (const p of L.paths) if (p.width < 1.5) out.push(`${p.name} is narrower than 1.5 ft`);
    return out; // Boundaries can't overlap: each grid cell belongs to one region.
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
    // Starting wear comes from the bare soil the land cover shows on each lawn.
    const small = L.lawns.filter((l) => l.elevation === 'low').sort((a, b) => a.area - b.area)[0] || L.lawns[L.lawns.length - 1];
    this.lawns = L.lawns.map((l, i) => ({
      ...l, grassHeight: Math.round((7 + this.rand() * 8) * 10) / 10, wear: Math.min(55, Math.round(8 + l.bareSoil * 150)),
      standingWater: 0, status: 'open', overflow: false, reseedTimer: 0, pendingReseed: false,
    }));
    for (const l of this.lawns) l.wear = Math.max(l.wear, Math.round(5 + this.rand() * 30));
    this.lawns[0].grassHeight = 16.5; // the biggest lawn needs mowing
    const sm = this.lawns.find((l) => l.id === small.id);
    sm.wear = 60; sm.grassHeight = 11;
    this.smallLawn = sm;
    this.regions = [this.lake, this.woods, ...this.paths, ...this.lawns];
    this.byId = Object.fromEntries(this.regions.map((r) => [r.id, r]));
    this.regionByIndex = [];
    for (const r of this.regions) this.regionByIndex[r.index] = r;

    this.fences = L.fences.map((f) => ({ ...f, kind: 'fence', status: 'intact' }));
    this.gate = L.gate; this.landing = L.landing; this.center = L.center;
    // Two broken fences on path-side edges, so the people in the woods can get out.
    const exits = this.fences.filter((f, k) => this.fenceSpots(k, false).length);
    exits.sort((a, b) => a.a.x - b.a.x);
    for (const f of [exits[Math.floor(exits.length * 0.3)], exits[Math.floor(exits.length * 0.75)]]) if (f) f.status = 'broken';

    // Duckweed in a few clustered patches, scaled to 20% average cover.
    const cells = L.grid.cells;
    const blobs = [];
    for (let k = 0; k < 6; k++) { const c = cells[Math.floor(this.rand() * cells.length)]; blobs.push([c.x, c.y, 50 + this.rand() * 60]); }
    let cov = cells.map((c) => {
      let v = 0;
      for (const [bx, by, br] of blobs) v += Math.exp(-((c.x - bx) ** 2 + (c.y - by) ** 2) / (2 * br * br));
      return v < 0.12 ? 0 : Math.min(1, v) * (0.75 + 0.25 * this.rand());
    });
    this.duckweed = Float32Array.from(cov, (v) => v * 100);
    for (let k = 0; k < 6; k++) { const f = 20 / this.duckweedCover(); this.duckweed = this.duckweed.map((v) => Math.min(100, v * f)); }

    this.people = []; this.dogs = []; this.boats = []; this.litter = [];
    this.mowers = []; this.stewards = []; this.skimmers = [];
    this.budget = RULES.BUDGET;
    this.autoRobots = true;
    this.controllerNote = 'Watching the park.';

    const near = (kind, from, k = 0) => {
      const regs = this.regions.filter((r) => r.kind === kind);
      regs.sort((a, b) => G.dist(a.anchor, from) - G.dist(b.anchor, from));
      return regs[Math.min(k, regs.length - 1)];
    };
    const c = this.center.position;
    const walkOn = (r, dog) => { const p = this.makePerson(this.randomPointIn(r), 'walking'); if (dog) this.giveDog(p); return p; };
    walkOn(near('path', c, 2), true); walkOn(near('path', c, 8)); walkOn(near('path', c, 20));
    walkOn(near('path', this.landing.pathPoint, 1), true); walkOn(near('path', this.landing.pathPoint, 10)); walkOn(near('path', c, 40));
    const lawnsByDist = [...this.lawns].sort((a, b) => G.dist(a.anchor, c) - G.dist(b.anchor, c));
    this.makePerson(this.randomPointIn(lawnsByDist[0]), 'sitting');
    this.makePerson(this.randomPointIn(sm), 'sitting');
    this.makePerson(this.randomPointIn(lawnsByDist[2]), 'sitting');
    this.giveDog(this.makePerson(this.randomPointIn(sm), 'standing'));
    walkOn(this.woods); walkOn(this.woods);
    const rowers = [this.makePerson(this.lake.anchor, 'walking'), this.makePerson(this.lake.anchor, 'walking')];
    rowers.forEach((r) => { r.personality.duckFeeder = false; });
    const b = this.makeBoat(this.lake.anchor, 0.6, rowers);
    b.trip = 20;

    const lit = [[sm, 'trash'], [lawnsByDist[1], 'trash'], [near('path', c, 5), 'trash'], [this.woods, 'trash'], [this.woods, 'trash']];
    for (const [r, type] of lit) this.makeLitter(this.randomPointIn(r), type);
    this.makeLitter(this.randomLakePoint(30), 'trash');

    this.buyRobot('mower', this.randomPointIn(near('path', c, 1)), true);
    this.buyRobot('steward', this.randomPointIn(near('path', c, 3)), true);
    this.buyRobot('skimmer', this.randomLakePoint(40), true);

    this.day = { number: 1, steps: 0, ok: { lawns: 0, woods: 0, lake: 0 }, now: this.presentable() };
    this.history = [];
    this.note('Example scene loaded: the Lake and the Ramble, Central Park.');
  }

  newId(prefix) { this.ids[prefix] = (this.ids[prefix] || 0) + 1; return `${prefix}${this.ids[prefix]}`; }
  note(text, alert = false) {
    this.log.unshift({ t: this.clock(), text });
    if (this.log.length > 60) this.log.length = 60;
    if (alert) this.alerts.push(text);
  }
  clock() {
    const m = RULES.DAY_START_MIN + (this.day ? this.day.steps : 0);
    return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  }

  randomPointIn(region, preferTrails = false) {
    const L = this.layout;
    let cells = region.cells;
    if (preferTrails && region.kind === 'woods' && L.trailCells.length && this.rand() < 0.85) cells = L.trailCells;
    const c = cells[Math.floor(this.rand() * cells.length)];
    return { x: L.cx(c) + (this.rand() - 0.5) * 2, y: L.cy(c) + (this.rand() - 0.5) * 2 };
  }
  randomLakePoint(minShore = 20) {
    for (let i = 0; i < 200; i++) { const p = this.randomPointIn(this.lake); if (this.shoreDist(p) >= minShore) return p; }
    return { ...this.lake.anchor };
  }

  makePerson(pos, activity) {
    const r = () => this.rand();
    const p = {
      kind: 'person', id: this.newId('P'), x: pos.x, y: pos.y, activity, dogId: null, route: [], goal: null, wait: 0, boatId: null,
      personality: {
        litterbug: Math.round(r() ** 2 * 100) / 100,   // most people rarely litter
        fenceHopper: Math.round(r() ** 2 * 100) / 100,
        duckFeeder: r() < 0.25,
        picksUpPoop: r() < 0.7,
        letsDogInWoods: r() < 0.3,
      },
    };
    p.location = this.regionIdAt(p) || this.layout.paths[0].id;
    p.prev = { x: p.x, y: p.y };
    this.people.push(p);
    return p;
  }
  giveDog(p) {
    const d = { kind: 'dog', id: this.newId('D'), ownerId: p.id, x: p.x, y: p.y, personality: { digger: this.rand() < 0.3 } };
    d.location = p.location;
    p.dogId = d.id;
    this.dogs.push(d);
    return d;
  }
  makeBoat(pos, heading, rowers) {
    const b = { kind: 'boat', id: this.newId('B'), x: pos.x, y: pos.y, heading, speed: RULES.SPEED.boat, rowers: rowers.map((r) => r.id), trip: 0, state: 'rowing', trail: [], route: [] };
    rowers.forEach((r, i) => { r.activity = 'boating'; r.boatId = b.id; r.location = b.id; r.route = []; r.goal = null; r.x = b.x; r.y = b.y; r.seat = i; });
    this.boats.push(b);
    return b;
  }
  makeLitter(pos, type = 'trash') {
    const l = { kind: 'litter', type, id: this.newId(type === 'hole' ? 'H' : 'L'), x: pos.x, y: pos.y };
    l.location = this.regionIdAt(l) || this.layout.paths[0].id;
    this.litter.push(l);
    return l;
  }

  // ---------- lookups ----------
  get(id) {
    return this.byId[id] || this.people.find((e) => e.id === id) || this.dogs.find((e) => e.id === id)
      || this.boats.find((e) => e.id === id) || this.litter.find((e) => e.id === id) || this.fences.find((e) => e.id === id)
      || this.robots().find((e) => e.id === id) || ({ gate: this.gate, landing: this.landing, center: this.center, weather: this.weather })[id] || null;
  }
  robots() { return [...this.mowers, ...this.stewards, ...this.skimmers]; }
  person(id) { return this.people.find((p) => p.id === id); }
  boat(id) { return this.boats.find((b) => b.id === id); }
  regionIdAt(p) { const r = this.layout.regionAt(p); return r ? r.id : null; }
  regionOfCell(c) { const L = this.layout; return c >= 0 && L.label[c] ? this.regionByIndex[L.label[c]] : null; }
  landRegionAt(p) { const id = this.regionIdAt(p); return id && id !== 'lake' ? id : null; }
  peopleIn(regionId) { return this.people.filter((p) => p.location === regionId && p.activity !== 'boating'); }
  dogsIn(regionId) { return this.dogs.filter((d) => d.location === regionId); }
  woodsOccupied() { return this.people.some((p) => p.location === 'woods'); }
  lakeOverflowing() { return this.lake.waterLevel > 0; }
  duckweedCover() { let s = 0; for (const v of this.duckweed) s += v; return s / this.duckweed.length; }
  lawnCapacity(l) { return Math.floor(l.area / RULES.LAWN_SQFT_PER_PERSON); }
  shoreDist(p) { // ft from a point in the lake to the nearest land cell (approximate)
    const L = this.layout, c = L.cellAt(p);
    if (c < 0 || L.label[c] !== L.lake.index) return 0;
    return this.lakeInner[c] * L.cell;
  }
  cellAt(p) {
    const g = this.layout.grid;
    const c = Math.floor((p.x - g.x0) / g.CELL), r = Math.floor((p.y - g.y0) / g.CELL);
    if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return -1;
    return g.cellIndex[r * g.cols + c];
  }
  get lakeInner() {
    if (!this._lakeInner) { const L = this.layout; this._lakeInner = L.distanceField((c) => L.label[c] !== L.lake.index); }
    return this._lakeInner;
  }

  // ---------- movement rules ----------
  // Can this agent be in (enter) the region?
  allowed(agent, regionId) {
    const r = this.byId[regionId];
    if (!r) return false;
    const k = agent.kind;
    if (k === 'skimmer' || k === 'boat') return r.kind === 'lake';
    if (r.kind === 'lake') return false;
    if (k === 'person') {
      if (r.kind === 'woods') return !(agent.dogId && !agent.personality.letsDogInWoods && agent.location !== 'woods') || agent.goal?.type === 'evacuate';
      if (r.standingWater > RULES.PERSON_MAX_WATER) return false;
      if (r.kind === 'lawn') {
        if (this.mowers.some((m) => m.targetLawn === r.id && m.state === 'mowing')) return false;
        return r.status === 'open' && this.peopleIn(r.id).length < this.lawnCapacity(r);
      }
      return true;
    }
    if (k === 'mower' && r.kind === 'woods') return false;
    if (r.kind === 'woods') return true;
    return r.standingWater <= RULES.ROBOT_MAX_WATER;
  }

  // Search options for an agent: which cells it may use and which steps are allowed.
  navOpts(agent, extra = {}) {
    const L = this.layout, label = L.label, W = L.woods.index;
    const start = agent.location;
    const cache = new Map();
    const passable = (c) => {
      const li = label[c];
      if (!li) return false;
      const r = this.regionByIndex[li];
      if (extra.only && r.id !== extra.only) return false;
      if (r.id === start) return true;
      let v = cache.get(r.id);
      if (v === undefined) { v = this.allowed(agent, r.id); cache.set(r.id, v); }
      return v;
    };
    const step = (a, b) => {
      const wa = label[a] === W, wb = label[b] === W;
      if (wa === wb) return true;
      const f = L.fenceAt[wa ? a : b];
      if (agent.kind === 'person') return f >= 0 && this.fences[f].status === 'broken';
      if (agent.kind === 'steward') return f === -2;
      return false;
    };
    return { passable, step, ...extra };
  }

  cellsToRoute(path, goal) {
    const L = this.layout;
    const out = [];
    let prevDir = null;
    for (let k = 1; k < path.length; k++) {
      const c = path[k], p = path[k - 1];
      const dir = c - p;
      const regionChange = L.label[c] !== L.label[p];
      if (out.length && dir === prevDir && !regionChange) out[out.length - 1] = { x: L.cx(c), y: L.cy(c) };
      else out.push({ x: L.cx(c), y: L.cy(c), cross: regionChange });
      prevDir = regionChange ? null : dir;
    }
    if (goal) {
      const last = out[out.length - 1];
      if (!last || L.cellAt(goal) === path[path.length - 1]) out.push({ x: goal.x, y: goal.y });
    }
    return out;
  }

  // Shortest route to a point. Returns waypoints or null.
  route(agent, goal, opts = {}) {
    const L = this.layout;
    const s = L.cellAt(agent), t = L.cellAt(goal);
    if (s < 0 || t < 0) return null;
    if (s === t) return [{ x: goal.x, y: goal.y }];
    const o = this.navOpts(agent, { ...opts, isGoal: (c) => c === t, goalCell: t });
    if (!o.passable(t)) return null;
    const path = this.nav.search(s, o);
    if (!path) return null;
    const rt = this.cellsToRoute(path, goal);
    rt.length_ft = path.length * L.cell;
    return rt;
  }
  // Route to the nearest cell that passes a test.
  routeWhere(agent, isGoal, opts = {}) {
    const L = this.layout;
    const s = L.cellAt(agent);
    if (s < 0) return null;
    const path = this.nav.search(s, this.navOpts(agent, { ...opts, isGoal }));
    if (!path) return null;
    const rt = this.cellsToRoute(path, null);
    rt.length_ft = path.length * L.cell;
    rt.endCell = path[path.length - 1];
    return rt;
  }

  canStep(agent, q) {
    const L = this.layout;
    const a = L.cellAt(agent), b = L.cellAt(q);
    if (b < 0) return false;
    const r = this.regionOfCell(b);
    if (!r) return false;
    if (r.id !== agent.location && !this.allowed(agent, r.id)) return false;
    const W = L.woods.index;
    if ((L.label[a] === W) !== (L.label[b] === W) && a !== b) {
      const f = L.fenceAt[L.label[a] === W ? a : b];
      if (agent.kind === 'person') return f >= 0 && this.fences[f].status === 'broken';
      if (agent.kind === 'steward') return f === -2;
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
      if (d <= budget) { q = { x: t.x, y: t.y }; budget -= d; } else { q = { x: agent.x + ((t.x - agent.x) / d) * budget, y: agent.y + ((t.y - agent.y) / d) * budget }; budget = 0; }
      // Check each cell boundary crossed on the way.
      const n = Math.ceil(G.dist(agent, q) / (this.layout.cell * 0.8));
      let from = { x: agent.x, y: agent.y };
      for (let k = 1; k <= n; k++) {
        const s = { x: agent.x + ((q.x - agent.x) * k) / n, y: agent.y + ((q.y - agent.y) * k) / n };
        const probe = { ...agent, x: from.x, y: from.y, location: this.regionIdAt(from) || agent.location };
        if (!this.canStep(probe, s)) return 'blocked';
        from = s;
      }
      agent.x = q.x; agent.y = q.y;
      if (q.x === t.x && q.y === t.y) agent.route.shift();
      agent.location = this.regionIdAt(agent) || agent.location;
    }
    return 'ok';
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
    for (const r of this.robots()) this.stepBattery(r);
    this.stepGrowth();
    this.stepChances();
    this.stepLitter();
    if (this.autoRobots && this.time % RULES.CONTROLLER_EVERY === 0) this.runController();
    this.stepGoal();
  }

  stepWater() {
    const rain = this.weather.rainIntensity, lake = this.lake;
    if (rain !== 'none') lake.waterLevel += RULES.LAKE_RAIN[rain];
    else if (lake.waterLevel > 0) lake.waterLevel = Math.max(0, lake.waterLevel - RULES.LAKE_FALL_ABOVE);
    else if (lake.waterLevel > RULES.LAKE_BASE) lake.waterLevel = Math.max(RULES.LAKE_BASE, lake.waterLevel - RULES.LAKE_FALL_BELOW);
    lake.waterLevel = Math.min(RULES.LAKE_MAX, lake.waterLevel);
    const level = lake.waterLevel;
    let newlyClosed = 0;
    for (const r of [...this.paths, ...this.lawns]) {
      const before = r.standingWater;
      if (rain !== 'none') r.standingWater += RULES.RAIN_WATER[rain] * RULES.COLLECT[r.elevation];
      const tier = this.layout.overflowTier[r.id];
      r.overflow = false;
      if (tier === 1 && level > 0) { r.standingWater += 0.1 + level * 0.05; r.overflow = true; }
      if (tier === 2 && level > RULES.MEDIUM_OVERFLOW_AT) { r.standingWater += 0.06 + (level - RULES.MEDIUM_OVERFLOW_AT) * 0.04; r.overflow = true; }
      if (rain === 'none' && !r.overflow) r.standingWater = Math.max(0, r.standingWater - RULES.DRAIN[r.elevation]);
      r.standingWater = Math.min(RULES.WATER_MAX, r.standingWater);
      if (before <= RULES.PERSON_MAX_WATER && r.standingWater > RULES.PERSON_MAX_WATER) {
        newlyClosed++;
        if (r.kind === 'lawn') this.note(`${r.name} has over 3″ of water: closed to people.`);
      }
    }
    if (newlyClosed) this.note(`${newlyClosed} lawn${newlyClosed > 1 ? 's and paths' : ' or path'} went over 3″ of water.`, true);
  }

  stepPerson(p) {
    if (p.activity === 'boating') return;
    p.prev = { x: p.x, y: p.y };
    const here = this.byId[p.location];
    if (here && (here.kind === 'lawn' || here.kind === 'path')) {
      const flooded = here.standingWater > RULES.PERSON_MAX_WATER;
      const closed = here.kind === 'lawn' && here.status !== 'open';
      if ((flooded || closed) && !p.evacuating) {
        const rt = this.routeWhere(p, (c) => {
          const r = this.regionOfCell(c);
          return r && r.id !== p.location && (r.kind === 'path' || (!closed && r.kind === 'lawn'));
        }, { maxExpand: 60000 });
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
      this.maybeFeedDucks(p);
      return;
    }
    if (!p.route.length) {
      if (p.goal && p.goal.type === 'boat') return this.tryBoard(p);
      if (p.goal && p.goal.type === 'activity') { p.activity = p.goal.activity; p.goal = null; return; }
      if (here && here.kind === 'lawn' && this.rand() < 0.05) { p.activity = this.rand() < 0.5 ? 'sitting' : 'standing'; return; }
      if (p.wait > 0) { p.wait--; this.maybeFeedDucks(p); return; }
      this.pickWander(p);
    }
    if (this.moveAlong(p, RULES.SPEED.person) === 'blocked') {
      p.route = [];
      if (p.goal && p.goal.type === 'boat') {
        const rt = this.route(p, this.landing.pathPoint);
        if (rt) p.route = rt; else { p.goal = null; this.note(`${p.id} can't reach the boat landing.`, true); }
      } else if (p.goal) p.goal = null;
    }
    this.maybeFeedDucks(p);
  }

  maybeFeedDucks(p) {
    if (!p.personality.duckFeeder || this.layout.lakeDist[this.layout.cellAt(p)] * this.layout.cell > RULES.LAKE_EDGE_NEAR + 5) return;
    if (this.rand() > RULES.DUCK_FEED_CHANCE) return;
    // Bread feeds the ducks and the water: nearby duckweed grows.
    let n = 0;
    for (let i = 0; i < this.layout.grid.cells.length; i++) {
      const c = this.layout.grid.cells[i];
      if (G.dist(c, p) < 40) { this.duckweed[i] = Math.min(100, this.duckweed[i] + RULES.DUCK_FEED_BOOST); n++; }
    }
    if (n) { p.fedDucks = (p.fedDucks || 0) + 1; if (p.fedDucks === 1) this.note(`${p.id} is feeding the ducks; duckweed nearby grows faster.`); }
  }

  pickWander(p) {
    const inWoods = p.location === 'woods';
    for (let tries = 0; tries < 5; tries++) {
      const x = this.rand();
      let r;
      if (inWoods) r = x < 0.45 ? this.woods : this.paths[Math.floor(this.rand() * this.paths.length)];
      else if (x < 0.62) r = this.paths[Math.floor(this.rand() * this.paths.length)];
      else if (x < 0.92) r = this.lawns[Math.floor(this.rand() * this.lawns.length)];
      else r = this.woods; // only reachable through a broken fence
      if (r.id !== p.location && !this.allowed(p, r.id)) continue;
      if (r.kind === 'lawn' && this.mowers.some((m) => m.targetLawn === r.id)) continue;
      const goal = this.randomPointIn(r, true);
      const rt = this.route(p, goal, { maxExpand: 80000 });
      if (rt) { p.route = rt; p.wait = Math.floor(this.rand() * 4); return; }
    }
    p.wait = 3;
  }

  tryBoard(p) {
    if (G.dist(p, this.landing.pathPoint) > 6) { p.goal = null; return; }
    if (this.lakeOverflowing()) {
      if (!p.waitingBoat) this.note(`${p.id} is waiting: boats can't launch while the lake overflows.`, true);
      p.waitingBoat = true;
      return;
    }
    const crew = this.people.filter((q) => q.goal && q.goal.type === 'boat' && q.activity === 'walking' && !q.route.length && G.dist(q, this.landing.pathPoint) <= 6).slice(0, 2);
    const wp = this.landing.waterPoint;
    this.makeBoat(wp, Math.atan2(this.lake.anchor.y - wp.y, this.lake.anchor.x - wp.x), crew);
    crew.forEach((q) => { q.waitingBoat = false; });
    this.note(`${crew.map((q) => q.id).join(' and ')} launched a boat at the boathouse.`);
  }

  stepDog(d) {
    const o = this.person(d.ownerId);
    if (!o) return;
    let q;
    const moved = G.dist(o, o.prev);
    if (moved > 0.1) {
      // Trot just behind the owner, on the same ground.
      const bx = (o.prev.x - o.x) / moved, by = (o.prev.y - o.y) / moved;
      q = { x: o.x + bx * 3 + (this.rand() - 0.5) * 1.5, y: o.y + by * 3 + (this.rand() - 0.5) * 1.5 };
    } else {
      const a = this.rand() * Math.PI * 2;
      q = { x: o.x + Math.cos(a) * 3, y: o.y + Math.sin(a) * 3 };
    }
    if (this.landRegionAt(q) !== o.location) q = { x: o.x + (this.rand() - 0.5), y: o.y + (this.rand() - 0.5) };
    if (!this.landRegionAt(q)) q = { x: o.x, y: o.y };
    d.x = q.x; d.y = q.y;
    d.location = this.landRegionAt(d) || o.location;
    // Personality: poop (picked up or not) and digging.
    if (this.rand() < RULES.POOP_CHANCE) {
      if (o.personality.picksUpPoop) { o.pickedUp = (o.pickedUp || 0) + 1; }
      else { this.makeLitter({ x: d.x, y: d.y }, 'poop'); this.note(`${d.id}'s owner ${o.id} left dog poop behind.`); }
    }
    const r = this.byId[d.location];
    if (d.personality.digger && r && r.kind === 'lawn' && this.rand() < RULES.DIG_CHANCE) {
      this.makeLitter({ x: d.x, y: d.y }, 'hole');
      r.wear = Math.min(100, r.wear + 1);
      this.note(`${d.id} dug a hole in ${r.name}.`);
    }
  }

  stepBoat(b) {
    b.trip++;
    if (b.state === 'rowing' && b.trip > RULES.BOAT_TRIP) {
      b.state = 'returning';
      b.route = this.lakeRoute(b, this.landing.waterPoint) || [];
    }
    let next = null;
    if (b.state === 'returning') {
      if (G.dist(b, this.landing.waterPoint) < 8 || !b.route.length) return this.dockBoat(b);
      const t = b.route[0], d = G.dist(b, t);
      b.heading = Math.atan2(t.y - b.y, t.x - b.x);
      next = d <= b.speed ? (b.route.shift(), { x: t.x, y: t.y }) : { x: b.x + Math.cos(b.heading) * b.speed, y: b.y + Math.sin(b.heading) * b.speed };
    } else {
      b.heading += (this.rand() - 0.5) * 0.35;
      for (let tries = 0; tries < 12; tries++) {
        const q = { x: b.x + Math.cos(b.heading) * b.speed, y: b.y + Math.sin(b.heading) * b.speed };
        if (this.shoreDist(q) >= 15) { next = q; break; }
        b.heading += (this.rand() < 0.5 ? -1 : 1) * (0.5 + this.rand());
      }
    }
    if (!next) return;
    this.pushDuckweed(b, next);
    b.trail.unshift({ x: b.x, y: b.y, h: b.heading });
    if (b.trail.length > 10) b.trail.length = 10;
    b.x = next.x; b.y = next.y;
    b.rowers.forEach((id) => { const r = this.person(id); if (r) { r.x = b.x; r.y = b.y; } });
  }

  // A moving boat pushes duckweed out of the cells it passes into the cells on either side.
  pushDuckweed(b, next) {
    const g = this.layout.grid.CELL;
    const steps = Math.ceil(G.dist(b, next) / 4);
    const h = Math.atan2(next.y - b.y, next.x - b.x), px = -Math.sin(h), py = Math.cos(h);
    for (let i = 1; i <= steps; i++) {
      const s = { x: b.x + ((next.x - b.x) * i) / steps, y: b.y + ((next.y - b.y) * i) / steps };
      const c = this.cellAt(s);
      if (c < 0 || this.duckweed[c] <= 0) continue;
      const amt = this.duckweed[c];
      this.duckweed[c] = 0;
      for (const side of [-1, 1]) {
        const nb = this.cellAt({ x: s.x + px * side * g, y: s.y + py * side * g });
        if (nb >= 0 && nb !== c) this.duckweed[nb] = Math.min(100, this.duckweed[nb] + amt / 2);
      }
    }
  }

  lakeRoute(agent, goal) {
    const probe = { kind: 'boat', x: agent.x, y: agent.y, location: 'lake' };
    return this.route(probe, goal, { maxExpand: 120000 });
  }

  dockBoat(b) {
    const pp = this.landing.pathPoint;
    for (const id of b.rowers) {
      const r = this.person(id);
      if (!r) continue;
      r.activity = 'walking'; r.boatId = null; r.x = pp.x + (this.rand() - 0.5) * 2; r.y = pp.y; r.prev = { x: r.x, y: r.y };
      r.location = this.regionIdAt(r) || this.landing.pathId; r.route = []; r.wait = 2;
    }
    this.boats = this.boats.filter((x) => x !== b);
    this.note(`Boat ${b.id} returned to the boathouse.`);
  }

  // ---------- robots ----------
  buyRobot(kind, pos, initial = false) {
    const r = { kind, id: this.newId(kind === 'mower' ? 'M' : kind === 'steward' ? 'S' : 'K'), x: pos.x, y: pos.y, state: 'idle', route: [], target: null, note: '', battery: 100, role: kind === 'steward' ? 'general' : null, recalled: false };
    r.location = this.regionIdAt(r);
    r.price = RULES.PRICE[kind];
    if (kind === 'mower') { r.targetLawn = null; r.task = null; this.mowers.push(r); }
    if (kind === 'steward') { r.work = 0; this.stewards.push(r); }
    if (kind === 'skimmer') this.skimmers.push(r);
    if (!initial) this.note(`Robot ${r.id} (${kind}) bought for $${(r.price / 1000).toFixed(0)}k.`);
    return r;
  }
  fleetCost() { return this.robots().reduce((s, r) => s + r.price, 0); }
  home(r) { return r.kind === 'skimmer' ? this.center.dock : this.center.position; }
  deployed(r) { return r.state !== 'docked' && !r.recalled && r.state !== 'returning' && r.state !== 'charging'; }

  releaseTask(r) {
    if (r.kind === 'mower' && r.targetLawn) {
      const lawn = this.byId[r.targetLawn];
      if (lawn.status === 'reseeding' && lawn.pendingReseed) { lawn.status = 'open'; lawn.pendingReseed = false; }
      r.targetLawn = null; r.task = null;
    }
    r.target = null;
  }

  // Robots drain their battery as they work and go home to recharge.
  stepBattery(r) {
    const B = RULES.BATTERY;
    if (r.state === 'charging' || r.state === 'docked') {
      r.battery = Math.min(100, r.battery + B.charge);
      if (r.state === 'charging' && r.battery >= 100) {
        r.state = r.recalled ? 'docked' : 'idle';
        this.note(`${r.id} is fully charged${r.recalled ? ' and parked' : ''}.`);
      }
      return;
    }
    const busy = r.state !== 'idle';
    r.battery = Math.max(0, r.battery - (busy ? B.move : B.idle));
    if (r.state === 'returning') return;
    const homeDist = G.dist(r, this.home(r)) * 2;
    const need = (homeDist / RULES.SPEED[r.kind]) * B.move + B.reserve;
    if (r.battery <= need || r.recalled) {
      this.releaseTask(r);
      r.state = 'returning';
      r.route = this.routeHome(r) || [];
      if (!r.recalled) this.note(`${r.id} is low on battery (${Math.round(r.battery)}%) and is heading to the robot center.`);
    }
  }
  routeHome(r) {
    if (r.kind === 'skimmer') return this.lakeRoute(r, this.center.dock);
    return this.route(r, this.center.position, { maxExpand: 250000 });
  }
  stepReturning(r) {
    if (r.route.length) { this.robotMove(r, RULES.SPEED[r.kind]); if (r.route.length) return true; }
    if (G.dist(r, this.home(r)) > 6) { r.route = this.routeHome(r) || [{ ...this.home(r) }]; return true; }
    r.state = r.battery >= 100 && r.recalled ? 'docked' : 'charging';
    return true;
  }

  robotMove(r, speed) {
    const here = this.byId[r.location];
    if (here && here.kind !== 'lake' && here.standingWater > RULES.ROBOT_MAX_WATER) { r.note = 'waiting for water to drain'; return 'blocked'; }
    const res = this.moveAlong(r, speed);
    r.note = res === 'blocked' ? 'waiting for water to drain' : '';
    if (res === 'blocked') r.blocked = (r.blocked || 0) + 1; else r.blocked = 0;
    return res;
  }

  sendMower(m, lawn, task) {
    const rt = m.location === lawn.id ? [] : this.routeWhere(m, (c) => {
      const r = this.regionOfCell(c);
      if (!r || r.kind !== 'path') return false;
      let ok = false;
      this.layout.neighbors4(c, (n) => { if (this.layout.label[n] === lawn.index) ok = true; });
      return ok;
    }, { maxExpand: 250000 });
    if (!rt) return false;
    m.targetLawn = lawn.id; m.task = task; m.route = rt; m.state = 'traveling'; m.note = ''; m.recalled = false;
    this.note(`${m.id} heading to ${task} ${lawn.name}.`);
    return true;
  }

  lawnNeeds(l) {
    if (l.status === 'reseeding') return null;
    if (l.wear > RULES.NEEDS_RESEEDING) return 'reseed';
    if (l.grassHeight > RULES.NEEDS_MOWING) return 'mow';
    return null;
  }

  stepMower(m) {
    if (m.state === 'docked' || m.state === 'charging') return;
    if (m.state === 'returning') return this.stepReturning(m);
    if (m.state === 'idle') {
      const taken = new Set(this.mowers.filter((x) => x !== m && x.targetLawn).map((x) => x.targetLawn));
      const free = this.lawns.filter((l) => !taken.has(l.id));
      const reseed = free.filter((l) => this.lawnNeeds(l) === 'reseed').sort((a, b) => G.dist(a.anchor, m) - G.dist(b.anchor, m));
      const mow = free.filter((l) => this.lawnNeeds(l) === 'mow').sort((a, b) => b.grassHeight - a.grassHeight);
      if (reseed.length) this.sendMower(m, reseed[0], 'reseed');
      else if (mow.length) this.sendMower(m, mow[0], 'mow');
      return;
    }
    const lawn = this.byId[m.targetLawn];
    if (m.state === 'traveling') {
      if (m.route.length) { this.robotMove(m, RULES.SPEED.mower); if (m.route.length) { if (m.blocked > 40) { this.releaseTask(m); m.state = 'idle'; m.route = []; } return; } }
      if (m.task === 'reseed' && lawn.status !== 'reseeding') {
        lawn.status = 'reseeding'; lawn.pendingReseed = true; lawn.reseedTimer = 0;
        this.note(`${lawn.name} closed for reseeding; people move to the nearest path.`, true);
      }
      const occupied = this.peopleIn(lawn.id).length + this.dogsIn(lawn.id).length > 0;
      const wet = m.task === 'mow' ? lawn.standingWater > 0.05 : lawn.standingWater > RULES.ROBOT_MAX_WATER;
      if (occupied || wet) { m.note = occupied ? 'waiting: people or dogs on the lawn' : 'waiting: standing water on the lawn'; m.waited = (m.waited || 0) + 1; return; }
      m.note = ''; m.waited = 0;
      m.route = this.sweepPattern(lawn, m);
      m.state = m.task === 'mow' ? 'mowing' : 'reseeding';
      if (m.task === 'reseed') { lawn.wear = 0; lawn.grassHeight = RULES.GRASS_MIN; lawn.pendingReseed = false; }
      return;
    }
    if (m.state === 'mowing' || m.state === 'reseeding') {
      if (m.state === 'mowing' && this.peopleIn(lawn.id).length + this.dogsIn(lawn.id).length > 0) { m.note = 'paused: people on the lawn'; return; }
      if (m.state === 'mowing' && lawn.standingWater > 0.05) { m.note = 'paused: standing water'; return; }
      m.note = '';
      const res = this.robotMove(m, RULES.SPEED.mower);
      if (res === 'blocked') m.route.shift();
      if (!m.route.length) {
        if (m.state === 'mowing') { lawn.grassHeight = RULES.MOW_TO; this.note(`${m.id} mowed ${lawn.name} to 5″.`); }
        else { lawn.reseedTimer = RULES.RESEED_CLOSED_STEPS; this.note(`${m.id} reseeded ${lawn.name}; it stays closed for ${RULES.RESEED_CLOSED_STEPS} minutes.`); }
        m.state = 'idle'; m.targetLawn = null; m.task = null;
      }
    }
  }

  // Lanes 25 ft apart across the lawn, driven back and forth.
  sweepPattern(lawn, from) {
    const L = this.layout, cols = L.cols;
    const rowsOf = new Map();
    for (const c of lawn.cells) {
      const r = Math.floor(c / cols);
      if (r % 5 !== 2) continue;
      if (!rowsOf.has(r)) rowsOf.set(r, []);
      rowsOf.get(r).push(c % cols);
    }
    const lanes = [];
    for (const [r, cs] of [...rowsOf.entries()].sort((a, b) => a[0] - b[0])) {
      cs.sort((a, b) => a - b);
      let s = cs[0];
      for (let k = 1; k <= cs.length; k++) {
        if (k === cs.length || cs[k] !== cs[k - 1] + 1) { lanes.push([r * cols + s, r * cols + cs[k - 1]]); if (k < cs.length) s = cs[k]; }
      }
    }
    if (Math.abs(L.cy(lanes[0]?.[0] ?? 0) - from.y) > Math.abs(L.cy(lanes[lanes.length - 1]?.[0] ?? 0) - from.y)) lanes.reverse();
    const pts = [];
    let cur = L.cellAt(from), flip = false;
    const probe = { kind: 'mower', location: lawn.id };
    for (const [a0, b0] of lanes) {
      const [a, b] = flip ? [b0, a0] : [a0, b0];
      flip = !flip;
      // Drive inside the lawn from the end of the last lane to the start of this one.
      const path = this.nav.search(cur, this.navOpts(probe, { only: lawn.id, isGoal: (c) => c === a, goalCell: a, maxExpand: 20000 }));
      if (path && path.length > 2) for (const c of path.slice(1, -1)) if (G.dist({ x: L.cx(c), y: L.cy(c) }, pts[pts.length - 1] || from) > 12) pts.push({ x: L.cx(c), y: L.cy(c) });
      pts.push({ x: L.cx(a), y: L.cy(a) }, { x: L.cx(b), y: L.cy(b) });
      cur = b;
    }
    if (!pts.length) pts.push({ ...lawn.anchor });
    return pts;
  }

  stepSteward(s) {
    if (s.state === 'docked' || s.state === 'charging') return;
    if (s.state === 'returning') return this.stepReturning(s);
    if (s.state === 'idle') return this.chooseStewardTask(s);
    const t = s.target;
    if (t.type === 'litter' && !this.litter.find((l) => l.id === t.id)) { s.state = 'idle'; s.target = null; s.route = []; return; }
    if (t.type === 'fence' && this.fences.find((f) => f.id === t.id).status === 'intact') { s.state = 'idle'; s.target = null; return; }
    if (s.state === 'traveling') {
      if (s.route.length) {
        this.robotMove(s, RULES.SPEED.steward);
        if (s.blocked > 40) { s.state = 'idle'; s.target = null; s.route = []; return; }
        if (s.route.length) return;
      }
      const lit = t.type === 'litter' && this.litter.find((l) => l.id === t.id);
      s.state = t.type === 'fence' ? 'repairing' : t.type === 'woods' ? 'weeding' : lit && lit.type === 'hole' ? 'repairing' : 'collecting';
      s.work = 0;
      return;
    }
    if (s.state === 'repairing' && t.type === 'litter') {
      if (++s.work >= RULES.FILL_STEPS) {
        this.litter = this.litter.filter((l) => l.id !== t.id);
        this.note(`${s.id} filled hole ${t.id}.`);
        s.state = 'idle'; s.target = null;
      }
      return;
    }
    if (s.state === 'repairing') {
      if (this.woodsOccupied()) { s.note = 'waiting: people in the woods'; return; }
      s.note = '';
      if (++s.work >= RULES.REPAIR_STEPS) {
        this.fences.find((f) => f.id === t.id).status = 'intact';
        this.note(`${s.id} repaired fence ${t.id}.`);
        s.state = 'idle'; s.target = null;
      }
      return;
    }
    if (s.state === 'collecting') {
      const l = this.litter.find((x) => x.id === t.id);
      this.litter = this.litter.filter((x) => x.id !== t.id);
      this.note(`${s.id} collected ${l && l.type === 'poop' ? 'dog poop' : 'litter'} ${t.id}.`);
      s.state = 'idle'; s.target = null;
      return;
    }
    if (s.state === 'weeding') {
      if (s.location === 'woods') this.woods.weedCover = Math.max(0, this.woods.weedCover - RULES.WEEDING_RATE);
      s.work++;
      const urgent = s.role === 'general' && s.work % 15 === 0 && (this.repairableFence(s) || this.nearestLitter(s, false));
      if (this.woods.weedCover <= RULES.WEED_DONE || urgent) { s.state = 'idle'; s.target = null; s.route = []; return; }
      if (!s.route.length) s.route = this.route(s, this.randomPointIn(this.woods, true), { maxExpand: 60000 }) || [];
      this.robotMove(s, RULES.SPEED.steward * 0.4);
    }
  }

  // Cells a steward can work on a fence from: the path or lawn side if there
  // is one (outside), otherwise inside the woods.
  fenceSpots(k, inside) {
    const L = this.layout, out = [];
    for (const c of L.woods.cells) {
      if (L.fenceAt[c] !== k) continue;
      if (inside) { out.push(c); continue; }
      L.neighbors4(c, (n) => { const r = L.regionOfCell(n); if (r && (r.kind === 'path' || r.kind === 'lawn')) out.push(n); });
    }
    return out;
  }
  repairableFence(s, evenIfOccupied = false) {
    if (!evenIfOccupied && this.woodsOccupied()) return null;
    const taken = new Set(this.stewards.filter((x) => x !== s && x.target && x.target.type === 'fence').map((x) => x.target.id));
    const goals = new Map();
    this.fences.forEach((f, k) => {
      if (f.status !== 'broken' || taken.has(f.id)) return;
      let spots = this.fenceSpots(k, false);
      if (!spots.length) spots = this.fenceSpots(k, true);
      for (const c of spots) goals.set(c, f);
    });
    if (!goals.size) return null;
    const rt = this.routeWhere(s, (c) => goals.has(c), { maxExpand: 250000 });
    return rt ? { f: goals.get(rt.endCell), rt } : null;
  }
  nearestLitter(s, includeShore = true, types = null) {
    const L = this.layout;
    const taken = new Set([...this.stewards, ...this.skimmers].filter((x) => x !== s && x.target && x.target.type === 'litter').map((x) => x.target.id));
    const goals = new Map();
    for (const l of this.litter) {
      if (taken.has(l.id) || (types && !types.includes(l.type))) continue;
      if (l.location !== 'lake') { goals.set(L.cellAt(l), l); continue; }
      if (!includeShore || this.shoreDist(l) > RULES.STEWARD_LAKE_REACH + L.cell / 2) continue;
      const c = L.cellAtNearest(l, (r) => r.kind === 'path' || r.kind === 'lawn' || r.kind === 'woods');
      if (G.dist({ x: L.cx(c), y: L.cy(c) }, l) < 12) goals.set(c, l);
    }
    if (!goals.size) return null;
    const rt = this.routeWhere(s, (c) => goals.has(c), { maxExpand: 250000 });
    return rt ? { l: goals.get(rt.endCell), rt } : null;
  }

  chooseStewardTask(s) {
    const role = s.role || 'general';
    const tryFence = () => {
      const fence = this.repairableFence(s, role === 'fence');
      if (fence) { s.target = { type: 'fence', id: fence.f.id }; s.route = fence.rt; s.state = 'traveling'; this.note(`${s.id} going to repair fence ${fence.f.id}.`); return true; }
      return false;
    };
    const tryLitter = () => {
      const lit = this.nearestLitter(s, true);
      if (lit) { s.target = { type: 'litter', id: lit.l.id }; s.route = lit.rt; s.state = 'traveling'; return true; }
      return false;
    };
    const tryWeeds = () => {
      if (this.woods.weedCover <= RULES.WEED_TRIGGER || this.stewards.some((x) => x !== s && x.target && x.target.type === 'woods' && role === 'general')) return false;
      const rt = this.route(s, this.randomPointIn(this.woods, true), { maxExpand: 250000 });
      if (rt) { s.target = { type: 'woods', id: 'woods' }; s.route = rt; s.state = 'traveling'; this.note(`${s.id} going to weed the Ramble (through the gate).`); return true; }
      return false;
    };
    if (role === 'fence') return void tryFence();
    if (role === 'litter') return void tryLitter();
    if (role === 'weeds') return void tryWeeds();
    if (!tryFence() && !tryLitter()) tryWeeds();
  }

  stepSkimmer(k) {
    if (k.state === 'docked' || k.state === 'charging') return;
    if (k.state === 'returning') return this.stepReturning(k);
    for (const l of [...this.litter]) {
      if (l.location === 'lake' && G.dist(l, k) < 8) { this.litter = this.litter.filter((x) => x !== l); this.note(`${k.id} picked up floating litter ${l.id}.`); }
    }
    const nearBoat = (p) => this.boats.some((b) => G.dist(p, b) < RULES.SKIMMER_BOAT_GAP);
    if (nearBoat(k)) {
      const b = this.boats.reduce((a, c) => (G.dist(c, k) < G.dist(a, k) ? c : a));
      for (const turn of [0, 0.6, -0.6, 1.2, -1.2, 2]) {
        const a = Math.atan2(k.y - b.y, k.x - b.x) + turn;
        const q = { x: k.x + Math.cos(a) * RULES.SPEED.skimmer, y: k.y + Math.sin(a) * RULES.SPEED.skimmer };
        if (this.shoreDist(q) >= 4) { k.x = q.x; k.y = q.y; break; }
      }
      k.note = 'keeping 10 ft from boats'; k.route = [];
      if (k.state === 'eating') k.state = 'traveling';
      return;
    }
    k.note = '';
    const cells = this.layout.grid.cells;
    if (k.state === 'idle') {
      // Floating litter first if it is close, then the densest duckweed.
      const lit = this.litter.filter((l) => l.location === 'lake' && !this.robots().some((r) => r !== k && r.target && r.target.id === l.id)).sort((a, b) => G.dist(a, k) - G.dist(b, k))[0];
      if (lit) { k.target = { type: 'litter', id: lit.id }; k.route = this.lakeRoute(k, lit) || []; k.state = 'traveling'; return; }
      const others = new Set(this.skimmers.filter((x) => x !== k && x.target && x.target.type === 'cell').map((x) => x.target.id));
      let best = -1, bv = -1;
      for (let i = 0; i < cells.length; i++) {
        const v = this.duckweed[i];
        if (v < 5 || others.has(i) || nearBoat(cells[i])) continue;
        const score = v - G.dist(cells[i], k) * 0.02;
        if (score > bv) { bv = score; best = i; }
      }
      if (best >= 0) { k.target = { type: 'cell', id: best }; k.route = this.lakeRoute(k, cells[best]) || [{ x: cells[best].x, y: cells[best].y }]; k.state = 'traveling'; }
      return;
    }
    if (k.state === 'traveling') {
      if (k.target.type === 'litter' && !this.litter.find((l) => l.id === k.target.id)) { k.state = 'idle'; k.target = null; return; }
      const before = { x: k.x, y: k.y };
      if (k.route.length) {
        const t = k.route[0];
        const d = G.dist(k, t), step = Math.min(d, RULES.SPEED.skimmer);
        const q = d ? { x: k.x + ((t.x - k.x) / d) * step, y: k.y + ((t.y - k.y) / d) * step } : t;
        if (nearBoat(q)) { k.note = 'waiting for a boat to pass'; return; }
        k.x = q.x; k.y = q.y;
        if (step >= d) k.route.shift();
      }
      if (!k.route.length) {
        if (k.target.type === 'cell') k.state = 'eating';
        else { k.state = 'idle'; k.target = null; }
      }
      if (G.dist(before, k) < 0.01 && k.route.length) k.route.shift();
      return;
    }
    if (k.state === 'eating') {
      const i = k.target.id;
      this.duckweed[i] = Math.max(0, this.duckweed[i] - RULES.SKIM_RATE);
      if (this.duckweed[i] <= 0.5) {
        const n = cells[i].nbrs.filter((j) => this.duckweed[j] > 5).sort((a, b) => this.duckweed[b] - this.duckweed[a])[0];
        if (n !== undefined) { k.target = { type: 'cell', id: n }; k.route = [{ x: cells[n].x, y: cells[n].y }]; k.state = 'traveling'; } else { k.state = 'idle'; k.target = null; }
      }
    }
  }

  // ---------- the robot controller ----------
  // Works out how many robots of each kind the park needs right now, deploys
  // parked ones, buys new ones while the budget allows, and parks the rest.
  demand() {
    const broken = this.fences.filter((f) => f.status === 'broken').length;
    const landMess = this.litter.filter((l) => l.location !== 'lake').length;
    const floating = this.litter.filter((l) => l.location === 'lake').length;
    const lawnsNeeding = this.lawns.filter((l) => this.lawnNeeds(l)).length;
    const duck = this.duckweedCover(), weeds = this.woods.weedCover;
    const share = this.dayShares();
    const behind = (k) => this.day.steps > 30 && share[k] < RULES.GOAL_SHARE ? 1 : 0;
    const want = {
      mower: Math.min(4, Math.ceil(lawnsNeeding / 3) + (lawnsNeeding ? behind('lawns') : 0)),
      fence: broken ? Math.min(2, 1 + (broken > 4 ? 1 : 0)) : 0,
      litter: Math.min(3, Math.ceil(landMess / 8) + (landMess ? behind('lawns') : 0)),
      weeds: weeds > RULES.WEED_TRIGGER ? Math.min(2, 1 + (weeds > 50 ? 1 : 0) + behind('woods')) : 0,
      skimmer: Math.min(4, (duck > 15 ? Math.ceil((duck - 15) / 6) : 0) + (floating > 2 ? 1 : 0) + (duck > 15 ? behind('lake') : 0)),
    };
    const why = [];
    if (lawnsNeeding) why.push(`${lawnsNeeding} lawn${lawnsNeeding > 1 ? 's' : ''} need mowing or reseeding`);
    if (broken) why.push(`${broken} broken fence${broken > 1 ? 's' : ''}`);
    if (landMess) why.push(`${landMess} litter, poop or holes on land`);
    if (weeds > RULES.WEED_TRIGGER) why.push(`weeds at ${Math.round(weeds)}%`);
    if (duck > 15) why.push(`duckweed at ${Math.round(duck)}%`);
    return { want, why };
  }

  runController() {
    const { want, why } = this.demand();
    const share = this.dayShares();
    const order = ['lawns', 'woods', 'lake'].sort((a, b) => share[a] - share[b]);
    const slots = { lawns: [['mower', null], ['steward', 'litter']], woods: [['steward', 'fence'], ['steward', 'weeds']], lake: [['skimmer', null]] };
    const actions = [];
    const active = (kind, role) => this.robots().filter((r) => r.kind === kind && (!role || r.role === role) && this.deployed(r));
    for (const eco of order) {
      for (const [kind, role] of slots[eco]) {
        const w = want[role || kind];
        const have = active(kind, role);
        if (have.length < w) {
          // Re-deploy a parked robot (and give a general steward a role) before buying.
          let r = this.robots().find((x) => x.kind === kind && (x.state === 'docked' || x.recalled) && x.battery >= 50)
            || (kind === 'steward' && this.stewards.find((x) => x.role === 'general' && this.deployed(x) && x.state === 'idle'));
          if (r) {
            if (r.state === 'docked') { r.state = 'idle'; }
            r.recalled = false;
            if (role) r.role = role;
            actions.push(`deployed ${r.id}${role ? ` as ${role} steward` : ''}`);
          } else if (this.fleetCost() + RULES.PRICE[kind] <= this.budget) {
            r = this.buyRobot(kind, kind === 'skimmer' ? { ...this.center.dock } : { ...this.center.position });
            if (role) r.role = role;
            actions.push(`bought ${r.id}${role ? ` (${role})` : ''}`);
          }
        } else if (have.length > w) {
          const extra = have.find((x) => x.state === 'idle' && x.role !== 'general');
          if (extra && w >= 0 && (kind !== 'mower' || w < have.length)) {
            extra.recalled = true;
            actions.push(`parked ${extra.id}`);
          }
        }
      }
    }
    // Keep at least one of each kind out if nothing else is going on? No: idle robots go home.
    if (actions.length) this.note(`Controller: ${actions.join(', ')}.`);
    this.controllerNote = why.length ? `Needs: ${why.join(', ')}.` : 'The park looks good.';
    this.lastWant = want;
  }

  // ---------- the daily goal ----------
  presentable() {
    const R = RULES;
    let ok = 0, all = 0;
    const messOn = new Map();
    for (const l of this.litter) messOn.set(l.location, (messOn.get(l.location) || 0) + 1);
    for (const l of this.lawns) {
      all += l.area;
      if (l.grassHeight <= R.NEEDS_MOWING && l.wear <= R.NEEDS_RESEEDING && l.standingWater <= R.PERSON_MAX_WATER && !messOn.get(l.id)) ok += l.area;
    }
    const lawnShare = ok / all;
    const broken = this.fences.filter((f) => f.status === 'broken').length;
    const woodsMess = messOn.get('woods') || 0;
    const lakeMess = messOn.get('lake') || 0;
    return {
      lawns: lawnShare >= R.LAWNS_OK_SHARE, lawnShare,
      woods: this.woods.weedCover <= R.WOODS_OK.weeds && broken <= R.WOODS_OK.broken && woodsMess <= R.WOODS_OK.mess,
      lake: this.duckweedCover() <= R.LAKE_OK.duckweed && lakeMess <= R.LAKE_OK.litter,
      detail: { broken, woodsMess, lakeMess },
    };
  }
  dayShares() {
    const d = this.day, n = Math.max(1, d.steps);
    return { lawns: d.ok.lawns / n, woods: d.ok.woods / n, lake: d.ok.lake / n };
  }
  stepGoal() {
    const d = this.day;
    const now = this.presentable();
    d.now = now;
    d.steps++;
    for (const k of ['lawns', 'woods', 'lake']) if (now[k]) d.ok[k]++;
    if (d.steps >= RULES.DAY_STEPS) {
      const s = this.dayShares();
      const met = Object.values(s).every((v) => v >= RULES.GOAL_SHARE);
      this.history.push({ day: d.number, ...s, met });
      this.note(`Day ${d.number} ${met ? 'met' : 'missed'} the goal: lawns ${Math.round(s.lawns * 100)}%, woods ${Math.round(s.woods * 100)}%, lake ${Math.round(s.lake * 100)}%.`, true);
      this.day = { number: d.number + 1, steps: 0, ok: { lawns: 0, woods: 0, lake: 0 }, now };
    }
  }

  // ---------- growth ----------
  stepGrowth() {
    const R = RULES;
    for (const l of this.lawns) {
      const n = this.peopleIn(l.id).length + 2 * this.dogsIn(l.id).length;
      const mult = l.overflow ? 3 : l.standingWater > 0.05 ? 2 : 1;
      const before = l.wear;
      l.wear = Math.min(100, l.wear + R.WEAR_PER_PERSON * n * mult);
      if (before <= R.NEEDS_RESEEDING && l.wear > R.NEEDS_RESEEDING) this.note(`${l.name} is over 70% worn and needs reseeding.`, true);
      if (l.wear <= R.NEEDS_RESEEDING) {
        const g = l.grassHeight;
        l.grassHeight = Math.min(R.GRASS_MAX, l.grassHeight + R.GRASS_GROWTH);
        if (g <= R.NEEDS_MOWING && l.grassHeight > R.NEEDS_MOWING) this.note(`${l.name} grass is over 15″ and needs mowing.`);
      }
      if (l.status === 'reseeding' && !l.pendingReseed && l.reseedTimer > 0) {
        if (--l.reseedTimer === 0) { l.status = 'open'; this.note(`${l.name} reopened after reseeding.`); }
      }
    }
    const broken = this.fences.filter((f) => f.status === 'broken').length;
    const dogsInWoods = this.dogsIn('woods').length;
    this.woods.weedCover = Math.min(100, this.woods.weedCover + R.WEED_GROWTH + R.WEED_PER_BROKEN * broken + 0.01 * dogsInWoods);

    const cells = this.layout.grid.cells, dw = this.duckweed, next = new Float32Array(dw.length);
    for (let i = 0; i < cells.length; i++) {
      const c = dw[i];
      let more = 0;
      for (const j of cells[i].nbrs) more = Math.max(more, dw[j] - c);
      next[i] = Math.min(100, c + (R.DUCK_BASE * c + R.DUCK_SPREAD * more) * (1 - c / 100));
    }
    this.duckweed = next;
  }

  stepChances() {
    for (const p of this.people) {
      const pers = p.personality;
      if (p.activity === 'walking' && p.activity !== 'boating') {
        const chance = RULES.FENCE_BREAK_CHANCE * (0.2 + 3 * pers.fenceHopper);
        for (const f of this.fences) {
          if (f.status === 'intact' && Math.abs(f.a.x - p.x) < 60 && Math.abs(f.a.y - p.y) < 60 && G.closestOnSegment(p, f.a, f.b).d < RULES.FENCE_NEAR && this.rand() < chance) {
            f.status = 'broken';
            this.note(`${p.id} broke fence ${f.id}.`, true);
            break;
          }
        }
      }
      if (this.rand() < RULES.LITTER_CHANCE * (0.2 + 6 * pers.litterbug)) this.dropLitterBy(p, true);
    }
  }

  dropLitterBy(p, chance = false) {
    const boat = p.boatId && this.boat(p.boatId);
    const L = this.layout;
    let pos;
    if (boat) pos = { x: boat.x + (this.rand() - 0.5) * 4, y: boat.y + (this.rand() - 0.5) * 4 };
    else if (chance && L.lakeDist[L.cellAt(p)] * L.cell <= RULES.LAKE_EDGE_NEAR && this.rand() < 0.5) {
      const c = L.cellAtNearest(p, (r) => r.kind === 'lake');
      pos = { x: L.cx(c), y: L.cy(c) };
    } else if (chance) pos = { x: p.x, y: p.y };
    else {
      for (let i = 0; i < 20 && !pos; i++) {
        const a = this.rand() * Math.PI * 2, r = 1 + this.rand() * 4;
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
    const L = this.layout;
    for (const l of this.litter) {
      if (l.type === 'hole') continue;
      const r = this.byId[l.location];
      if (r && (r.kind === 'lawn' || r.kind === 'path') && r.standingWater > RULES.PERSON_MAX_WATER) {
        // Wash downhill toward the lake, a few cells per step.
        let c = L.cellAt(l);
        for (let k = 0; k < 3; k++) {
          let best = c;
          L.neighbors4(c, (n) => { if (L.lakeDist[n] < L.lakeDist[best]) best = n; });
          c = best;
        }
        l.x = L.cx(c) + (this.rand() - 0.5) * 2; l.y = L.cy(c) + (this.rand() - 0.5) * 2;
        const now = this.regionIdAt(l);
        if (now) l.location = now;
        if (l.location === 'lake') this.note(`Litter ${l.id} washed into the lake.`);
      } else if (l.location === 'lake') {
        const q = { x: l.x + (this.rand() - 0.5) * 1.5, y: l.y + (this.rand() - 0.5) * 1.5 };
        if (this.regionIdAt(q) === 'lake') { l.x = q.x; l.y = q.y; }
      }
    }
  }

  // ---------- toolbar actions ----------
  // Each returns { ok, msg } so the UI can explain a refusal.
  addPerson() {
    const ok = this.paths.filter((p) => this.allowed({ kind: 'person', personality: {} }, p.id));
    if (!ok.length) return { ok: false, msg: 'Every path is flooded; no one can be placed.' };
    const r = ok[Math.floor(this.rand() * ok.length)];
    const p = this.makePerson(this.randomPointIn(r), 'walking');
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
    const rt = this.routeWhere(p, (c) => { const r = this.regionOfCell(c); return r && (r.kind === 'lawn' || r.kind === 'woods') && r.id !== p.location; }, { maxExpand: 120000 });
    if (!rt) return { ok: false, msg: `No open, dry lawn ${p.id} can reach to be ${next} on.` };
    p.activity = 'walking'; p.route = rt; p.goal = { type: 'activity', activity: next };
    return { ok: true, msg: `${p.id} is walking to the nearest lawn to be ${next}.` };
  }
  goBoating(p) {
    if (p.activity === 'boating') return { ok: false, msg: `${p.id} is already in a boat.` };
    if (p.dogId) return { ok: false, msg: 'A person with a dog cannot board a boat.' };
    if (this.lakeOverflowing()) return { ok: false, msg: 'Boats cannot launch while the lake is overflowing.' };
    const rt = G.dist(p, this.landing.pathPoint) < 6 ? [] : this.route(p, this.landing.pathPoint, { maxExpand: 250000 });
    if (!rt) return { ok: false, msg: `${p.id} can't reach the boat landing (flooded, closed or fenced in).` };
    p.activity = 'walking'; p.route = rt; p.goal = { type: 'boat' }; p.evacuating = false;
    return { ok: true, msg: `${p.id} is heading to the Loeb Boathouse landing.` };
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
    if (this.fleetCost() + RULES.PRICE[kind] > this.budget) return { ok: false, msg: `A ${kind} costs $${RULES.PRICE[kind] / 1000}k and the robot budget only has $${(this.budget - this.fleetCost()) / 1000}k left.` };
    let pos;
    if (kind === 'skimmer') pos = this.randomLakePoint(20);
    else {
      const ok = this.paths.filter((p) => p.standingWater <= RULES.ROBOT_MAX_WATER);
      if (!ok.length) return { ok: false, msg: 'Every path is under more than 6″ of water.' };
      pos = this.randomPointIn(ok[Math.floor(this.rand() * ok.length)]);
    }
    const r = this.buyRobot(kind, pos);
    return { ok: true, entity: r };
  }
  nearestIdleMower(lawn) {
    return this.mowers.filter((m) => m.state === 'idle' || m.state === 'docked').sort((a, b) => G.dist(a, lawn.anchor) - G.dist(b, lawn.anchor))[0];
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
  setBudget(v) { this.budget = Math.max(0, Math.round(v / 1000) * 1000); return { ok: true }; }
  toggleAuto() { this.autoRobots = !this.autoRobots; this.note(`Robot controller ${this.autoRobots ? 'on' : 'off'}.`); return { ok: true }; }
}
