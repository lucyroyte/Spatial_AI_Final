// UI wiring: toolbar actions, click selection, attribute panel, status display.
import { Model, RULES } from './model.js';
import { View } from './view.js';

const $ = (id) => document.getElementById(id);
const model = new Model();
const view = new View($('scene'), model);
let selection = null; // { kind, id }
let playing = null;

const fmt = (v, d = 1) => (Math.round(v * 10 ** d) / 10 ** d).toFixed(d);
const inches = (v) => `${fmt(v)}″`;
const pt = (p) => `(${fmt(p.x)}, ${fmt(p.y)}) ft`;
const regionName = (id) => model.byId[id]?.name || (id && id.startsWith('B') ? `Boat ${id}` : id || '—');

function toast(msg, ok = false) {
  if (!msg) return;
  const el = document.createElement('div');
  el.className = `toast${ok ? ' ok' : ''}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; }, 2800);
  setTimeout(() => el.remove(), 3300);
  while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
}

function selected() { return selection ? model.get(selection.id) : null; }

function select(ref) {
  selection = ref && model.get(ref.id) ? ref : null;
  renderInspector();
  updateButtons();
}

// ---------- attribute panel ----------
function describe(e) {
  const rows = [], flags = [];
  const k = e.kind;
  if (k === 'person') {
    rows.push(['Position', pt(e)], ['Activity', e.activity + (e.goal?.type === 'activity' ? ` (going to ${e.goal.activity})` : '')],
      ['Location', regionName(e.location)], ['Dog', e.dogId || 'none']);
    if (e.goal?.type === 'boat') flags.push(e.waitingBoat ? ['Waiting: lake overflowing', true] : ['Heading to boat landing']);
    if (e.evacuating) flags.push(['Moving to dry or open ground']);
    if (e.stranded) flags.push(['Stranded by flooding', true]);
    return { title: `Person ${e.id}`, rows, flags };
  }
  if (k === 'dog') {
    const o = model.person(e.ownerId);
    rows.push(['Position', pt(e)], ['Owner', e.ownerId], ['Distance to owner', o ? `${fmt(Math.hypot(o.x - e.x, o.y - e.y))} ft (max 6)` : '—'], ['Location', regionName(e.location)]);
    return { title: `Dog ${e.id}`, rows, flags };
  }
  if (k === 'boat') {
    rows.push(['Position', pt(e)], ['Heading', `${fmt(((90 - (e.heading * 180) / Math.PI) % 360 + 360) % 360, 0)}°`], ['Speed', `${fmt(e.speed)} ft/step`],
      ['Rowers', `${e.rowers.length} (${e.rowers.join(', ')})`], ['State', e.state === 'returning' ? 'returning to landing' : 'rowing']);
    return { title: `Boat ${e.id}`, rows, flags };
  }
  if (k === 'lawn') {
    const people = model.peopleIn(e.id).length, dogs = model.dogsIn(e.id).length;
    rows.push(['Grass height', inches(e.grassHeight)], ['Wear', `${fmt(e.wear)}%`], ['Area', `${Math.round(e.area).toLocaleString()} sq ft`],
      ['Elevation', e.elevation], ['Standing water', inches(e.standingWater)], ['Status', e.status + (e.status === 'reseeding' && !e.pendingReseed ? ` (${e.reseedTimer} steps left)` : '')],
      ['People / dogs', `${people} / ${dogs} (max ${model.lawnCapacity(e)} people)`], ['Boundary', `${e.boundary.length}-point polygon`]);
    if (e.grassHeight > RULES.NEEDS_MOWING) flags.push(['Needs mowing']);
    if (e.wear > RULES.NEEDS_RESEEDING) flags.push(['Needs reseeding', true]);
    if (e.overflow) flags.push(['Flooded by lake overflow', true]);
    else if (e.standingWater > RULES.PERSON_MAX_WATER) flags.push(['Over 3″ of water: closed to people', true]);
    const mower = model.mowers.find((m) => m.targetLawn === e.id);
    if (mower) flags.push([`${mower.id} ${mower.state}${mower.note ? ` · ${mower.note}` : ''}`]);
    return { title: e.name, rows, flags };
  }
  if (k === 'path') {
    rows.push(['Width', `${e.width} ft`], ['Elevation', e.elevation], ['Standing water', inches(e.standingWater)], ['Boundary', `${e.boundary.length}-point polygon`],
      ['Borders', [...model.layout.adj[e.id]].map(regionName).join(', ')]);
    if (e.overflow) flags.push(['Flooded by lake overflow', true]);
    else if (e.standingWater > RULES.PERSON_MAX_WATER) flags.push(['Over 3″ of water: closed to people', true]);
    return { title: e.name, rows, flags };
  }
  if (k === 'woods') {
    const broken = model.fences.filter((f) => f.status === 'broken').length;
    rows.push(['Area', `${Math.round(e.area).toLocaleString()} sq ft`], ['Weed cover', `${fmt(e.weedCover)}%`], ['Fence segments', `${model.fences.length} (${broken} broken)`],
      ['People inside', model.peopleIn('woods').length], ['Robots inside', model.stewards.filter((s) => s.location === 'woods').length]);
    return { title: e.name, rows, flags };
  }
  if (k === 'lake') {
    rows.push(['Area', `${Math.round(e.area).toLocaleString()} sq ft`], ['Water level', `${e.waterLevel >= 0 ? '+' : ''}${inches(e.waterLevel)} vs rim`],
      ['Duckweed cover', `${fmt(model.duckweedCover())}% (average of ${model.layout.grid.cells.length} cells)`], ['Boats', model.boats.length],
      ['Floating litter', model.litter.filter((l) => l.location === 'lake').length]);
    if (model.lakeOverflowing()) flags.push(['Overflowing: boats cannot launch', true]);
    return { title: e.name, rows, flags };
  }
  if (k === 'fence') {
    rows.push(['Status', e.status], ['Position', `${pt(e.a)} → ${pt(e.b)}`], ['Length', `${fmt(Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y))} ft`]);
    const s = model.stewards.find((x) => x.target?.type === 'fence' && x.target.id === e.id);
    if (s) flags.push([`${s.id} ${s.state}${s.note ? ` · ${s.note}` : ''}`]);
    return { title: `Fence segment ${e.id}`, rows, flags };
  }
  if (k === 'gate') {
    rows.push(['Position', pt(e.position)], ['Used by', 'steward robots only']);
    return { title: e.name, rows, flags };
  }
  if (k === 'landing') {
    rows.push(['Position', pt(e.position)], ['Connects', `${regionName(e.pathId)} ↔ The Lake`]);
    if (model.lakeOverflowing()) flags.push(['Lake overflowing: no launches', true]);
    return { title: e.name, rows, flags };
  }
  if (k === 'litter') {
    rows.push(['Position', pt(e)], ['Location', regionName(e.location)]);
    return { title: `Litter ${e.id}`, rows, flags };
  }
  if (k === 'mower' || k === 'steward' || k === 'skimmer') {
    rows.push(['Position', pt(e)], ['State', e.state]);
    if (k === 'mower') rows.push(['Target lawn', e.targetLawn ? `${regionName(e.targetLawn)} (${e.task})` : 'none']);
    if (k === 'steward') rows.push(['Target', !e.target ? 'none' : e.target.type === 'woods' ? 'The Woods (weeding)' : `${e.target.type === 'fence' ? 'Fence' : 'Litter'} ${e.target.id}`]);
    if (k === 'skimmer') rows.push(['Target', !e.target ? 'none' : `Duckweed cell ${model.layout.grid.cells[e.target.id].id} (${fmt(model.duckweed[e.target.id], 0)}%)`]);
    if (k !== 'skimmer') rows.push(['Location', regionName(e.location)]);
    if (e.note) flags.push([e.note]);
    const names = { mower: 'Mower robot', steward: 'Steward robot', skimmer: 'Skimmer robot' };
    return { title: `${names[k]} ${e.id}`, rows, flags };
  }
  return { title: e.id, rows, flags };
}

function renderInspector() {
  const e = selected();
  $('insp-close').hidden = !e;
  if (!e) {
    $('insp-kind').textContent = 'Nothing selected';
    $('insp-body').innerHTML = '<p class="muted">Click a person, dog, boat, robot, lawn, fence segment or litter item to see its attributes.</p>';
    return;
  }
  const d = describe(e);
  $('insp-kind').textContent = d.title;
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  $('insp-body').innerHTML = `<table>${d.rows.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join('')}</table>` +
    d.flags.map(([t, bad]) => `<span class="flag${bad ? ' bad' : ''}">${esc(t)}</span>`).join('');
}

function renderLog() {
  $('log').innerHTML = model.log.slice(0, 30).map((l) => `<li><b>${l.t}</b>${l.text.replace(/[&<>]/g, '')}</li>`).join('');
}

function renderStatus() {
  const rain = model.weather.rainIntensity, lvl = model.lake.waterLevel;
  $('st-rain').textContent = rain;
  $('st-lake').textContent = `${lvl >= 0 ? '+' : '−'}${fmt(Math.abs(lvl))}″ ${lvl > 0 ? 'over rim' : 'below rim'}`;
  $('st-lake').classList.toggle('alert', lvl > 0);
  const bar = $('st-lake-bar');
  bar.style.width = `${Math.max(0, Math.min(100, ((lvl + 10) / 24) * 100))}%`;
  bar.classList.toggle('over', lvl > 0);
  $('st-step').textContent = `Step ${model.time}`;
  $('st-duck').textContent = `Duckweed ${fmt(model.duckweedCover(), 0)}%`;
  $('st-weed').textContent = `Weeds ${fmt(model.woods.weedCover, 0)}%`;
  $('btn-rain').textContent = `Rain: ${rain}`;
}

function updateButtons() {
  const e = selected();
  for (const b of document.querySelectorAll('[data-needs]')) b.disabled = !e || e.kind !== b.dataset.needs;
}

// ---------- actions ----------
function advance() {
  model.advance();
  for (const a of model.alerts) toast(a);
  if (selection && !model.get(selection.id)) select(null);
  renderLog();
}

function run(action) {
  const e = selected();
  let res = { ok: true };
  switch (action) {
    case 'addPerson': res = model.addPerson(); break;
    case 'removePerson': res = model.removePerson(e); select(null); break;
    case 'addDog': res = model.addDog(e); break;
    case 'changeActivity': res = model.changeActivity(e); break;
    case 'goBoating': res = model.goBoating(e); break;
    case 'dropLitter': res = model.dropLitter(e); break;
    case 'breakFence': res = model.breakFence(e); break;
    case 'mowLawn': res = model.mowLawn(e); break;
    case 'reseedLawn': res = model.reseedLawn(e); break;
    case 'toggleLawn': res = model.toggleLawn(e); break;
    case 'addMower': res = model.addRobotAction('mower'); break;
    case 'addSteward': res = model.addRobotAction('steward'); break;
    case 'addSkimmer': res = model.addRobotAction('skimmer'); break;
    case 'rain': res = model.cycleRain(); break;
    case 'advance': advance(); break;
    case 'play':
      if (playing) { clearInterval(playing); playing = null; }
      else playing = setInterval(advance, 140);
      $('btn-play').textContent = playing ? 'Pause' : 'Play';
      $('btn-play').classList.toggle('on', !!playing);
      break;
    case 'reset': model.reset(); select(null); toast('Example scene restored.', true); break;
  }
  if (res && !res.ok) toast(res.msg);
  else if (res && res.msg) toast(res.msg, true);
  if (res && res.entity && ['addPerson', 'addMower', 'addSteward', 'addSkimmer'].includes(action)) select({ kind: res.entity.kind, id: res.entity.id });
  renderLog();
  renderInspector();
}

document.querySelectorAll('#toolbar [data-action]').forEach((b) => b.addEventListener('click', () => run(b.dataset.action)));
$('insp-close').addEventListener('click', () => select(null));

// Click to select (ignore drags used for orbiting).
let down = null;
const canvas = view.renderer.domElement;
canvas.addEventListener('pointerdown', (ev) => { down = { x: ev.clientX, y: ev.clientY }; });
canvas.addEventListener('pointerup', (ev) => {
  if (!down || Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 5) return;
  select(view.pick(ev.clientX, ev.clientY));
});
window.addEventListener('keydown', (ev) => {
  if (ev.target.tagName === 'INPUT') return;
  if (ev.key === ' ') { ev.preventDefault(); run('play'); }
  if (ev.key === 'Escape') select(null);
});

// ---------- loop ----------
let last = performance.now(), panelTick = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  view.update(dt, selection);
  view.render();
  panelTick += dt;
  if (panelTick > 0.2) { panelTick = 0; renderStatus(); if (selection) renderInspector(); }
  requestAnimationFrame(frame);
}
renderStatus(); renderLog(); updateButtons();
if (window.innerWidth > 760) $('legend').querySelector('details').open = true;
$('loading').remove();
requestAnimationFrame(frame);

// Handles for tests and the console.
window.__model = model;
window.__view = view;
window.__select = select;
