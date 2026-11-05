// Rendering and interaction for the Gowanus Flood Routing model.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import * as C from './config.js';
import { Model, makeRng } from './model.js';
import { loadStations, loadFloodNet, load311 } from './data.js';

const $ = (id) => document.getElementById(id);
const model = new Model();

// Ground plane (x east, y north, in feet) -> three.js world (x, height, -y).
const w = (x, y, h = 0) => new THREE.Vector3(x, h, -y);

// Heights of the flat layers, so overlapping streets don't flicker.
const H = { canal: 0.2, ns: 0.6, ew: 1.0, hatch: 1.6, outline: 2.0, node: 2.4, route: 3.2 };

const COLORS = {
  waiting: 0xeab308, riding: 0x10b981, docked: 0x6366f1, stranded: 0xe11d8f, fallen: 0xdc2626,
  station: 0xf97316, stationOff: 0x9ca3af, sensor: 0x7c3aed,
  basin: 0x334155, basinClog: 0xb45309, glow: 0x34d399, glowCore: 0x059669,
  tool: 0x06b6d4, dry: 0x1e293b,
};
const DEPTH_STOPS = [[0, '#a3a8ae'], [1, '#9fd3ff'], [6, '#3b82f6'], [12, '#0b2f7a']].map(([d, c]) => [d, new THREE.Color(c)]);
function depthColor(d, out = new THREE.Color()) {
  if (d <= 0) return out.copy(DEPTH_STOPS[0][1]);
  for (let i = 1; i < DEPTH_STOPS.length; i++) {
    const [d1, c1] = DEPTH_STOPS[i], [d0, c0] = DEPTH_STOPS[i - 1];
    if (d <= d1) return out.copy(c0).lerp(c1, (d - d0) / (d1 - d0));
  }
  return out.copy(DEPTH_STOPS[DEPTH_STOPS.length - 1][1]);
}

// ---------- three.js setup ----------
const container = $('scene');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
container.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
Object.assign(labelRenderer.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none' });
container.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe7ebee);
scene.fog = new THREE.Fog(0xe7ebee, 9000, 22000);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 5, 60000);
// Pull the camera back on narrow screens so the whole study area fits.
const fit = Math.max(1, 1.25 / camera.aspect);
camera.position.set(-700 * fit, 2900 * fit, 3100 * fit);
if (window.innerWidth < 760) $('log-wrap').open = false;
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.maxPolarAngle = 1.35;
controls.minDistance = 250;
controls.maxDistance = 12000;
controls.screenSpacePanning = false;

scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa0a6, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-1500, 3000, 1200);
scene.add(sun);

const lineMats = [];
function lineMat(opts) {
  const m = new LineMaterial({ worldUnits: false, ...opts });
  m.resolution.set(window.innerWidth, window.innerHeight);
  lineMats.push(m);
  return m;
}
function makeLine(points, mat, h) {
  const g = new LineGeometry();
  g.setPositions(points.flatMap((p) => [p.x, h, -p.y]));
  const l = new Line2(g, mat);
  l.computeLineDistances();
  return l;
}
function setLinePoints(line, points, h) {
  const pts = [];
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 0.01) pts.push(p);
  }
  if (pts.length < 2) { line.visible = false; return; }
  line.visible = true;
  line.geometry.dispose();
  line.geometry = new LineGeometry();
  line.geometry.setPositions(pts.flatMap((p) => [p.x, h, -p.y]));
  line.computeLineDistances();
}

// Layers
const pickables = [];
const staticGroup = new THREE.Group();
const stationGroup = new THREE.Group();
const sensorGroup = new THREE.Group();
const riderGroup = new THREE.Group();
const routeGroup = new THREE.Group();
scene.add(staticGroup, stationGroup, sensorGroup, riderGroup, routeGroup);

function addPick(obj, kind, id) {
  obj.userData.pick = { kind, id };
  pickables.push(obj);
}
function pickProxy(r, pos, kind, id, parent) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), new THREE.MeshBasicMaterial());
  m.visible = false;
  m.position.copy(pos);
  parent.add(m);
  addPick(m, kind, id);
  return m;
}

// ---------- static scene: ground, canal, blocks, streets ----------
function flatMesh(points, h, material) {
  const shape = new THREE.Shape(points.map((p) => new THREE.Vector2(p.x, p.y)));
  const g = new THREE.ShapeGeometry(shape);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, material);
  m.position.y = h;
  return m;
}

// Offset each edge of a convex quad inward by its own distance.
function insetQuad(pts, ds) {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length, cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const lines = pts.map((a, i) => {
    const b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
    let nx = -dy / L, ny = dx / L;
    if ((cx - a.x) * nx + (cy - a.y) * ny < 0) { nx = -nx; ny = -ny; }
    return { p: { x: a.x + nx * ds[i], y: a.y + ny * ds[i] }, d: { x: dx / L, y: dy / L } };
  });
  return lines.map((l, i) => {
    const k = lines[(i + lines.length - 1) % lines.length];
    const den = k.d.x * l.d.y - k.d.y * l.d.x;
    const t = ((l.p.x - k.p.x) * l.d.y - (l.p.y - k.p.y) * l.d.x) / den;
    return { x: k.p.x + k.d.x * t, y: k.p.y + k.d.y * t };
  });
}

function hatchTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(239,68,68,0.9)';
  g.lineWidth = 7;
  for (let i = -64; i <= 128; i += 22) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 64, 64); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const streetViews = new Map();

function buildStatic() {
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(30000, 30000), new THREE.MeshLambertMaterial({ color: 0xd9d6cd }));
  ground.rotation.x = -Math.PI / 2;
  staticGroup.add(ground);

  // Lighter land inside the study area
  const area = flatMesh(model.boundary.map((p) => ({ x: p.x * 1.08, y: p.y * 1.08 })), 0.05, new THREE.MeshLambertMaterial({ color: 0xe6e3da }));
  staticGroup.add(area);

  // Canal
  const canal = flatMesh(model.canalPolygon, H.canal, new THREE.MeshStandardMaterial({ color: 0x4f7f6d, roughness: 0.25, metalness: 0.1 }));
  staticGroup.add(canal);
  const mid = model.canalLine[Math.floor(model.canalLine.length * 0.62)];
  const canalLbl = document.createElement('div');
  canalLbl.className = 'lbl-street';
  canalLbl.style.color = '#2f5d4d';
  canalLbl.textContent = 'Gowanus Canal';
  const cl = new CSS2DObject(canalLbl);
  cl.position.copy(w(mid.x, mid.y, 4));
  staticGroup.add(cl);

  // Building blocks
  const rng = makeRng(7);
  const bmat = new THREE.MeshStandardMaterial({ color: 0xf5f2ea, roughness: 0.95 });
  const bmat2 = new THREE.MeshStandardMaterial({ color: 0xe8e2d5, roughness: 0.95 });
  const G = (u, v) => model.grid(u, v);
  const addBlock = (u0, u1, v0, v1, ds) => {
    const pts = insetQuad([G(u0, v0), G(u1, v0), G(u1, v1), G(u0, v1)], ds);
    const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, p.y)));
    const h = 18 + rng() * 26;
    const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    staticGroup.add(new THREE.Mesh(g, rng() < 0.5 ? bmat : bmat2));
  };
  const SW = 12; // sidewalk
  const cols = C.COLUMNS, rows = C.ROWS;
  for (let j = 0; j < cols.length - 1; j++) {
    if (j === C.CANAL_WEST_COL) continue;
    for (let i = 0; i < rows.length - 1; i++) {
      addBlock(cols[j].u, cols[j + 1].u, rows[i].v, rows[i + 1].v,
        [rows[i].width / 2 + SW, cols[j + 1].width / 2 + SW, rows[i + 1].width / 2 + SW, cols[j].width / 2 + SW]);
    }
  }
  const bridges = rows.map((r, i) => (C.BRIDGE_ROWS.includes(r.name) ? i : -1)).filter((i) => i >= 0);
  const cw = C.COLUMNS[C.CANAL_WEST_COL], ce = C.COLUMNS[C.CANAL_EAST_COL];
  const cu0 = C.CANAL.u - C.CANAL.halfWidth, cu1 = C.CANAL.u + C.CANAL.halfWidth;
  for (let k = 0; k < bridges.length - 1; k++) {
    const r0 = rows[bridges[k]], r1 = rows[bridges[k + 1]];
    addBlock(cw.u, cu0, r0.v, r1.v, [r0.width / 2 + SW, 10, r1.width / 2 + SW, cw.width / 2 + SW]);
    addBlock(cu1, ce.u, r0.v, r1.v, [r0.width / 2 + SW, ce.width / 2 + SW, r1.width / 2 + SW, 10]);
  }

  // Streets
  const hatch = hatchTexture();
  for (const seg of model.segments.values()) {
    const h = seg.id.startsWith('ns') ? H.ns : H.ew;
    const geo = new THREE.BufferGeometry();
    const b = seg.boundary;
    const verts = [b[0], b[1], b[2], b[3]].flatMap((p) => [p.x, 0, -p.y]);
    const T = 40;
    const uv = [0, 0, seg.length / T, 0, seg.length / T, seg.width / T, 0, seg.width / T];
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex([0, 2, 1, 0, 3, 2]);
    geo.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({ color: depthColor(0), depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = h;
    mesh.renderOrder = 1;
    staticGroup.add(mesh);
    addPick(mesh, 'segment', seg.id);

    const hm = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: hatch, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    hm.position.y = H.hatch;
    hm.renderOrder = 2;
    hm.visible = false;
    staticGroup.add(hm);

    const outline = makeLine([...b, b[0]], lineMat({ color: 0xef4444, linewidth: 2.5, depthWrite: false }), H.outline);
    outline.renderOrder = 3;
    outline.visible = false;
    staticGroup.add(outline);
    streetViews.set(seg.id, { mesh, hatch: hm, outline, depth: -1, passable: true });
  }

  // Intersections
  const nodeGeo = new THREE.CircleGeometry(8, 16).rotateX(-Math.PI / 2);
  const nodeMat = new THREE.MeshBasicMaterial({ color: 0x64748b, depthWrite: false });
  for (const n of model.intersections.values()) {
    const m = new THREE.Mesh(nodeGeo, nodeMat);
    m.position.copy(w(n.x, n.y, H.node));
    m.renderOrder = 4;
    staticGroup.add(m);
    pickProxy(18, w(n.x, n.y, 4), 'intersection', n.id, staticGroup);
  }

  // Street name labels
  const label = (text, p) => {
    const el = document.createElement('div');
    el.className = 'lbl-street';
    el.textContent = text;
    const o = new CSS2DObject(el);
    o.position.copy(w(p.x, p.y, 3));
    staticGroup.add(o);
  };
  C.COLUMNS.forEach((c) => label(c.name, G(c.u, -0.07)));
  C.ROWS.forEach((r) => label(r.name, G(-0.07, r.v)));
}

// Catch basins
const basinViews = new Map();
const basinGeo = new THREE.BoxGeometry(10, 2, 10);
function buildBasins() {
  for (const b of model.basins.values()) {
    const m = new THREE.Mesh(basinGeo, new THREE.MeshStandardMaterial({ color: COLORS.basin }));
    m.position.copy(w(b.x, b.y, 2.6));
    staticGroup.add(m);
    pickProxy(16, w(b.x, b.y, 3), 'basin', b.id, staticGroup);
    basinViews.set(b.id, { mesh: m, status: null });
  }
}

// Flood sensors
const sensorViews = new Map();
function buildSensors() {
  for (const v of sensorViews.values()) sensorGroup.remove(v.group);
  sensorViews.clear();
  for (let i = pickables.length - 1; i >= 0; i--) if (pickables[i].userData.pick.kind === 'sensor') pickables.splice(i, 1);
  sensorGroup.clear();
  const mat = new THREE.MeshStandardMaterial({ color: COLORS.sensor });
  for (const s of model.sensors.values()) {
    const g = new THREE.Group();
    const post = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 30, 8), mat);
    post.position.y = 15;
    const head = new THREE.Mesh(new THREE.SphereGeometry(6, 16, 12), mat);
    head.position.y = 32;
    g.add(post, head);
    g.position.copy(w(s.x, s.y, 0));
    const el = document.createElement('div');
    el.className = 'lbl-sensor';
    const lbl = new CSS2DObject(el);
    lbl.position.set(0, 40, 0);
    g.add(lbl);
    sensorGroup.add(g);
    pickProxy(18, w(s.x, s.y, 30), 'sensor', s.id, sensorGroup);
    sensorViews.set(s.id, { group: g, el, depth: -1 });
  }
}

// Citi Bike stations: a column whose height is bikes available
const BIKE_FT = 3.5;
const stationViews = new Map();
function buildStations() {
  stationGroup.clear();
  stationViews.clear();
  for (let i = pickables.length - 1; i >= 0; i--) if (pickables[i].userData.pick.kind === 'station') pickables.splice(i, 1);
  for (const st of model.stations.values()) {
    const g = new THREE.Group();
    g.position.copy(w(st.x, st.y, 0));
    const base = new THREE.Mesh(new THREE.CylinderGeometry(20, 20, 2, 24), new THREE.MeshStandardMaterial({ color: 0xffffff }));
    base.position.y = 1;
    const capH = st.capacity * BIKE_FT;
    const ghost = new THREE.Mesh(new THREE.CylinderGeometry(13, 13, capH, 20, 1, true),
      new THREE.MeshBasicMaterial({ color: COLORS.station, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
    ghost.position.y = capH / 2 + 2;
    const colGeo = new THREE.CylinderGeometry(11, 11, 1, 20);
    colGeo.translate(0, 0.5, 0);
    const col = new THREE.Mesh(colGeo, new THREE.MeshStandardMaterial({ color: COLORS.station, roughness: 0.5 }));
    col.position.y = 2;
    g.add(base, ghost, col);
    stationGroup.add(g);
    pickProxy(Math.max(24, capH / 2), w(st.x, st.y, capH / 2), 'station', st.id, stationGroup);
    stationViews.set(st.id, { group: g, col, ghost, bikes: -1, status: null });
  }
}

// Riders and their glowing routes
const riderViews = new Map();
const riderGeo = (() => {
  const s = new THREE.SphereGeometry(17, 18, 14);
  s.translate(0, 40, 0);
  return s;
})();
const riderStem = new THREE.ConeGeometry(10, 30, 12).rotateX(Math.PI).translate(0, 16, 0);
function riderView(r) {
  const mat = new THREE.MeshStandardMaterial({ color: COLORS[r.state], emissive: COLORS[r.state], emissiveIntensity: 0.25 });
  const g = new THREE.Group();
  g.add(new THREE.Mesh(riderGeo, mat), new THREE.Mesh(riderStem, mat));
  const proxy = new THREE.Mesh(new THREE.SphereGeometry(28, 8, 6), new THREE.MeshBasicMaterial());
  proxy.visible = false;
  proxy.position.y = 34;
  g.add(proxy);
  addPick(proxy, 'rider', r.id);
  riderGroup.add(g);
  // Ripple under a rider who has fallen into the water
  const splash = new THREE.Mesh(new THREE.RingGeometry(20, 30, 28).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x2563eb, transparent: true, opacity: 0.6, depthWrite: false }));
  splash.position.y = 3;
  splash.visible = false;
  riderGroup.add(splash);
  g.userData.splash = splash;
  const outer = makeLine([{ x: 0, y: 0 }, { x: 1, y: 0 }], lineMat({ color: COLORS.glow, linewidth: 12, transparent: true, opacity: 0.35, depthWrite: false }), H.route);
  const inner = makeLine([{ x: 0, y: 0 }, { x: 1, y: 0 }], lineMat({ color: COLORS.glowCore, linewidth: 3.5, depthWrite: false }), H.route + 0.2);
  outer.renderOrder = 5; inner.renderOrder = 6;
  outer.visible = inner.visible = false;
  routeGroup.add(outer, inner);
  return { group: g, mat, proxy, outer, inner, splash, state: r.state, routeKey: null };
}
function dropRiderView(id) {
  const v = riderViews.get(id);
  riderGroup.remove(v.group, v.splash);
  routeGroup.remove(v.outer, v.inner);
  v.outer.geometry.dispose(); v.inner.geometry.dispose();
  const i = pickables.indexOf(v.proxy);
  if (i >= 0) pickables.splice(i, 1);
  riderViews.delete(id);
}

// Selection ring
const ring = new THREE.Mesh(new THREE.RingGeometry(26, 32, 32).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x0f172a, transparent: true, opacity: 0.85, depthWrite: false }));
ring.renderOrder = 7;
ring.visible = false;
scene.add(ring);

// Rain
const RAIN_MAX = 7000;
const rainGeo = new THREE.BufferGeometry();
const rainPos = new Float32Array(RAIN_MAX * 6);
for (let i = 0; i < RAIN_MAX; i++) {
  const x = (Math.random() - 0.5) * 4600, z = (Math.random() - 0.5) * 4000, y = Math.random() * 1400;
  rainPos.set([x, y, z, x - 4, y - 28, z], i * 6);
}
rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: 0x7895b2, transparent: true, opacity: 0.45 }));
rain.visible = false;
scene.add(rain);
function animateRain(dt) {
  rain.visible = model.mode === 'simulation' && model.rain !== 'off';
  if (!rain.visible) return;
  const n = model.rain === 'heavy' ? RAIN_MAX : 2200;
  rainGeo.setDrawRange(0, n * 2);
  const fall = (model.rain === 'heavy' ? 1500 : 1100) * dt;
  for (let i = 0; i < n; i++) {
    const k = i * 6;
    rainPos[k + 1] -= fall; rainPos[k + 4] -= fall;
    if (rainPos[k + 4] < 0) { rainPos[k + 1] += 1400; rainPos[k + 4] += 1400; }
  }
  rainGeo.attributes.position.needsUpdate = true;
}

// ---------- sync model -> view ----------
const tmpColor = new THREE.Color();
function syncScene() {
  for (const seg of model.segments.values()) {
    const v = streetViews.get(seg.id);
    if (Math.abs(v.depth - seg.depth) > 0.02) { v.mesh.material.color.copy(depthColor(seg.depth, tmpColor)); v.depth = seg.depth; }
    if (v.passable !== seg.passable) { v.passable = seg.passable; v.hatch.visible = v.outline.visible = !seg.passable; }
  }
  for (const b of model.basins.values()) {
    const v = basinViews.get(b.id);
    if (v.status !== b.status) {
      v.status = b.status;
      v.mesh.material.color.set(b.status === 'clogged' ? COLORS.basinClog : COLORS.basin);
      v.mesh.scale.setScalar(b.status === 'clogged' ? 1.7 : 1);
    }
  }
  for (const s of model.sensors.values()) {
    const v = sensorViews.get(s.id);
    if (!v || Math.abs(v.depth - s.depth) < 0.05) continue;
    v.depth = s.depth;
    v.el.textContent = `${s.depth.toFixed(1)}″`;
    v.el.className = `lbl-sensor${s.depth > C.IMPASSABLE_DEPTH_IN ? ' deep' : s.depth > 0.05 ? ' wet' : ''}`;
  }
  for (const st of model.stations.values()) {
    const v = stationViews.get(st.id);
    if (!v) continue;
    if (v.bikes !== st.bikes) { v.bikes = st.bikes; v.col.scale.y = Math.max(0.5, st.bikes * BIKE_FT); }
    if (v.status !== st.status) {
      v.status = st.status;
      const off = st.status === 'flooded';
      v.col.material.color.set(off ? COLORS.stationOff : COLORS.station);
      v.ghost.material.color.set(off ? COLORS.stationOff : COLORS.station);
    }
  }
  // Riders
  for (const id of [...riderViews.keys()]) if (!model.riders.has(id)) dropRiderView(id);
  for (const r of model.riders.values()) {
    let v = riderViews.get(r.id);
    if (!v) { v = riderView(r); riderViews.set(r.id, v); }
    const p = model.riderPosition(r);
    v.group.position.copy(w(p.x, p.y, 0));
    v.splash.position.set(v.group.position.x, 3, v.group.position.z);
    if (v.state !== r.state) {
      v.state = r.state;
      v.mat.color.set(COLORS[r.state]); v.mat.emissive.set(COLORS[r.state]);
      v.group.rotation.z = r.state === 'fallen' ? 1.4 : 0; // knocked over
      v.splash.visible = r.state === 'fallen';
    }
    if (v.splash.visible) v.splash.scale.setScalar(1 + 0.25 * Math.sin(performance.now() / 180));
    // Glowing route for riders who are riding, and for the selected rider.
    const show = r.route && (r.state === 'riding' || (selected?.kind === 'rider' && selected.id === r.id));
    if (!show) { v.outer.visible = v.inner.visible = false; v.routeKey = null; continue; }
    const key = `${model.version}:${r.state}:${Math.floor(r.progress / 15)}:${r.route.distance}`;
    if (key !== v.routeKey) {
      v.routeKey = key;
      const fromD = r.state === 'riding' ? r.progress : 0;
      const pts = model.legsToPoints(r.route.legs, fromD, r.route);
      if (r.state !== 'riding') pts.unshift(model.stations.get(r.station));
      pts.push(model.stations.get(r.destination));
      setLinePoints(v.outer, pts, H.route);
      setLinePoints(v.inner, pts, H.route + 0.2);
    }
  }
  updateRing();
  updateDestMarker();
}

// A marker over the selected rider's destination station
const destMarker = new THREE.Mesh(new THREE.ConeGeometry(14, 34, 16).rotateX(Math.PI),
  new THREE.MeshStandardMaterial({ color: COLORS.tool, emissive: COLORS.tool, emissiveIntensity: 0.4 }));
destMarker.visible = false;
scene.add(destMarker);
function updateDestMarker() {
  const r = selected?.kind === 'rider' ? model.riders.get(selected.id) : null;
  const st = r && r.route && model.stations.get(r.destination);
  destMarker.visible = !!st;
  if (!st) return;
  const top = st.capacity * BIKE_FT + 30;
  destMarker.position.copy(w(st.x, st.y, top + 6 * Math.sin(performance.now() / 250)));
}

function updateRing() {
  const p = selectedPosition();
  ring.visible = !!p;
  if (p) ring.position.copy(w(p.x, p.y, 3.5));
}

function selectedPosition() {
  if (!selected) return null;
  const { kind, id } = selected;
  if (kind === 'rider') { const r = model.riders.get(id); return r ? model.riderPosition(r) : null; }
  if (kind === 'station') return model.stations.get(id) || null;
  if (kind === 'basin') return model.basins.get(id) || null;
  if (kind === 'sensor') return model.sensors.get(id) || null;
  if (kind === 'intersection') return model.intersections.get(id) || null;
  if (kind === 'segment') return model.segments.get(id)?.mid || null;
  return null;
}

// ---------- Find route tool ----------
const tool = { active: false, origin: null, dest: null, version: -1 };
const toolLines = {
  outer: makeLine([{ x: 0, y: 0 }, { x: 1, y: 0 }], lineMat({ color: COLORS.tool, linewidth: 14, transparent: true, opacity: 0.35, depthWrite: false }), H.route + 0.4),
  inner: makeLine([{ x: 0, y: 0 }, { x: 1, y: 0 }], lineMat({ color: 0x0891b2, linewidth: 4, depthWrite: false }), H.route + 0.6),
  dry: makeLine([{ x: 0, y: 0 }, { x: 1, y: 0 }], lineMat({ color: COLORS.dry, linewidth: 3, transparent: true, opacity: 0.85, dashed: true, dashSize: 30, gapSize: 20, depthWrite: false }), H.route + 0.8),
};
Object.values(toolLines).forEach((l) => { l.visible = false; l.renderOrder = 8; scene.add(l); });
const toolLabelEl = document.createElement('div');
toolLabelEl.className = 'lbl-route';
const toolLabel = new CSS2DObject(toolLabelEl);
toolLabel.visible = false;
scene.add(toolLabel);

function clearTool() {
  tool.origin = tool.dest = null;
  Object.values(toolLines).forEach((l) => (l.visible = false));
  toolLabel.visible = false;
}

function updateTool(force = false) {
  if (!tool.origin || !tool.dest) return;
  if (!force && tool.version === model.version) return;
  tool.version = model.version;
  const o = model.stations.get(tool.origin), d = model.stations.get(tool.dest);
  if (!o || !d) { clearTool(); return; }
  const flood = model.shortestPath(model.stationLoc(o), model.stationLoc(d));
  const dry = model.shortestPath(model.stationLoc(o), model.stationLoc(d), true);
  const ends = (legs) => [o, ...model.legsToPoints(legs), d];
  if (dry) setLinePoints(toolLines.dry, ends(dry.legs), H.route + 0.8);
  if (flood) {
    setLinePoints(toolLines.outer, ends(flood.legs), H.route + 0.4);
    setLinePoints(toolLines.inner, ends(flood.legs), H.route + 0.6);
  } else {
    toolLines.outer.visible = toolLines.inner.visible = false;
  }
  const ft = (n) => `${Math.round(n).toLocaleString()} ft`;
  toolLabelEl.innerHTML = `<div>${esc(o.name)} → ${esc(d.name)}</div>` + (flood
    ? `<div>Flood-avoiding: <b>${ft(flood.length)}</b></div><div>Dry-day: ${ft(dry.length)}</div><div>Detour: <b>+${ft(flood.length - dry.length)}</b></div>`
    : `<div class="none">No flood-free route</div><div>Dry-day: ${ft(dry.length)}</div>`);
  const legs = (flood || dry).legs;
  const pts = ends(legs);
  const m = pts[Math.floor(pts.length / 2)];
  toolLabel.position.copy(w(m.x, m.y, 40));
  toolLabel.visible = true;
}

// ---------- inspector ----------
let selected = null;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const xy = (p) => `x ${Math.round(p.x).toLocaleString()}, y ${Math.round(p.y).toLocaleString()} ft`;
const tag = (v) => `<span class="tag ${v}">${v}</span>`;
const ft = (n) => `${Math.round(n).toLocaleString()} ft`;
const segName = (id) => { const s = model.segments.get(id); return s ? `${s.name} (${model.segLabel(s)})` : id; };
const stName = (id) => model.stations.get(id)?.name || '—';

function renderInspector() {
  const kindEl = $('insp-kind'), body = $('insp-body');
  const actions = $('insp-actions');
  $('insp-close').hidden = !selected;
  if (!selected) {
    actions.innerHTML = '';
    kindEl.textContent = 'Select something';
    body.innerHTML = '<p class="muted">Click a street, intersection, station, rider, catch basin or flood sensor to see its attributes.</p>';
    return;
  }
  const rows = [];
  const row = (k, v) => rows.push(`<tr><td>${k}</td><td>${v}</td></tr>`);
  const { kind, id } = selected;
  if (kind === 'segment') {
    const s = model.segments.get(id);
    kindEl.textContent = 'Street Segment';
    row('Name', esc(s.name));
    row('Centerline', esc(model.segLabel(s)));
    row('Width', ft(s.width));
    row('Length', ft(s.length));
    row('Boundary', `${s.boundary.length}-point polygon`);
    row('Elevation', `${s.elevation} (${ft(s.canalDistance)} from canal)`);
    row('Flood depth', `${s.depth.toFixed(1)} in`);
    row('Passable', tag(s.passable ? 'yes' : 'no'));
    row('Intersections', [s.a, s.b].map((n) => esc(model.intersections.get(n).name)).join('<br>'));
    row('Catch basins', s.basins.map((b) => `${b} ${tag(model.basins.get(b).status)}`).join('<br>'));
    if (s.sensors.length) row('Sensors', s.sensors.map(esc).join('<br>'));
    if (s.stations.length) row('Stations beside', s.stations.map((x) => esc(stName(x))).join('<br>'));
    if (model.mode === 'real') row('Depth from', s.depthSource ? `sensor ${esc(s.depthSource)}` : 'no sensor within 500 ft');
  } else if (kind === 'intersection') {
    const n = model.intersections.get(id);
    kindEl.textContent = 'Intersection';
    row('Name', esc(n.name));
    row('Position', xy(n));
    row('Connected', n.segments.map((x) => esc(segName(x))).join('<br>'));
  } else if (kind === 'basin') {
    const b = model.basins.get(id);
    kindEl.textContent = 'Catch Basin';
    row('Id', b.id);
    row('Position', xy(b));
    row('Drains', esc(segName(b.segment)));
    row('Status', tag(b.status));
  } else if (kind === 'sensor') {
    const s = model.sensors.get(id);
    kindEl.textContent = 'Flood Sensor';
    row('Id', esc(s.id));
    row('Name', esc(s.name));
    row('Position', xy(s));
    row('Sits on', esc(segName(s.segment)));
    row('Depth reading', `${s.depth.toFixed(1)} in`);
  } else if (kind === 'station') {
    const s = model.stations.get(id);
    kindEl.textContent = 'Citi Bike Station';
    row('Id', esc(s.id));
    row('Name', esc(s.name));
    row('Position', xy(s));
    row('Beside', esc(segName(s.segment)));
    row('Capacity', s.capacity);
    row('Bikes available', s.bikes);
    row('Docks available', s.docks);
    row('Status', tag(s.status));
  } else if (kind === 'rider') {
    const r = model.riders.get(id);
    kindEl.textContent = 'Rider';
    row('Id', r.id);
    row('State', tag(r.state));
    row('Position', xy(model.riderPosition(r)));
    row('Origin', esc(stName(r.origin)));
    row('Destination', esc(stName(r.destination)));
    if (r.state === 'fallen') row('Status', `fell in ${model.segments.get(r.loc.seg).depth.toFixed(1)} in of water, back up in ${Math.ceil(r.timer)} s`);
    row('Falls', r.falls);
    if (r.route) {
      row('Route', `${r.route.segments.length} segments`);
      row('Flood-avoiding', ft(r.route.distance));
      row('Dry-day', ft(r.route.dryDistance));
      row('Detour', ft(r.route.detour));
      if (r.state === 'riding') row('Remaining', ft(r.route.distance - r.progress));
    } else {
      row('Route', r.state === 'stranded' ? 'none: waiting for a street to open' : '—');
    }
  }
  let extra = '';
  if (kind === 'rider') {
    const sending = send.rider === id;
    extra = `<button class="send" data-act="send"${model.riders.get(id).state === 'fallen' ? ' disabled' : ''}>${sending ? 'Cancel send' : 'Send to a station…'}</button>`;
  }
  body.innerHTML = `<table>${rows.join('')}</table>`;
  // Keep the button element stable so clicks aren't lost when the table refreshes.
  if (actions.innerHTML !== extra) actions.innerHTML = extra;
}

function renderLog() {
  $('log').innerHTML = model.events.slice(0, 20).map((e) => `<li><time>${clock(e.t)}</time>${esc(e.msg)}</li>`).join('');
}

function clock(t) {
  const s = Math.floor(t), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return `${h ? h + ':' : ''}${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`;
}

function select(p) {
  selected = p;
  renderInspector();
  updateButtons();
}

// ---------- toolbar ----------
let playing = false;
function updateButtons() {
  const sim = model.mode === 'simulation';
  $('btn-mode').textContent = `Mode: ${sim ? 'Simulation' : 'Real'}`;
  $('btn-mode').classList.toggle('active', !sim);
  $('btn-refresh').disabled = sim;
  $('btn-rain').disabled = !sim;
  $('btn-rain').textContent = `Rain: ${model.rain[0].toUpperCase()}${model.rain.slice(1)}`;
  $('btn-rain').classList.toggle('active', sim && model.rain !== 'off');
  $('btn-play').textContent = playing ? 'Pause' : 'Play';
  $('btn-play').classList.toggle('active', playing);
  $('btn-route').classList.toggle('active', tool.active);
  $('btn-remove').disabled = selected?.kind !== 'rider';
  $('btn-send').disabled = selected?.kind !== 'rider' && !send.rider;
  $('btn-send').classList.toggle('active', !!send.rider);
  const b = selected?.kind === 'basin' ? model.basins.get(selected.id) : null;
  $('btn-basin').disabled = !b;
  $('btn-basin').textContent = b?.status === 'clogged' ? 'Clear basin' : 'Clog basin';
  $('clock').textContent = `${sim ? 'Simulation' : 'Real'} · ${clock(model.time)}${sim ? ` · Rain ${model.rain}` : ''}`;
  setHint();
}

function setHint() {
  const h = $('hint');
  if (send.rider) { h.hidden = false; h.textContent = `Click a station to send ${send.rider} there (Esc to cancel)`; return; }
  if (!tool.active) { h.hidden = true; return; }
  h.hidden = false;
  h.textContent = !tool.origin ? 'Click an origin station' : !tool.dest ? 'Now click a destination station' : 'Click another station to start a new route';
}

let liveData = null; // {stations, flood, c311}
let initial = null; // stations, sensors and snapshot used by Reset

function applyRealMode() {
  model.applyComplaints(liveData.c311.data);
  model.applySensorDepths();
}

$('btn-mode').onclick = () => {
  if (model.mode === 'simulation') {
    model.saveSimBasins();
    model.mode = 'real';
    model.rain = 'off';
    applyRealMode();
  } else {
    model.mode = 'simulation';
    model.restoreSimBasins();
    model.resetDepths();
  }
  model.log(`Switched to ${model.mode} mode`);
  updateButtons();
};

$('btn-refresh').onclick = async () => {
  const btn = $('btn-refresh');
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  await loadAll();
  const { stations, status } = liveData.stations.data;
  const same = stations.filter((s) => model.stations.has(s.station_id)).length === model.stations.size;
  if (same) {
    model.updateStationStatus(status);
  } else {
    model.setStations(stations, status);
    model.buildExample(snapshot());
    model.mode = 'real';
    buildStations();
  }
  model.setSensors(liveData.flood.data);
  buildSensors();
  if (model.mode === 'real') applyRealMode();
  model.log('Live data refreshed');
  btn.textContent = 'Refresh live data';
  updateButtons();
};

// ---------- send a rider ----------
const send = { rider: null };
function startSend(id) {
  send.rider = send.rider === id ? null : id;
  if (send.rider && tool.active) { tool.active = false; clearTool(); }
  renderInspector();
  updateButtons();
}
function finishSend(stationId) {
  const r = model.riders.get(send.rider);
  const res = model.dispatch(r, stationId);
  send.rider = null;
  model.alerts.length = 0; // dispatch's own result is shown below
  toast(res.kind, res.msg);
  if (r) select({ kind: 'rider', id: r.id });
  updateButtons();
}
$('btn-send').onclick = () => {
  if (send.rider) startSend(send.rider);
  else if (selected?.kind === 'rider') startSend(selected.id);
};
$('insp-actions').addEventListener('click', (e) => {
  if (e.target.closest('[data-act="send"]') && selected?.kind === 'rider') startSend(selected.id);
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && send.rider) { send.rider = null; renderInspector(); updateButtons(); }
});

// Pop-up messages (dock full, falls). Newest on top, each fades after a few seconds.
function toast(kind, msg) {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = msg;
  box.prepend(el);
  while (box.children.length > 4) box.lastChild.remove();
  setTimeout(() => { el.classList.add('gone'); setTimeout(() => el.remove(), 400); }, kind === 'ok' ? 4000 : 7000);
}

$('btn-route').onclick = () => {
  if (send.rider) send.rider = null;
  tool.active = !tool.active;
  if (!tool.active) clearTool();
  updateButtons();
};

$('btn-add').onclick = () => {
  const r = model.addRandomRider();
  if (r) select({ kind: 'rider', id: r.id });
  else model.log('No open station with bikes available');
};

$('btn-remove').onclick = () => {
  if (selected?.kind !== 'rider') return;
  if (send.rider === selected.id) send.rider = null;
  model.removeRider(selected.id);
  model.log(`${selected.id} removed`);
  select(null);
};

$('btn-basin').onclick = () => {
  const b = selected?.kind === 'basin' && model.basins.get(selected.id);
  if (!b) return;
  b.status = b.status === 'clogged' ? 'clear' : 'clogged';
  if (model.mode === 'simulation') model.saveSimBasins();
  model.log(`${b.id} on ${model.segments.get(b.segment).name} is ${b.status}`);
  renderInspector();
  updateButtons();
};

$('btn-rain').onclick = () => {
  model.rain = { off: 'light', light: 'heavy', heavy: 'off' }[model.rain];
  model.log(`Rain: ${model.rain}`);
  updateButtons();
};

function advance(seconds) {
  const sub = 2;
  for (let t = 0; t < seconds - 1e-9; t += sub) model.step(Math.min(sub, seconds - t));
}

$('btn-step').onclick = () => { advance(C.STEP_SECONDS); updateButtons(); };
$('btn-play').onclick = () => { playing = !playing; updateButtons(); };

$('btn-reset').onclick = () => {
  playing = false;
  model.setStations(initial.stations, initial.status);
  model.setSensors(initial.sensors);
  model.buildExample(initial.snapshot);
  buildStations();
  buildSensors();
  tool.active = false;
  send.rider = null;
  clearTool();
  model.alerts.length = 0;
  select(null);
  updateButtons();
};

$('insp-close').onclick = () => select(null);

// ---------- picking ----------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const PRIORITY = { rider: 0, station: 1, basin: 2, sensor: 3, intersection: 4, segment: 5 };
function pickAt(ev) {
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(pickables, false);
  let best = null;
  for (const h of hits) {
    const p = h.object.userData.pick;
    if (!best || PRIORITY[p.kind] < PRIORITY[best.kind]) best = p;
  }
  return best;
}

let down = null;
renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
  down = null;
  const p = pickAt(e);
  if (send.rider) {
    if (p?.kind === 'station') finishSend(p.id);
    else if (p?.kind === 'rider') { send.rider = p.id; select(p); }
    return;
  }
  if (tool.active) {
    if (p?.kind !== 'station') return;
    if (!tool.origin || tool.dest) { clearTool(); tool.origin = p.id; select(p); }
    else if (p.id !== tool.origin) { tool.dest = p.id; updateTool(true); select(p); }
    setHint();
    return;
  }
  select(p);
});

const tip = $('tooltip');
let tipFrame = 0;
renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.buttons || ++tipFrame % 2) return;
  const p = pickAt(e);
  if (!p) { tip.hidden = true; renderer.domElement.style.cursor = ''; return; }
  const name = {
    rider: () => { const r = model.riders.get(p.id); return `Rider ${p.id} · ${r?.state}${r?.falls ? ` · ${r.falls} fall${r.falls > 1 ? 's' : ''}` : ''}`; },
    station: () => { const s = model.stations.get(p.id); return `${s.name} · ${s.bikes} bikes, ${s.docks} docks`; },
    basin: () => `Catch basin ${p.id} · ${model.basins.get(p.id).status}`,
    sensor: () => { const s = model.sensors.get(p.id); return `Sensor ${s.name} · ${s.depth.toFixed(1)}″`; },
    intersection: () => model.intersections.get(p.id).name,
    segment: () => { const s = model.segments.get(p.id); return `${s.name} · ${s.depth.toFixed(1)}″${s.passable ? '' : ' · impassable'}`; },
  }[p.kind]?.();
  tip.textContent = name || '';
  tip.style.left = `${e.clientX}px`;
  tip.style.top = `${e.clientY}px`;
  tip.hidden = !name;
  renderer.domElement.style.cursor = 'pointer';
});
renderer.domElement.addEventListener('pointerleave', () => { tip.hidden = true; });

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
  for (const m of lineMats) m.resolution.set(window.innerWidth, window.innerHeight);
});

// ---------- data loading ----------
async function loadAll() {
  const [stations, flood, c311] = await Promise.all([loadStations(), loadFloodNet(), load311()]);
  liveData = { stations, flood, c311 };
  const sample = [];
  if (stations.sample) sample.push('Citi Bike');
  if (flood.sample) sample.push('FloodNet');
  if (c311.sample) sample.push('311');
  const n = $('notice');
  n.hidden = !sample.length;
  n.textContent = `Sample data in use for ${sample.join(', ')} (live request failed or not configured).`;
}

function snapshot() {
  return new Map([...model.stations.values()].map((s) => [s.id, { bikes: s.bikes, docks: s.docks }]));
}

// ---------- main loop ----------
let last = performance.now();
let uiTimer = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (playing) advance(dt * C.PLAY_SPEED);
  animateRain(dt);
  syncScene();
  updateTool();
  uiTimer += dt;
  if (uiTimer > 0.25) {
    uiTimer = 0;
    for (const a of model.alerts.splice(0)) toast(a.kind, a.msg);
    if (send.rider && !model.riders.has(send.rider)) send.rider = null;
    if (selected) {
      const gone = (selected.kind === 'rider' && !model.riders.has(selected.id)) || (selected.kind === 'station' && !model.stations.has(selected.id));
      if (gone) select(null); else renderInspector();
    }
    renderLog();
    updateButtons();
  }
  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  requestAnimationFrame(frame);
}

async function start() {
  buildStatic();
  buildBasins();
  await loadAll();
  const { stations, status } = liveData.stations.data;
  model.setStations(stations, status);
  model.setSensors(liveData.flood.data);
  initial = { stations, status, sensors: liveData.flood.data, snapshot: snapshot() };
  model.buildExample(initial.snapshot);
  buildStations();
  buildSensors();
  updateButtons();
  renderInspector();
  const l = $('loading');
  l.style.opacity = '0';
  setTimeout(() => l.remove(), 450);
  requestAnimationFrame(frame);
  // Handy for poking at the model from the browser console.
  window.__model = model;
  window.__toScreen = (x, y, h = 10) => {
    const v = w(x, y, h).project(camera);
    return { x: ((v.x + 1) / 2) * window.innerWidth, y: ((1 - v.y) / 2) * window.innerHeight };
  };
}

start().catch((err) => {
  console.error(err);
  $('loading').textContent = `Could not start: ${err.message}`;
});
