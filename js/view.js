// three.js rendering of the model. Ground plane (x east, y north, feet)
// maps to world (x, height, -y). The map is about 2,600 by 2,400 ft, so
// agents are built in feet, with a small readability allowance at overview scale.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import * as G from './geometry.js';
import { RULES } from './model.js';
import { drawRobotMap, ROBOT_COLORS } from './monitor.js';
import { KnowledgeLayer } from './knowledge.js';

const w = (x, y, h = 0) => new THREE.Vector3(x, h, -y);

export const COLORS = {
  walking: '#1757d2', standing: '#3982ed', sitting: '#4ebcf6', boating: '#9bdcff',
  skin: '#f1c9a5', dog: '#8b5a2b',
  mower: '#df5719', steward: '#f78336', skimmer: '#ffb05f',
  litter: ['#ff2bd6', '#ffe600', '#00e5ff', '#ff4d4d'], poop: '#5b3a1e', hole: '#3b2a1a',
  grassShort: '#adc26c', grassTall: '#35613a', worn: '#8a6a3f', straw: '#e6d6a2',
  leafLitter: '#7a5a3a', weeds: '#7ba644', path: '#dccfb2', meadow: '#869d60', planting: '#688653',
  building: '#b9b2a6', lakeBed: '#2d5560', water: '#3e8587', duckweed: '#789e53', select: '#22d3ee',
  standing_water: '#2f80ed', fenceWood: '#9a6b3f', broken: '#e11d48', pad: '#334155',
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
    uHatch: { value: 0 }, uHatchColor: { value: new THREE.Color('#333') }, uScale: { value: 0.035 },
  };
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = 'varying vec2 vWxz;\n' + sh.vertexShader.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n vWxz = (modelMatrix * vec4(transformed, 1.0)).xz;');
    sh.fragmentShader = 'varying vec2 vWxz;\nuniform vec3 uBase, uPatch, uHatchColor;\nuniform float uAmount, uHatch, uScale;\n' + NOISE +
      sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
        float n = fbm(vWxz * uScale);
        float fine = noise(vWxz * 0.5);
        vec3 col = uBase * (0.9 + 0.2 * fine);
        float pm = smoothstep(n - 0.03, n + 0.03, uAmount);
        col = mix(col, uPatch * (0.88 + 0.24 * fine), pm);
        if (uHatch > 0.5) { float s = step(0.6, fract((vWxz.x + vWxz.y) * 0.08)); col = mix(col, uHatchColor, s * 0.55); }
        if (uHatch > 1.5) { float s2 = step(0.6, fract((vWxz.x - vWxz.y) * 0.08)); col = mix(col, uHatchColor, s2 * 0.55); }
        diffuseColor.rgb = col;`);
  };
  m.userData.u = u;
  return m;
}

// World-space ripples stay continuous across the original lake polygons.
function lakeMaterial(time) {
  const material = new THREE.MeshPhongMaterial({
    color: COLORS.water, shininess: 80, specular: '#72948b',
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uLakeTime = time;
    shader.vertexShader = 'varying vec2 vLakeXZ;\n' + shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      '#include <worldpos_vertex>\n vLakeXZ = (modelMatrix * vec4(transformed, 1.0)).xz;',
    );
    shader.fragmentShader = 'varying vec2 vLakeXZ;\nuniform float uLakeTime;\n' + NOISE +
      shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
        float current = noise(vLakeXZ * 0.008);
        float a = dot(vLakeXZ, vec2(0.12, 0.19)) + current * 4.0 - uLakeTime * 0.9;
        float b = dot(vLakeXZ, vec2(-0.17, 0.07)) + uLakeTime * 0.64;
        float detail = 1.0 - smoothstep(0.8, 3.0, max(fwidth(a), fwidth(b)));
        diffuseColor.rgb *= 0.83 + current * 0.36 + detail * sin(a) * cos(b) * 0.07;
      `).replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = normalize(normal + mat3(viewMatrix) * vec3(cos(a), 0.0, sin(b)) * 0.12 * detail);
        float grazing = pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 3.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.29, 0.48, 0.46), grazing * 0.6);
      `);
  };
  return material;
}

// polygons: [[outer, ...holes], ...] with points {x, y}
function shapesOf(polygons) {
  return polygons.map(([outer, ...holes]) => {
    const s = new THREE.Shape(outer.map((p) => new THREE.Vector2(p.x, p.y)));
    for (const h of holes) s.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p.x, p.y))));
    return s;
  });
}
function flatMesh(polygons, mat, h, depth = 0) {
  const shapes = shapesOf(polygons);
  const geo = depth > 0 ? new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: false }) : new THREE.ShapeGeometry(shapes);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = h;
  mesh.receiveShadow = true;
  return mesh;
}
function ringLines(polygons, h) {
  const pts = [];
  for (const poly of polygons) for (const ring of poly) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    pts.push(w(a.x, a.y, h), w(b.x, b.y, h));
  }
  return new THREE.BufferGeometry().setFromPoints(pts);
}

export const waterY = (level) => (level < 0 ? -0.2 + level * 0.25 : -0.2 + level * 0.05);
const REGION_TOP = { woods: 0.5, lawn: 0.6, path: 0.8, lake: 0 };
const isNamed = (name) => name && !/^(Lawn|Path) \d+$/.test(name);

export class View {
  constructor(container, model) {
    this.model = model;
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    this.labels.setSize(window.innerWidth, window.innerHeight);
    Object.assign(this.labels.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none' });
    container.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.sky = { dry: c3('#e6ede5'), wet: c3('#adbcbf'), night: c3('#171c25') };
    this.scene.background = this.sky.dry.clone();
    this.scene.fog = new THREE.Fog(this.scene.background, 2700, 6600);

    this.camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 2, 14000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.minDistance = 25;
    this.controls.maxDistance = 5000;
    this.controls.screenSpacePanning = false;
    this.fitCamera();

    const hemi = new THREE.HemisphereLight(0xe1efff, 0x8b7c50, 1.5);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffecd0, 2.15);
    sun.position.set(-1550, 1700, 1000);
    sun.castShadow = true;
    Object.assign(sun.shadow.camera, { left: -1900, right: 1900, top: 1900, bottom: -1900, near: 10, far: 5400 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.00015;
    sun.shadow.normalBias = 1.5;
    this.renderer.shadowMap.needsUpdate = true;
    this.scene.add(sun);
    this.hemi = hemi; this.sun = sun;

    this.meshes = new Map(); // entity id -> Object3D
    this.pickables = [];     // meshes for raycast picking (regions, fences)
    this.entityScale = 1;
    this.night = false;
    this.visitorTrails = new WeakMap();
    this.buildStatic();
    this.buildDynamicLayers();
    this.knowledge = new KnowledgeLayer(this.scene, model);

    window.addEventListener('resize', () => this.resize());
  }

  fitCamera() {
    const a = window.innerWidth / window.innerHeight;
    const f = Math.max(1, 1.2 / a);
    this.camera.aspect = a;
    this.controls.target.set(0, 0, -40);
    this.camera.position.set(-345 * f, 2240 * f, 1800 * f);
    this.camera.lookAt(this.controls.target);
    this.camera.updateProjectionMatrix();
  }
  setScenePreset(preset) {
    this.night = preset === 'night';
    this.fitCamera();
    if (preset !== 'lakeside') return;

    const { pathPoint, waterPoint } = this.model.layout.landing;
    const target = w(pathPoint.x, pathPoint.y, 4);
    const direction = w(waterPoint.x, waterPoint.y).sub(target);
    direction.y = 0;
    const up = this.camera.up;
    direction.normalize().applyAxisAngle(up, -1.18);
    target.addScaledVector(direction.clone().cross(up), 32);
    const distance = Math.max(1, 1.05 / this.camera.aspect);
    this.controls.target.copy(target);
    this.camera.position.copy(target).addScaledVector(direction, 205 * distance);
    this.camera.position.y += 100 * distance;
    this.camera.lookAt(target);
  }

  resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.labels.setSize(window.innerWidth, window.innerHeight);
  }
  focus(x, y, dist = 420) {
    const t = w(x, y, 0);
    const off = this.camera.position.clone().sub(this.controls.target).setLength(dist);
    this.controls.target.copy(t);
    this.camera.position.copy(t).add(off);
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
    const m = this.model, L = m.layout, S = this.scene, B = L.bounds;
    const lam = (color) => new THREE.MeshLambertMaterial({ color });
    // Ground outside the park, then the park itself.
    const base = new THREE.Mesh(new THREE.BoxGeometry(B.x1 - B.x0 + 40, 12, B.y1 - B.y0 + 40), lam('#a5a18d'));
    base.position.y = -8.2;
    base.receiveShadow = true;
    S.add(base);
    // The park ground has the lake cut out so the water shows through.
    const lakeHoles = L.lake.polygons.map((poly) => poly[0]);
    S.add(flatMesh(L.other.park.map(([outer, ...holes]) => [outer, ...holes, ...lakeHoles]), lam(COLORS.meadow), 0.05));
    S.add(flatMesh(L.other.plantings, lam(COLORS.planting), 0.3));
    S.add(flatMesh(L.other.water, lam(COLORS.water), 0.1));
    const bld = flatMesh(L.other.buildings, lam(COLORS.building), 0, 14);
    bld.castShadow = true;
    S.add(bld);

    S.add(flatMesh(L.lake.polygons, lam(COLORS.lakeBed), -3.9));
    this.lakeTime = { value: 0 };
    this.lakeWater = flatMesh(L.lake.polygons, lakeMaterial(this.lakeTime), waterY(-2));
    this.lakeWater.userData.ref = { kind: 'lake', id: 'lake' };
    S.add(this.lakeWater);
    this.pickables.push(this.lakeWater);

    // Paths, lawns and the woods understory: one mesh per region.
    this.regionMeshes = {};
    const pathMat = this.pathMaterial = lam(COLORS.path);
    pathMat.emissive.set('#ad713b');
    for (const p of L.paths) {
      const mesh = flatMesh(p.polygons, pathMat, REGION_TOP.path);
      mesh.userData.ref = { kind: 'path', id: p.id };
      S.add(mesh); this.pickables.push(mesh); this.regionMeshes[p.id] = mesh;
    }
    for (const l of L.lawns) {
      const mat = patchMaterial();
      mat.userData.u.uPatch.value.set(COLORS.worn);
      const mesh = flatMesh(l.polygons, mat, REGION_TOP.lawn);
      mesh.userData.ref = { kind: 'lawn', id: l.id };
      S.add(mesh); this.pickables.push(mesh); this.regionMeshes[l.id] = mesh;
      // Orange rope around a closed lawn.
      const rope = new THREE.LineSegments(ringLines(l.polygons, 3), new THREE.LineBasicMaterial({ color: '#f59e0b' }));
      rope.visible = false;
      S.add(rope);
      mesh.userData.rope = rope;
      mesh.userData.badge = this.label('', w(l.anchor.x, l.anchor.y - 22, 8), 'map-badge');
    }
    {
      const mat = patchMaterial();
      mat.userData.u.uBase.value.set(COLORS.leafLitter);
      mat.userData.u.uPatch.value.set(COLORS.weeds);
      mat.userData.u.uScale.value = 0.015;
      const mesh = flatMesh(L.woods.polygons, mat, REGION_TOP.woods);
      mesh.userData.ref = { kind: 'woods', id: 'woods' };
      S.add(mesh); this.pickables.push(mesh); this.regionMeshes.woods = mesh;
    }

    // Standing water layers share each region's geometry.
    this.waterLayers = {};
    for (const r of [...L.paths, ...L.lawns]) {
      const mat = new THREE.MeshBasicMaterial({ color: COLORS.standing_water, transparent: true, opacity: 0, depthWrite: false });
      const src = this.regionMeshes[r.id];
      const mesh = new THREE.Mesh(src.geometry, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      mesh.renderOrder = 2;
      S.add(mesh);
      this.waterLayers[r.id] = mesh;
    }

    this.buildingPos = this.findBuildingSpot();
    this.buildTrees();
    this.buildFences();

    // Boat landing: a small dock from the path out over the water.
    const lp = L.landing;
    const dockLen = Math.max(8, G.dist(lp.pathPoint, lp.waterPoint) + 4);
    const dock = new THREE.Mesh(new THREE.BoxGeometry(6, 0.6, dockLen), lam('#8b6b47'));
    const mid = { x: (lp.pathPoint.x + lp.waterPoint.x) / 2, y: (lp.pathPoint.y + lp.waterPoint.y) / 2 };
    dock.position.copy(w(mid.x, mid.y, 0.6));
    dock.rotation.y = Math.atan2(lp.waterPoint.x - lp.pathPoint.x, lp.waterPoint.y - lp.pathPoint.y);
    dock.userData.ref = { kind: 'landing', id: 'landing' };
    S.add(dock); this.pickables.push(dock);
    dock.receiveShadow = true;

    const deck = new THREE.Group();
    deck.position.copy(dock.position);
    deck.rotation.copy(dock.rotation);
    const wood = lam('#806047');
    const planks = Math.ceil(dockLen / 0.95);
    const plank = new THREE.BoxGeometry(6.15, 0.16, dockLen / planks - 0.045);
    for (let i = 0; i < planks; i++) {
      const board = new THREE.Mesh(plank, wood);
      board.position.set(0, 0.36, dockLen * ((i + 0.5) / planks - 0.5));
      board.receiveShadow = true;
      deck.add(board);
    }
    const railLength = dockLen * 0.67;
    const rail = new THREE.BoxGeometry(0.19, 0.16, railLength);
    const post = new THREE.BoxGeometry(0.27, 2.65, 0.27);
    for (const x of [-2.85, 2.85]) {
      const handrail = new THREE.Mesh(rail, wood);
      handrail.position.set(x, 2.85, -dockLen / 2 + railLength / 2);
      handrail.castShadow = true;
      deck.add(handrail);
      for (let i = 0; i <= 3; i++) {
        const support = new THREE.Mesh(post, wood);
        support.position.set(x, 1.57, -dockLen / 2 + railLength * i / 3);
        support.castShadow = true;
        deck.add(support);
      }
    }
    S.add(deck);
    this.buildShoreReeds(lp);

    // Robot center: a charging pad on the path and a floating dock for skimmers.
    const c = L.center;
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(16, 16, 0.6, 32), lam(COLORS.pad));
    pad.position.copy(w(c.position.x, c.position.y, 0.9));
    pad.userData.ref = { kind: 'center', id: 'center' };
    const ring = new THREE.Mesh(new THREE.RingGeometry(13, 15, 32), new THREE.MeshBasicMaterial({ color: '#facc15', side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.copy(w(c.position.x, c.position.y, 1.25));
    const fdock = new THREE.Mesh(new THREE.BoxGeometry(18, 0.8, 18), lam('#64748b'));
    fdock.position.copy(w(c.dock.x, c.dock.y, 0.2));
    fdock.userData.ref = { kind: 'center', id: 'center' };
    S.add(pad, ring, fdock); this.pickables.push(pad, fdock);
    this.buildCenterBuilding();
    this.buildPathLights();

    // Labels for named places only.
    for (const r of [...L.lawns, L.woods, L.lake]) if (isNamed(r.name)) this.label(r.name, w(r.anchor.x, r.anchor.y, 3));
    this.label('Maintenance gate', w(L.gate.position.x, L.gate.position.y, 8), 'map-label small');
    this.label('Boat landing', w(lp.pathPoint.x, lp.pathPoint.y - 12, 3), 'map-label small');
    this.label('Robot center', w(this.buildingPos.x, this.buildingPos.y, 26), 'map-label small');
    this.label('Skimmer dock', w(c.dock.x, c.dock.y - 16, 3), 'map-label small');
  }

  buildShoreReeds({ position }) {
    const boundary = this.model.layout.lake.boundary;
    const rand = G.mulberry32(467);
    const vertices = [];
    const colors = [];
    const shades = ['#687342', '#9a9b56', '#b0a465'].map(c3);
    for (const [i, a] of boundary.entries()) {
      const b = boundary[(i + 1) % boundary.length];
      const length = G.dist(a, b);
      for (let offset = 1.5; offset < length; offset += 2.4) {
        const x = THREE.MathUtils.lerp(a.x, b.x, offset / length);
        const y = THREE.MathUtils.lerp(a.y, b.y, offset / length);
        const distance = G.dist({ x, y }, position);
        if (distance < 13 || distance > 110 || rand() < 0.42) continue;
        for (let blade = 0; blade < 7; blade++) {
          const angle = rand() * Math.PI * 2;
          const dx = Math.cos(angle), dz = Math.sin(angle);
          const width = 0.05 + rand() * 0.09;
          const height = 0.8 + rand() * 3.1;
          const lean = 0.35 + rand() * 0.9;
          const bx = x + dx * rand(), bz = -y + dz * rand();
          vertices.push(bx - dz * width, 0.12, bz + dx * width,
            bx + dz * width, 0.12, bz - dx * width,
            bx + dx * lean, height, bz + dz * lean);
          const color = shades[Math.floor(rand() * shades.length)];
          colors.push(color.r * 0.55, color.g * 0.55, color.b * 0.55,
            color.r * 0.66, color.g * 0.66, color.b * 0.66, color.r, color.g, color.b);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    this.scene.add(new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({
      vertexColors: true, side: THREE.DoubleSide,
    })));
  }

  buildPathLights() {
    const positions = [];
    for (const { anchor } of this.model.layout.paths) {
      positions.push(anchor.x, 4.8, -anchor.y);
    }
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.12, 'rgba(255,255,255,0.85)');
    gradient.addColorStop(0.45, 'rgba(255,255,255,0.22)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.pathLights = new THREE.Points(geometry, new THREE.PointsMaterial({
      color: '#ffc27a', size: 43, map: new THREE.CanvasTexture(canvas),
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    }));
    this.pathLights.visible = false;
    this.scene.add(this.pathLights);
  }

  // The building stands next to the charging pad, on ground nobody walks on if possible.
  findBuildingSpot() {
    const L = this.model.layout, c = L.center.position;
    let best = null;
    for (let k = 0; k < 16 && !best; k++) {
      const a = Math.PI + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 8);
      const p = { x: c.x + Math.cos(a) * 36, y: c.y + Math.sin(a) * 36 };
      const r = L.regionAt(p);
      if (!r || (r.kind !== 'path' && r.kind !== 'lake')) best = p;
    }
    return best || { x: c.x - 36, y: c.y };
  }

  buildCenterBuilding() {
    const b = this.buildingPos, c = this.model.layout.center.position;
    const lam = (color) => new THREE.MeshLambertMaterial({ color });
    const g = new THREE.Group();
    g.position.copy(w(b.x, b.y, 0.5));
    // Face the screen toward the charging pad.
    g.rotation.y = Math.atan2(c.x - b.x, -(c.y - b.y));
    const walls = new THREE.Mesh(new THREE.BoxGeometry(26, 12, 16), lam('#e2e8f0'));
    walls.position.y = 6;
    const base = new THREE.Mesh(new THREE.BoxGeometry(28, 1, 18), lam('#64748b'));
    base.position.y = 0.5;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(28, 1.2, 18), lam('#334155'));
    roof.position.y = 12.6;
    g.add(walls, base, roof);
    // Solar panels on the roof.
    const panelMat = new THREE.MeshLambertMaterial({ color: '#1e3a8a' });
    for (const x of [-7.5, 0, 7.5]) {
      const pnl = new THREE.Mesh(new THREE.BoxGeometry(6.5, 0.3, 10), panelMat);
      pnl.position.set(x, 14, -1); pnl.rotation.x = -0.35;
      g.add(pnl);
    }
    // Antenna with a light.
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 9, 6), lam('#94a3b8'));
    mast.position.set(10, 17.5, -5);
    this.beacon = new THREE.Mesh(new THREE.SphereGeometry(0.8, 10, 8), new THREE.MeshBasicMaterial({ color: '#ef4444' }));
    this.beacon.position.set(10, 22.4, -5);
    g.add(mast, this.beacon);
    // Garage doors either side of the screen.
    for (const x of [-9.5, 9.5]) {
      const door = new THREE.Mesh(new THREE.BoxGeometry(5.5, 7, 0.3), lam('#94a3b8'));
      door.position.set(x, 4, 8.1);
      g.add(door);
    }
    // The monitor: a live map of every robot, drawn onto a canvas.
    this.screenCanvas = document.createElement('canvas');
    this.screenCanvas.width = 512; this.screenCanvas.height = 300;
    this.screenTex = new THREE.CanvasTexture(this.screenCanvas);
    this.screenTex.colorSpace = THREE.SRGBColorSpace;
    const frame = new THREE.Mesh(new THREE.BoxGeometry(11.6, 7.2, 0.4), lam('#0f172a'));
    frame.position.set(0, 6.6, 8.1);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(10.8, 6.33), new THREE.MeshBasicMaterial({ map: this.screenTex, toneMapped: false }));
    screen.position.set(0, 6.6, 8.32);
    g.add(frame, screen);
    // Clicking anywhere on the building opens the monitor.
    g.traverse((o) => { if (o.isMesh) { o.userData.ref = { kind: 'center', id: 'center', monitor: true }; this.pickables.push(o); } });
    this.scene.add(g);
    this.screenTimer = 1;
    this.updateScreen(1);
  }

  updateScreen(dt) {
    if (!this.screenCanvas) return;
    if (this.beacon) this.beacon.visible = Math.floor(performance.now() / 600) % 2 === 0;
    this.screenTimer += dt;
    if (this.screenTimer < 0.5) return;
    this.screenTimer = 0;
    const ctx = this.screenCanvas.getContext('2d');
    drawRobotMap(ctx, this.model, 512, 300, { pad: 6, labels: false, header: `ROBOTS ${this.model.robots().length} · ${this.model.clock()}` });
    this.screenTex.needsUpdate = true;
  }

  // Where each robot has been, drawn over the map while the monitor is open.
  updateTrails(lakeY) {
    const g = this.trailLines.geometry;
    let k = 0;
    if (this.showTrails || this.night) {
      const pa = g.attributes.position.array, ca = g.attributes.color.array, col = new THREE.Color(), max = pa.length;
      for (const r of this.model.robots()) {
        const tr = r.trail, h = r.kind === 'skimmer' ? lakeY + 0.4 : 1.6;
        col.set(ROBOT_COLORS[r.kind]);
        for (let i = 1; i < tr.length && k + 6 <= max; i++) {
          pa.set([tr[i - 1].x, h, -tr[i - 1].y, tr[i].x, h, -tr[i].y], k);
          const f = 0.25 + 0.75 * (i / tr.length);
          ca.set([col.r * f, col.g * f, col.b * f, col.r * f, col.g * f, col.b * f], k);
          k += 6;
        }
      }
      if (this.night) {
        col.set('#71cfff');
        for (const p of this.model.people) {
          const trail = this.visitorTrails.get(p) || [];
          for (let i = 1; i < trail.length && k + 6 <= max; i++) {
            const start = trail[i - 1], end = trail[i];
            if (Math.hypot(end.x - start.x, end.y - start.y) > 160) continue;
            pa.set([start.x, start.h, -start.y, end.x, end.h, -end.y], k);
            const fade = 0.28 + 0.72 * i / trail.length;
            ca.set([col.r * fade, col.g * fade, col.b * fade, col.r * fade, col.g * fade, col.b * fade], k);
            k += 6;
          }
        }
      }
      g.attributes.position.needsUpdate = true;
      g.attributes.color.needsUpdate = true;
    }
    g.setDrawRange(0, k / 3);
  }

  buildTrees() {
    // Leave room for the robot center building.
    const bp = this.buildingPos;
    const trees = this.model.layout.trees.filter(([x, y, r]) => Math.hypot(x - bp.x, y - bp.y) > 18 + r * 0.6);
    const rand = G.mulberry32(42);
    const trunkGeo = new THREE.CylinderGeometry(0.45, 0.8, 1, 6);
    const crownGeo = new THREE.IcosahedronGeometry(1, 1);
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: '#69513b' }), trees.length);
    const foliage = new THREE.MeshLambertMaterial();
    foliage.onBeforeCompile = (shader) => {
      shader.vertexShader = 'varying vec3 vCanopy;\n' + shader.vertexShader.replace(
        '#include <project_vertex>', 'vCanopy = (instanceMatrix * vec4(transformed, 1.0)).xyz;\n#include <project_vertex>',
      );
      shader.fragmentShader = 'varying vec3 vCanopy;\n' + NOISE +
        shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
          vec2 leaf = vCanopy.xz + vCanopy.y * vec2(0.73, 1.3);
          float grain = mix(noise(leaf * 0.58), 0.5, smoothstep(0.3, 2.5, length(fwidth(leaf))));
          diffuseColor.rgb *= 0.8 + grain * 0.42;
        `);
    };
    const crowns = new THREE.InstancedMesh(crownGeo, foliage, trees.length * 4);
    const needles = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 9), foliage, Math.ceil(trees.length / 11) * 4);
    needles.castShadow = true;
    needles.receiveShadow = true;
    let broadleafCount = 0, evergreenCount = 0;
    crowns.castShadow = true;
    crowns.receiveShadow = true;
    const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion();
    const size = new THREE.Vector3(), angles = new THREE.Euler();
    const greens = ['#31583a', '#3c693b', '#50743e', '#65834a', '#788e45'].map(c3);
    const color = new THREE.Color(), upAxis = new THREE.Vector3(0, 1, 0);
    trees.forEach(([x, y, radius], i) => {
      const height = 15 + radius * (1.2 + rand() * 0.55);
      const spread = Math.max(5, radius * (0.68 + rand() * 0.22));
      const green = greens[Math.floor(rand() * greens.length)];
      rotation.identity();
      matrix.compose(w(x, y, height * 0.35), rotation, size.set(1.6, height * 0.7, 1.6));
      trunks.setMatrixAt(i, matrix);
      const bearing = rand() * Math.PI * 2;
      if (i % 11 === 0) {
        rotation.setFromAxisAngle(upAxis, bearing);
        for (let tier = 0; tier < 4; tier++) {
          const width = spread * (0.75 - tier * 0.13);
          matrix.compose(w(x, y, height * (0.43 + tier * 0.19)),
            rotation, size.set(width, height * 0.48, width));
          needles.setMatrixAt(evergreenCount, matrix);
          needles.setColorAt(evergreenCount++, color.set('#355345').offsetHSL(0, 0, tier * 0.029));
        }
        return;
      }
      for (let lobe = 0; lobe < 4; lobe++) {
        const central = lobe === 0;
        const angle = bearing + lobe * Math.PI * 2 / 3;
        const offset = central ? 0 : spread * 0.53;
        const width = spread * (central ? 0.78 : 0.53 + rand() * 0.15);
        const top = height * (central ? 0.94 : 0.67 + rand() * 0.17);
        rotation.setFromEuler(angles.set(rand() * 0.4, angle, rand() * 0.4));
        matrix.compose(w(x + Math.cos(angle) * offset, y + Math.sin(angle) * offset, top),
          rotation, size.set(width, width * (0.77 + rand() * 0.47), width));
        const index = broadleafCount++;
        crowns.setMatrixAt(index, matrix);
        crowns.setColorAt(index, color.copy(green).offsetHSL(0, 0, (rand() - 0.5) * 0.09));
      }
    });
    this.trees = new THREE.Group();
    crowns.count = broadleafCount;
    needles.count = evergreenCount;
    this.trees.add(trunks, crowns, needles);
    this.scene.add(this.trees);
  }
  setTreesVisible(v) {
    this.trees.visible = v;
    this.renderer.shadowMap.needsUpdate = true;
  }

  // Fences are instanced: posts and two rails per intact segment, red cones
  // at both ends of a broken one, and an invisible box per segment for clicks.
  buildFences() {
    const L = this.model.layout, n = L.fences.length;
    const inst = (geo, mat, count) => { const im = new THREE.InstancedMesh(geo, mat, count); im.frustumCulled = false; this.scene.add(im); return im; };
    const wood = new THREE.MeshLambertMaterial({ color: COLORS.fenceWood });
    this.fRails = inst(new THREE.BoxGeometry(1, 0.35, 0.3), wood, n * 2);
    this.fPosts = inst(new THREE.BoxGeometry(0.6, 3.6, 0.6), wood, n * 6);
    this.fCones = inst(new THREE.ConeGeometry(1.2, 3.4, 8), new THREE.MeshLambertMaterial({ color: COLORS.broken }), n * 2);
    this.fProxy = inst(new THREE.BoxGeometry(1, 6, 4), new THREE.MeshBasicMaterial({ visible: false }), n);
    this.fProxy.userData.refs = L.fences.map((f) => ({ kind: 'fence', id: f.id }));
    this.pickables.unshift(this.fProxy);
    this.fenceGeom = L.fences.map((f) => {
      const len = G.dist(f.a, f.b), ang = Math.atan2(f.b.y - f.a.y, f.b.x - f.a.x);
      return { len, ang, mid: { x: (f.a.x + f.b.x) / 2, y: (f.a.y + f.b.y) / 2 }, f };
    });
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
    this.fenceGeom.forEach((g, i) => {
      Q.setFromAxisAngle(Y, g.ang);
      M.compose(w(g.mid.x, g.mid.y, 3.5), Q, V.set(g.len, 1, 1)); this.fProxy.setMatrixAt(i, M);
    });
    this.fenceState = new Array(n).fill(null);

    // Maintenance gate: stone piers with a green gate between them.
    const gt = L.gate, gg = new THREE.Group();
    gg.position.copy(w(gt.position.x, gt.position.y, 0.5));
    gg.rotation.y = Math.atan2(gt.b.y - gt.a.y, gt.b.x - gt.a.x);
    const gl = G.dist(gt.a, gt.b);
    const stone = new THREE.MeshLambertMaterial({ color: '#9ca3af' });
    for (const x of [-gl / 2, gl / 2]) { const pier = new THREE.Mesh(new THREE.BoxGeometry(1.6, 6, 1.6), stone); pier.position.set(x, 3, 0); gg.add(pier); }
    const bar = new THREE.Mesh(new THREE.BoxGeometry(gl - 1.6, 3.4, 0.3), new THREE.MeshLambertMaterial({ color: '#15803d' }));
    bar.position.set(0, 2.2, 0);
    gg.add(bar);
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(gl + 4, 7, 5), new THREE.MeshBasicMaterial({ visible: false }));
    proxy.position.y = 3; proxy.userData.ref = { kind: 'gate', id: 'gate' };
    gg.add(proxy); this.pickables.unshift(proxy);
    this.scene.add(gg);
  }

  updateFences() {
    const fences = this.model.fences;
    let dirty = false;
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 0), P = new THREE.Vector3();
    fences.forEach((f, i) => {
      if (this.fenceState[i] === f.status) return;
      this.fenceState[i] = f.status;
      dirty = true;
      const g = this.fenceGeom[i], intact = f.status === 'intact';
      const dx = Math.cos(g.ang), dy = Math.sin(g.ang);
      Q.setFromAxisAngle(Y, g.ang);
      for (const [k, h] of [[0, 1.4], [1, 2.9]]) {
        M.compose(w(g.mid.x, g.mid.y, h + 0.5), Q, intact ? V.set(g.len, 1, 1) : Z); this.fRails.setMatrixAt(i * 2 + k, M);
      }
      for (let k = 0; k < 6; k++) {
        const t = k / 5 - 0.5;
        M.compose(P.copy(w(g.mid.x + dx * g.len * t, g.mid.y + dy * g.len * t, 2.3)), Q, intact ? V.set(1, 1, 1) : Z); this.fPosts.setMatrixAt(i * 6 + k, M);
      }
      for (const [k, t] of [[0, -0.45], [1, 0.45]]) {
        M.compose(P.copy(w(g.mid.x + dx * g.len * t, g.mid.y + dy * g.len * t, 2.2)), Q, intact ? Z : V.set(1, 1, 1)); this.fCones.setMatrixAt(i * 2 + k, M);
      }
    });
    if (dirty) for (const im of [this.fRails, this.fPosts, this.fCones]) im.instanceMatrix.needsUpdate = true;
  }

  // ---------- dynamic layers ----------
  buildDynamicLayers() {
    const S = this.scene, L = this.model.layout, B = L.bounds;
    // Duckweed cells.
    const cells = L.grid.cells;
    const patch = new THREE.CircleGeometry(L.grid.CELL * 0.59, 9);
    patch.rotateX(-Math.PI / 2);
    this.duck = new THREE.InstancedMesh(patch, new THREE.MeshLambertMaterial({ color: '#ffffff', polygonOffset: true, polygonOffsetFactor: -1 }), cells.length);
    const rand = G.mulberry32(9), col = new THREE.Color();
    this.duckOffsets = cells.map((_, i) => {
      this.duck.setColorAt(i, col.set(COLORS.duckweed).offsetHSL((rand() - 0.5) * 0.04, 0, (rand() - 0.5) * 0.1));
      return [(rand() - 0.5) * L.grid.CELL * 0.44, (rand() - 0.5) * L.grid.CELL * 0.44];
    });
    this.duck.renderOrder = 1;
    S.add(this.duck);

    // Rain streaks over the whole map.
    const N = 9000, pos = new Float32Array(N * 6);
    this.rainSeed = [];
    for (let i = 0; i < N; i++) {
      this.rainSeed.push([B.x0 + Math.random() * (B.x1 - B.x0), Math.random() * 300, -(B.y0 + Math.random() * (B.y1 - B.y0))]);
    }
    this.rainGeo = new THREE.BufferGeometry();
    this.rainGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.rain = new THREE.LineSegments(this.rainGeo, new THREE.LineBasicMaterial({ color: '#dbeafe', transparent: true, opacity: 0.55 }));
    this.rain.frustumCulled = false;
    S.add(this.rain);

    // Leashes, wakes and robot target lines are rebuilt each frame.
    const lineLayer = (color, opts = {}) => {
      const g = new THREE.BufferGeometry(), n = opts.segments || 4000;
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 2 * n), 3));
      if (opts.vertexColors) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(3 * 2 * n), 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: opts.opacity ?? 1, vertexColors: !!opts.vertexColors, depthTest: opts.depthTest ?? true }));
      l.frustumCulled = false;
      l.renderOrder = 3;
      S.add(l);
      return l;
    };
    this.leashes = lineLayer('#1f2937', { opacity: 0.85 });
    this.wakes = lineLayer('#ffffff', { opacity: 0.85 });
    this.targets = lineLayer('#ffffff', { vertexColors: true, opacity: 0.9, depthTest: false });
    this.trailLines = lineLayer('#ffffff', { vertexColors: true, opacity: 0.85, depthTest: false, segments: 20000 });
    this.showTrails = false;

    // Selection marker.
    this.selRing = new THREE.Mesh(new THREE.RingGeometry(2.4, 3.1, 32), new THREE.MeshBasicMaterial({ color: COLORS.select, side: THREE.DoubleSide, depthTest: false, transparent: true }));
    this.selRing.rotation.x = -Math.PI / 2;
    this.selRing.renderOrder = 5;
    this.selRing.visible = false;
    S.add(this.selRing);
    this.selOutline = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: COLORS.select, depthTest: false, transparent: true }));
    this.selOutline.renderOrder = 5;
    this.selOutline.visible = false;
    S.add(this.selOutline);

    this.geo = {
      torso: new THREE.CapsuleGeometry(0.55, 1.15, 3, 8),
      head: new THREE.SphereGeometry(0.41, 12, 8),
      limb: new THREE.CapsuleGeometry(0.24, 1.63, 2, 6),
      dogBody: new THREE.BoxGeometry(2, 0.9, 0.85),
      dogHead: new THREE.BoxGeometry(0.75, 0.7, 0.7),
      litter: new THREE.IcosahedronGeometry(0.6, 0),
      poop: new THREE.SphereGeometry(0.5, 8, 6),
      hole: new THREE.CircleGeometry(1, 16).rotateX(-Math.PI / 2),
      battery: new THREE.BoxGeometry(1, 0.35, 0.35),
    };
    this.mats = {
      skin: new THREE.MeshLambertMaterial({ color: COLORS.skin }),
      trousers: new THREE.MeshLambertMaterial({ color: '#263647' }),
      dog: new THREE.MeshLambertMaterial({ color: COLORS.dog }),
      activity: Object.fromEntries(['walking', 'standing', 'sitting', 'boating'].map((a) => [a, new THREE.MeshLambertMaterial({ color: COLORS[a] })])),
      litter: COLORS.litter.map((c) => new THREE.MeshBasicMaterial({ color: c })),
      poop: new THREE.MeshLambertMaterial({ color: COLORS.poop }),
      hole: new THREE.MeshBasicMaterial({ color: COLORS.hole }),
    };
  }

  makePerson() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(this.geo.torso, this.mats.activity.walking);
    const head = new THREE.Mesh(this.geo.head, this.mats.skin);
    head.scale.y = 1.15;
    const arms = [], legs = [];
    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(this.geo.limb, this.mats.activity.walking);
      arm.scale.set(0.84, 0.93, 0.84);
      arm.rotation.x = side * 0.1;
      const leg = new THREE.Mesh(this.geo.limb, this.mats.trousers);
      legs.push(leg);
      arms.push(arm);
    }
    g.add(body, head, ...arms, ...legs);
    Object.assign(g.userData, { body, head, arms, legs, base: 1 });
    return g;
  }
  makeDog() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(this.geo.dogBody, this.mats.dog); body.position.y = 1.0;
    const head = new THREE.Mesh(this.geo.dogHead, this.mats.dog); head.position.set(1.15, 1.45, 0);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.15, 0.15), this.mats.dog); tail.position.set(-1.2, 1.4, 0); tail.rotation.z = 0.6;
    const legs = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 0.6), this.mats.dog); legs.position.y = 0.3;
    g.add(body, head, tail, legs);
    g.userData.base = 1.15;
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
    const g = new THREE.Group();
    g.add(hull, stripe, seat);
    g.userData.base = 1;
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
    } else if (kind === 'steward') {
      const body = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.3, 2.6, 16), lam(COLORS.steward)); body.position.y = 1.3;
      const dome = new THREE.Mesh(new THREE.SphereGeometry(1.1, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), lam('#99f6e4')); dome.position.y = 2.6;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(2, 0.3, 0.3), lam('#334155')); arm.position.set(1.3, 1.8, 0); arm.rotation.z = -0.5;
      g.add(body, dome, arm);
    } else {
      const pont = new THREE.CylinderGeometry(0.5, 0.5, 4.4, 10);
      for (const z of [-1.3, 1.3]) { const p = new THREE.Mesh(pont, lam(COLORS.skimmer)); p.rotation.z = Math.PI / 2; p.position.set(0, 0.4, z); g.add(p); }
      const deck = new THREE.Mesh(new THREE.BoxGeometry(3, 0.3, 3), lam('#1f2937')); deck.position.y = 0.9;
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 2, 6), lam('#1f2937')); mast.position.y = 1.9;
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), new THREE.MeshBasicMaterial({ color: '#fde047' })); lamp.position.y = 3;
      g.add(deck, mast, lamp);
    }
    // Battery bar above the robot: green to red.
    const bar = new THREE.Mesh(this.geo.battery, new THREE.MeshBasicMaterial({ color: '#22c55e' }));
    bar.position.y = 4.2;
    g.add(bar);
    g.userData.battery = bar;
    g.userData.base = 1.1;
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
      o.scale.setScalar((o.userData.base || 1) * (o.userData.fixed ? 1 : this.entityScale));
      update(e, o, dt);
      o.userData.fresh = false;
    }
    return seen;
  }
  ease(o, target, dt, heading) {
    if (o.userData.fresh || o.position.distanceTo(target) > 60) o.position.copy(target);
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
    const camDist = this.camera.position.distanceTo(this.controls.target);
    this.entityScale = THREE.MathUtils.clamp(1 + (camDist - 300) / 3300, 1, 1.85);
    const wet = rain === 'heavy' ? 1 : rain === 'light' ? 0.5 : 0;
    this.scene.background.copy(this.night ? this.sky.night : this.sky.dry);
    if (!this.night) this.scene.background.lerp(this.sky.wet, wet);
    this.scene.fog.color.copy(this.scene.background);
    this.sun.intensity = this.night ? 0.36 - wet * 0.1 : 2.15 - wet * 1.15;
    this.hemi.intensity = this.night ? 0.8 : 1.5;
    this.hemi.color.set(this.night ? '#a3bcf3' : '#e1efff');
    this.hemi.groundColor.set(this.night ? '#35434c' : '#8b7c50');
    this.pathMaterial.emissiveIntensity = this.night ? 0.38 : 0;
    this.lakeWater.material.emissive.set(this.night ? '#155073' : '#000000');
    this.pathLights.visible = this.night;
    this.lakeTime.value = (this.lakeTime.value + dt) % 10000;

    // Lawns: grass color by height, brown wear patches, hatching for closed/reseeding.
    const short = c3(COLORS.grassShort), tall = c3(COLORS.grassTall);
    const mess = new Map();
    for (const l of m.litter) mess.set(l.location, (mess.get(l.location) || 0) + 1);
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
      if (l.status === 'reseeding') badges.push(l.pendingReseed ? 'Closing to reseed' : `Reseeding · ${l.reseedTimer}m`);
      if (l.wear > RULES.NEEDS_RESEEDING && l.status !== 'reseeding') badges.push('Reseed');
      if (l.grassHeight > RULES.NEEDS_MOWING && l.status !== 'reseeding') badges.push('Mow');
      const el = mesh.userData.badge.element;
      el.textContent = badges.join(' · ');
      el.style.display = badges.length ? '' : 'none';
    }
    const wu = this.regionMeshes.woods.material.userData.u;
    wu.uAmount.value = 0.08 + (m.woods.weedCover / 100) * 0.9;

    for (const r of [...m.paths, ...m.lawns]) {
      const layer = this.waterLayers[r.id];
      layer.visible = r.standingWater > 0.02;
      if (!layer.visible) continue;
      layer.material.opacity = Math.min(0.82, 0.12 + r.standingWater / 9);
      layer.position.y = REGION_TOP[r.kind] + 0.1 + Math.min(r.standingWater, 12) * 0.05;
    }
    const wy = waterY(m.lake.waterLevel);
    this.lakeWater.position.y += (wy - this.lakeWater.position.y) * (1 - Math.exp(-dt * 6));
    const lakeY = this.lakeWater.position.y;

    // Duckweed: each cell is drawn as a patch sized by its cover.
    const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), P = new THREE.Vector3();
    const cells = m.layout.grid.cells;
    for (let i = 0; i < cells.length; i++) {
      const v = m.duckweed[i];
      const s = v < 1 ? 0.0001 : 0.12 + 0.9 * Math.sqrt(v / 100);
      const [dx, dz] = this.duckOffsets[i];
      M4.compose(P.set(cells[i].x + dx, lakeY + 0.05, -cells[i].y + dz), Q, V.set(s, 1, s));
      this.duck.setMatrixAt(i, M4);
    }
    this.duck.instanceMatrix.needsUpdate = true;
    this.updateFences();

    // Rain.
    const count = rain === 'heavy' ? 9000 : rain === 'light' ? 2600 : 0;
    const arr = this.rainGeo.attributes.position.array;
    for (let i = 0; i < count; i++) {
      const s = this.rainSeed[i];
      s[1] -= dt * 260;
      if (s[1] < 0) s[1] += 300;
      arr[i * 6] = s[0]; arr[i * 6 + 1] = s[1]; arr[i * 6 + 2] = s[2];
      arr[i * 6 + 3] = s[0] + 1.5; arr[i * 6 + 4] = s[1] + 9; arr[i * 6 + 5] = s[2];
    }
    this.rainGeo.setDrawRange(0, count * 2);
    this.rainGeo.attributes.position.needsUpdate = true;

    // Entities.
    const alive = new Set();
    const add = (set) => set.forEach((id) => alive.add(id));
    const topOf = (loc) => REGION_TOP[m.byId[loc]?.kind] ?? 0.6;
    add(this.syncEntities(m.boats, () => this.makeBoat(), (b, o, d) => this.ease(o, w(b.x, b.y, lakeY + 0.3), d, b.heading), dt));
    add(this.syncEntities(m.people, () => this.makePerson(), (p, o, d) => {
      const { body, head, arms, legs } = o.userData;
      body.material = this.mats.activity[p.activity];
      const sit = p.activity === 'sitting' || p.activity === 'boating';
      body.position.y = sit ? 2.32 : 3.63;
      head.position.y = sit ? 3.79 : 5.1;
      for (const [i, side] of [-1, 1].entries()) {
        arms[i].material = body.material;
        arms[i].position.set(sit ? 0.38 : 0, sit ? 2.25 : 3.62, side * 0.7);
        arms[i].rotation.z = sit ? -0.45 : 0;
        legs[i].position.set(sit ? 0.83 : 0, sit ? 1.15 : 1.46, side * 0.3);
        legs[i].rotation.z = sit ? -Math.PI * 0.42 : 0;
      }
      let x = p.x, y = p.y, h = topOf(p.location), heading = p.heading;
      if (p.activity === 'boating') {
        const b = m.boat(p.boatId);
        if (b) {
          const off = (p.seat ? -2.2 : 1.6);
          x = b.x + Math.cos(b.heading) * off; y = b.y + Math.sin(b.heading) * off; h = lakeY + 0.6; heading = b.heading;
          o.scale.setScalar(o.userData.base);
        }
      }
      this.ease(o, w(x, y, h), d, heading);

      // Keep a short display history by simulation minute, independent of camera movement.
      let trail = this.visitorTrails.get(p);
      if (!trail) { trail = []; this.visitorTrails.set(p, trail); }
      if (trail.at(-1)?.time !== m.time) {
        trail.push({ x, y, h: h + 0.6, time: m.time });
        if (trail.length > 45) trail.shift();
      }
    }, dt));
    add(this.syncEntities(m.dogs, () => this.makeDog(), (dg, o, d) => {
      const own = m.person(dg.ownerId);
      const hd = own ? Math.atan2(own.y - dg.y, own.x - dg.x) : 0;
      this.ease(o, w(dg.x, dg.y, topOf(dg.location)), d, hd);
    }, dt));
    add(this.syncEntities(m.litter, (l) => {
      let o;
      if (l.type === 'poop') o = new THREE.Mesh(this.geo.poop, this.mats.poop);
      else if (l.type === 'hole') o = new THREE.Mesh(this.geo.hole, this.mats.hole);
      else o = new THREE.Mesh(this.geo.litter, this.mats.litter[parseInt(l.id.slice(1), 10) % this.mats.litter.length]);
      o.userData.base = l.type === 'hole' ? 2 : 1.6;
      return o;
    }, (l, o, d) => {
      const h = l.location === 'lake' ? lakeY + 0.35 : topOf(l.location) + (l.type === 'hole' ? 0.08 : 0.5);
      this.ease(o, w(l.x, l.y, h), d);
      if (l.type !== 'hole') o.rotation.y += d;
    }, dt));
    // Robots parked or charging at the center line up side by side.
    const slots = { land: 0, lake: 0 };
    for (const list of [m.mowers, m.stewards, m.skimmers]) {
      add(this.syncEntities(list, (r) => this.makeRobot(r.kind), (r, o, d) => {
        const prev = o.userData.last || { x: r.x, y: r.y };
        const moved = Math.hypot(r.x - prev.x, r.y - prev.y) > 0.05;
        if (moved) o.userData.heading = Math.atan2(r.y - prev.y, r.x - prev.x);
        o.userData.last = { x: r.x, y: r.y };
        let x = r.x, y = r.y;
        if (r.state === 'docked' || r.state === 'charging') {
          const k = r.kind === 'skimmer' ? slots.lake++ : slots.land++;
          const a = k * 0.9;
          x += Math.cos(a) * (k ? 9 : 0); y += Math.sin(a) * (k ? 9 : 0);
        }
        const h = r.kind === 'skimmer' ? lakeY + 0.1 : topOf(r.location);
        this.ease(o, w(x, y, h), d, o.userData.heading ?? 0);
        const bar = o.userData.battery;
        bar.scale.x = Math.max(0.05, r.battery / 100) * 3;
        bar.material.color.setHSL((r.battery / 100) * 0.33, 0.8, 0.45);
        bar.rotation.y = -o.rotation.y;
        bar.visible = selection?.id === r.id || this.showTrails;
      }, dt));
    }
    for (const [id, o] of this.meshes) if (!alive.has(id)) { this.scene.remove(o); this.meshes.delete(id); }

    this.updateLines(lakeY, selection);
    this.updateTrails(lakeY);
    this.updateScreen(dt);
    this.knowledge.update(dt, selection, this.entityScale);
    this.updateSelection(selection, lakeY);
  }

  updateLines(lakeY, selection) {
    const m = this.model;
    // Leashes: owner's hand to dog's collar, using the eased mesh positions.
    let k = 0;
    const la = this.leashes.geometry.attributes.position.array;
    for (const d of m.dogs) {
      const om = this.meshes.get(d.ownerId), dm = this.meshes.get(d.id);
      if (!om || !dm) continue;
      la.set([om.position.x, om.position.y + 2.8 * om.scale.y, om.position.z, dm.position.x, dm.position.y + 1.6 * dm.scale.y, dm.position.z], k); k += 6;
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
      for (const [len, ang] of [[28, 0.36], [16, 0.22]]) {
        for (const side of [-1, 1]) {
          const a = h + Math.PI + side * ang;
          wa.set([sx, lakeY + 0.15, -sy, sx + Math.cos(a) * len, lakeY + 0.15, -(sy + Math.sin(a) * len)], k); k += 6;
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
      if (this.night && selection?.id !== r.id) continue;
      const rm = this.meshes.get(r.id);
      const tp = this.targetPoint(r, lakeY);
      if (!rm || !tp) continue;
      col.set(COLORS[r.kind]);
      ta.set([rm.position.x, rm.position.y + 2 * rm.scale.y, rm.position.z, tp.x, tp.y, tp.z], k);
      tc.set([col.r, col.g, col.b, col.r, col.g, col.b], k); k += 6;
    }
    this.targets.geometry.setDrawRange(0, k / 3);
    this.targets.geometry.attributes.position.needsUpdate = true;
    this.targets.geometry.attributes.color.needsUpdate = true;
  }

  targetPoint(r, lakeY) {
    const m = this.model;
    if (r.state === 'returning') { const h = m.home(r); return w(h.x, h.y, 2); }
    if (r.kind === 'mower' && r.targetLawn) { const l = m.byId[r.targetLawn]; return w(l.anchor.x, l.anchor.y, 1); }
    if (r.kind === 'steward' && r.target) {
      if (r.target.type === 'fence') { const f = m.fences.find((x) => x.id === r.target.id); return w((f.a.x + f.b.x) / 2, (f.a.y + f.b.y) / 2, 2); }
      if (r.target.type === 'woods') { const p = r.route.length ? r.route[r.route.length - 1] : r; return w(p.x, p.y, 1); }
      const l = m.litter.find((x) => x.id === r.target.id); return l ? w(l.x, l.y, l.location === 'lake' ? lakeY + 0.3 : 0.8) : null;
    }
    if (r.kind === 'skimmer' && r.target) {
      if (r.target.type === 'litter') { const l = m.litter.find((x) => x.id === r.target.id); return l ? w(l.x, l.y, lakeY + 0.3) : null; }
      const c = m.layout.grid.cells[r.target.id]; return w(c.x, c.y, lakeY + 0.1);
    }
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
      this.selRing.position.set(o.position.x, Math.max(o.position.y, 0.6) + 0.2, o.position.z);
      const s = sel.kind === 'boat' ? 2.4 : sel.kind === 'litter' ? 0.8 : 1;
      this.selRing.scale.setScalar(s * this.entityScale);
      return;
    }
    if (this.selFor === sel.id && this.selOutline.geometry.attributes.position) { this.selOutline.visible = true; this.selOutline.position.y = e.kind === 'lake' ? lakeY : 0; return; }
    let geo = null;
    const segs = (pts, h) => new THREE.BufferGeometry().setFromPoints([w(pts[0].x, pts[0].y, h), w(pts[1].x, pts[1].y, h)]);
    if (e.polygons) geo = ringLines(e.polygons, e.kind === 'lake' ? 0.3 : (REGION_TOP[e.kind] || 0) + 0.3);
    else if (e.kind === 'fence') geo = segs([e.a, e.b], 5);
    else if (e.kind === 'gate') geo = segs([e.a, e.b], 7);
    else if (e.kind === 'landing') geo = segs([e.pathPoint, e.waterPoint], 1.5);
    else if (e.kind === 'center') { const c = e.position, pts = []; for (let i = 0; i < 32; i++) { const a = (i / 32) * Math.PI * 2, b = ((i + 1) / 32) * Math.PI * 2; pts.push(w(c.x + Math.cos(a) * 18, c.y + Math.sin(a) * 18, 1.5), w(c.x + Math.cos(b) * 18, c.y + Math.sin(b) * 18, 1.5)); } geo = new THREE.BufferGeometry().setFromPoints(pts); }
    if (!geo) return;
    this.selOutline.geometry.dispose();
    this.selOutline.geometry = geo;
    this.selFor = sel.id;
    this.selOutline.position.y = e.kind === 'lake' ? lakeY : 0;
    this.selOutline.visible = true;
  }

  // Click picking: nearest small entity on screen, else the region/fence under the cursor.
  pick(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const sx = clientX - rect.left, sy = clientY - rect.top;
    let best = null, bd = 16;
    const v = new THREE.Vector3();
    for (const [, o] of this.meshes) {
      v.copy(o.position); v.y += 1.5 * o.scale.y;
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
    if (!hits.length) return null;
    const h = hits[0];
    if (h.object === this.fProxy) return this.fProxy.userData.refs[h.instanceId];
    return h.object.userData.ref;
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
