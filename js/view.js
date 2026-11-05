// three.js rendering of the model. Ground plane (x east, y north, feet)
// maps to world (x, height, -y).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import * as G from './geometry.js';
import { PARK } from './layout.js';
import { RULES } from './model.js';

const w = (x, y, h = 0) => new THREE.Vector3(x, h, -y);

export const COLORS = {
  walking: '#f97316', standing: '#a855f7', sitting: '#0ea5e9', boating: '#facc15',
  skin: '#f1c9a5', dog: '#8b5a2b',
  mower: '#ea580c', steward: '#0f766e', skimmer: '#eab308',
  litter: ['#ff2bd6', '#ffe600', '#00e5ff', '#ff4d4d'],
  grassShort: '#c8e27c', grassTall: '#2b6629', worn: '#8a6a3f', straw: '#e6d6a2',
  leafLitter: '#7a5a3a', weeds: '#8fdc3c', path: '#dccfb2', meadow: '#a7b98a',
  lakeBed: '#2d5560', water: '#3f86b8', duckweed: '#86b83a', select: '#22d3ee',
  standing_water: '#2f80ed', fenceWood: '#9a6b3f', broken: '#e11d48',
};
const c3 = (hex) => new THREE.Color(hex);

const NOISE = /* glsl */ `
float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), u.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y); }
float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ v += a*noise(p); p *= 2.03; a *= 0.5; } return v/0.9375; }
`;

// Lambert material whose color is a base color blended with patches of a
// second color (wear on lawns, weeds in the woods), with optional hatching.
function patchMaterial() {
  const u = {
    uBase: { value: new THREE.Color() }, uPatch: { value: new THREE.Color() }, uAmount: { value: 0 },
    uHatch: { value: 0 }, uHatchColor: { value: new THREE.Color('#333') }, uScale: { value: 0.07 },
  };
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = 'varying vec2 vWxz;\n' + sh.vertexShader.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n vWxz = (modelMatrix * vec4(transformed, 1.0)).xz;');
    sh.fragmentShader = 'varying vec2 vWxz;\nuniform vec3 uBase, uPatch, uHatchColor;\nuniform float uAmount, uHatch, uScale;\n' + NOISE +
      sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
        float n = fbm(vWxz * uScale);
        float fine = noise(vWxz * 0.9);
        vec3 col = uBase * (0.9 + 0.2 * fine);
        float pm = smoothstep(n - 0.03, n + 0.03, uAmount);
        col = mix(col, uPatch * (0.88 + 0.24 * fine), pm);
        if (uHatch > 0.5) { float s = step(0.62, fract((vWxz.x + vWxz.y) * 0.18)); col = mix(col, uHatchColor, s * 0.55); }
        if (uHatch > 1.5) { float s2 = step(0.62, fract((vWxz.x - vWxz.y) * 0.18)); col = mix(col, uHatchColor, s2 * 0.55); }
        diffuseColor.rgb = col;`);
  };
  m.userData.u = u;
  return m;
}

function shapeOf(poly, holes = []) {
  const s = new THREE.Shape(poly.map((p) => new THREE.Vector2(p.x, p.y)));
  for (const h of holes) s.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p.x, p.y))));
  return s;
}
function flatMesh(poly, mat, h, depth = 0, holes = []) {
  const geo = depth > 0 ? new THREE.ExtrudeGeometry(shapeOf(poly, holes), { depth, bevelEnabled: false }) : new THREE.ShapeGeometry(shapeOf(poly, holes));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = h;
  return mesh;
}

export const waterY = (level) => (level < 0 ? -0.1 + level * 0.25 : -0.1 + level * 0.045);
const REGION_TOP = { lawn: 0.25, path: 0.35, woods: 0.2 };

export class View {
  constructor(container, model) {
    this.model = model;
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    this.labels.setSize(window.innerWidth, window.innerHeight);
    Object.assign(this.labels.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none' });
    container.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.sky = { dry: c3('#dfe8ec'), wet: c3('#a9b5bf') };
    this.scene.background = this.sky.dry.clone();
    this.scene.fog = new THREE.Fog(this.scene.background, 900, 2600);

    this.camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 1, 4000);
    this.fitCamera();
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.minDistance = 30;
    this.controls.maxDistance = 1500;
    this.controls.screenSpacePanning = false;

    const hemi = new THREE.HemisphereLight(0xffffff, 0x6b7a5a, 1.6);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff3df, 1.8);
    sun.position.set(-120, 220, 90);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -220, right: 220, top: 220, bottom: -220, near: 10, far: 600 });
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);
    this.hemi = hemi; this.sun = sun;

    this.meshes = new Map(); // entity id -> Object3D
    this.pickables = [];     // meshes for raycast picking (regions, fences)
    this.buildStatic();
    this.buildDynamicLayers();

    window.addEventListener('resize', () => this.resize());
  }

  fitCamera() {
    const a = window.innerWidth / window.innerHeight;
    const f = Math.max(1, 1.45 / a);
    this.camera.aspect = a;
    this.camera.position.set(a > 1 ? -40 : 0, 250 * f, 260 * f);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
  }
  resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.labels.setSize(window.innerWidth, window.innerHeight);
  }

  label(text, pos, cls = 'map-label') {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    const o = new CSS2DObject(el);
    o.position.copy(pos);
    this.scene.add(o);
    return o;
  }

  // ---------- static scene ----------
  buildStatic() {
    const m = this.model, L = m.layout, S = this.scene;
    const outer = G.rectPoly(PARK.x0 - 6, PARK.y0 - 6, PARK.x1 + 6, PARK.y1 + 6);
    const hole = L.lake.boundary.slice().reverse();
    const slab = flatMesh(outer, new THREE.MeshLambertMaterial({ color: COLORS.meadow }), -4, 4, [hole]);
    slab.receiveShadow = true;
    S.add(slab);
    const base = new THREE.Mesh(new THREE.BoxGeometry(PARK.x1 - PARK.x0 + 12, 3, PARK.y1 - PARK.y0 + 12), new THREE.MeshLambertMaterial({ color: '#6f6a5f' }));
    base.position.y = -5.5;
    S.add(base);
    const bed = flatMesh(L.lake.boundary, new THREE.MeshLambertMaterial({ color: COLORS.lakeBed }), -3.9);
    S.add(bed);

    this.lakeWater = flatMesh(L.lake.boundary, new THREE.MeshPhongMaterial({ color: COLORS.water, transparent: true, opacity: 0.88, shininess: 80, specular: 0x99bbdd }), waterY(-2));
    this.lakeWater.userData.ref = { kind: 'lake', id: 'lake' };
    this.lakeWater.receiveShadow = true;
    S.add(this.lakeWater);
    this.pickables.push(this.lakeWater);

    // Paths, lawns and woods understory.
    this.regionMeshes = {};
    for (const p of L.paths) {
      const mesh = flatMesh(p.boundary, new THREE.MeshLambertMaterial({ color: COLORS.path }), 0, REGION_TOP.path);
      mesh.receiveShadow = true;
      mesh.userData.ref = { kind: 'path', id: p.id };
      S.add(mesh); this.pickables.push(mesh); this.regionMeshes[p.id] = mesh;
    }
    for (const l of L.lawns) {
      const mat = patchMaterial();
      mat.userData.u.uPatch.value.set(COLORS.worn);
      const mesh = flatMesh(l.boundary, mat, 0, REGION_TOP.lawn);
      mesh.receiveShadow = true;
      mesh.userData.ref = { kind: 'lawn', id: l.id };
      S.add(mesh); this.pickables.push(mesh); this.regionMeshes[l.id] = mesh;
      // Rope fence posts shown when the lawn is closed.
      const rope = new THREE.Group();
      const b = G.bounds(l.boundary);
      const pts = [];
      const inset = 1.2;
      const corners = [[b.x0 + inset, b.y0 + inset], [b.x1 - inset, b.y0 + inset], [b.x1 - inset, b.y1 - inset], [b.x0 + inset, b.y1 - inset], [b.x0 + inset, b.y0 + inset]];
      for (const [x, y] of corners) pts.push(w(x, y, 2));
      rope.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#f59e0b' })));
      const postGeo = new THREE.CylinderGeometry(0.2, 0.2, 2.2, 6), postMat = new THREE.MeshLambertMaterial({ color: '#f59e0b' });
      for (let i = 0; i < 4; i++) {
        const [x0, y0] = corners[i], [x1, y1] = corners[i + 1];
        const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / 10));
        for (let k = 0; k < n; k++) {
          const post = new THREE.Mesh(postGeo, postMat);
          post.position.copy(w(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n, 1.1));
          rope.add(post);
        }
      }
      rope.visible = false;
      S.add(rope);
      mesh.userData.rope = rope;
      mesh.userData.badge = this.label('', w(l.center.x, l.center.y, 6), 'map-badge');
    }
    {
      const mat = patchMaterial();
      mat.userData.u.uBase.value.set(COLORS.leafLitter);
      mat.userData.u.uPatch.value.set(COLORS.weeds);
      mat.userData.u.uScale.value = 0.09;
      const mesh = flatMesh(L.woods.boundary, mat, 0, REGION_TOP.woods);
      mesh.receiveShadow = true;
      mesh.userData.ref = { kind: 'woods', id: 'woods' };
      S.add(mesh); this.pickables.push(mesh); this.regionMeshes.woods = mesh;
    }

    // Standing water layers.
    this.waterLayers = {};
    for (const r of [...L.paths, ...L.lawns]) {
      const mat = new THREE.MeshBasicMaterial({ color: COLORS.standing_water, transparent: true, opacity: 0, depthWrite: false });
      const mesh = flatMesh(r.boundary, mat, REGION_TOP[r.kind] + 0.05);
      mesh.visible = false;
      mesh.renderOrder = 2;
      S.add(mesh);
      this.waterLayers[r.id] = mesh;
    }

    this.buildTrees();
    this.buildFences();

    // Boat landing: a small dock from the path out over the water.
    const lp = L.landing;
    const dockLen = G.dist(lp.pathPoint, lp.waterPoint) + 1;
    const dock = new THREE.Mesh(new THREE.BoxGeometry(5, 0.5, dockLen), new THREE.MeshLambertMaterial({ color: '#8b6b47' }));
    const mid = { x: (lp.pathPoint.x + lp.waterPoint.x) / 2, y: (lp.pathPoint.y + lp.waterPoint.y) / 2 };
    dock.position.copy(w(mid.x, mid.y, 0.3));
    dock.rotation.y = Math.atan2(lp.waterPoint.x - lp.pathPoint.x, lp.waterPoint.y - lp.pathPoint.y);
    dock.castShadow = true;
    dock.userData.ref = { kind: 'landing', id: 'landing' };
    S.add(dock); this.pickables.push(dock);

    for (const r of [...L.paths, ...L.lawns, L.woods, L.lake]) {
      const at = r.kind === 'path' ? (r.boundary[2].x - r.boundary[0].x > r.boundary[2].y - r.boundary[0].y ? { x: r.center.x + (r.id === 'path-north' ? 20 : 0), y: r.center.y } : { x: r.center.x, y: r.center.y + 40 }) : r.kind === 'lake' ? { x: 0, y: 60 } : r.kind === 'woods' ? { x: r.center.x, y: 60 } : { x: r.center.x, y: r.center.y - (r.id === 'lawn-big' ? 30 : 12) };
      this.label(r.name, w(at.x, at.y, 2), 'map-label');
    }
    this.label('Gate', w(L.gate.position.x + 4, L.gate.position.y, 5), 'map-label small');
    this.label('Boat landing', w(lp.pathPoint.x, lp.pathPoint.y - 5, 2), 'map-label small');
  }

  buildTrees() {
    const L = this.model.layout, rand = G.mulberry32(42);
    const spots = [];
    const tryPlace = (poly, n, rMin, rMax, check) => {
      for (let i = 0, placed = 0; i < n * 30 && placed < n; i++) {
        const p = G.randomPointInPolygon(poly, rand, 3);
        if (check && !check(p)) continue;
        if (spots.some((s) => G.dist(s, p) < (s.r + 3))) continue;
        spots.push({ ...p, r: rMin + rand() * (rMax - rMin), h: 10 + rand() * 10, tone: rand() });
        placed++;
      }
    };
    tryPlace(L.woods.boundary, 46, 3.5, 6);
    // A few park trees on the meadow edges, away from lawns, paths and the lake.
    const clear = (p) => !this.model.regionIdAt(p) && L.regions.every((r) => G.closestOnPolygon(p, r.boundary).d > 5);
    tryPlace(G.rectPoly(PARK.x0, 80, PARK.x1, PARK.y1), 10, 4, 6, clear);
    tryPlace(G.rectPoly(-90, PARK.y0, PARK.x1, -90), 8, 3.5, 5, clear);
    tryPlace(G.rectPoly(-90, -90, 90, 80), 6, 3, 4, clear);

    const trunkGeo = new THREE.CylinderGeometry(0.5, 0.8, 1, 6);
    const crownGeo = new THREE.IcosahedronGeometry(1, 1);
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: '#5b4330' }), spots.length);
    const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true }), spots.length);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3();
    const cA = c3('#2f6a35'), cB = c3('#4d8a3c'), tmp = new THREE.Color();
    spots.forEach((s, i) => {
      M.compose(w(s.x, s.y, s.h * 0.35), Q, V.set(1, s.h * 0.7, 1)); trunks.setMatrixAt(i, M);
      M.compose(w(s.x, s.y, s.h * 0.7 + s.r * 0.3), Q, V.set(s.r, s.r * 0.85, s.r)); crowns.setMatrixAt(i, M);
      crowns.setColorAt(i, tmp.copy(cA).lerp(cB, s.tone));
    });
    trunks.castShadow = crowns.castShadow = true;
    this.scene.add(trunks, crowns);
  }

  buildFences() {
    const L = this.model.layout;
    const wood = new THREE.MeshLambertMaterial({ color: COLORS.fenceWood });
    const red = new THREE.MeshLambertMaterial({ color: COLORS.broken });
    const white = new THREE.MeshLambertMaterial({ color: '#ffffff' });
    const postGeo = new THREE.BoxGeometry(0.45, 3.2, 0.45);
    const coneGeo = new THREE.ConeGeometry(0.7, 2.2, 8);
    const bandGeo = new THREE.CylinderGeometry(0.42, 0.5, 0.35, 8);
    const proxyMat = new THREE.MeshBasicMaterial({ visible: false });
    this.fenceMeshes = {};
    for (const f of L.fences) {
      const len = G.dist(f.a, f.b);
      const ang = Math.atan2(f.b.y - f.a.y, f.b.x - f.a.x);
      const g = new THREE.Group();
      const mid = { x: (f.a.x + f.b.x) / 2, y: (f.a.y + f.b.y) / 2 };
      g.position.copy(w(mid.x, mid.y, 0.2));
      g.rotation.y = ang;
      const intact = new THREE.Group();
      const n = Math.max(2, Math.round(len / 4));
      for (let i = 0; i <= n; i++) {
        const post = new THREE.Mesh(postGeo, wood);
        post.position.set(-len / 2 + (len * i) / n, 1.6, 0);
        post.castShadow = true;
        intact.add(post);
      }
      for (const h of [1.2, 2.5]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.28, 0.18), wood);
        rail.position.set(0, h, 0);
        rail.castShadow = true;
        intact.add(rail);
      }
      const broken = new THREE.Group();
      for (const x of [-len / 2 + 0.6, len / 2 - 0.6]) {
        const cone = new THREE.Mesh(coneGeo, red); cone.position.set(x, 1.1, 0); broken.add(cone);
        const band = new THREE.Mesh(bandGeo, white); band.position.set(x, 1.2, 0); broken.add(band);
      }
      const fallen = new THREE.Mesh(new THREE.BoxGeometry(len * 0.45, 0.28, 0.18), wood);
      fallen.position.set(len * 0.1, 0.2, 1.2); fallen.rotation.y = 0.4;
      broken.add(fallen);
      g.add(intact, broken);
      const proxy = new THREE.Mesh(new THREE.BoxGeometry(len, 5, 3), proxyMat);
      proxy.position.y = 2;
      proxy.userData.ref = { kind: 'fence', id: f.id };
      g.add(proxy);
      this.pickables.unshift(proxy);
      this.scene.add(g);
      this.fenceMeshes[f.id] = { g, intact, broken };
    }
    // Maintenance gate: stone piers with a green gate between them.
    const gt = L.gate, gg = new THREE.Group();
    gg.position.copy(w(gt.position.x, gt.position.y, 0.2));
    gg.rotation.y = Math.PI / 2;
    const stone = new THREE.MeshLambertMaterial({ color: '#9ca3af' });
    for (const z of [-2.9, 2.9]) { const pier = new THREE.Mesh(new THREE.BoxGeometry(1, 4.4, 1), stone); pier.position.set(z, 2.2, 0); pier.castShadow = true; gg.add(pier); }
    const gateBar = new THREE.Mesh(new THREE.BoxGeometry(4.8, 2.4, 0.2), new THREE.MeshLambertMaterial({ color: '#15803d' }));
    gateBar.position.set(0, 1.6, 0);
    gg.add(gateBar);
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(7, 5, 3), proxyMat);
    proxy.position.y = 2; proxy.userData.ref = { kind: 'gate', id: 'gate' };
    gg.add(proxy); this.pickables.unshift(proxy);
    this.scene.add(gg);
  }

  // ---------- dynamic layers ----------
  buildDynamicLayers() {
    const S = this.scene, L = this.model.layout;
    // Duckweed cells.
    const cells = L.grid.cells;
    const plane = new THREE.PlaneGeometry(L.grid.CELL, L.grid.CELL);
    plane.rotateX(-Math.PI / 2);
    this.duck = new THREE.InstancedMesh(plane, new THREE.MeshLambertMaterial({ color: '#ffffff' }), cells.length);
    const rand = G.mulberry32(9), col = new THREE.Color();
    cells.forEach((c, i) => this.duck.setColorAt(i, col.set(COLORS.duckweed).offsetHSL((rand() - 0.5) * 0.04, 0, (rand() - 0.5) * 0.08)));
    this.duck.renderOrder = 1;
    S.add(this.duck);

    // Rain streaks.
    const N = 3200, pos = new Float32Array(N * 6);
    this.rainSeed = [];
    for (let i = 0; i < N; i++) {
      const x = PARK.x0 - 20 + Math.random() * (PARK.x1 - PARK.x0 + 40), z = -(PARK.y0 - 20 + Math.random() * (PARK.y1 - PARK.y0 + 40)), y = Math.random() * 140;
      this.rainSeed.push([x, y, z]);
    }
    this.rainGeo = new THREE.BufferGeometry();
    this.rainGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.rain = new THREE.LineSegments(this.rainGeo, new THREE.LineBasicMaterial({ color: '#dbeafe', transparent: true, opacity: 0.55 }));
    this.rain.frustumCulled = false;
    S.add(this.rain);

    // Leashes, wakes and robot target lines are rebuilt each frame.
    const lineLayer = (color, opts = {}) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 2 * 2000), 3));
      if (opts.vertexColors) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(3 * 2 * 2000), 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: opts.opacity ?? 1, vertexColors: !!opts.vertexColors, depthTest: opts.depthTest ?? true }));
      l.frustumCulled = false;
      l.renderOrder = 3;
      S.add(l);
      return l;
    };
    this.leashes = lineLayer('#1f2937', { opacity: 0.85 });
    this.wakes = lineLayer('#ffffff', { opacity: 0.85 });
    this.targets = lineLayer('#ffffff', { vertexColors: true, opacity: 0.9, depthTest: false });

    // Selection marker.
    this.selRing = new THREE.Mesh(new THREE.RingGeometry(2.4, 3.1, 32), new THREE.MeshBasicMaterial({ color: COLORS.select, side: THREE.DoubleSide, depthTest: false, transparent: true }));
    this.selRing.rotation.x = -Math.PI / 2;
    this.selRing.renderOrder = 5;
    this.selRing.visible = false;
    S.add(this.selRing);
    this.selOutline = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: COLORS.select, depthTest: false, transparent: true }));
    this.selOutline.renderOrder = 5;
    this.selOutline.visible = false;
    S.add(this.selOutline);

    this.geo = {
      body: new THREE.CylinderGeometry(0.55, 0.75, 3.1, 10),
      head: new THREE.SphereGeometry(0.62, 12, 10),
      dogBody: new THREE.BoxGeometry(2, 0.9, 0.85),
      dogHead: new THREE.BoxGeometry(0.75, 0.7, 0.7),
      litter: new THREE.IcosahedronGeometry(0.6, 0),
    };
    this.mats = {
      skin: new THREE.MeshLambertMaterial({ color: COLORS.skin }),
      dog: new THREE.MeshLambertMaterial({ color: COLORS.dog }),
      activity: Object.fromEntries(['walking', 'standing', 'sitting', 'boating'].map((a) => [a, new THREE.MeshLambertMaterial({ color: COLORS[a] })])),
      litter: COLORS.litter.map((c) => new THREE.MeshBasicMaterial({ color: c })),
    };
  }

  makePerson() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(this.geo.body, this.mats.activity.walking);
    body.position.y = 1.55;
    const head = new THREE.Mesh(this.geo.head, this.mats.skin);
    head.position.y = 3.6;
    body.castShadow = head.castShadow = true;
    g.add(body, head);
    g.userData.body = body; g.userData.head = head;
    g.scale.setScalar(2.1);
    return g;
  }
  makeDog() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(this.geo.dogBody, this.mats.dog); body.position.y = 1.0;
    const head = new THREE.Mesh(this.geo.dogHead, this.mats.dog); head.position.set(1.15, 1.45, 0);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.15, 0.15), this.mats.dog); tail.position.set(-1.2, 1.4, 0); tail.rotation.z = 0.6;
    const legs = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 0.6), this.mats.dog); legs.position.y = 0.3;
    body.castShadow = true;
    g.add(body, head, tail, legs);
    g.scale.setScalar(1.9);
    return g;
  }
  makeBoat() {
    const s = new THREE.Shape();
    s.moveTo(-5.5, -2); s.lineTo(3, -2); s.quadraticCurveTo(5.8, -1.2, 6, 0); s.quadraticCurveTo(5.8, 1.2, 3, 2); s.lineTo(-5.5, 2); s.lineTo(-5.5, -2);
    const hull = new THREE.Mesh(new THREE.ExtrudeGeometry(s, { depth: 1.3, bevelEnabled: true, bevelSize: 0.25, bevelThickness: 0.2, bevelSegments: 1 }), new THREE.MeshLambertMaterial({ color: '#f8fafc' }));
    hull.rotation.x = -Math.PI / 2;
    hull.position.y = -0.3;
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(11.2, 0.3, 4.5), new THREE.MeshLambertMaterial({ color: '#b91c1c' }));
    stripe.position.set(0.2, 0.7, 0);
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.2, 3.8), new THREE.MeshLambertMaterial({ color: '#8b6b47' }));
    seat.position.set(-0.5, 0.9, 0);
    hull.castShadow = true;
    const g = new THREE.Group();
    g.add(hull, stripe, seat);
    return g;
  }
  makeRobot(kind) {
    const g = new THREE.Group();
    const lam = (c) => new THREE.MeshLambertMaterial({ color: c });
    if (kind === 'mower') {
      const body = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.4, 2.6), lam(COLORS.mower)); body.position.y = 1.1;
      const top = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.8, 1.8), lam('#7c2d12')); top.position.set(-0.4, 2.2, 0);
      g.add(body, top);
      const wheel = new THREE.CylinderGeometry(0.6, 0.6, 0.4, 12);
      for (const [x, z] of [[-1.2, 1.4], [1.2, 1.4], [-1.2, -1.4], [1.2, -1.4]]) { const wh = new THREE.Mesh(wheel, lam('#111827')); wh.rotation.x = Math.PI / 2; wh.position.set(x, 0.6, z); g.add(wh); }
      body.castShadow = true;
    } else if (kind === 'steward') {
      const body = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.3, 2.6, 16), lam(COLORS.steward)); body.position.y = 1.3;
      const dome = new THREE.Mesh(new THREE.SphereGeometry(1.1, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), lam('#99f6e4')); dome.position.y = 2.6;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(2, 0.3, 0.3), lam('#334155')); arm.position.set(1.3, 1.8, 0); arm.rotation.z = -0.5;
      body.castShadow = true;
      g.add(body, dome, arm);
    } else {
      const pont = new THREE.CylinderGeometry(0.5, 0.5, 4.4, 10);
      for (const z of [-1.3, 1.3]) { const p = new THREE.Mesh(pont, lam(COLORS.skimmer)); p.rotation.z = Math.PI / 2; p.position.set(0, 0.4, z); g.add(p); }
      const deck = new THREE.Mesh(new THREE.BoxGeometry(3, 0.3, 3), lam('#1f2937')); deck.position.y = 0.9;
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 2, 6), lam('#1f2937')); mast.position.y = 1.9;
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), new THREE.MeshBasicMaterial({ color: '#fde047' })); lamp.position.y = 3;
      g.add(deck, mast, lamp);
    }
    g.scale.setScalar(1.8);
    return g;
  }

  // Create, update and remove a mesh per entity so the scene matches the model.
  syncEntities(list, factory, update, dt) {
    const seen = new Set();
    for (const e of list) {
      seen.add(e.id);
      let o = this.meshes.get(e.id);
      if (!o) {
        o = factory(e);
        o.userData.ref = { kind: e.kind, id: e.id };
        this.scene.add(o);
        this.meshes.set(e.id, o);
        o.userData.fresh = true;
      }
      update(e, o, dt);
      o.userData.fresh = false;
    }
    return seen;
  }
  ease(o, target, dt, heading) {
    if (o.userData.fresh || o.position.distanceTo(target) > 25) o.position.copy(target);
    else o.position.lerp(target, 1 - Math.exp(-dt * 10));
    if (heading !== undefined) {
      const cur = o.rotation.y;
      const d = Math.atan2(Math.sin(heading - cur), Math.cos(heading - cur));
      o.rotation.y = o.userData.fresh ? heading : cur + d * (1 - Math.exp(-dt * 8));
    }
  }

  update(dt, selection) {
    const m = this.model;
    const rain = m.weather.rainIntensity;
    // Sky darkens with rain.
    const wet = rain === 'heavy' ? 1 : rain === 'light' ? 0.5 : 0;
    this.scene.background.copy(this.sky.dry).lerp(this.sky.wet, wet);
    this.scene.fog.color.copy(this.scene.background);
    this.sun.intensity = 1.8 - wet * 0.9;

    // Lawns: grass color by height, brown wear patches, hatching for closed/reseeding.
    const short = c3(COLORS.grassShort), tall = c3(COLORS.grassTall);
    for (const l of m.lawns) {
      const mesh = this.regionMeshes[l.id], u = mesh.material.userData.u;
      const t = (l.grassHeight - RULES.GRASS_MIN) / (RULES.GRASS_MAX - RULES.GRASS_MIN);
      if (l.status === 'reseeding') {
        u.uBase.value.set(COLORS.straw).lerp(short, Math.min(0.6, Math.max(0, t) * 2));
        u.uAmount.value = 0; u.uHatch.value = 2; u.uHatchColor.value.set('#a88a4a');
      } else {
        u.uBase.value.copy(short).lerp(tall, Math.max(0, Math.min(1, t)));
        u.uAmount.value = 0.12 + (l.wear / 100) * 0.85;
        u.uHatch.value = l.status === 'closed' ? 1 : 0; u.uHatchColor.value.set('#334155');
      }
      mesh.userData.rope.visible = l.status !== 'open';
      const badges = [];
      if (l.status === 'closed') badges.push('Closed');
      if (l.status === 'reseeding') badges.push(l.pendingReseed ? 'Closing for reseeding' : `Reseeding · opens in ${l.reseedTimer}`);
      if (l.wear > RULES.NEEDS_RESEEDING && l.status !== 'reseeding') badges.push('Needs reseeding');
      if (l.grassHeight > RULES.NEEDS_MOWING && l.status !== 'reseeding') badges.push('Needs mowing');
      const el = mesh.userData.badge.element;
      el.textContent = badges.join(' · ');
      el.style.display = badges.length ? '' : 'none';
    }
    const wu = this.regionMeshes.woods.material.userData.u;
    wu.uAmount.value = 0.08 + (m.woods.weedCover / 100) * 0.9;

    for (const r of [...m.paths, ...m.lawns]) {
      const layer = this.waterLayers[r.id];
      layer.visible = r.standingWater > 0.02;
      layer.material.opacity = Math.min(0.82, 0.12 + r.standingWater / 9);
      layer.position.y = REGION_TOP[r.kind] + 0.06 + Math.min(r.standingWater, 12) * 0.05;
    }
    const wy = waterY(m.lake.waterLevel);
    this.lakeWater.position.y += (wy - this.lakeWater.position.y) * (1 - Math.exp(-dt * 6));
    const lakeY = this.lakeWater.position.y;

    // Duckweed: each cell is a green tile sized by its cover.
    const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), P = new THREE.Vector3();
    const cells = m.layout.grid.cells;
    for (let i = 0; i < cells.length; i++) {
      const v = m.duckweed[i];
      const s = v < 1 ? 0.0001 : 0.12 + 0.9 * Math.sqrt(v / 100);
      M4.compose(P.set(cells[i].x, lakeY + 0.04, -cells[i].y), Q, V.set(s, 1, s));
      this.duck.setMatrixAt(i, M4);
    }
    this.duck.instanceMatrix.needsUpdate = true;

    for (const f of m.fences) {
      const fm = this.fenceMeshes[f.id];
      fm.intact.visible = f.status === 'intact';
      fm.broken.visible = f.status === 'broken';
    }

    // Rain.
    const count = rain === 'heavy' ? 3200 : rain === 'light' ? 900 : 0;
    const arr = this.rainGeo.attributes.position.array;
    for (let i = 0; i < count; i++) {
      const s = this.rainSeed[i];
      s[1] -= dt * 150;
      if (s[1] < 0) s[1] += 140;
      arr.set([s[0], s[1], s[2], s[0] + 0.8, s[1] + 4, s[2]], i * 6);
    }
    this.rainGeo.setDrawRange(0, count * 2);
    this.rainGeo.attributes.position.needsUpdate = true;

    // Entities.
    const alive = new Set();
    const add = (set) => set.forEach((id) => alive.add(id));
    add(this.syncEntities(m.boats, () => this.makeBoat(), (b, o, d) => this.ease(o, w(b.x, b.y, lakeY + 0.3), d, b.heading), dt));
    add(this.syncEntities(m.people, () => this.makePerson(), (p, o, d) => {
      const body = o.userData.body;
      body.material = this.mats.activity[p.activity];
      const sit = p.activity === 'sitting' || p.activity === 'boating';
      body.scale.y = sit ? 0.55 : 1;
      body.position.y = sit ? 0.85 : 1.55;
      o.userData.head.position.y = sit ? 2.3 : 3.6;
      let x = p.x, y = p.y, h = REGION_TOP[m.byId[p.location]?.kind] || 0.3, heading;
      if (p.activity === 'boating') {
        const b = m.boat(p.boatId);
        if (b) {
          const off = (p.seat ? -2.2 : 1.6);
          x = b.x + Math.cos(b.heading) * off; y = b.y + Math.sin(b.heading) * off; h = lakeY + 0.6; heading = b.heading;
        }
      }
      this.ease(o, w(x, y, h), d, heading);
    }, dt));
    add(this.syncEntities(m.dogs, () => this.makeDog(), (dg, o, d) => {
      const own = m.person(dg.ownerId);
      const hd = own ? Math.atan2(own.y - dg.y, own.x - dg.x) : 0;
      this.ease(o, w(dg.x, dg.y, REGION_TOP[m.byId[dg.location]?.kind] || 0.3), d, hd);
    }, dt));
    add(this.syncEntities(m.litter, (l) => {
      const o = new THREE.Mesh(this.geo.litter, this.mats.litter[parseInt(l.id.slice(1), 10) % this.mats.litter.length]);
      o.scale.setScalar(1.6);
      return o;
    }, (l, o, d) => {
      const h = l.location === 'lake' ? lakeY + 0.35 : (REGION_TOP[m.byId[l.location]?.kind] || 0.2) + 0.5;
      this.ease(o, w(l.x, l.y, h), d);
      o.rotation.y += d;
    }, dt));
    for (const list of [m.mowers, m.stewards, m.skimmers]) {
      add(this.syncEntities(list, (r) => this.makeRobot(r.kind), (r, o, d) => {
        const prev = o.userData.last || { x: r.x, y: r.y };
        const moved = Math.hypot(r.x - prev.x, r.y - prev.y) > 0.05;
        if (moved) o.userData.heading = Math.atan2(r.y - prev.y, r.x - prev.x);
        o.userData.last = { x: r.x, y: r.y };
        const h = r.kind === 'skimmer' ? lakeY + 0.1 : REGION_TOP[m.byId[r.location]?.kind] || 0.3;
        this.ease(o, w(r.x, r.y, h), d, o.userData.heading ?? 0);
      }, dt));
    }
    for (const [id, o] of this.meshes) if (!alive.has(id)) { this.scene.remove(o); this.meshes.delete(id); }

    this.updateLines(lakeY);
    this.updateSelection(selection, lakeY);
  }

  updateLines(lakeY) {
    const m = this.model;
    // Leashes: owner's hand to dog's collar, using the eased mesh positions.
    let k = 0;
    const la = this.leashes.geometry.attributes.position.array;
    for (const d of m.dogs) {
      const om = this.meshes.get(d.ownerId), dm = this.meshes.get(d.id);
      if (!om || !dm) continue;
      la.set([om.position.x, om.position.y + 2.6, om.position.z, dm.position.x, dm.position.y + 1.6, dm.position.z], k); k += 6;
    }
    this.leashes.geometry.setDrawRange(0, k / 3);
    this.leashes.geometry.attributes.position.needsUpdate = true;

    // Boat wakes: a V of open water widening behind each boat.
    k = 0;
    const wa = this.wakes.geometry.attributes.position.array;
    for (const b of m.boats) {
      const bm = this.meshes.get(b.id);
      if (!bm) continue;
      const h = bm.rotation.y;
      const sx = bm.position.x - Math.cos(h) * 5, sy = -bm.position.z - Math.sin(h) * 5;
      // Two pairs of arms spreading back from the stern at about 20 degrees.
      for (const [len, ang] of [[18, 0.36], [10, 0.22]]) {
        for (const side of [-1, 1]) {
          const a = h + Math.PI + side * ang;
          wa.set([sx, lakeY + 0.12, -sy, sx + Math.cos(a) * len, lakeY + 0.12, -(sy + Math.sin(a) * len)], k); k += 6;
        }
      }
    }
    this.wakes.geometry.setDrawRange(0, k / 3);
    this.wakes.geometry.attributes.position.needsUpdate = true;

    // Robot target lines.
    k = 0;
    const ta = this.targets.geometry.attributes.position.array, tc = this.targets.geometry.attributes.color.array;
    const col = new THREE.Color();
    for (const r of m.robots()) {
      const rm = this.meshes.get(r.id);
      const tp = this.targetPoint(r, lakeY);
      if (!rm || !tp) continue;
      col.set(COLORS[r.kind]);
      ta.set([rm.position.x, rm.position.y + 3, rm.position.z, tp.x, tp.y, tp.z], k);
      tc.set([col.r, col.g, col.b, col.r, col.g, col.b], k); k += 6;
    }
    this.targets.geometry.setDrawRange(0, k / 3);
    this.targets.geometry.attributes.position.needsUpdate = true;
    this.targets.geometry.attributes.color.needsUpdate = true;
  }

  targetPoint(r, lakeY) {
    const m = this.model;
    if (r.kind === 'mower' && r.targetLawn) { const l = m.byId[r.targetLawn]; return w(l.center.x, l.center.y, 1); }
    if (r.kind === 'steward' && r.target) {
      if (r.target.type === 'fence') { const f = m.fences.find((x) => x.id === r.target.id); return w((f.a.x + f.b.x) / 2, (f.a.y + f.b.y) / 2, 2); }
      if (r.target.type === 'woods') return w(m.woods.center.x, m.woods.center.y, 1);
      const l = m.litter.find((x) => x.id === r.target.id); return l ? w(l.x, l.y, l.location === 'lake' ? lakeY + 0.3 : 0.8) : null;
    }
    if (r.kind === 'skimmer' && r.target) { const c = m.layout.grid.cells[r.target.id]; return w(c.x, c.y, lakeY + 0.1); }
    return null;
  }

  updateSelection(sel, lakeY) {
    this.selRing.visible = false;
    this.selOutline.visible = false;
    if (!sel) return;
    const m = this.model;
    const e = m.get(sel.id);
    if (!e) return;
    const o = this.meshes.get(sel.id);
    if (o) {
      this.selRing.visible = true;
      this.selRing.position.set(o.position.x, Math.max(o.position.y, 0.3) + 0.15, o.position.z);
      const s = sel.kind === 'boat' ? 2.4 : sel.kind === 'litter' ? 0.6 : 1;
      this.selRing.scale.setScalar(s);
      return;
    }
    let pts = null, h = 1;
    if (e.boundary) { pts = [...e.boundary, e.boundary[0]]; h = e.kind === 'lake' ? lakeY + 0.2 : (REGION_TOP[e.kind] || 0) + 0.2; }
    else if (e.kind === 'fence') { pts = [e.a, e.b]; h = 3.6; }
    else if (e.kind === 'gate') { pts = [e.a, e.b]; h = 4.8; }
    else if (e.kind === 'landing') { pts = [e.pathPoint, e.waterPoint]; h = 1; }
    if (!pts) return;
    this.selOutline.geometry.dispose();
    this.selOutline.geometry = new THREE.BufferGeometry().setFromPoints(pts.map((p) => w(p.x, p.y, h)));
    this.selOutline.visible = true;
  }

  // Click picking: nearest small entity on screen, else the region/fence under the cursor.
  pick(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const sx = clientX - rect.left, sy = clientY - rect.top;
    let best = null, bd = 18;
    const v = new THREE.Vector3();
    for (const [id, o] of this.meshes) {
      v.copy(o.position); v.y += 1.5;
      v.project(this.camera);
      if (v.z > 1) continue;
      const px = ((v.x + 1) / 2) * rect.width, py = ((1 - v.y) / 2) * rect.height;
      const d = Math.hypot(px - sx, py - sy);
      if (d < bd) { bd = d; best = o.userData.ref; }
    }
    if (best) return best;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((sx / rect.width) * 2 - 1, -(sy / rect.height) * 2 + 1), this.camera);
    const hits = ray.intersectObjects(this.pickables, false);
    return hits.length ? hits[0].object.userData.ref : null;
  }

  // Screen position of a ground point, for tests and tooltips.
  toScreen(x, y, h = 0) {
    const v = w(x, y, h).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}
