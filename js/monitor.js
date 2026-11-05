// The robot center's monitor: a top-down map of the park with every robot,
// the trail of where it has been, its task and its battery. The same drawing
// shows on the screen on the building's wall and in the monitor panel.

export const ROBOT_COLORS = { mower: '#f97316', steward: '#2dd4bf', skimmer: '#facc15' };

const baseCache = new Map();

function fit(L, W, H, pad) {
  const B = L.bounds;
  const s = Math.min((W - pad * 2) / (B.x1 - B.x0), (H - pad * 2) / (B.y1 - B.y0));
  const ox = (W - (B.x1 - B.x0) * s) / 2, oy = (H - (B.y1 - B.y0) * s) / 2;
  return { s, X: (x) => ox + (x - B.x0) * s, Y: (y) => oy + (B.y1 - y) * s };
}

// The park itself only changes when the size does, so draw it once per size.
function baseMap(L, W, H, pad) {
  const key = `${W}x${H}x${pad}`;
  if (baseCache.has(key)) return baseCache.get(key);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d'), T = fit(L, W, H, pad);
  g.fillStyle = '#0b1220'; g.fillRect(0, 0, W, H);
  const fill = (polygons, color) => {
    g.fillStyle = color;
    for (const poly of polygons) {
      g.beginPath();
      for (const ring of poly) ring.forEach((p, i) => (i ? g.lineTo(T.X(p.x), T.Y(p.y)) : g.moveTo(T.X(p.x), T.Y(p.y))));
      g.fill('evenodd');
    }
  };
  fill(L.other.park, '#15233a');
  for (const l of L.lawns) fill(l.polygons, '#1d3b2f');
  fill(L.woods.polygons, '#173126');
  for (const p of L.paths) fill(p.polygons, '#3b4a63');
  fill(L.lake.polygons, '#12456b');
  fill(L.other.water, '#12456b');
  // Faint grid, like a radar screen.
  g.strokeStyle = 'rgba(148, 197, 255, 0.07)'; g.lineWidth = 1;
  for (let x = 0; x < W; x += 32) { g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); g.stroke(); }
  for (let y = 0; y < H; y += 32) { g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); g.stroke(); }
  const out = { canvas: c, T };
  baseCache.set(key, out);
  return out;
}

export function batteryColor(b) {
  return b > 50 ? '#22c55e' : b > 25 ? '#eab308' : '#ef4444';
}

export function drawRobotMap(ctx, model, W, H, opts = {}) {
  const L = model.layout, pad = opts.pad ?? 8;
  const { canvas, T } = baseMap(L, W, H, pad);
  ctx.drawImage(canvas, 0, 0);
  const big = W >= 400;
  // Trails: older parts fade out.
  for (const r of model.robots()) {
    const tr = r.trail;
    if (!tr || tr.length < 2) continue;
    ctx.strokeStyle = ROBOT_COLORS[r.kind];
    ctx.lineWidth = r.id === opts.selectedId ? 2.5 : 1.4;
    const n = tr.length;
    for (let i = 1; i < n; i++) {
      ctx.globalAlpha = 0.12 + 0.75 * (i / n);
      ctx.beginPath(); ctx.moveTo(T.X(tr[i - 1].x), T.Y(tr[i - 1].y)); ctx.lineTo(T.X(tr[i].x), T.Y(tr[i].y)); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(T.X(tr[n - 1].x), T.Y(tr[n - 1].y)); ctx.lineTo(T.X(r.x), T.Y(r.y)); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // The center and dock.
  const c = model.center;
  ctx.strokeStyle = '#facc15'; ctx.lineWidth = 2;
  for (const p of [c.position, c.dock]) { ctx.beginPath(); ctx.arc(T.X(p.x), T.Y(p.y), big ? 7 : 5, 0, Math.PI * 2); ctx.stroke(); }
  // Robots: a dot in the robot's color with a battery bar under it.
  ctx.font = `${big ? 11 : 10}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  const parked = {};
  for (const r of model.robots()) {
    let x = T.X(r.x), y = T.Y(r.y);
    if (r.state === 'docked' || r.state === 'charging') {
      const k = (parked[r.kind === 'skimmer'] = (parked[r.kind === 'skimmer'] || 0) + 1) - 1;
      x += (k % 4) * 9 - 13; y += Math.floor(k / 4) * 11 + 12;
    }
    const sel = r.id === opts.selectedId;
    ctx.fillStyle = ROBOT_COLORS[r.kind];
    ctx.strokeStyle = sel ? '#ffffff' : '#0b1220'; ctx.lineWidth = sel ? 2.5 : 1.5;
    ctx.beginPath();
    if (r.kind === 'mower') ctx.rect(x - 4.5, y - 4.5, 9, 9);
    else if (r.kind === 'skimmer') { ctx.moveTo(x, y - 5.5); ctx.lineTo(x + 5.5, y); ctx.lineTo(x, y + 5.5); ctx.lineTo(x - 5.5, y); ctx.closePath(); }
    else ctx.arc(x, y, 4.8, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#0b1220'; ctx.fillRect(x - 7, y + 7, 14, 3);
    ctx.fillStyle = batteryColor(r.battery); ctx.fillRect(x - 7, y + 7, 14 * Math.max(0.05, r.battery / 100), 3);
    if (opts.labels !== false && (big || sel)) { ctx.fillStyle = '#e2e8f0'; ctx.fillText(r.id, x, y - 8); }
  }
  if (opts.header) {
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(11, 18, 32, 0.8)'; ctx.fillRect(0, 0, W, 22);
    ctx.fillStyle = '#94e2ff'; ctx.font = 'bold 13px ui-monospace, monospace';
    ctx.fillText(opts.header, 8, 15);
  }
  return T;
}
