// The fixed geometry of the scene: a real section of Central Park (the Lake
// and the Ramble) baked from NYC Open Data by tools/bake_park.py into
// data/park.json. Units are feet, x east and y north.
//
// The simulation runs on a 5 ft grid. Every cell belongs to one region (the
// lake, the woods, a lawn or a path) or to nothing (plantings, buildings,
// outside the park). Regions keep their polygons for drawing.
import * as G from './geometry.js';

export async function loadLayout(url = 'data/park.json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url}`);
  return buildLayout(await res.json());
}

export function buildLayout(d) {
  const g = d.grid;
  const N = g.cols * g.rows;
  const label = new Uint16Array(N);
  for (let i = 0, k = 0; i < g.rle.length; i += 2) { label.fill(g.rle[i], k, k + g.rle[i + 1]); k += g.rle[i + 1]; }

  const regions = d.regions.map((r) => ({ ...r, polygons: r.polygons.map((p) => p.map((ring) => ring.map(([x, y]) => ({ x, y })))) }));
  const byId = Object.fromEntries(regions.map((r) => [r.id, r]));
  // label value k (1-based) -> region index k-1
  const cellsOf = regions.map(() => []);
  for (let i = 0; i < N; i++) if (label[i]) cellsOf[label[i] - 1].push(i);
  const L = Object.assign(Object.create(proto), {
    data: d, bounds: d.bounds, cell: g.cell, cols: g.cols, rows: g.rows, x0: g.x0, y0: g.y0, N, label, regions, byId,
    other: Object.fromEntries(Object.entries(d.other).map(([k, v]) => [k, (v || []).map((p) => p.map((ring) => ring.map(([x, y]) => ({ x, y }))))])),
    trails: d.trails.map((t) => ({ ...t, points: t.points.map(([x, y]) => ({ x, y })) })),
    trees: d.trees,
  });
  regions.forEach((r, k) => {
    r.index = k + 1;
    r.cells = Int32Array.from(cellsOf[k]);
    let sx = 0, sy = 0;
    for (const c of r.cells) { sx += L.cx(c); sy += L.cy(c); }
    r.center = r.cells.length ? { x: sx / r.cells.length, y: sy / r.cells.length } : { x: 0, y: 0 };
    // The representative point is a cell of the region nearest its centroid.
    let best = r.cells[0], bd = Infinity;
    for (const c of r.cells) { const dd = (L.cx(c) - r.center.x) ** 2 + (L.cy(c) - r.center.y) ** 2; if (dd < bd) { bd = dd; best = c; } }
    r.anchor = { x: L.cx(best), y: L.cy(best) };
    r.boundary = r.polygons.length ? r.polygons.reduce((a, p) => (G.polygonArea(p[0]) > G.polygonArea(a) ? p[0] : a), r.polygons[0][0]) : [];
  });
  Object.assign(L, {
    lake: byId.lake, woods: byId.woods,
    paths: regions.filter((r) => r.kind === 'path'),
    lawns: regions.filter((r) => r.kind === 'lawn'),
  });
  L.regionOfCell = (c) => (c >= 0 && label[c] ? regions[label[c] - 1] : null);

  // Fences, gate, landing, robot center.
  const pt = ([x, y]) => ({ x, y });
  L.fences = d.fences.map((f) => ({ id: f.id, a: pt(f.a), b: pt(f.b) }));
  L.gate = { id: 'gate', kind: 'gate', name: 'Maintenance Gate', position: pt(d.gate.position), a: pt(d.gate.a), b: pt(d.gate.b) };
  L.landing = { id: 'landing', kind: 'landing', name: d.landing.name, position: pt(d.landing.position), pathPoint: pt(d.landing.pathPoint), waterPoint: pt(d.landing.waterPoint) };
  L.center = { id: 'center', kind: 'center', name: d.center.name, position: pt(d.center.position), dock: pt(d.center.dock) };
  L.landing.pathId = L.regionOfCell(L.cellAtNearest(L.landing.pathPoint, (r) => r.kind === 'path'))?.id;
  L.landing.pathPoint = L.snap(L.landing.pathPoint, (r) => r.kind === 'path');
  L.center.position = L.snap(L.center.position, (r) => r.kind === 'path');
  L.center.dock = L.snap(L.center.dock, (r) => r.kind === 'lake');
  L.landing.waterPoint = L.snap(L.landing.waterPoint, (r) => r.kind === 'lake');

  // Region adjacency (4-neighbor cells) and distance from the lake shore.
  const adj = Object.fromEntries(regions.map((r) => [r.id, new Set()]));
  for (let row = 0; row < g.rows; row++) {
    for (let col = 0; col < g.cols; col++) {
      const i = row * g.cols + col, a = label[i];
      if (!a) continue;
      for (const j of [col + 1 < g.cols ? i + 1 : -1, row + 1 < g.rows ? i + g.cols : -1]) {
        if (j < 0) continue;
        const b = label[j];
        if (b && b !== a) { adj[regions[a - 1].id].add(regions[b - 1].id); adj[regions[b - 1].id].add(regions[a - 1].id); }
      }
    }
  }
  // Regions within 15 ft of the lake also count as bordering it (plantings
  // often sit between a shore path and the water).
  const lakeDist = L.distanceField((c) => label[c] === L.lake.index);
  L.lakeDist = lakeDist;
  for (const r of regions) {
    if (r.kind === 'lake') continue;
    let m = Infinity;
    for (const c of r.cells) if (lakeDist[c] < m) m = lakeDist[c];
    r.lakeGap = m * g.cell;
    if (m <= 3) { adj[r.id].add('lake'); adj.lake.add(r.id); }
  }
  L.adj = adj;

  // Overflow tiers: low ground by the lake floods first, then medium.
  const lakeside = new Set([...adj.lake]);
  for (const id of adj.lake) if (byId[id].kind === 'path' && byId[id].elevation === 'low') for (const n of adj[id]) lakeside.add(n);
  L.overflowTier = {};
  for (const id of lakeside) {
    const r = byId[id];
    if (r.kind !== 'path' && r.kind !== 'lawn') continue;
    if (r.elevation === 'low') L.overflowTier[id] = 1;
    else if (r.elevation === 'medium' && adj[id].has('lake')) L.overflowTier[id] = 2;
  }

  // Fence crossings: each woods cell on the woods edge knows the fence
  // segment (or gate) it sits behind.
  const W = L.woods.index;
  L.fenceAt = new Int32Array(N).fill(-1); // fence index, or -2 for the gate
  for (const c of L.woods.cells) {
    let edge = false;
    L.neighbors4(c, (n) => { if (label[n] !== W && label[n] !== L.lake.index) edge = true; });
    if (!edge) continue;
    const p = { x: L.cx(c), y: L.cy(c) };
    if (G.closestOnSegment(p, L.gate.a, L.gate.b).d < 9) { L.fenceAt[c] = -2; continue; }
    let best = -1, bd = 16;
    L.fences.forEach((f, k) => { const dd = G.closestOnSegment(p, f.a, f.b).d; if (dd < bd) { bd = dd; best = k; } });
    L.fenceAt[c] = best;
  }

  // Woods cells near the Ramble's trails, where people like to walk.
  L.trailCells = [];
  const inWoodsTrail = new Uint8Array(N);
  for (const t of L.trails) {
    for (let k = 0; k + 1 < t.points.length; k++) {
      const a = t.points[k], b = t.points[k + 1], n = Math.ceil(G.dist(a, b) / 3);
      for (let s = 0; s <= n; s++) {
        const c = L.cellAt({ x: a.x + ((b.x - a.x) * s) / n, y: a.y + ((b.y - a.y) * s) / n });
        if (c >= 0 && label[c] === W && !inWoodsTrail[c]) { inWoodsTrail[c] = 1; L.trailCells.push(c); }
      }
    }
  }

  // Duckweed grid: 20 ft cells whose centers fall in the lake.
  const DC = 20, lb = G.bounds(L.lake.boundary);
  const dcols = Math.ceil((lb.x1 - lb.x0) / DC), drows = Math.ceil((lb.y1 - lb.y0) / DC);
  const cells = [], cellIndex = new Int32Array(dcols * drows).fill(-1);
  for (let r = 0; r < drows; r++) {
    for (let c = 0; c < dcols; c++) {
      const p = { x: lb.x0 + (c + 0.5) * DC, y: lb.y0 + (r + 0.5) * DC };
      const gc = L.cellAt(p);
      if (gc >= 0 && label[gc] === L.lake.index) { cellIndex[r * dcols + c] = cells.length; cells.push({ id: `C${c}-${r}`, col: c, row: r, x: p.x, y: p.y }); }
    }
  }
  for (const cell of cells) {
    cell.nbrs = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dc, dr]) => {
      const c = cell.col + dc, r = cell.row + dr;
      return c >= 0 && r >= 0 && c < dcols && r < drows ? cellIndex[r * dcols + c] : -1;
    }).filter((i) => i >= 0);
  }
  L.grid = { CELL: DC, x0: lb.x0, y0: lb.y0, cols: dcols, rows: drows, cells, cellIndex };
  return L;
}

// Grid helpers, attached to the layout object.
const proto = {
  cx(c) { return this.x0 + ((c % this.cols) + 0.5) * this.cell; },
  cy(c) { return this.y0 + (Math.floor(c / this.cols) + 0.5) * this.cell; },
  cellAt(p) {
    const col = Math.floor((p.x - this.x0) / this.cell), row = Math.floor((p.y - this.y0) / this.cell);
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return -1;
    return row * this.cols + col;
  },
  regionAt(p) { return this.regionOfCell(this.cellAt(p)); },
  neighbors4(c, fn) {
    const col = c % this.cols, row = (c - col) / this.cols;
    if (col > 0) fn(c - 1); if (col + 1 < this.cols) fn(c + 1);
    if (row > 0) fn(c - this.cols); if (row + 1 < this.rows) fn(c + this.cols);
  },
  // Breadth-first distance (in cells, 4-connected) from every cell to the nearest source cell.
  distanceField(isSource) {
    const d = new Uint16Array(this.N).fill(65535), q = new Int32Array(this.N);
    let h = 0, t = 0;
    for (let i = 0; i < this.N; i++) if (isSource(i)) { d[i] = 0; q[t++] = i; }
    while (h < t) {
      const c = q[h++], nd = d[c] + 1;
      this.neighbors4(c, (n) => { if (d[n] > nd) { d[n] = nd; q[t++] = n; } });
    }
    return d;
  },
  cellAtNearest(p, filter) {
    const c0 = this.cellAt(p);
    const col0 = c0 % this.cols, row0 = Math.floor(c0 / this.cols);
    for (let r = 0; r < 40; r++) {
      let best = -1, bd = Infinity;
      for (let dr = -r; dr <= r; dr++) for (let dc = -r; dc <= r; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== r) continue;
        const col = col0 + dc, row = row0 + dr;
        if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) continue;
        const c = row * this.cols + col, reg = this.regionOfCell(c);
        if (reg && filter(reg)) { const dd = dr * dr + dc * dc; if (dd < bd) { bd = dd; best = c; } }
      }
      if (best >= 0) return best;
    }
    return c0;
  },
  snap(p, filter) {
    const r = this.regionAt(p);
    if (r && filter(r)) return { ...p };
    const c = this.cellAtNearest(p, filter);
    return { x: this.cx(c), y: this.cy(c) };
  },
};
