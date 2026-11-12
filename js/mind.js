// What a single agent knows about the park: the cells it has seen, what it
// found there, the landmarks it saved, and the other agents it has noticed.
// Knowledge is kept on a 10 ft grid (2 x 2 simulation cells).
import * as G from './geometry.js';

export const K = { UNKNOWN: 0, OPEN: 1, BLOCKED: 2, WATER: 3 };

// Vision cones per agent kind: field of view in degrees, range in feet.
export const SENSORS = {
  person: { fov: 120, range: 90, woodsRange: 35 },
  steward: { fov: 140, range: 150, woodsRange: 60 },
  mower: { fov: 100, range: 100, woodsRange: 30 },
  skimmer: { fov: 360, range: 70, woodsRange: 20 },
};

const DIRS = ['east', 'northeast', 'north', 'northwest', 'west', 'southwest', 'south', 'southeast'];
export function compass(dx, dy) {
  const a = Math.atan2(dy, dx);
  return DIRS[(Math.round(a / (Math.PI / 4)) + 8) % 8];
}

export class Mind {
  constructor(L) {
    this.L = L;
    this.cols = Math.ceil(L.cols / 2);
    this.rows = Math.ceil(L.rows / 2);
    this.seen = new Uint8Array(this.cols * this.rows);
    this.seenAt = new Uint16Array(this.cols * this.rows);
    this.known = 0;              // number of cells seen at least once
    this.landmarks = [];         // { key, type, label, x, y, t, rel, trailIndex }
    this.byKey = new Map();
    this.others = new Map();     // id -> { kind, x, y, t }
    this.cone = null;            // { x, y, heading, fov, range } of the last look
  }

  // Knowledge cell for a simulation cell / a point.
  kOfCell(c) { const col = c % this.L.cols, row = (c - col) / this.L.cols; return (row >> 1) * this.cols + (col >> 1); }
  kAt(p) { const c = this.L.cellAt(p); return c < 0 ? -1 : this.kOfCell(c); }
  kx(k) { return this.L.x0 + ((k % this.cols) + 0.5) * this.L.cell * 2; }
  ky(k) { return this.L.y0 + (Math.floor(k / this.cols) + 0.5) * this.L.cell * 2; }
  knowsCell(c) { return this.seen[this.kOfCell(c)] !== K.UNKNOWN; }

  mark(k, v, t) {
    if (k < 0) return;
    if (this.seen[k] === K.UNKNOWN) this.known++;
    // Open wins over blocked inside one 10 ft cell, so narrow paths stay open.
    if (!(this.seen[k] === K.OPEN && v === K.BLOCKED)) this.seen[k] = v;
    this.seenAt[k] = t;
  }

  // Remember everything within a radius (used at spawn: "I can see where I'm standing").
  glance(model, p, radius, kind, t) {
    const L = this.L, r = Math.ceil(radius / L.cell), c0 = L.cellAt(p);
    if (c0 < 0) return;
    const col0 = c0 % L.cols, row0 = (c0 - col0) / L.cols;
    for (let dr = -r; dr <= r; dr++) for (let dc = -r; dc <= r; dc++) {
      if (dr * dr + dc * dc > r * r) continue;
      const col = col0 + dc, row = row0 + dr;
      if (col < 0 || row < 0 || col >= L.cols || row >= L.rows) continue;
      const c = row * L.cols + col;
      this.mark(this.kOfCell(c), model.cellKind(c, kind), t);
    }
  }

  // Add or refresh a landmark. Returns true if it is new.
  remember(lm) {
    const old = this.byKey.get(lm.key);
    if (old) { Object.assign(old, { x: lm.x, y: lm.y, t: lm.t, label: lm.label, data: lm.data }); return false; }
    this.landmarks.push(lm);
    this.byKey.set(lm.key, lm);
    if (this.heat) { const k = this.kAt(lm); if (k >= 0) this.heat[k] += 1; }
    if (this.landmarks.length > 80) {
      // Forget the oldest hindrance first; places are kept.
      const i = this.landmarks.findIndex((l) => l.type === 'hindrance' || l.type === 'issue');
      const gone = this.landmarks.splice(i >= 0 ? i : 1, 1)[0];
      this.byKey.delete(gone.key);
    }
    return true;
  }
  forget(key) {
    const lm = this.byKey.get(key);
    if (!lm) return;
    this.byKey.delete(key);
    this.landmarks.splice(this.landmarks.indexOf(lm), 1);
  }

  // Where a landmark is, in the agent's own terms: next to something it
  // already knows, or relative to where it started.
  relativeTo(p, origin, originLabel) {
    let best = null, bd = 260;
    for (const l of this.landmarks) {
      if (l.type !== 'place' && l.type !== 'start') continue;
      const d = G.dist(l, p);
      if (d < bd && d > 5) { bd = d; best = l; }
    }
    const ref = best ? { x: best.x, y: best.y, label: best.label } : { ...origin, label: originLabel };
    const d = G.dist(ref, p);
    if (d < 25) return `next to ${ref.label}`;
    return `${Math.round(d / 10) * 10} ft ${compass(p.x - ref.x, p.y - ref.y)} of ${ref.label}`;
  }

  // Copy what another mind knows into this one (fresher wins).
  mergeFrom(other, landmarkFilter = () => true) {
    const n = this.seen.length;
    for (let k = 0; k < n; k++) {
      const v = other.seen[k];
      if (v === K.UNKNOWN) continue;
      if (this.seen[k] === K.UNKNOWN || other.seenAt[k] > this.seenAt[k]) {
        if (this.seen[k] === K.UNKNOWN) this.known++;
        this.seen[k] = v; this.seenAt[k] = other.seenAt[k];
      }
    }
    // Map syncs copy landmarks; they are not counted as new ones on the heatmap.
    const h = this.heat; this.heat = null;
    for (const l of other.landmarks) if (landmarkFilter(l)) this.remember({ ...l });
    this.heat = h;
  }

  // Known open cells next to unknown ones: the edge of what the agent has explored.
  frontier(limit = 4000) {
    const out = [], { cols, rows, seen } = this;
    for (let k = 0; k < seen.length && out.length < limit; k++) {
      if (seen[k] !== K.OPEN) continue;
      const col = k % cols, row = (k - col) / cols;
      if ((col > 0 && seen[k - 1] === K.UNKNOWN) || (col + 1 < cols && seen[k + 1] === K.UNKNOWN)
        || (row > 0 && seen[k - cols] === K.UNKNOWN) || (row + 1 < rows && seen[k + cols] === K.UNKNOWN)) out.push(k);
    }
    return out;
  }
}
