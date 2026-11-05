// The real city around the model, drawn like a white architectural massing model:
// building footprints and heights, curb lines, street trees, the canal and parks.
// Data comes from data/context.json (baked from NYC Open Data, see README).
import * as THREE from 'three';

export const PALETTE = {
  background: 0xf2f0eb,
  plinthTop: 0xe9e6df,
  plinthSide: 0xc9c4ba,
  building: 0xfbfaf7, // inside the study area
  context: 0xdcd8d0, // outside the study area
  edge: 0x4b4a46,
  curb: 0xa29d93,
  tree: 0x9fb08f,
  water: 0xa9bec6,
  park: 0xd7dccb,
  boundary: 0x3f3d39,
};

export async function loadContext(url = 'data/context.json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---------- 2D helpers (plain {x, y} points, ground plane in feet) ----------

const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
function ccw(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += a.x * b.y - b.x * a.y; }
  return s > 0 ? poly : [...poly].reverse();
}
function insideConvex(p, poly) {
  for (let i = 0; i < poly.length; i++) if (cross(poly[i], poly[(i + 1) % poly.length], p) < 0) return false;
  return true;
}
// Sutherland–Hodgman clip of any polygon against a convex counter-clockwise polygon.
function clipPolygon(subject, clip) {
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j], q = input[(j + 1) % input.length];
      const pin = cross(a, b, p) >= 0, qin = cross(a, b, q) >= 0;
      if (pin) out.push(p);
      if (pin !== qin) {
        const d1 = cross(a, b, p), d2 = cross(a, b, q), t = d1 / (d1 - d2);
        out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      }
    }
  }
  return out;
}
// Clip a line segment to a convex counter-clockwise polygon (Cyrus–Beck). Returns null if outside.
function clipSegment(p, q, poly) {
  let t0 = 0, t1 = 1;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dp = cross(a, b, p), dq = cross(a, b, q);
    if (dp < 0 && dq < 0) return null;
    if (dp < 0) t0 = Math.max(t0, dp / (dp - dq));
    else if (dq < 0) t1 = Math.min(t1, dp / (dp - dq));
  }
  if (t0 >= t1) return null;
  const at = (t) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  return [at(t0), at(t1)];
}
// Move each edge of a convex quad outward by d feet.
export function growQuad(pts, d) {
  const poly = ccw(pts);
  const lines = poly.map((a, i) => {
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
    const n = { x: dy / L, y: -dx / L }; // outward for a counter-clockwise polygon
    return { p: { x: a.x + n.x * d, y: a.y + n.y * d }, d: { x: dx / L, y: dy / L } };
  });
  return lines.map((l, i) => {
    const k = lines[(i + lines.length - 1) % lines.length];
    const den = k.d.x * l.d.y - k.d.y * l.d.x;
    const t = ((l.p.x - k.p.x) * l.d.y - (l.p.y - k.p.y) * l.d.x) / den;
    return { x: k.p.x + k.d.x * t, y: k.p.y + k.d.y * t };
  });
}
function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

// ---------- the layers ----------

// ctx: parsed context.json. offset: model x/y of the data's origin.
// study: the study area quad. avoid: street segments ({centerline, width}) to keep clear of buildings.
export function buildContext(ctx, { offset, study, margin = 550, avoid = [] }) {
  const group = new THREE.Group();
  group.name = 'context';
  const site = ccw(growQuad(study, margin)); // the model's base
  const focus = ccw(study);
  const pts = (flat) => {
    const out = [];
    for (let i = 0; i < flat.length; i += 2) out.push({ x: flat[i] + offset.x, y: flat[i + 1] + offset.y });
    return out;
  };

  // Plinth: a slab the model sits on
  const shape = new THREE.Shape(site.map((p) => new THREE.Vector2(p.x, p.y)));
  const slab = new THREE.ExtrudeGeometry(shape, { depth: 60, bevelEnabled: false });
  slab.rotateX(-Math.PI / 2);
  slab.translate(0, -60, 0);
  const plinth = new THREE.Mesh(slab, [
    new THREE.MeshLambertMaterial({ color: PALETTE.plinthTop }),
    new THREE.MeshLambertMaterial({ color: PALETTE.plinthSide }),
  ]);
  plinth.receiveShadow = true;
  group.add(plinth);

  const flatLayer = (polys, color, h) => {
    const geos = [];
    for (const flat of polys) {
      const clipped = clipPolygon(ccw(pts(flat)), site);
      if (clipped.length < 3) continue;
      const g = new THREE.ShapeGeometry(new THREE.Shape(clipped.map((p) => new THREE.Vector2(p.x, p.y))));
      geos.push(g);
    }
    if (!geos.length) return null;
    const g = mergeFlat(geos);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color }));
    m.position.y = h;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };
  flatLayer(ctx.parks, PALETTE.park, 0.1);
  const water = flatLayer(ctx.water, PALETTE.water, 0.3);
  if (water) water.material = new THREE.MeshStandardMaterial({ color: PALETTE.water, roughness: 0.35, metalness: 0.05 });

  // Curb lines
  const curb = [];
  for (const flat of ctx.curbs) {
    const p = pts(flat);
    for (let i = 0; i < p.length - 1; i++) {
      const s = clipSegment(p[i], p[i + 1], site);
      if (s) curb.push(s[0].x, 0.5, -s[0].y, s[1].x, 0.5, -s[1].y);
    }
  }
  const curbGeo = new THREE.BufferGeometry();
  curbGeo.setAttribute('position', new THREE.Float32BufferAttribute(curb, 3));
  group.add(new THREE.LineSegments(curbGeo, new THREE.LineBasicMaterial({ color: PALETTE.curb })));

  // Buildings: one merged mesh with flat-shaded walls and roofs, plus outline edges.
  const blocked = (ring) => {
    if (!avoid.length) return false;
    for (const s of avoid) {
      const [a, b] = s.centerline, half = s.width / 2 - 4;
      for (const p of ring) if (distToSegment(p, a, b) < half) return true;
    }
    return false;
  };
  const pos = [], nor = [], col = [], edges = [];
  const cFocus = new THREE.Color(PALETTE.building), cCtx = new THREE.Color(PALETTE.context);
  let kept = 0, cleared = 0;
  for (const b of ctx.buildings) {
    const h = b[0];
    const ring = ccw(pts(b.slice(1)));
    if (!ring.every((p) => insideConvex(p, site))) continue;
    const c = ring.reduce((s, p) => ({ x: s.x + p.x / ring.length, y: s.y + p.y / ring.length }), { x: 0, y: 0 });
    const inFocus = insideConvex(c, focus);
    if (inFocus && blocked(ring)) { cleared++; continue; }
    kept++;
    const color = inFocus ? cFocus : cCtx;
    const push = (x, y, z, n) => { pos.push(x, y, z); nor.push(n.x, n.y, n.z); col.push(color.r, color.g, color.b); };
    // walls
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], q = ring[(i + 1) % ring.length];
      const dx = q.x - a.x, dy = q.y - a.y, L = Math.hypot(dx, dy) || 1;
      const n = { x: dy / L, y: 0, z: dx / L }; // outward normal in world space (z = -y)
      push(a.x, 0, -a.y, n); push(q.x, 0, -q.y, n); push(q.x, h, -q.y, n);
      push(a.x, 0, -a.y, n); push(q.x, h, -q.y, n); push(a.x, h, -a.y, n);
      // roof outline, and a vertical edge at each real corner
      edges.push(a.x, h, -a.y, q.x, h, -q.y);
      const prev = ring[(i + ring.length - 1) % ring.length];
      const turn = Math.abs(Math.atan2(cross(prev, a, q), (a.x - prev.x) * (q.x - a.x) + (a.y - prev.y) * (q.y - a.y)));
      if (turn > 0.5) edges.push(a.x, 0, -a.y, a.x, h, -a.y);
    }
    // roof
    const tris = THREE.ShapeUtils.triangulateShape(ring.map((p) => new THREE.Vector2(p.x, p.y)), []);
    const up = { x: 0, y: 1, z: 0 };
    for (const [i, j, k] of tris) for (const v of [i, j, k]) push(ring[v].x, h, -ring[v].y, up);
  }
  const bg = new THREE.BufferGeometry();
  bg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  bg.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  bg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const buildings = new THREE.Mesh(bg, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  buildings.castShadow = buildings.receiveShadow = true;
  group.add(buildings);
  const eg = new THREE.BufferGeometry();
  eg.setAttribute('position', new THREE.Float32BufferAttribute(edges, 3));
  group.add(new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: PALETTE.edge, transparent: true, opacity: 0.32 })));

  // Street trees: faceted canopies sized by trunk diameter
  const trees = ctx.trees.map(([x, y, dbh]) => ({ x: x + offset.x, y: y + offset.y, dbh })).filter((t) => insideConvex(t, site));
  const canopy = new THREE.IcosahedronGeometry(1, 0);
  const tm = new THREE.InstancedMesh(canopy, new THREE.MeshLambertMaterial({ color: PALETTE.tree, flatShading: true }), trees.length);
  const trunkGeo = new THREE.CylinderGeometry(0.6, 0.8, 1, 5).translate(0, 0.5, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: 0x8c8378 }), trees.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  trees.forEach((t, i) => {
    const r = Math.min(22, 5 + t.dbh * 0.42); // canopy radius, ft
    const trunkH = 7 + r * 0.5;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (t.x * 13 + t.y * 7) % 6.28);
    m4.compose(p.set(t.x, trunkH + r * 0.75, -t.y), q, s.set(r, r * 0.9, r));
    tm.setMatrixAt(i, m4);
    m4.compose(p.set(t.x, 0, -t.y), q.identity(), s.set(1, trunkH + r * 0.3, 1));
    trunks.setMatrixAt(i, m4);
  });
  tm.castShadow = true;
  group.add(tm, trunks);

  // Study area outline: a thin dashed line, like a site boundary on a drawing
  const ob = [...focus, focus[0]].map((pt) => new THREE.Vector3(pt.x, 1.2, -pt.y));
  const outline = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ob),
    new THREE.LineDashedMaterial({ color: PALETTE.boundary, dashSize: 40, gapSize: 26, transparent: true, opacity: 0.7 }));
  outline.computeLineDistances();
  group.add(outline);

  return { group, site, stats: { buildings: kept, cleared, trees: trees.length } };
}

// Merge flat ShapeGeometries (position + normal only) into one.
function mergeFlat(geos) {
  const pos = [], nor = [], idx = [];
  let base = 0;
  for (const g of geos) {
    const P = g.attributes.position.array, N = g.attributes.normal.array;
    for (let i = 0; i < P.length; i++) { pos.push(P[i]); nor.push(N[i]); }
    const I = g.index ? g.index.array : [...Array(P.length / 3).keys()];
    for (const i of I) idx.push(i + base);
    base += P.length / 3;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setIndex(idx);
  return out;
}
