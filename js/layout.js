// The fixed geometry of the example scene: a stylized section of Central Park
// inspired by the Lake and the Ramble. Units are feet, x east and y north.
//
//   Woods (fenced) | West Walk | The Lake | Lakeside Walk | Big Lawn / Lawn Walk / Small Lawn
//   North Walk runs along the top, from the woods across to the lawns.
//   Lakeside Walk (south) closes the loop around the lake.
import * as G from './geometry.js';

export const PARK = { x0: -160, x1: 160, y0: -100, y1: 100 };

function makeLake(cx, cy, a, b, n = 2.6, count = 96) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    const t = (i / count) * Math.PI * 2;
    const c = Math.cos(t), s = Math.sin(t);
    // Superellipse, pulled in a little in places so the shore looks natural.
    const w = 1 - 0.015 * (1 + Math.sin(3 * t + 0.7)) - 0.01 * (1 + Math.cos(5 * t + 1.3));
    pts.push({
      x: cx + a * w * Math.sign(c) * Math.abs(c) ** (2 / n),
      y: cy + b * w * Math.sign(s) * Math.abs(s) ** (2 / n),
    });
  }
  return G.ensureCCW(pts);
}

function splitEdge(a, b, target, skip) {
  // Split a straight edge into pieces about `target` feet long, leaving the
  // `skip` interval (a gate opening, in edge distance) uncovered.
  const len = G.dist(a, b);
  const at = (d) => ({ x: a.x + ((b.x - a.x) * d) / len, y: a.y + ((b.y - a.y) * d) / len });
  const ranges = skip ? [[0, skip[0]], [skip[1], len]] : [[0, len]];
  const out = [];
  for (const [d0, d1] of ranges) {
    const n = Math.max(1, Math.round((d1 - d0) / target));
    for (let i = 0; i < n; i++) out.push([at(d0 + ((d1 - d0) * i) / n), at(d0 + ((d1 - d0) * (i + 1)) / n)]);
  }
  return out;
}

export function buildLayout() {
  const R = G.rectPoly;
  const lake = { id: 'lake', kind: 'lake', name: 'The Lake', boundary: makeLake(0, -4, 81, 76) };
  const paths = [
    { id: 'path-north', name: 'North Walk', boundary: R(-160, 73, 160, 79), width: 6, elevation: 'high' },
    { id: 'path-west', name: 'West Walk', boundary: R(-90, -80, -82, 72), width: 8, elevation: 'medium' },
    { id: 'path-east', name: 'Lakeside Walk (east)', boundary: R(82, -80, 90, 72), width: 8, elevation: 'low' },
    { id: 'path-south', name: 'Lakeside Walk (south)', boundary: R(-90, -89, 90, -81), width: 8, elevation: 'low' },
    { id: 'path-lawn', name: 'Lawn Walk', boundary: R(91, -45, 160, -39), width: 6, elevation: 'medium' },
  ];
  const lawns = [
    { id: 'lawn-big', name: 'Big Lawn', boundary: R(91, -38, 160, 72), elevation: 'medium' },
    { id: 'lawn-small', name: 'Small Lawn', boundary: R(91, -89, 160, -46), elevation: 'low' },
  ];
  const woods = { id: 'woods', kind: 'woods', name: 'The Woods', boundary: R(-160, -100, -91, 72) };
  for (const p of paths) p.kind = 'path';
  for (const l of lawns) l.kind = 'lawn';
  for (const r of [lake, woods, ...paths, ...lawns]) {
    r.area = G.polygonArea(r.boundary);
    r.center = G.centroid(r.boundary);
  }

  // Fence segments around the woods, with a gate opening on the east side
  // where the woods meet the West Walk.
  const gateY = -20, gateHalf = 2.5;
  const wb = woods.boundary; // (-160,-100) (-91,-100) (-91,72) (-160,72)
  const fences = [];
  const edges = [
    [wb[0], wb[1], null],
    [wb[1], wb[2], [gateY - gateHalf - wb[1].y, gateY + gateHalf - wb[1].y]],
    [wb[2], wb[3], null],
    [wb[3], wb[0], null],
  ];
  for (const [a, b, skip] of edges) {
    for (const [p, q] of splitEdge(a, b, 12, skip)) fences.push({ id: `F${fences.length + 1}`, a: p, b: q });
  }
  const gate = {
    id: 'gate', kind: 'gate', name: 'Maintenance Gate',
    position: { x: -91, y: gateY }, a: { x: -91, y: gateY - gateHalf }, b: { x: -91, y: gateY + gateHalf },
  };

  // Boat landing on the south shore, where the Lakeside Walk meets the lake.
  const south = paths.find((p) => p.id === 'path-south');
  const shore = G.closestOnPolygon({ x: 30, y: -81 }, lake.boundary);
  const landing = {
    id: 'landing', kind: 'landing', name: 'Boat Landing',
    position: { x: shore.x, y: shore.y },
    pathId: south.id,
    pathPoint: { x: shore.x, y: -82.5 },
    waterPoint: G.insideNear(shore, lake.boundary, 5),
  };

  const regions = [lake, woods, ...paths, ...lawns];
  const byId = Object.fromEntries(regions.map((r) => [r.id, r]));

  // Which regions border which (boundaries within a few feet of each other;
  // the lake shore wanders, so it gets a wider allowance).
  const adj = Object.fromEntries(regions.map((r) => [r.id, new Set()]));
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const A = regions[i], B = regions[j];
      const limit = A.kind === 'lake' || B.kind === 'lake' ? 7 : 2.5;
      if (G.polygonGap(A.boundary, B.boundary) <= limit) { adj[A.id].add(B.id); adj[B.id].add(A.id); }
    }
  }

  // Portals: pairs of points just inside two bordering land regions. Agents
  // step from one to the other to change region. Woods portals go through a
  // fence segment (people, when broken) or the gate (robots only).
  const portals = [];
  const addPair = (A, B, pa, pb, via) => {
    portals.push({ from: A.id, to: B.id, pa, pb: { ...pb, hop: true }, via });
    portals.push({ from: B.id, to: A.id, pa: pb, pb: { ...pa, hop: true }, via });
  };
  const land = regions.filter((r) => r.kind === 'path' || r.kind === 'lawn');
  for (let i = 0; i < land.length; i++) {
    for (let j = i + 1; j < land.length; j++) {
      const A = land[i], B = land[j];
      if (!adj[A.id].has(B.id)) continue;
      const poly = A.boundary;
      for (let e = 0; e < poly.length; e++) {
        const a = poly[e], b = poly[(e + 1) % poly.length];
        const len = G.dist(a, b), n = Math.max(1, Math.floor(len / 9));
        for (let k = 0; k < n; k++) {
          const t = (k + 0.5) / n;
          const s = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
          if (G.closestOnPolygon(s, B.boundary).d > 2.5) continue;
          const pa = G.insideNear(s, A.boundary, 0.8), pb = G.insideNear(s, B.boundary, 0.8);
          if (G.pointInPolygon(pa, A.boundary) && G.pointInPolygon(pb, B.boundary)) addPair(A, B, pa, pb, null);
        }
      }
    }
  }
  for (const f of [...fences, gate]) {
    const m = f.position || { x: (f.a.x + f.b.x) / 2, y: (f.a.y + f.b.y) / 2 };
    for (const P of paths) {
      if (G.closestOnPolygon(m, P.boundary).d > 2.5) continue;
      const pa = G.insideNear(m, wb, 1.2), pb = G.insideNear(m, P.boundary, 0.8);
      addPair(woods, P, pa, pb, f.kind === 'gate' ? { gate: true } : { fence: f.id });
    }
  }
  const exits = Object.fromEntries(regions.map((r) => [r.id, []]));
  portals.forEach((p, i) => exits[p.from].push(i));

  // Overflow tiers: low or medium ground that borders the lake, or borders a
  // path that borders the lake. Low floods first, then medium.
  const lakeside = new Set();
  for (const id of adj.lake) {
    lakeside.add(id);
    if (byId[id].kind === 'path' && byId[id].elevation === 'low') for (const n of adj[id]) if (n !== 'lake' && n !== 'woods') lakeside.add(n);
  }
  const overflowTier = {};
  for (const id of lakeside) {
    const r = byId[id];
    if (r.kind !== 'path' && r.kind !== 'lawn') continue;
    if (r.elevation === 'low') overflowTier[id] = 1;
    else if (r.elevation === 'medium') overflowTier[id] = 2;
  }

  // Duckweed grid: 4 ft cells whose centers fall inside the lake.
  const CELL = 4;
  const lb = G.bounds(lake.boundary);
  const cols = Math.ceil((lb.x1 - lb.x0) / CELL), rows = Math.ceil((lb.y1 - lb.y0) / CELL);
  const cells = [];
  const cellIndex = new Int32Array(cols * rows).fill(-1);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const p = { x: lb.x0 + (c + 0.5) * CELL, y: lb.y0 + (r + 0.5) * CELL };
      if (G.pointInPolygon(p, lake.boundary) && G.closestOnPolygon(p, lake.boundary).d > 1) {
        cellIndex[r * cols + c] = cells.length;
        cells.push({ id: `C${c}-${r}`, col: c, row: r, x: p.x, y: p.y });
      }
    }
  }
  for (const cell of cells) {
    cell.nbrs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([dc, dr]) => {
        const c = cell.col + dc, r = cell.row + dr;
        return c >= 0 && r >= 0 && c < cols && r < rows ? cellIndex[r * cols + c] : -1;
      })
      .filter((i) => i >= 0);
  }
  const grid = { CELL, x0: lb.x0, y0: lb.y0, cols, rows, cells, cellIndex };

  return { lake, woods, paths, lawns, regions, byId, fences, gate, landing, adj, portals, exits, overflowTier, grid };
}

// Checks the geometric rules of the model and returns a list of problems.
export function validateLayout(L) {
  const problems = [];
  for (let i = 0; i < L.regions.length; i++) {
    for (let j = i + 1; j < L.regions.length; j++) {
      if (G.polygonsOverlap(L.regions[i].boundary, L.regions[j].boundary)) problems.push(`${L.regions[i].name} overlaps ${L.regions[j].name}`);
    }
  }
  for (const r of [...L.lawns, L.woods, L.lake]) {
    if (![...L.adj[r.id]].some((id) => L.byId[id].kind === 'path')) problems.push(`${r.name} does not border a path`);
  }
  for (const p of L.paths) if (p.width < 1.5) problems.push(`${p.name} is narrower than 1.5 ft`);
  return problems;
}
