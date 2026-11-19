// Ground relief for the 3D view. park.json carries a surveyed elevation for
// every path and lawn (NYC Planimetric Elevation Points, see tools/bake_park.py)
// and the lake's surface elevation. Here they become a smooth height field:
// known cells are averaged onto a coarse grid, the gaps (woods, plantings) are
// filled by relaxation, and the result is measured from the lake surface.
// Heights fade to zero at the shore so the water still meets the bank.
//
// The simulation itself stays 2D; only the drawing is lifted.
import * as THREE from 'three';

export function buildTerrain(L, { exaggeration = 3, cell = 20, fade = 70 } = {}) {
  const s = Math.max(1, Math.round(cell / L.cell));
  const step = s * L.cell;
  const cols = Math.ceil(L.cols / s), rows = Math.ceil(L.rows / s), n = cols * rows;
  const lakeZ = L.data.lakeElevationFt ?? 57;
  const sum = new Float64Array(n), cnt = new Float64Array(n), lake = new Float64Array(n), all = new Float64Array(n);
  for (let i = 0; i < L.N; i++) {
    const k = Math.floor(Math.floor(i / L.cols) / s) * cols + Math.floor((i % L.cols) / s);
    all[k]++;
    const r = L.regionOfCell(i);
    if (!r) continue;
    if (r.kind === 'lake') { lake[k]++; sum[k] += lakeZ; cnt[k]++; } else if ((r.kind === 'path' || r.kind === 'lawn') && Number.isFinite(r.elevationFt)) { sum[k] += r.elevationFt; cnt[k]++; }
  }
  const z = new Float64Array(n), known = new Uint8Array(n);
  let mean = 0, m = 0;
  for (let k = 0; k < n; k++) if (cnt[k]) { z[k] = sum[k] / cnt[k]; known[k] = 1; mean += z[k]; m++; }
  mean = m ? mean / m : lakeZ;
  for (let k = 0; k < n; k++) if (!known[k]) z[k] = mean;
  // Fill the unknown cells with a smooth surface (Jacobi relaxation).
  const nb = (k, f) => {
    const c = k % cols, r = (k - c) / cols;
    let a = 0, q = 0;
    if (c > 0) { a += f[k - 1]; q++; } if (c < cols - 1) { a += f[k + 1]; q++; }
    if (r > 0) { a += f[k - cols]; q++; } if (r < rows - 1) { a += f[k + cols]; q++; }
    return a / q;
  };
  let tmp = new Float64Array(n);
  for (let it = 0; it < 400; it++) {
    for (let k = 0; k < n; k++) tmp[k] = known[k] ? z[k] : nb(k, z);
    z.set(tmp);
  }
  // Soften the step between neighbouring paths and lawns.
  for (let it = 0; it < 3; it++) {
    for (let k = 0; k < n; k++) tmp[k] = (z[k] * 2 + nb(k, z) * 4) / 6;
    z.set(tmp);
  }
  // Distance (ft) from the lake, for the shoreline fade.
  const dist = new Float64Array(n).fill(1e9);
  for (let k = 0; k < n; k++) if (lake[k] > all[k] * 0.4) dist[k] = 0;
  const D = Math.SQRT2 * step;
  for (let pass = 0; pass < 2; pass++) {
    const fwd = pass === 0;
    for (let t = 0; t < n; t++) {
      const k = fwd ? t : n - 1 - t, c = k % cols, r = (k - c) / cols, d = fwd ? -1 : 1;
      const cc = c + d, rr = r + d;
      let v = dist[k];
      if (cc >= 0 && cc < cols) v = Math.min(v, dist[k + d] + step);
      if (rr >= 0 && rr < rows) {
        v = Math.min(v, dist[k + d * cols] + step);
        if (c - 1 >= 0) v = Math.min(v, dist[k + d * cols - 1] + D);
        if (c + 1 < cols) v = Math.min(v, dist[k + d * cols + 1] + D);
      }
      dist[k] = v;
    }
  }
  const H = new Float32Array(n);
  let maxH = 0;
  for (let k = 0; k < n; k++) {
    const t = Math.min(1, dist[k] / fade), ease = t * t * (3 - 2 * t);
    H[k] = Math.max(0, z[k] - lakeZ) * exaggeration * ease;
    maxH = Math.max(maxH, H[k]);
  }
  const x0 = L.x0, y0 = L.y0;
  // Bilinear sample in model feet; returns display height above the lake surface.
  const at = (x, y) => {
    let u = (x - x0) / step - 0.5, v = (y - y0) / step - 0.5;
    u = Math.min(Math.max(u, 0), cols - 1.001); v = Math.min(Math.max(v, 0), rows - 1.001);
    const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j, k = j * cols + i;
    return (H[k] * (1 - fu) + H[k + 1] * fu) * (1 - fv) + (H[k + cols] * (1 - fu) + H[k + cols + 1] * fu) * fv;
  };
  // Real elevation (ft above sea level, before exaggeration) for labels/UI.
  const elevationAt = (x, y) => lakeZ + at(x, y) / exaggeration;
  return { at, elevationAt, exaggeration, lakeZ, maxH };
}

// Split long triangle edges (each edge decides by its own length, so shared
// edges split identically and no cracks open), then lift every vertex.
// The geometry is a ShapeGeometry in model (x, y); z becomes the height.
export function drapeGeometry(geo, at, maxEdge = 28) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const src = g.attributes.position.array;
  const out = [];
  const m2 = maxEdge * maxEdge;
  const long = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 > m2;
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const tri = (a, b, c, depth) => {
    const ab = long(a, b), bc = long(b, c), ca = long(c, a);
    if (depth > 12 || !(ab || bc || ca)) { out.push(a, b, c); return; }
    const d = depth + 1;
    if (ab && bc && ca) {
      const p = mid(a, b), q = mid(b, c), r = mid(c, a);
      tri(a, p, r, d); tri(p, b, q, d); tri(r, q, c, d); tri(p, q, r, d);
    } else if (ab && bc) { const p = mid(a, b), q = mid(b, c); tri(a, p, c, d); tri(p, q, c, d); tri(p, b, q, d); }
    else if (bc && ca) { const q = mid(b, c), r = mid(c, a); tri(a, b, r, d); tri(r, b, q, d); tri(r, q, c, d); }
    else if (ca && ab) { const r = mid(c, a), p = mid(a, b); tri(b, c, r, d); tri(p, b, r, d); tri(a, p, r, d); }
    else if (ab) { const p = mid(a, b); tri(a, p, c, d); tri(p, b, c, d); }
    else if (bc) { const q = mid(b, c); tri(a, b, q, d); tri(a, q, c, d); }
    else { const r = mid(c, a); tri(a, b, r, d); tri(r, b, c, d); }
  };
  for (let i = 0; i < src.length; i += 9) {
    tri([src[i], src[i + 1]], [src[i + 3], src[i + 4]], [src[i + 6], src[i + 7]], 0);
  }
  const pos = new Float32Array(out.length * 3), uv = new Float32Array(out.length * 2);
  out.forEach((p, i) => { pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = at(p[0], p[1]); uv[i * 2] = p[0]; uv[i * 2 + 1] = p[1]; });
  const res = new THREE.BufferGeometry();
  res.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  res.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  // Smooth normals from the height field itself (shape space: z is up).
  const nor = new Float32Array(pos.length), e = 4;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1];
    const dx = (at(x + e, y) - at(x - e, y)) / (2 * e), dy = (at(x, y + e) - at(x, y - e)) / (2 * e);
    const l = Math.hypot(dx, dy, 1);
    nor[i] = -dx / l; nor[i + 1] = -dy / l; nor[i + 2] = 1 / l;
  }
  res.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return res;
}

// A regular grid over the bounds, lifted by the terrain, for ground that is
// painted rather than modelled (meadow, plantings, ponds): the picture comes
// from a texture, so the triangle count does not depend on polygon detail.
export function terrainSheet(B, at, step = 15) {
  const W = B.x1 - B.x0, H = B.y1 - B.y0;
  const nx = Math.ceil(W / step), ny = Math.ceil(H / step);
  const pos = new Float32Array((nx + 1) * (ny + 1) * 3), uv = new Float32Array((nx + 1) * (ny + 1) * 2), nor = new Float32Array(pos.length);
  let k = 0;
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++, k++) {
    const x = B.x0 + (W * i) / nx, y = B.y0 + (H * j) / ny;
    pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = at(x, y);
    uv[k * 2] = i / nx; uv[k * 2 + 1] = j / ny;
    const dx = (at(x + 4, y) - at(x - 4, y)) / 8, dy = (at(x, y + 4) - at(x, y - 4)) / 8, l = Math.hypot(dx, dy, 1);
    nor[k * 3] = -dx / l; nor[k * 3 + 1] = -dy / l; nor[k * 3 + 2] = 1 / l;
  }
  const idx = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
    idx.push(a, b, d, a, d, c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}
