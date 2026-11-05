// The semantic model: entities, relationships, and rules. No rendering here.
import * as C from './config.js';

// ---------- geometry helpers ----------

const FT_PER_DEG_LAT = 364320;

export class Projection {
  constructor(lat0, lon0) {
    this.lat0 = lat0;
    this.lon0 = lon0;
    this.ftPerDegLon = FT_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  }
  toXY(lat, lon) {
    return { x: (lon - this.lon0) * this.ftPerDegLon, y: (lat - this.lat0) * FT_PER_DEG_LAT };
  }
  toLatLon(x, y) {
    return { lat: this.lat0 + y / FT_PER_DEG_LAT, lon: this.lon0 + x / this.ftPerDegLon };
  }
}

// Bilinear position inside the study area: u goes west->east, v goes north->south.
export function gridLatLon(u, v) {
  const { nw, ne, sw, se } = C.CORNERS;
  const w = (a, b, c, d) => (1 - u) * (1 - v) * a + u * (1 - v) * b + (1 - u) * v * c + u * v * d;
  return { lat: w(nw.lat, ne.lat, sw.lat, se.lat), lon: w(nw.lon, ne.lon, sw.lon, se.lon) };
}

export const lerp = (a, b, t) => a + (b - a) * t;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Distance from point p to segment ab, and the parameter t of the closest point.
export function pointToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const q = { x: a.x + dx * t, y: a.y + dy * t };
  return { d: dist(p, q), t, q, side: Math.sign(dx * (p.y - a.y) - dy * (p.x - a.x)) || 1 };
}

export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// Seeded random numbers so the example scene is repeatable.
export function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- the model ----------

export class Model {
  constructor() {
    const c = C.CORNERS;
    this.proj = new Projection((c.nw.lat + c.ne.lat + c.sw.lat + c.se.lat) / 4, (c.nw.lon + c.ne.lon + c.sw.lon + c.se.lon) / 4);
    this.grid = (u, v) => { const ll = gridLatLon(u, v); return this.proj.toXY(ll.lat, ll.lon); };
    this.boundary = [this.grid(0, 0), this.grid(1, 0), this.grid(1, 1), this.grid(0, 1)];
    this.mode = 'simulation';
    this.rain = 'off';
    this.time = 0;
    this.intersections = new Map();
    this.segments = new Map();
    this.basins = new Map();
    this.sensors = new Map();
    this.stations = new Map();
    this.riders = new Map();
    this.nextRiderId = 1;
    this.rng = makeRng(1);
    this.events = []; // short log of rule firings, newest first
    this.alerts = []; // messages for the person (dock full, falls); the view drains these
    this.version = 0; // bumps whenever passability changes
    this.buildNetwork();
  }

  log(msg) {
    this.events.unshift({ t: this.time, msg });
    if (this.events.length > 30) this.events.length = 30;
  }

  // Log a message and also pop it up for the person. kind: 'error' | 'warn' | 'ok'.
  alert(kind, msg) {
    this.log(msg);
    this.alerts.push({ kind, msg });
  }

  // ---- streets, intersections, canal, basins ----
  buildNetwork() {
    const bridge = new Set(C.BRIDGE_ROWS);
    C.COLUMNS.forEach((col, ci) => C.ROWS.forEach((row, ri) => {
      const p = this.grid(col.u, row.v);
      this.intersections.set(`${ci}-${ri}`, { id: `${ci}-${ri}`, name: `${col.name} & ${row.name}`, x: p.x, y: p.y, segments: [] });
    }));
    const addSeg = (id, name, aId, bId, width) => {
      const a = this.intersections.get(aId), b = this.intersections.get(bId);
      const length = dist(a, b);
      const dir = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
      const n = { x: -dir.y, y: dir.x };
      const h = width / 2;
      const seg = {
        id, name, a: aId, b: bId, width, length, dir, normal: n,
        centerline: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }],
        boundary: [
          { x: a.x + n.x * h, y: a.y + n.y * h }, { x: b.x + n.x * h, y: b.y + n.y * h },
          { x: b.x - n.x * h, y: b.y - n.y * h }, { x: a.x - n.x * h, y: a.y - n.y * h },
        ],
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        elevation: 'high', depth: 0, passable: true, basins: [], sensors: [], stations: [],
      };
      this.segments.set(id, seg);
      a.segments.push(id);
      b.segments.push(id);
    };
    // North–south segments
    C.COLUMNS.forEach((col, ci) => {
      for (let ri = 0; ri < C.ROWS.length - 1; ri++) addSeg(`ns-${ci}-${ri}`, col.name, `${ci}-${ri}`, `${ci}-${ri + 1}`, col.width);
    });
    // East–west segments (only bridge streets cross the canal)
    C.ROWS.forEach((row, ri) => {
      for (let ci = 0; ci < C.COLUMNS.length - 1; ci++) {
        if (ci === C.CANAL_WEST_COL && !bridge.has(row.name)) continue;
        addSeg(`ew-${ri}-${ci}`, row.name, `${ci}-${ri}`, `${ci + 1}-${ri}`, row.width);
      }
    });

    // Canal centerline and water polygon
    const steps = 24, e = C.CANAL.extend;
    this.canalLine = [];
    const west = [], east = [];
    for (let i = 0; i <= steps; i++) {
      const v = -e + ((1 + 2 * e) * i) / steps;
      this.canalLine.push(this.grid(C.CANAL.u, v));
      west.push(this.grid(C.CANAL.u - C.CANAL.halfWidth, v));
      east.push(this.grid(C.CANAL.u + C.CANAL.halfWidth, v));
    }
    this.canalPolygon = [...west, ...east.reverse()];

    // Elevation from distance to the canal, and one catch basin per segment
    let n = 1;
    for (const seg of this.segments.values()) {
      const d = this.distanceToCanal(seg.mid);
      seg.canalDistance = d;
      seg.elevation = d < C.ELEVATION_BANDS.low ? 'low' : d < C.ELEVATION_BANDS.medium ? 'medium' : 'high';
      const a = this.intersections.get(seg.a);
      const t = 0.18;
      const off = seg.width / 2 - 5;
      const basin = {
        id: `CB-${String(n++).padStart(3, '0')}`,
        segment: seg.id,
        x: a.x + seg.dir.x * seg.length * t + seg.normal.x * off,
        y: a.y + seg.dir.y * seg.length * t + seg.normal.y * off,
        status: 'clear',
      };
      this.basins.set(basin.id, basin);
      seg.basins.push(basin.id);
    }
  }

  distanceToCanal(p) {
    let best = Infinity;
    for (let i = 0; i < this.canalLine.length - 1; i++) best = Math.min(best, pointToSegment(p, this.canalLine[i], this.canalLine[i + 1]).d);
    return best;
  }

  inStudyArea(p) { return pointInPolygon(p, this.boundary); }

  nearestSegment(p, maxD = Infinity) {
    let best = null;
    for (const seg of this.segments.values()) {
      const a = this.intersections.get(seg.a), b = this.intersections.get(seg.b);
      const r = pointToSegment(p, a, b);
      if (r.d < maxD && (!best || r.d < best.d)) best = { seg, ...r };
    }
    return best;
  }

  segmentPoint(segId, t) {
    const s = this.segments.get(segId);
    const a = this.intersections.get(s.a), b = this.intersections.get(s.b);
    return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
  }

  segmentClogged(seg) { return seg.basins.some((id) => this.basins.get(id).status === 'clogged'); }

  // ---- stations ----
  // info: [{station_id, name, lat, lon, capacity}], status: {id: {bikes, docks}}
  setStations(info, status) {
    this.stations.clear();
    for (const s of info) {
      const p = this.proj.toXY(s.lat, s.lon);
      if (!this.inStudyArea(p)) continue;
      const near = this.nearestSegment(p);
      if (!near) continue;
      const seg = near.seg;
      const t = Math.min(0.85, Math.max(0.15, near.t));
      const q = this.segmentPoint(seg.id, t);
      const off = (seg.width / 2 + 14) * near.side;
      const capacity = Math.max(1, s.capacity | 0);
      const st = status[s.station_id] || {};
      let bikes = Math.max(0, st.bikes ?? Math.round(capacity / 2));
      let docks = Math.max(0, st.docks ?? capacity - bikes);
      bikes = Math.min(bikes, capacity);
      docks = Math.min(docks, capacity - bikes); // bikes + docks never exceed capacity
      this.stations.set(String(s.station_id), {
        id: String(s.station_id), name: s.name, lat: s.lat, lon: s.lon,
        x: q.x + seg.normal.x * off, y: q.y + seg.normal.y * off,
        segment: seg.id, t, capacity, bikes, docks, status: 'open',
      });
    }
    for (const seg of this.segments.values()) seg.stations = [];
    for (const st of this.stations.values()) this.segments.get(st.segment).stations.push(st.id);
    this.updatePassability();
  }

  updateStationStatus(status) {
    for (const st of this.stations.values()) {
      const s = status[st.id];
      if (!s) continue;
      st.bikes = Math.min(Math.max(0, s.bikes), st.capacity);
      st.docks = Math.min(Math.max(0, s.docks), st.capacity - st.bikes);
    }
  }

  stationOpen(st) { return st.status === 'open'; }

  // ---- sensors ----
  setSensors(list) {
    this.sensors.clear();
    for (const seg of this.segments.values()) seg.sensors = [];
    for (const s of list) {
      const p = this.proj.toXY(s.lat, s.lon);
      if (!this.inStudyArea(p)) continue;
      const near = this.nearestSegment(p);
      if (!near) continue;
      const sensor = { id: s.id, name: s.name || s.id, x: near.q.x, y: near.q.y, segment: near.seg.id, liveDepth: s.depth, depth: s.depth };
      this.sensors.set(sensor.id, sensor);
      near.seg.sensors.push(sensor.id);
    }
  }

  // Real mode: a segment's depth is the nearest sensor's reading within 500 ft, else 0.
  applySensorDepths() {
    for (const seg of this.segments.values()) {
      const a = this.intersections.get(seg.a), b = this.intersections.get(seg.b);
      let best = null;
      for (const s of this.sensors.values()) {
        const d = pointToSegment(s, a, b).d;
        if (d <= C.SENSOR_RADIUS_FT && (!best || d < best.d)) best = { d, s };
      }
      seg.depth = best ? best.s.liveDepth : 0;
      seg.depthSource = best ? best.s.id : null;
    }
    for (const s of this.sensors.values()) s.depth = s.liveDepth;
    this.updatePassability();
  }

  // Real mode: basins on segments with an open 311 catch basin complaint are clogged.
  applyComplaints(complaints) {
    this.complaints = [];
    for (const b of this.basins.values()) b.status = 'clear';
    for (const c of complaints) {
      const p = this.proj.toXY(c.lat, c.lon);
      if (!this.inStudyArea(p)) continue;
      const near = this.nearestSegment(p, C.COMPLAINT_SNAP_FT);
      if (!near) continue;
      this.complaints.push({ ...c, x: p.x, y: p.y, segment: near.seg.id });
      for (const id of near.seg.basins) this.basins.get(id).status = 'clogged';
    }
  }

  saveSimBasins() { this.simBasins = new Map([...this.basins.values()].map((b) => [b.id, b.status])); }
  restoreSimBasins() { if (this.simBasins) for (const [id, s] of this.simBasins) this.basins.get(id).status = s; }

  // ---- flooding ----
  updateFlood(dt) {
    for (const seg of this.segments.values()) {
      const clogged = this.segmentClogged(seg);
      if (this.rain !== 'off') {
        const rate = C.RAIN_RATES[this.rain][seg.elevation] * (clogged ? C.CLOGGED_FLOOD_FACTOR : 1);
        seg.depth = Math.min(C.MAX_DEPTH_IN, seg.depth + rate * dt);
      } else if (seg.depth > 0) {
        const rate = C.DRAIN_RATE * (clogged ? C.CLOGGED_DRAIN_FACTOR : 1);
        seg.depth = Math.max(0, seg.depth - rate * dt);
      }
    }
    // In simulation, sensors read the depth of the segment they sit on.
    for (const s of this.sensors.values()) s.depth = this.segments.get(s.segment).depth;
    this.updatePassability();
  }

  resetDepths() {
    for (const seg of this.segments.values()) { seg.depth = 0; seg.depthSource = null; }
    for (const s of this.sensors.values()) s.depth = 0;
    this.updatePassability();
  }

  // Returns the list of segments that just became impassable.
  updatePassability() {
    const closed = [];
    let changed = false;
    for (const seg of this.segments.values()) {
      const p = seg.depth <= C.IMPASSABLE_DEPTH_IN;
      if (p !== seg.passable) {
        changed = true;
        if (!p) closed.push(seg);
        seg.passable = p;
      }
    }
    for (const st of this.stations.values()) {
      const s = this.segments.get(st.segment).passable ? 'open' : 'flooded';
      if (s !== st.status) { st.status = s; if (s === 'flooded') this.log(`${st.name} is flooded`); }
    }
    if (changed) {
      this.version++;
      for (const seg of closed) this.log(`${seg.name} (${this.segLabel(seg)}) is impassable`);
      this.onPassabilityChange(closed);
    }
    return closed;
  }

  segLabel(seg) {
    const a = this.intersections.get(seg.a).name.split(' & '), b = this.intersections.get(seg.b).name.split(' & ');
    const other = (pair) => pair.find((n) => n !== seg.name) || pair[1];
    return `${other(a)} to ${other(b)}`;
  }

  // ---- routing ----
  // A location is a point on a street segment: {seg, t}.
  // Shortest path between two locations, using only passable segments unless dry is true.
  shortestPath(from, to, dry = false) {
    const ok = (seg) => dry || seg.passable;
    const fs = this.segments.get(from.seg), ts = this.segments.get(to.seg);
    if (!ok(fs) || !ok(ts)) return null;
    let best = null;
    if (from.seg === to.seg) best = { length: Math.abs(to.t - from.t) * fs.length, legs: [{ seg: fs.id, t0: from.t, t1: to.t }] };

    const D = new Map(), prev = new Map(), done = new Set();
    D.set(fs.a, from.t * fs.length); prev.set(fs.a, { start: 0 });
    const db = (1 - from.t) * fs.length;
    if (!D.has(fs.b) || db < D.get(fs.b)) { D.set(fs.b, db); prev.set(fs.b, { start: 1 }); }
    while (true) {
      let u = null, du = Infinity;
      for (const [k, v] of D) if (!done.has(k) && v < du) { u = k; du = v; }
      if (u === null) break;
      done.add(u);
      for (const sid of this.intersections.get(u).segments) {
        const s = this.segments.get(sid);
        if (!ok(s)) continue;
        const w = s.a === u ? s.b : s.a;
        const nd = du + s.length;
        if (!D.has(w) || nd < D.get(w)) { D.set(w, nd); prev.set(w, { from: u, seg: sid }); }
      }
    }
    for (const [node, endT] of [[ts.a, 0], [ts.b, 1]]) {
      if (!D.has(node)) continue;
      const total = D.get(node) + Math.abs(to.t - endT) * ts.length;
      if (best && total >= best.length - 1e-6) continue;
      // Walk back to build the legs.
      const legs = [];
      let cur = node;
      while (prev.get(cur).from !== undefined) {
        const p = prev.get(cur);
        const s = this.segments.get(p.seg);
        legs.unshift({ seg: s.id, t0: s.a === p.from ? 0 : 1, t1: s.a === p.from ? 1 : 0 });
        cur = p.from;
      }
      legs.unshift({ seg: fs.id, t0: from.t, t1: prev.get(cur).start });
      legs.push({ seg: ts.id, t0: endT, t1: to.t });
      const kept = legs.filter((l) => Math.abs(l.t1 - l.t0) > 1e-9);
      best = { length: total, legs: kept.length ? kept : [legs[legs.length - 1]] };
    }
    return best;
  }

  stationLoc(st) { return { seg: st.segment, t: st.t }; }

  // Build a Route entity between two locations.
  makeRoute(from, to, originId, destId) {
    const p = this.shortestPath(from, to);
    if (!p) return null;
    const dry = this.shortestPath(from, to, true);
    const route = { legs: p.legs, distance: p.length, dryDistance: dry ? dry.length : p.length, origin: originId, destination: destId, from, to };
    route.detour = route.distance - route.dryDistance;
    route.segments = [...new Set(route.legs.map((l) => l.seg))];
    route.cum = [];
    let acc = 0;
    for (const l of route.legs) { route.cum.push(acc); acc += Math.abs(l.t1 - l.t0) * this.segments.get(l.seg).length; }
    route.dryLegs = dry ? dry.legs : p.legs;
    return route;
  }

  // Location reached after travelling d feet along a route.
  routeLoc(route, d) {
    for (let i = route.legs.length - 1; i >= 0; i--) {
      if (d >= route.cum[i] || i === 0) {
        const l = route.legs[i];
        const len = Math.abs(l.t1 - l.t0) * this.segments.get(l.seg).length || 1;
        const f = Math.max(0, Math.min(1, (d - route.cum[i]) / len));
        return { seg: l.seg, t: lerp(l.t0, l.t1, f), leg: i };
      }
    }
  }

  legsToPoints(legs, fromD = 0, route = null) {
    const pts = [];
    legs.forEach((l, i) => {
      let t0 = l.t0;
      if (route) {
        const legLen = Math.abs(l.t1 - l.t0) * this.segments.get(l.seg).length;
        const end = route.cum[i] + legLen;
        if (end <= fromD) return;
        if (fromD > route.cum[i]) t0 = lerp(l.t0, l.t1, (fromD - route.cum[i]) / (legLen || 1));
      }
      pts.push(this.segmentPoint(l.seg, t0), this.segmentPoint(l.seg, l.t1));
    });
    return pts;
  }

  canEndAt(st) { return this.stationOpen(st) && st.docks >= 1; }
  canStartAt(st) { return this.stationOpen(st) && st.bikes >= 1; }

  // Nearest open station with a dock to `near` (usually the original destination)
  // that can be reached from `loc`. Returns {station, route} or null.
  nearestDock(loc, near, originId, excludeId) {
    const options = [...this.stations.values()]
      .filter((st) => st.id !== excludeId && this.canEndAt(st))
      .sort((a, b) => dist(a, near) - dist(b, near));
    for (const st of options) {
      const r = this.makeRoute(loc, this.stationLoc(st), originId, st.id);
      if (r) return { station: st, route: r };
    }
    return null;
  }

  // ---- riders ----
  riderLoc(r) {
    if (r.loc && (r.state === 'riding' || r.state === 'fallen' || r.state === 'stranded')) return r.loc;
    return this.stationLoc(this.stations.get(r.station));
  }

  riderPosition(r) {
    if (r.state === 'waiting' || r.state === 'docked' || (r.state === 'stranded' && !r.hasBike)) {
      const st = this.stations.get(r.station);
      const here = [...this.riders.values()].filter((o) => o.station === r.station && !o.loc);
      const k = Math.max(0, here.indexOf(r));
      const ang = (k / Math.max(here.length, 1)) * Math.PI * 2;
      return { x: st.x + Math.cos(ang) * 26, y: st.y + Math.sin(ang) * 26 };
    }
    return this.segmentPoint(r.loc.seg, r.loc.t);
  }

  addRider({ state, origin, destination, progress = 0, timer = 0 }) {
    const id = `R${this.nextRiderId++}`;
    const r = { id, state, origin, destination, station: origin, route: null, progress: 0, loc: null, timer, hasBike: false, falls: 0, dispatched: false };
    this.riders.set(id, r);
    const o = this.stations.get(origin), d = this.stations.get(destination);
    r.route = this.makeRoute(this.stationLoc(o), this.stationLoc(d), origin, destination);
    if (state === 'riding') {
      if (!r.route) { r.state = 'waiting'; return r; }
      r.hasBike = true;
      r.station = null;
      r.progress = r.route.distance * progress;
      r.loc = this.routeLoc(r.route, r.progress);
    } else if (state === 'docked') {
      r.station = destination;
      r.route = null;
    }
    return r;
  }

  removeRider(id) { this.riders.delete(id); }

  // A random open station with bikes, and a random other destination.
  addRandomRider(rng = this.rng) {
    const starts = [...this.stations.values()].filter((s) => this.canStartAt(s));
    if (!starts.length) return null;
    const o = starts[Math.floor(rng() * starts.length)];
    const others = [...this.stations.values()].filter((s) => s.id !== o.id);
    if (!others.length) return null;
    const d = others[Math.floor(rng() * others.length)];
    const r = this.addRider({ state: 'waiting', origin: o.id, destination: d.id, timer: 5 });
    this.log(`${r.id} added at ${o.name}, heading to ${d.name}`);
    return r;
  }

  startRide(r) {
    const st = this.stations.get(r.station);
    st.bikes -= 1; // starting a ride takes a bike and frees a dock
    st.docks += 1;
    r.hasBike = true;
    r.origin = st.id;
    r.station = null;
    r.progress = 0;
    r.state = 'riding';
    r.loc = this.routeLoc(r.route, 0);
  }

  endRide(r, st) {
    st.bikes += 1; // ending a ride returns a bike and fills a dock
    st.docks -= 1;
    r.hasBike = false;
    r.state = 'docked';
    r.station = st.id;
    r.destination = st.id;
    r.loc = null;
    r.route = null;
    r.timer = C.DOCKED_REST_S;
    if (r.dispatched) this.alert('ok', `${r.id} docked at ${st.name}`);
    else this.log(`${r.id} docked at ${st.name}`);
    r.dispatched = false;
  }

  // Send a rider to a station the person picked. If that dock is full (or flooded),
  // the rider heads for the nearest dock with space instead.
  // Returns {ok, msg, kind} for the view to show.
  dispatch(r, destId) {
    const dest = this.stations.get(destId);
    if (!r || !dest) return { ok: false, kind: 'error', msg: 'Pick a rider and a station.' };
    if (r.state === 'fallen') return { ok: false, kind: 'error', msg: `${r.id} has fallen off their bike and can't ride yet.` };
    const atStation = !r.loc;
    const here = atStation ? this.stations.get(r.station) : null;
    if (atStation && here.id === dest.id) return { ok: false, kind: 'error', msg: `${r.id} is already at ${dest.name}.` };
    if (atStation && !this.canStartAt(here)) {
      const why = here.status === 'flooded' ? 'is flooded' : 'has no bikes left';
      return { ok: false, kind: 'error', msg: `${r.id} can't start: ${here.name} ${why}.` };
    }
    const loc = atStation ? this.stationLoc(here) : r.loc;
    const origin = atStation ? here.id : r.origin;
    let route = null, target = dest, problem = null;
    if (!this.stationOpen(dest)) problem = `${dest.name} is flooded`;
    else if (dest.docks < 1) problem = `${dest.name} is full (0 of ${dest.capacity} docks free)`;
    else {
      route = this.makeRoute(loc, this.stationLoc(dest), origin, dest.id);
      if (!route) return { ok: false, kind: 'error', msg: `No flood-free route from ${r.id} to ${dest.name} right now.` };
    }
    if (problem) {
      const alt = this.nearestDock(loc, dest, origin, here?.id);
      if (!alt) return { ok: false, kind: 'error', msg: `${problem}, and no other dock with space can be reached.` };
      route = alt.route;
      target = alt.station;
    }
    r.destination = target.id;
    r.route = route;
    r.dispatched = true;
    if (atStation) {
      this.startRide(r);
    } else {
      r.state = 'riding';
      r.progress = 0;
      r.loc = this.routeLoc(route, 0);
    }
    const dist = `${Math.round(route.distance).toLocaleString()} ft`;
    if (problem) {
      const msg = `${problem}. ${r.id} is riding to the nearest dock with space instead: ${target.name} (${dist}).`;
      this.alert('error', msg);
      return { ok: true, kind: 'error', msg };
    }
    this.log(`${r.id} sent to ${dest.name}`);
    return { ok: true, kind: 'ok', msg: `${r.id} is heading to ${dest.name} (${dist}, ${dest.docks} docks free).` };
  }

  // Give a rider with a bike a new route from where they are.
  reroute(r) {
    const loc = r.loc;
    const dest = this.stations.get(r.destination);
    let route = dest && this.canEndAt(dest) ? this.makeRoute(loc, this.stationLoc(dest), r.origin, dest.id) : null;
    if (!route) {
      const alt = this.nearestDock(loc, dest || this.segmentPoint(loc.seg, loc.t), r.origin);
      if (alt) {
        if (dest && r.dispatched && dest.docks < 1) this.alert('error', `${dest.name} filled up. ${r.id} is looking for space at ${alt.station.name}.`);
        else if (dest) this.log(`${r.id} rerouted to ${alt.station.name}`);
        r.destination = alt.station.id;
        route = alt.route;
      }
    }
    if (!route) {
      if (r.state !== 'stranded') this.log(`${r.id} is stranded`);
      r.state = 'stranded';
      r.route = null;
      return false;
    }
    if (r.state === 'stranded') this.log(`${r.id} has a route again`);
    r.route = route;
    r.progress = 0;
    r.state = 'riding';
    r.loc = this.routeLoc(route, 0);
    return true;
  }

  // Rule: when a segment becomes impassable, riders whose route crosses it get a new route.
  // Routes are always the shortest passable path, so riders also re-plan when streets reopen.
  onPassabilityChange(closed) {
    const closedIds = new Set(closed.map((s) => s.id));
    for (const r of this.riders.values()) {
      if (r.state === 'riding' && r.route) {
        const remaining = r.route.legs.slice(r.loc.leg ?? 0).map((l) => l.seg);
        const crosses = remaining.some((s) => closedIds.has(s));
        const before = r.route.distance - r.progress;
        if (this.reroute(r) && crosses) this.log(`${r.id} rerouted around flooding (${Math.round(r.route.distance)} ft left, was ${Math.round(before)} ft)`);
      } else if (r.route && r.station) {
        // Riders waiting at a station keep a planned route up to date.
        r.route = this.makeRoute(this.riderLoc(r), this.stationLoc(this.stations.get(r.destination)), r.station, r.destination);
      }
    }
  }

  updateRiders(dt) {
    for (const r of this.riders.values()) {
      if (r.state === 'docked') {
        r.timer -= dt;
        if (r.timer <= 0) {
          const others = [...this.stations.values()].filter((s) => s.id !== r.station);
          const d = others[Math.floor(this.rng() * others.length)];
          r.state = 'waiting';
          r.origin = r.station;
          r.destination = d.id;
          r.timer = 15 + this.rng() * 30;
          r.route = this.makeRoute(this.riderLoc(r), this.stationLoc(d), r.station, d.id);
        }
      } else if (r.state === 'waiting' || (r.state === 'stranded' && !r.hasBike)) {
        r.timer -= dt;
        if (r.timer > 0) continue;
        const st = this.stations.get(r.station);
        if (!this.canStartAt(st)) {
          // No bikes, or the station is flooded: keep waiting at the station.
          if (r.state === 'stranded' && this.stationOpen(st)) r.state = 'waiting';
          continue;
        }
        let dest = this.stations.get(r.destination);
        let route = dest && this.canEndAt(dest) ? this.makeRoute(this.stationLoc(st), this.stationLoc(dest), st.id, dest.id) : null;
        if (!route) {
          const alt = this.nearestDock(this.stationLoc(st), dest || st, st.id, st.id);
          if (alt) { r.destination = alt.station.id; route = alt.route; }
        }
        if (!route) {
          if (r.state !== 'stranded') this.log(`${r.id} is stranded at ${st.name}: no route`);
          r.state = 'stranded';
          continue;
        }
        r.route = route;
        this.startRide(r);
        this.log(`${r.id} started a ride from ${st.name}`);
      } else if (r.state === 'stranded') {
        // Has a bike, stuck on the street: wait in place until a route opens.
        if (this.segments.get(r.loc.seg).passable) this.reroute(r);
        if (r.state === 'riding') r.loc = this.routeLoc(r.route, 0);
      } else if (r.state === 'fallen') {
        // Get back on the bike after a while and carry on from here.
        r.timer -= dt;
        if (r.timer > 0) continue;
        r.state = 'riding';
        this.log(`${r.id} got back on their bike`);
        this.reroute(r);
      } else if (r.state === 'riding') {
        const dest = this.stations.get(r.destination);
        if (!this.segments.get(r.loc.seg).passable) { this.reroute(r); continue; }
        if (!dest || !this.canEndAt(dest)) {
          if (!this.reroute(r)) continue;
          r.loc = this.routeLoc(r.route, 0);
        }
        r.progress += C.RIDER_SPEED_FT_S * dt;
        if (this.maybeFall(r, dt)) continue;
        if (r.progress >= r.route.distance) {
          r.progress = r.route.distance;
          r.loc = this.routeLoc(r.route, r.progress);
          const d = this.stations.get(r.destination);
          if (this.canEndAt(d)) this.endRide(r, d);
          else this.reroute(r);
        } else {
          r.loc = this.routeLoc(r.route, r.progress);
        }
      }
    }
  }

  // Rule: on a street with more than 3 in of water, a rider may fall off their bike.
  maybeFall(r, dt) {
    r.loc = this.routeLoc(r.route, Math.min(r.progress, r.route.distance));
    const seg = this.segments.get(r.loc.seg);
    const over = seg.depth - C.FALL_DEPTH_IN;
    if (over <= 0) return false;
    const chance = 1 - Math.exp(-C.FALL_RATE_PER_IN * over * dt);
    if (this.rng() >= chance) return false;
    r.state = 'fallen';
    r.timer = C.FALL_RECOVER_S;
    r.falls += 1;
    this.alert('warn', `${r.id} fell off their bike on ${seg.name} (${seg.depth.toFixed(1)} in of water)`);
    return true;
  }

  step(dt) {
    this.time += dt;
    if (this.mode === 'simulation') this.updateFlood(dt);
    this.updateRiders(dt);
  }

  // ---- example scene ----
  buildExample(stationSnapshot) {
    const rng = makeRng(C.EXAMPLE_SEED);
    this.rng = makeRng(C.EXAMPLE_SEED + 1);
    this.mode = 'simulation';
    this.rain = 'off';
    this.time = 0;
    this.events = [];
    this.riders.clear();
    this.nextRiderId = 1;
    for (const st of this.stations.values()) {
      const snap = stationSnapshot.get(st.id);
      if (snap) { st.bikes = snap.bikes; st.docks = snap.docks; }
    }
    for (const b of this.basins.values()) b.status = 'clear';
    for (const id of C.EXAMPLE_CLOGGED) {
      const seg = this.segments.get(id);
      if (seg) for (const b of seg.basins) this.basins.get(b).status = 'clogged';
    }
    this.saveSimBasins();
    this.resetDepths();

    const stations = [...this.stations.values()];
    if (stations.length < 2) return;
    const clogged = new Set(C.EXAMPLE_CLOGGED);
    const westOf = (st) => {
      const c = this.canalLine[Math.floor(this.canalLine.length / 2)];
      const c2 = this.canalLine[this.canalLine.length - 1];
      return (c2.x - c.x) * (st.y - c.y) - (c2.y - c.y) * (st.x - c.x) > 0;
    };
    // Prefer pairs whose dry-day route uses a clogged segment, then pairs that cross the canal.
    const pairs = [];
    for (const o of stations) for (const d of stations) {
      if (o.id === d.id) continue;
      const p = this.shortestPath(this.stationLoc(o), this.stationLoc(d), true);
      if (!p || p.length < 900 || !this.canEndAt(d)) continue;
      const usesClogged = p.legs.some((l) => clogged.has(l.seg));
      const crosses = westOf(o) !== westOf(d);
      pairs.push({ o, d, score: (usesClogged ? 2 : 0) + (crosses ? 1 : 0) + rng() * 0.9 });
    }
    pairs.sort((a, b) => b.score - a.score);
    const usedO = new Set(), usedD = new Set();
    let riding = 0;
    for (const p of pairs) {
      if (riding >= 5) break;
      if (usedO.has(p.o.id) || usedD.has(p.d.id)) continue;
      usedO.add(p.o.id); usedD.add(p.d.id);
      this.addRider({ state: 'riding', origin: p.o.id, destination: p.d.id, progress: 0.1 + rng() * 0.25 });
      riding++;
    }
    const withBikes = stations.filter((s) => s.bikes >= 1 && !usedO.has(s.id));
    const pick = (list) => list.splice(Math.floor(rng() * list.length), 1)[0];
    for (let i = 0; i < 2 && withBikes.length; i++) {
      const o = pick(withBikes);
      const others = stations.filter((s) => s.id !== o.id);
      const d = others[Math.floor(rng() * others.length)];
      this.addRider({ state: 'waiting', origin: o.id, destination: d.id, timer: 20 + i * 25 });
    }
    const dockAt = stations.filter((s) => !usedD.has(s.id))[0] || stations[0];
    this.addRider({ state: 'docked', origin: dockAt.id, destination: dockAt.id, timer: C.DOCKED_REST_S });
    this.version++;
    this.log('Example scene loaded');
  }
}
