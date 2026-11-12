// Drawing what agents know: one agent's map, cone of vision, landmarks and
// the others it has seen, plus park-wide overlays of what all agents share.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { K } from './mind.js';

const w = (x, y, h = 0) => new THREE.Vector3(x, h, -y);

export const OVERLAYS = {
  off: 'No overlay',
  agent: "Selected agent's map",
  paths: 'Where everyone walked',
  landmarks: 'Where landmarks were left',
  shared: 'What visitors know (shared)',
  fleet: 'What the robot fleet knows',
};

export const LANDMARK_COLORS = {
  start: '#ffffff', place: '#22c55e', hindrance: '#ef4444', issue: '#f97316', affordance: '#facc15', patrol: '#a78bfa',
};
const OTHER_COLORS = { person: '#38bdf8', dog: '#a16207', mower: '#f59e0b', steward: '#8b5cf6', skimmer: '#06b6d4', boat: '#e5e7eb' };

// Color ramps for the heatmaps, from 0..1.
const ramp = (stops) => (t) => {
  t = Math.max(0, Math.min(1, t));
  const i = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
  const f = t * (stops.length - 1) - i, a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
};
const HEAT = ramp([[253, 141, 60], [240, 59, 32], [189, 0, 38], [90, 0, 30]]);
const MARKS = ramp([[158, 154, 200], [128, 90, 190], [106, 30, 150], [60, 0, 90]]);
const SHARE = ramp([[65, 182, 196], [29, 145, 192], [34, 94, 168], [12, 44, 132]]);

export class KnowledgeLayer {
  constructor(scene, model) {
    this.scene = scene;
    this.model = model;
    this.mode = 'off';
    const L = model.layout, fm = model.fleet.mind;
    this.cols = fm.cols; this.rows = fm.rows;
    this.data = new Uint8Array(this.cols * this.rows * 4);
    this.tex = new THREE.DataTexture(this.data, this.cols, this.rows, THREE.RGBAFormat);
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.needsUpdate = true;
    const W = this.cols * L.cell * 2, H = this.rows * L.cell * 2;
    this.plane = new THREE.Mesh(
      new THREE.PlaneGeometry(W, H).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, depthTest: false }),
    );
    this.plane.position.copy(w(L.x0 + W / 2, L.y0 + H / 2, 2.5));
    this.plane.renderOrder = 2;
    this.plane.visible = false;
    scene.add(this.plane);

    const lines = (n, opts = {}) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 6), 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 6), 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: opts.opacity ?? 1, depthTest: false }));
      l.frustumCulled = false;
      l.renderOrder = 4;
      scene.add(l);
      return l;
    };
    this.cone = lines(80, { opacity: 0.95 });
    this.pins = lines(400);
    this.route = lines(1200, { opacity: 0.8 });
    this.labels = [];
    this.buildSignposts();
    this.t = 0;
    this.lastKey = '';
  }

  buildSignposts() {
    const m = this.model;
    this.signs = new THREE.Group();
    const post = new THREE.CylinderGeometry(0.25, 0.25, 7, 6), board = new THREE.BoxGeometry(3.2, 1.1, 0.25);
    const wood = new THREE.MeshLambertMaterial({ color: '#7c5a3a' }), face = new THREE.MeshLambertMaterial({ color: '#166534' });
    for (const sp of m.allSignposts || []) {
      const g = new THREE.Group();
      const p = new THREE.Mesh(post, wood); p.position.y = 3.5; g.add(p);
      for (const [i, pt] of sp.points.slice(0, 3).entries()) {
        const b = new THREE.Mesh(board, face);
        b.position.y = 6.3 - i * 1.3;
        b.rotation.y = Math.atan2(pt.y - sp.y, pt.x - sp.x);
        b.translateX(1.4);
        g.add(b);
      }
      g.position.copy(w(sp.x, sp.y, 0.8));
      g.userData.ref = { kind: 'signpost', id: sp.id };
      this.signs.add(g);
    }
    this.scene.add(this.signs);
  }

  setMode(mode) { this.mode = mode; this.lastKey = ''; }

  label(i) {
    if (!this.labels[i]) {
      const el = document.createElement('div');
      el.className = 'lm-label';
      const o = new CSS2DObject(el);
      this.scene.add(o);
      this.labels[i] = o;
    }
    return this.labels[i];
  }

  agentOf(sel) {
    if (!sel) return null;
    const e = this.model.get(sel.id);
    return e && e.mind ? e : null;
  }

  update(dt, sel, scale) {
    const agent = this.agentOf(sel);
    this.t += dt;
    const key = `${this.mode}|${agent ? agent.id : ''}`;
    if (key !== this.lastKey || this.t > 0.4) { this.t = 0; this.lastKey = key; this.paint(agent); }
    this.drawCone(agent, scale);
    this.drawAgentExtras(this.mode === 'agent' ? agent : null, scale);
    const up = new Set(this.model.signposts.map((sp) => sp.id));
    this.signs.children.forEach((g) => { g.visible = up.has(g.userData.ref.id); g.scale.setScalar(Math.min(3, scale)); });
  }

  // Fill the overlay texture for the current mode.
  paint(agent) {
    const m = this.model, d = this.data, n = this.cols * this.rows;
    d.fill(0);
    let show = true;
    if (this.mode === 'agent' || this.mode === 'fleet') {
      const mind = this.mode === 'fleet' ? m.fleet.mind : agent && agent.mind;
      if (!mind) show = false;
      else {
        const now = m.time;
        for (let k = 0; k < n; k++) {
          const v = mind.seen[k], o = k * 4;
          if (v === K.UNKNOWN) { d[o] = 24; d[o + 1] = 30; d[o + 2] = 42; d[o + 3] = 175; continue; }
          const fresh = now - mind.seenAt[k] <= 1;
          if (v === K.BLOCKED) { d[o] = 220; d[o + 1] = 60; d[o + 2] = 60; d[o + 3] = 150; } else if (v === K.WATER) { d[o] = 60; d[o + 1] = 130; d[o + 2] = 235; d[o + 3] = 90; } else { d[o] = 255; d[o + 1] = 255; d[o + 2] = 255; d[o + 3] = 18; }
          if (fresh && this.mode === 'agent') { d[o] = 255; d[o + 1] = 230; d[o + 2] = 90; d[o + 3] = 120; }
        }
      }
    } else if (this.mode === 'paths' || this.mode === 'landmarks') {
      let src = this.mode === 'paths' ? m.heat : m.lmHeat;
      if (this.mode === 'landmarks') src = this.blur(src, 3);
      let max = 0;
      for (let k = 0; k < n; k++) if (src[k] > max) max = src[k];
      const lm = Math.log1p(max || 1), f = this.mode === 'paths' ? HEAT : MARKS;
      for (let k = 0; k < n; k++) {
        if (!src[k]) continue;
        const t = Math.log1p(src[k]) / lm, c = f(t), o = k * 4;
        d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = this.mode === 'paths' ? 150 + t * 105 : 30 + t * 225;
      }
    } else if (this.mode === 'shared') {
      const minds = m.people.filter((p) => p.mind && p.plan).map((p) => p.mind.seen);
      if (!minds.length) show = false;
      const cnt = new Uint16Array(n);
      for (const s of minds) for (let k = 0; k < n; k++) if (s[k]) cnt[k]++;
      for (let k = 0; k < n; k++) {
        if (!cnt[k]) continue;
        const t = cnt[k] / minds.length, c = SHARE(Math.sqrt(t)), o = k * 4;
        d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 120 + Math.sqrt(t) * 135;
      }
    } else show = false;
    this.plane.visible = show;
    this.tex.needsUpdate = true;
  }

  blur(src, r) {
    const { cols, rows } = this, out = new Float32Array(src.length);
    for (let k = 0; k < src.length; k++) {
      const v = src[k];
      if (!v) continue;
      const col = k % cols, row = (k - col) / cols;
      for (let dr = -r; dr <= r; dr++) for (let dc = -r; dc <= r; dc++) {
        const c = col + dc, rr = row + dr;
        const f = 1 - Math.hypot(dr, dc) / (r + 1);
        if (c < 0 || rr < 0 || c >= cols || rr >= rows || f <= 0) continue;
        out[rr * cols + c] += v * f;
      }
    }
    return out;
  }

  // The selected agent's cone of vision.
  drawCone(agent, scale) {
    const g = this.cone.geometry, pa = g.attributes.position.array, ca = g.attributes.color.array;
    let k = 0;
    const cone = agent && agent.mind.cone;
    if (cone && this.model.time - cone.t <= 3) {
      const h = 3, fov = (cone.fov * Math.PI) / 180, n = 24, col = new THREE.Color('#fde047');
      const pt = (a) => [agent.x + Math.cos(a) * cone.range, h, -(agent.y + Math.sin(a) * cone.range)];
      const a0 = cone.fov >= 360 ? 0 : cone.heading - fov / 2, span = cone.fov >= 360 ? Math.PI * 2 : fov;
      const seg = (p, q) => { pa.set([...p, ...q], k); ca.set([col.r, col.g, col.b, col.r, col.g, col.b], k); k += 6; };
      const o = [agent.x, h, -agent.y];
      if (cone.fov < 360) { seg(o, pt(a0)); seg(o, pt(a0 + span)); }
      for (let i = 0; i < n; i++) seg(pt(a0 + (span * i) / n), pt(a0 + (span * (i + 1)) / n));
    }
    g.setDrawRange(0, k / 3);
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
  }

  // Landmarks (pins and labels), others last seen, and the planned route.
  drawAgentExtras(agent, scale) {
    const pg = this.pins.geometry, pa = pg.attributes.position.array, pc = pg.attributes.color.array;
    let k = 0, li = 0;
    const col = new THREE.Color();
    const seg = (x1, y1, h1, x2, y2, h2, c) => {
      if (k + 6 > pa.length) return;
      col.set(c);
      pa.set([x1, h1, -y1, x2, h2, -y2], k); pc.set([col.r, col.g, col.b, col.r, col.g, col.b], k); k += 6;
    };
    if (agent) {
      const s = Math.min(4, scale), lms = agent.mind.landmarks;
      // Label the landmarks nearest the agent; pin all of them.
      const near = [...lms].sort((a, b) => Math.hypot(a.x - agent.x, a.y - agent.y) - Math.hypot(b.x - agent.x, b.y - agent.y));
      for (const lm of near) {
        const c = LANDMARK_COLORS[lm.type] || '#ffffff', top = 10 * s;
        seg(lm.x, lm.y, 1, lm.x, lm.y, top, c);
        seg(lm.x - 1.5 * s, lm.y, top, lm.x + 1.5 * s, lm.y, top, c);
        if (li < 24) {
          const o = this.label(li++);
          o.visible = true;
          o.position.copy(w(lm.x, lm.y, top + 2 * s));
          o.element.textContent = lm.label;
          o.element.style.borderColor = c;
          o.element.title = lm.rel || '';
        }
      }
      // Others it has seen, where it last saw them: a small X.
      for (const [, o] of agent.mind.others) {
        const r = 2 * s, c = OTHER_COLORS[o.kind] || '#e5e7eb';
        seg(o.x - r, o.y - r, 2, o.x + r, o.y + r, 2, c);
        seg(o.x - r, o.y + r, 2, o.x + r, o.y - r, 2, c);
      }
    }
    for (; li < this.labels.length; li++) this.labels[li].visible = false;
    pg.setDrawRange(0, k / 3);
    pg.attributes.position.needsUpdate = true;
    pg.attributes.color.needsUpdate = true;

    // The route it planned with what it knows.
    const rg = this.route.geometry, ra = rg.attributes.position.array, rc = rg.attributes.color.array;
    k = 0;
    if (agent && agent.route && agent.route.length) {
      col.set('#fde047');
      let prev = agent;
      for (let i = 0; i < agent.route.length && k + 6 <= ra.length; i += 1) {
        const q = agent.route[i];
        if (i % 2 === 0) { ra.set([prev.x, 2.2, -prev.y, q.x, 2.2, -q.y], k); rc.set([col.r, col.g, col.b, col.r, col.g, col.b], k); k += 6; }
        prev = q;
      }
    }
    rg.setDrawRange(0, k / 3);
    rg.attributes.position.needsUpdate = true;
    rg.attributes.color.needsUpdate = true;
  }
}
