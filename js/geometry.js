// Small 2D geometry helpers. Points are {x, y} in feet on the ground plane
// (x east, y north). Polygons are arrays of points in counter-clockwise order.

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function signedArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export const polygonArea = (poly) => Math.abs(signedArea(poly));

export const ensureCCW = (poly) => (signedArea(poly) < 0 ? poly.slice().reverse() : poly);

export function rectPoly(x0, y0, x1, y1) {
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
}

export function centroid(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const f = p.x * q.y - q.x * p.y;
    a += f; cx += (p.x + q.x) * f; cy += (p.y + q.y) * f;
  }
  a /= 2;
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

export function bounds(poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
}

export function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function closestOnSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const x = a.x + dx * t, y = a.y + dy * t;
  return { x, y, t, d: Math.hypot(p.x - x, p.y - y) };
}

// Nearest point on the polygon's boundary, with the edge index it lies on.
export function closestOnPolygon(p, poly) {
  let best = null;
  for (let i = 0; i < poly.length; i++) {
    const c = closestOnSegment(p, poly[i], poly[(i + 1) % poly.length]);
    if (!best || c.d < best.d) best = { ...c, edge: i };
  }
  return best;
}

// Unit normal of edge i pointing into a counter-clockwise polygon.
export function inwardNormal(poly, i) {
  const a = poly[i], b = poly[(i + 1) % poly.length];
  const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
  return { x: -dy / l, y: dx / l };
}

// A point a little inside the polygon, next to the boundary point nearest p.
export function insideNear(p, poly, inset = 1) {
  const c = closestOnPolygon(p, poly);
  const n = inwardNormal(poly, c.edge);
  let q = { x: c.x + n.x * inset, y: c.y + n.y * inset };
  if (!pointInPolygon(q, poly)) {
    const m = centroid(poly), d = dist(c, m) || 1;
    q = { x: c.x + ((m.x - c.x) / d) * inset, y: c.y + ((m.y - c.y) / d) * inset };
  }
  return q;
}

function orient(a, b, c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }

export function segmentsIntersect(a, b, c, d) {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0) && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}

export function polygonsOverlap(A, B) {
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < B.length; j++) {
      if (segmentsIntersect(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length])) return true;
    }
  }
  if (A.some((p) => pointInPolygon(p, B) && closestOnPolygon(p, B).d > 1e-6)) return true;
  if (B.some((p) => pointInPolygon(p, A) && closestOnPolygon(p, A).d > 1e-6)) return true;
  return false;
}

// Smallest distance between the boundaries of two non-overlapping polygons.
export function polygonGap(A, B) {
  let g = Infinity;
  for (const p of A) g = Math.min(g, closestOnPolygon(p, B).d);
  for (const p of B) g = Math.min(g, closestOnPolygon(p, A).d);
  return g;
}

export function randomPointInPolygon(poly, rand, margin = 0) {
  const b = bounds(poly);
  for (let i = 0; i < 300; i++) {
    const p = { x: b.x0 + rand() * (b.x1 - b.x0), y: b.y0 + rand() * (b.y1 - b.y0) };
    if (pointInPolygon(p, poly) && closestOnPolygon(p, poly).d >= margin) return p;
  }
  return centroid(poly);
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
