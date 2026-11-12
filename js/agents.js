// Spatial agent behaviors (Spatial Agents workshop):
//  - every visitor and robot starts with a limited picture of the park
//  - each looks around through a cone of vision every step and remembers
//    what it saw: open ground, obstacles, hindrances, affordances, other agents
//  - agents give way to the other agents they can see
//  - visitors have goals (places to see) and performance criteria (time and
//    distance); they explore to find places, save landmarks, ask other
//    visitors for directions, and use what they know to find their way back
//  - robots find litter and broken fences by sight and report them to the
//    robot center; with nothing reported, stewards patrol the least-recently
//    seen parts of the park. Robots share their maps when they dock.
// These methods are mixed into Model (see model.js).
import * as G from './geometry.js';
import { Mind, K, SENSORS, compass } from './mind.js';

export const AGENT_RULES = {
  SPAWN_GLANCE: 40,          // ft a new visitor can see around them
  VISIT_MINUTES: [90, 180],  // a visitor's time budget
  GOALS: [2, 4],             // how many places a visitor wants to see
  SIT_MINUTES: [8, 25],      // how long a visitor sits on a lawn they wanted to see
  SHARE_RANGE: 25,           // ft: visitors this close can ask each other for directions
  SHARE_CHANCE: 0.35,
  YIELD_RADIUS: 3,           // ft of personal space
  MAX_YIELDS: 4,             // after waiting this many steps, squeeze past
  PATROL_RECHECK: 8,         // steps between a patrolling steward checking the job board
  EXIT_RADIUS: 12,
};

const isNamed = (name) => name && !/^(Lawn|Path) \d+$/.test(name);

export const AgentBehaviors = {
  // ---------- setup ----------
  setupAgents() {
    const L = this.layout;
    this.fleet = { board: new Map(), mind: new Mind(L) };
    this.visitorLog = [];
    this.kcells = this.fleet.mind.seen.length;
    this.heat = new Float32Array(this.kcells);
    this.lmHeat = new Float32Array(this.kcells);   // where landmarks get saved, by anyone
    this.fleet.mind.heat = this.lmHeat;
    this._vis = this._vis || new Uint32Array(L.N);
    this._visGen = this._visGen || 0;
    if (!this.woodsDist) this.woodsDist = L.distanceField((c) => L.label[c] === L.woods.index);
    if (!this.places) this.places = this.buildPlaces();
    if (!this.entrances) this.entrances = this.findEntrances();
    if (!this.allSignposts) this.allSignposts = this.signposts = this.findSignposts();
  },

  // Places a visitor may want to see, and how they know they've seen it.
  buildPlaces() {
    const L = this.layout;
    const out = L.lawns.filter((l) => isNamed(l.name)).map((l) => ({ key: `place:${l.id}`, label: l.name, kind: 'lawn', regionId: l.id }));
    // Sights: seen from a distance, visited by walking up to them.
    for (const sg of L.sights || []) {
      const at = L.snap(sg, (r) => r.kind === 'path' || r.kind === 'lawn');
      out.push({ key: `place:${sg.id}`, label: sg.name, kind: 'sight', x: sg.x, y: sg.y, sight: sg.sight, at });
    }
    out.push({ key: 'place:lake', label: 'the Lake', kind: 'lake' });
    out.push({ key: 'place:woods', label: 'the Ramble', kind: 'woods' });
    return out;
  },

  // Park entrances: where paths run off the edge of the map.
  findEntrances() {
    const L = this.layout, pts = [];
    for (const p of L.paths) for (const c of p.cells) {
      const col = c % L.cols, row = (c - col) / L.cols;
      if (col < 3 || row < 3 || col > L.cols - 4 || row > L.rows - 4) pts.push({ x: L.cx(c), y: L.cy(c) });
    }
    const out = [];
    for (const p of pts) if (!out.some((q) => G.dist(p, q) < 120)) out.push(p);
    const mid = { x: (L.bounds.x0 + L.bounds.x1) / 2, y: (L.bounds.y0 + L.bounds.y1) / 2 };
    return out.map((p, i) => ({ id: `E${i + 1}`, x: p.x, y: p.y, name: `${compass(p.x - mid.x, p.y - mid.y)} entrance` }));
  },

  // Signposts at the busiest path junctions and at the entrances. Each one
  // points to the places within about 900 ft.
  findSignposts() {
    const L = this.layout, R = 3, cand = [];
    for (const p of L.paths) for (const c of p.cells) {
      const col = c % L.cols, row = (c - col) / L.cols;
      if ((col + row) % 3) continue;
      const ids = new Set();
      for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) {
        const cc = col + dc, rr = row + dr;
        if (cc < 0 || rr < 0 || cc >= L.cols || rr >= L.rows) continue;
        const r = L.regionOfCell(rr * L.cols + cc);
        if (r && r.kind === 'path') ids.add(r.id);
      }
      if (ids.size >= 3) cand.push({ x: L.cx(c), y: L.cy(c), deg: ids.size });
    }
    cand.sort((a, b) => b.deg - a.deg);
    const out = this.entrances.map((e) => ({ x: e.x, y: e.y }));
    for (const c of cand) if (!out.some((q) => G.dist(c, q) < 260)) out.push(c);
    return out.map((sp, i) => {
      const points = this.places
        .map((pl) => ({ pl, at: this.placePoint(pl) }))
        .filter((o) => o.at && G.dist(o.at, sp) < 900)
        .map((o) => ({ key: o.pl.key, label: o.pl.label, x: o.at.x, y: o.at.y }));
      return { id: `sign${i + 1}`, x: sp.x, y: sp.y, points };
    });
  },
  // A walkable spot to head for when going to a place.
  placePoint(pl) {
    const L = this.layout;
    if (pl.kind === 'sight') return pl.at;
    if (pl.kind === 'lawn') return this.byId?.[pl.regionId]?.anchor || L.byId[pl.regionId].anchor;
    if (pl.kind === 'lake' || pl.kind === 'woods') return null; // too big to point at
    return null;
  },

  // What a cell is to an agent of this kind: open, blocked or water.
  cellKind(c, kind) {
    const L = this.layout, li = L.label[c];
    if (!li) return K.BLOCKED;
    if (li === L.lake.index) return kind === 'skimmer' ? K.OPEN : K.WATER;
    if (kind === 'skimmer') return K.BLOCKED;
    if (li === L.woods.index && kind === 'mower') return K.BLOCKED;
    return K.OPEN;
  },

  // ---------- visitors ----------
  initVisitor(p, start = null) {
    const A = AGENT_RULES, L = this.layout;
    p.mind = new Mind(L);
    p.mind.heat = this.lmHeat;
    const st = start || { x: p.x, y: p.y, name: 'where I came in' };
    p.mind.remember({ key: 'start', type: 'start', label: st.name === 'where I came in' ? st.name : `the ${st.name}`, x: st.x, y: st.y, t: this.time, rel: 'where my visit began' });
    p.mind.glance(this, p, A.SPAWN_GLANCE, 'person', this.time);
    const n = A.GOALS[0] + Math.floor(this.rand() * (A.GOALS[1] - A.GOALS[0] + 1));
    const pool = [...this.places];
    const goals = [];
    while (goals.length < n && pool.length) goals.push(pool.splice(Math.floor(this.rand() * pool.length), 1)[0]);
    p.plan = {
      goals: goals.map((g) => g.key), done: [], start: { x: st.x, y: st.y }, startT: this.time,
      budget: Math.round(A.VISIT_MINUTES[0] + this.rand() * (A.VISIT_MINUTES[1] - A.VISIT_MINUTES[0])),
      distance: 0, status: 'exploring', target: null, asked: 0, told: 0,
    };
    p.stats = { yields: 0 };
    const mid = { x: (L.bounds.x0 + L.bounds.x1) / 2, y: (L.bounds.y0 + L.bounds.y1) / 2 };
    p.heading = Math.atan2(mid.y - p.y, mid.x - p.x) + (this.rand() - 0.5) * 2;
    p.exploreDir = p.heading;
  },

  place(key) { return this.places.find((pl) => pl.key === key); },

  // Has the visitor reached this place?
  atPlace(p, pl) {
    const L = this.layout, c = L.cellAt(p);
    if (pl.kind === 'lawn') return p.location === pl.regionId;
    if (pl.kind === 'lake') return c >= 0 && L.lakeDist[c] <= 3;
    if (pl.kind === 'woods') return c >= 0 && this.woodsDist[c] <= 3;
    if (pl.kind === 'sight') return G.dist(p, pl) < 45 || G.dist(p, pl.at) < 12;
    return false;
  },

  spawnVisitor(entrance) {
    const e = entrance || this.entrances[Math.floor(this.rand() * this.entrances.length)];
    const p = this.makePerson({ x: e.x + (this.rand() - 0.5) * 3, y: e.y + (this.rand() - 0.5) * 3 }, 'walking', { x: e.x, y: e.y, name: e.name });
    if (this.rand() < 0.2) this.giveDog(p);
    return p;
  },

  addVisitors(n = 25) {
    this.visitorTarget = (this.visitorTarget || this.people.length) + n;
    const made = [];
    for (let i = 0; i < n; i++) made.push(this.spawnVisitor());
    this.note(`${n} more visitors came in at the park entrances.`);
    return { ok: true, msg: `${n} visitors added. Each one only knows the spot where they came in.`, entity: made[0] };
  },

  leavePark(p) {
    const pl = p.plan;
    const minutes = this.time - pl.startT;
    this.visitorLog.push({ id: p.id, wanted: pl.goals.length, saw: pl.done.length, minutes, budget: pl.budget, distance: Math.round(pl.distance), onTime: minutes <= pl.budget, landmarks: p.mind.landmarks.length });
    if (this.visitorLog.length > 500) this.visitorLog.shift();
    if (p.dogId) this.dogs = this.dogs.filter((d) => d.id !== p.dogId);
    this.people = this.people.filter((x) => x !== p);
    this.note(`${p.id} left the park after ${minutes} min, having seen ${pl.done.length} of ${pl.goals.length} places.`);
  },

  // Called when a walking visitor has nowhere to go: pick the next move.
  decideVisitor(p, depth = 0) {
    const pl = p.plan, A = AGENT_RULES;
    if (pl.status === 'returning') {
      if (G.dist(p, pl.start) < A.EXIT_RADIUS) return this.leavePark(p);
      // Head back on ground they know, using their own landmarks.
      let rt = this.route(p, pl.start, { mind: p.mind, knownOnly: true, maxExpand: 120000 });
      pl.returnOnKnown = !!rt;
      if (!rt) rt = this.route(p, pl.start, { mind: p.mind, maxExpand: 120000 });
      if (rt) { p.route = rt; return; }
      p.wait = 2;
      return;
    }
    const remaining = pl.goals.filter((k) => !pl.done.includes(k));
    // Leave enough time to walk back (performance criterion: finish within the budget).
    const backIn = (G.dist(p, pl.start) * 1.5) / 30;
    if (!remaining.length || this.time - pl.startT + backIn > pl.budget) {
      pl.status = 'returning';
      pl.target = null;
      this.note(remaining.length ? `${p.id} ran out of time and is heading back to ${p.mind.byKey.get('start').label}.` : `${p.id} has seen everything they came for and is heading back.`);
      return this.decideVisitor(p, depth + 1);
    }
    // A wanted place they know the way to: go there.
    const known = remaining.map((k) => p.mind.byKey.get(k)).filter(Boolean).sort((a, b) => G.dist(a, p) - G.dist(b, p));
    for (const lm of known) {
      const rt = this.route(p, lm, { mind: p.mind, maxExpand: 150000 });
      if (rt) { p.route = rt; pl.status = 'heading'; pl.target = lm.key; return; }
    }
    // Otherwise explore: walk to the edge of what they know.
    pl.status = 'exploring'; pl.target = null;
    // Look all the way around before choosing where to go next.
    const stamp = this.look(p, 360, 70);
    this.visitorSees(p, stamp);
    if (depth === 0 && remaining.some((k) => p.mind.byKey.has(k))) return this.decideVisitor(p, 1);
    const m = p.mind, fr = m.frontier(8000);
    let best = -1, bs = -Infinity;
    for (let i = 0; i < 140 && fr.length; i++) {
      const k = fr[Math.floor(this.rand() * fr.length)];
      const x = m.kx(k), y = m.ky(k);
      const d = Math.hypot(x - p.x, y - p.y);
      if (d < 40) continue;
      // How much is unknown around it: the information to gain by going there.
      let unknown = 0;
      const col = k % m.cols, row = (k - col) / m.cols;
      for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) {
        const cc = col + dc, rr = row + dr;
        if (cc >= 0 && rr >= 0 && cc < m.cols && rr < m.rows && m.seen[rr * m.cols + cc] === 0) unknown++;
      }
      const ahead = Math.cos(Math.atan2(y - p.y, x - p.x) - p.exploreDir);
      const s = unknown * 4 + ahead * 90 - Math.abs(d - 300) * 0.2 + this.rand() * 30;
      if (s > bs) { bs = s; best = k; }
    }
    if (best >= 0) {
      const goal = this.layout.snap({ x: m.kx(best), y: m.ky(best) }, (r) => r.kind === 'path' || r.kind === 'lawn');
      const rt = this.route(p, goal, { mind: m, maxExpand: 120000 });
      if (rt) {
        p.route = rt;
        const a = Math.atan2(goal.y - p.y, goal.x - p.x);
        p.exploreDir += Math.atan2(Math.sin(a - p.exploreDir), Math.cos(a - p.exploreDir)) * 0.5;
        return;
      }
    }
    p.exploreDir += (this.rand() < 0.5 ? 1 : -1) * Math.PI / 2;
    p.wait = 1;
  },

  // Each step, before moving on: tick off places reached, sit on a wanted
  // lawn, and drop a route that runs into something they now know is in the way.
  checkVisitor(p) {
    const pl = p.plan;
    if (!pl || p.activity === 'boating') return;
    for (const k of pl.goals) {
      if (pl.done.includes(k)) continue;
      const place = this.place(k);
      if (!this.atPlace(p, place)) continue;
      pl.done.push(k);
      const lm = p.mind.byKey.get(k);
      if (!lm) p.mind.remember({ key: k, type: 'place', label: place.label, x: p.x, y: p.y, t: this.time, rel: p.mind.relativeTo(p, pl.start, 'where I came in') });
      this.note(`${p.id} reached ${place.label} (${pl.done.length} of ${pl.goals.length}).`);
      if (place.kind === 'lawn' && p.goal == null && this.rand() < 0.7) {
        const [a, b] = AGENT_RULES.SIT_MINUTES;
        p.activity = 'sitting'; p.route = []; p.sitFor = Math.round(a + this.rand() * (b - a));
      }
      if (pl.target === k) { pl.target = null; p.route = []; }
    }
    if (p.route.length && !p.goal && this.routeBlockedAhead(p)) p.route = [];
  },

  routeBlockedAhead(p) {
    const L = this.layout;
    let from = { x: p.x, y: p.y };
    const cache = new Map();
    for (let i = 0; i < Math.min(3, p.route.length); i++) {
      const t = p.route[i], n = Math.ceil(G.dist(from, t) / 4);
      for (let s = 1; s <= n; s++) {
        const c = L.cellAt({ x: from.x + ((t.x - from.x) * s) / n, y: from.y + ((t.y - from.y) * s) / n });
        if (c < 0 || !p.mind.knowsCell(c)) continue;
        const r = this.regionOfCell(c);
        if (!r) return true;
        if (r.id === p.location) continue;
        if (!cache.has(r.id)) cache.set(r.id, this.allowed(p, r.id));
        if (!cache.get(r.id)) return true;
      }
      from = t;
    }
    return false;
  },

  // ---------- vision ----------
  // Cast rays through the agent's cone of vision. Returns the stamp that
  // marks the cells it can see this step.
  look(a, fovOverride = null, rangeOverride = null) {
    const L = this.layout, mind = a.mind, S0 = SENSORS[a.kind];
    const S = fovOverride ? { ...S0, fov: fovOverride, range: rangeOverride || S0.range } : S0;
    const t = this.time;
    if (a.lastLook && G.dist(a.lastLook, a) > 0.5) a.heading = Math.atan2(a.y - a.lastLook.y, a.x - a.lastLook.x);
    else if (a.route && a.route.length) a.heading = Math.atan2(a.route[0].y - a.y, a.route[0].x - a.x);
    a.lastLook = { x: a.x, y: a.y };
    const h = a.heading || 0;
    const stamp = ++this._visGen;
    const vis = this._vis, W = L.woods.index;
    const fov = (S.fov * Math.PI) / 180;
    const rays = S.fov >= 360 ? 48 : Math.max(9, Math.round(S.fov / 4));
    const c0 = L.cellAt(a);
    if (c0 >= 0) { vis[c0] = stamp; mind.mark(mind.kOfCell(c0), this.cellKind(c0, a.kind), t); }
    for (let i = 0; i < rays; i++) {
      const ang = S.fov >= 360 ? (i / rays) * Math.PI * 2 : h - fov / 2 + (fov * i) / (rays - 1);
      const dx = Math.cos(ang), dy = Math.sin(ang);
      let woods = 0;
      for (let d = 3; d <= S.range; d += 4) {
        const c = L.cellAt({ x: a.x + dx * d, y: a.y + dy * d });
        if (c < 0) break;
        if (vis[c] !== stamp) { vis[c] = stamp; mind.mark(mind.kOfCell(c), this.cellKind(c, a.kind), t); }
        const li = L.label[c];
        if (!li) break;                                  // plantings and buildings block the view
        if (li === W && (woods += 4) > S.woodsRange) break; // so does the Ramble's undergrowth, after a while
      }
    }
    if (!fovOverride) mind.cone = { x: a.x, y: a.y, heading: h, fov: S.fov, range: S.range, t };
    return stamp;
  },
  sees(stamp, p) { const c = this.layout.cellAt(p); return c >= 0 && this._vis[c] === stamp; },

  // Notice other agents in view.
  noticeAgents(a, stamp) {
    const m = a.mind;
    const check = (o) => { if (o !== a && this.sees(stamp, o)) m.others.set(o.id, { kind: o.kind, x: o.x, y: o.y, t: this.time }); };
    for (const o of this.people) if (o.activity !== 'boating') check(o);
    for (const o of this.dogs) check(o);
    for (const o of this.robots()) check(o);
    for (const o of this.boats) check(o);
    if (this.time % 30 === 0) for (const [id, o] of m.others) if (this.time - o.t > 120) m.others.delete(id);
  },

  // What a visitor notices: the places they want, hindrances, gaps in the fence.
  visitorSees(p, stamp) {
    const L = this.layout, m = p.mind, pl = p.plan, t = this.time;
    const rel = (pt) => m.relativeTo(pt, pl.start, 'where I came in');
    const save = (lm) => {
      if (m.remember({ ...lm, t, rel: rel(lm), trailIndex: Math.round(pl.distance) })) {
        if (lm.type === 'place' && pl.goals.includes(lm.key) && !pl.done.includes(lm.key)) { p.route = []; pl.spotted = (pl.spotted || 0) + 1; }
      }
    };
    // Nearest visible walkable cell of each place-like thing.
    let lakeBest = -1, lakeD = 1e9, woodsBest = -1, woodsD = 1e9;
    const lawnBest = new Map();
    const r = Math.ceil(Math.max(m.cone ? m.cone.range : 0, 70) / L.cell);
    const c0 = L.cellAt(p);
    if (c0 < 0) return;
    const col0 = c0 % L.cols, row0 = (c0 - col0) / L.cols;
    const vis = this._vis;
    for (let dr = -r; dr <= r; dr += 2) {
      const row = row0 + dr;
      if (row < 0 || row >= L.rows) continue;
      for (let dc = -r; dc <= r; dc += 2) {
        const col = col0 + dc;
        if (col < 0 || col >= L.cols) continue;
        const c = row * L.cols + col;
        if (vis[c] !== stamp) continue;
        const reg = this.regionOfCell(c);
        if (!reg) continue;
        const d = dr * dr + dc * dc;
        if (reg.kind === 'path' || reg.kind === 'lawn') {
          if (L.lakeDist[c] <= 3 && d < lakeD) { lakeD = d; lakeBest = c; }
          if (this.woodsDist[c] <= 3 && d < woodsD) { woodsD = d; woodsBest = c; }
          if (reg.kind === 'lawn' && isNamed(reg.name) && (!lawnBest.has(reg.id) || d < lawnBest.get(reg.id)[1])) lawnBest.set(reg.id, [c, d]);
          // Hindrances: flooded or closed ground.
          const flooded = reg.standingWater > 3, closed = reg.kind === 'lawn' && reg.status !== 'open';
          const key = `hindrance:${reg.id}`;
          if (flooded || closed) { if (!m.byKey.has(key)) save({ key, type: 'hindrance', label: `${reg.name} ${flooded ? 'flooded' : 'closed'}`, x: L.cx(c), y: L.cy(c) }); }
          else if (m.byKey.has(key)) m.forget(key);
        }
      }
    }
    for (const [id, [c]] of lawnBest) save({ key: `place:${id}`, type: 'place', label: this.byId[id].name, x: L.cx(c), y: L.cy(c) });
    if (lakeBest >= 0 && !m.byKey.has('place:lake')) save({ key: 'place:lake', type: 'place', label: 'the Lake', x: L.cx(lakeBest), y: L.cy(lakeBest) });
    if (woodsBest >= 0 && !m.byKey.has('place:woods')) save({ key: 'place:woods', type: 'place', label: 'the Ramble', x: L.cx(woodsBest), y: L.cy(woodsBest) });
    for (const pl2 of this.places) {
      if (pl2.kind !== 'sight' || m.byKey.has(pl2.key)) continue;
      if (this.canSeeSight(p, pl2, stamp)) save({ key: pl2.key, type: 'place', label: pl2.label, ...pl2.at });
    }
    if (this.sees(stamp, this.landing.pathPoint)) save({ key: 'place:landing', type: 'place', label: 'the Boathouse landing', ...this.landing.pathPoint });
    if (this.sees(stamp, this.center.position)) save({ key: 'place:center', type: 'place', label: 'the robot center', ...this.center.position });
    // Affordances: signposts (read up close) point the way to nearby places.
    for (const sp of this.signposts) {
      if (G.dist(sp, p) > 40 || !this.sees(stamp, sp)) continue;
      if (m.byKey.has(sp.id)) continue;
      save({ key: sp.id, type: 'affordance', label: 'signpost', x: sp.x, y: sp.y });
      for (const pt of sp.points) {
        if (m.byKey.has(pt.key)) continue;
        m.remember({ key: pt.key, type: 'place', label: pt.label, x: pt.x, y: pt.y, t, rel: `the signpost said ${Math.round(G.dist(sp, pt) / 50) * 50} ft ${compass(pt.x - sp.x, pt.y - sp.y)}`, fromSign: true });
        if (pl.goals.includes(pt.key) && !pl.done.includes(pt.key)) p.route = [];
      }
    }
    // Some visitors report problems they see to the park, like calling 311.
    if (p.personality.reporter) {
      for (const l of this.litter) {
        const key = `litter:${l.id}`;
        if (this.fleet.board.has(key) || G.dist(l, p) > 60 || !this.sees(stamp, l)) continue;
        this.fleet.board.set(key, { type: 'litter', id: l.id, what: l.type, x: l.x, y: l.y, where: l.location === 'lake' ? 'lake' : 'land', t, by: p.id });
        pl.reported = (pl.reported || 0) + 1;
      }
    }
    // Affordances: gaps in the Ramble fence.
    for (const f of this.fences) {
      if (f.status !== 'broken') { if (m.byKey.has(`gap:${f.id}`) && this.sees(stamp, f.a)) m.forget(`gap:${f.id}`); continue; }
      const mid = { x: (f.a.x + f.b.x) / 2, y: (f.a.y + f.b.y) / 2 };
      if (this.sees(stamp, f.a) || this.sees(stamp, f.b) || this.sees(stamp, mid)) save({ key: `gap:${f.id}`, type: 'affordance', label: `gap in the fence (${f.id})`, ...mid });
    }
  },

  // Sights stand out: they can be seen from further than the ground around
  // them, as long as they're inside the cone and nothing dense is in the way.
  canSeeSight(p, sg, stamp) {
    if (this.sees(stamp, sg) || this.sees(stamp, sg.at)) return true;
    const d = G.dist(p, sg);
    const cone = p.mind.cone;
    if (!cone || d > sg.sight) return false;
    const off = Math.atan2(sg.y - p.y, sg.x - p.x) - cone.heading;
    if (Math.abs(Math.atan2(Math.sin(off), Math.cos(off))) > ((cone.fov / 2) * Math.PI) / 180) return false;
    if (sg.sight >= 300) return true; // tall enough to see over the trees
    const L = this.layout, n = Math.ceil(d / 5);
    let blocked = 0;
    for (let i = 1; i < n - 2; i++) {
      const c = L.cellAt({ x: p.x + ((sg.x - p.x) * i) / n, y: p.y + ((sg.y - p.y) * i) / n });
      if (c < 0 || !L.label[c]) blocked++;
    }
    return blocked < 3;
  },

  // Visitors who meet can ask each other for directions.
  shareDirections(p) {
    const pl = p.plan, A = AGENT_RULES;
    const wants = pl.goals.filter((k) => !pl.done.includes(k) && !p.mind.byKey.has(k));
    if (!wants.length) return;
    for (const [id, o] of p.mind.others) {
      if (o.kind !== 'person' || o.t !== this.time) continue;
      if (Math.hypot(o.x - p.x, o.y - p.y) > A.SHARE_RANGE) continue;
      p.askedPeople = p.askedPeople || new Set();
      if (p.askedPeople.has(id)) continue;
      p.askedPeople.add(id);
      if (this.rand() > A.SHARE_CHANCE) continue;
      const q = this.person(id);
      if (!q || !q.mind) continue;
      const told = wants.map((k) => q.mind.byKey.get(k)).filter(Boolean);
      if (!told.length) continue;
      for (const lm of told) p.mind.remember({ ...lm, rel: `${q.id} said: ${lm.rel}`, t: this.time, heardFrom: q.id });
      pl.asked++; q.plan && q.plan.told++;
      p.route = [];
      this.note(`${p.id} asked ${q.id} for directions to ${told.map((l) => l.label).join(' and ')}.`);
      return;
    }
  },

  // ---------- robots ----------
  initRobotMind(r) {
    r.mind = new Mind(this.layout);
    r.mind.heat = this.lmHeat;
    r.mind.glance(this, this.home(r), 60, r.kind, this.time);
    r.mind.mergeFrom(this.fleet.mind, (l) => l.type === 'place');
    r.stats = { yields: 0, reported: 0 };
  },

  // A robot reports problems it can see to the robot center's job board.
  robotSees(r, stamp) {
    const board = this.fleet.board, t = this.time;
    for (const l of this.litter) {
      const key = `litter:${l.id}`;
      if (board.has(key) || !this.sees(stamp, l)) continue;
      const where = l.location === 'lake' ? 'lake' : 'land';
      board.set(key, { type: 'litter', id: l.id, what: l.type, x: l.x, y: l.y, where, t, by: r.id });
      r.mind.remember({ key, type: 'issue', label: `${l.type === 'hole' ? 'hole' : l.type === 'poop' ? 'dog poop' : 'litter'} ${l.id}`, x: l.x, y: l.y, t, rel: this.regionName(l.location) });
      r.stats.reported++;
    }
    for (const f of this.fences) {
      const key = `fence:${f.id}`;
      const mid = { x: (f.a.x + f.b.x) / 2, y: (f.a.y + f.b.y) / 2 };
      if (!(this.sees(stamp, mid) || this.sees(stamp, f.a) || this.sees(stamp, f.b))) continue;
      if (f.status === 'broken' && !board.has(key)) {
        board.set(key, { type: 'fence', id: f.id, x: mid.x, y: mid.y, t, by: r.id });
        r.mind.remember({ key, type: 'issue', label: `broken fence ${f.id}`, ...mid, t, rel: 'on the Ramble fence' });
        r.stats.reported++;
        this.note(`${r.id} spotted broken fence ${f.id} and reported it to the robot center.`);
      } else if (f.status === 'intact' && board.has(key)) board.delete(key);
    }
    // Clear reports the robot can see are out of date.
    for (const [key, b] of board) if (b.type === 'litter' && this.sees(stamp, b) && !this.litter.some((l) => l.id === b.id)) board.delete(key);
  },

  // Stewards with nothing reported walk to the part of the park the fleet
  // has seen least recently.
  startPatrol(s) {
    const L = this.layout, fm = this.fleet.mind;
    if (!this.fenceWatch) {
      // Path cells along the Ramble fence, for fence fixers to walk.
      this.fenceWatch = [];
      for (const p of this.paths) for (const c of p.cells) if (this.woodsDist[c] <= 3) this.fenceWatch.push(c);
    }
    const pick = () => {
      if (s.role === 'fence') return this.fenceWatch[Math.floor(this.rand() * this.fenceWatch.length)];
      const x = this.rand();
      if (x < 0.2 && L.trailCells.length) return L.trailCells[Math.floor(this.rand() * L.trailCells.length)];
      const reg = x < 0.6 ? this.lawns[Math.floor(this.rand() * this.lawns.length)] : this.paths[Math.floor(this.rand() * this.paths.length)];
      return reg.cells[Math.floor(this.rand() * reg.cells.length)];
    };
    let best = null, bs = -Infinity;
    for (let i = 0; i < 160; i++) {
      const c = pick();
      const k = fm.kOfCell(c);
      const stale = fm.seen[k] === K.UNKNOWN ? 2000 : this.time - fm.seenAt[k];
      const d = Math.hypot(L.cx(c) - s.x, L.cy(c) - s.y);
      const own = s.mind.seen[s.mind.kOfCell(c)] ? this.time - s.mind.seenAt[s.mind.kOfCell(c)] : 2000;
      const score = Math.min(stale, own) - d * 0.35;
      if (score > bs) { bs = score; best = { x: L.cx(c), y: L.cy(c) }; }
    }
    const rt = best && this.route(s, best, { maxExpand: 250000 });
    if (!rt) return;
    s.route = rt; s.state = 'patrolling'; s.target = { type: 'patrol', id: 'patrol', x: best.x, y: best.y }; s.patrolT = 0;
  },
  stepPatrol(s) {
    if (++s.patrolT % AGENT_RULES.PATROL_RECHECK === 0) {
      // Something reported? Drop the patrol and go to work.
      const role = s.role || 'general';
      const useful = [...this.fleet.board.values()].some((b) => (b.type === 'fence' && (role === 'fence' || role === 'general')) || (b.type === 'litter' && b.where === 'land' && (role === 'litter' || role === 'general')));
      if (useful) { const keep = { route: s.route, target: s.target }; s.state = 'idle'; s.target = null; s.route = []; this.chooseStewardTask(s); if (s.state === 'idle') { s.state = 'patrolling'; Object.assign(s, keep); } else return; }
    }
    this.robotMove(s, 30);
    if (!s.route.length || s.blocked > 20) { s.state = 'idle'; s.target = null; s.route = []; }
  },

  // ---------- giving way ----------
  // Another agent this one can see, standing where it is about to step.
  blockerAt(agent, q) {
    const A = AGENT_RULES, m = agent.mind;
    if (!m) return null;
    for (const [id, o] of m.others) {
      if (this.time - o.t > 1 || o.kind === 'boat') continue;
      if (id === agent.dogId || id === agent.ownerId) continue;
      const live = o.kind === 'person' ? this.person(id) : o.kind === 'dog' ? this.dogs.find((d) => d.id === id) : this.robots().find((r) => r.id === id);
      if (!live || (live.kind === 'person' && live.activity === 'boating') || live.state === 'docked' || live.state === 'charging') continue;
      if (Math.hypot(live.x - q.x, live.y - q.y) < A.YIELD_RADIUS && Math.hypot(live.x - q.x, live.y - q.y) < Math.hypot(live.x - agent.x, live.y - agent.y)) return live;
    }
    return null;
  },
  // Step aside, or wait a moment, when someone is in the way.
  giveWay(agent, q) {
    if (!agent.mind || agent.kind === 'skimmer' || agent.evacuating) return null;
    if (agent.state === 'returning' && G.dist(agent, this.home(agent)) < 25) return null;
    const other = this.blockerAt(agent, q);
    if (!other) { agent.yielding = 0; return null; }
    if ((agent.yielding || 0) >= AGENT_RULES.MAX_YIELDS) { agent.yielding = 0; return null; }
    agent.yielding = (agent.yielding || 0) + 1;
    agent.stats.yields++;
    const dx = q.x - agent.x, dy = q.y - agent.y, d = Math.hypot(dx, dy) || 1;
    for (const side of [1, -1]) {
      const s = { x: agent.x + (-dy / d) * side * 3 + (dx / d) * 1, y: agent.y + (dx / d) * side * 3 + (dy / d) * 1 };
      if (this.canStep(agent, s) && !this.blockerAt(agent, s)) return s;
    }
    return { x: agent.x, y: agent.y };
  },

  // ---------- each step ----------
  stepSenses() {
    const t = this.time;
    for (const p of [...this.people]) {
      if (p.activity === 'boating' || !p.mind) continue;
      if (p.activity !== 'walking' && t % 3) continue;   // sitting people look around less often
      const stamp = this.look(p);
      this.noticeAgents(p, stamp);
      this.visitorSees(p, stamp);
      if (p.activity === 'walking') this.shareDirections(p);
    }
    for (const r of this.robots()) {
      if (!r.mind) continue;
      if (r.state === 'docked' || r.state === 'charging') {
        // Share maps with the fleet while charging.
        if (!r.synced) { this.fleet.mind.mergeFrom(r.mind); r.mind.mergeFrom(this.fleet.mind); r.synced = true; }
        continue;
      }
      r.synced = false;
      const stamp = this.look(r);
      this.noticeAgents(r, stamp);
      this.robotSees(r, stamp);
    }
    // Where agents walk, for the overlay of everyone's paths.
    const m = this.fleet.mind;
    for (const p of this.people) if (p.activity === 'walking') { const k = m.kAt(p); if (k >= 0) this.heat[k] += 1; }
    for (const r of this.robots()) if (r.state !== 'docked' && r.state !== 'charging' && r.kind !== 'skimmer') { const k = m.kAt(r); if (k >= 0) this.heat[k] += 1; }
    // Keep visitors coming as others leave.
    if (this.visitorTarget && this.people.length < this.visitorTarget && this.rand() < 0.25) this.spawnVisitor();
  },

  regionName(id) { return this.byId[id]?.name || id; },

  visitorStats() {
    const log = this.visitorLog, n = log.length;
    const inPark = this.people.filter((p) => p.plan);
    const avg = (f) => (n ? log.reduce((s, v) => s + f(v), 0) / n : 0);
    return {
      inPark: inPark.length, left: n,
      allSeen: n ? log.filter((v) => v.saw === v.wanted).length / n : 0,
      onTime: n ? log.filter((v) => v.onTime).length / n : 0,
      minutes: avg((v) => v.minutes), distance: avg((v) => v.distance), places: avg((v) => v.saw / v.wanted),
      exploring: inPark.filter((p) => p.plan.status === 'exploring').length,
      heading: inPark.filter((p) => p.plan.status === 'heading').length,
      returning: inPark.filter((p) => p.plan.status === 'returning').length,
      known: inPark.length ? inPark.reduce((s, p) => s + p.mind.known, 0) / inPark.length / this.kcells : 0,
      reported: this.fleet.board.size,
      fleetKnown: this.fleet.mind.known / this.kcells,
    };
  },
};
