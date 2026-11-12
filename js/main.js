// UI wiring: toolbar actions, click selection, attribute panel, status display.
import { Model, RULES } from './model.js';
import { View } from './view.js';
import { loadLayout } from './layout.js';
import { drawRobotMap, ROBOT_COLORS, batteryColor } from './monitor.js';
import { OVERLAYS, LANDMARK_COLORS } from './knowledge.js';
import { setupDesigner } from './designer-ui.js';

const $ = (id) => document.getElementById(id);
let layout;
try { layout = await loadLayout('data/park.json'); } catch (err) {
  $('loading').textContent = `Could not load the park data: ${err.message}`;
  throw err;
}
const model = new Model(layout);
const view = new View($('scene'), model);
let selection = null; // { kind, id }
let playing = null, fast = false;

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
    const ps = e.personality;
    rows.push(['Position', pt(e)], ['Activity', e.activity + (e.goal?.type === 'activity' ? ` (going to ${e.goal.activity})` : '')],
      ['Location', regionName(e.location)], ['Dog', e.dogId || 'none'],
      ['Litters', ps.litterbug > 0.5 ? 'often' : ps.litterbug > 0.15 ? 'sometimes' : 'rarely'],
      ['Breaks fences', ps.fenceHopper > 0.5 ? 'often' : ps.fenceHopper > 0.15 ? 'sometimes' : 'rarely'],
      ['Feeds the ducks', ps.duckFeeder ? 'yes' : 'no']);
    if (e.dogId) rows.push(['Picks up poop', ps.picksUpPoop ? 'yes' : 'no'], ['Lets dog in the woods', ps.letsDogInWoods ? 'yes' : 'no']);
    rows.push(['Reports problems', ps.reporter ? 'yes, like calling 311' : 'no']);
    if (e.plan) {
      const pl = e.plan, used = model.time - pl.startT;
      const goals = pl.goals.map((g) => `${pl.done.includes(g) ? '✓' : '○'} ${model.place(g)?.label || g}${!pl.done.includes(g) && e.mind.byKey.has(g) ? ' (knows where)' : ''}`).join(' · ');
      const status = { exploring: 'exploring to find places', heading: `heading to ${e.mind.byKey.get(pl.target)?.label || 'a place'}`, returning: `going back to ${e.mind.byKey.get('start')?.label || 'the start'}` }[pl.status];
      rows.push(['Goals', goals], ['Plan', status], ['Time', `${used} of ${pl.budget} min`], ['Walked', `${Math.round(pl.distance).toLocaleString()} ft`],
        ['Knows', `${fmt((e.mind.known / model.kcells) * 100, 1)}% of the park · ${e.mind.landmarks.length} landmarks`],
        ['Has seen', `${e.mind.others.size} other agents nearby`]);
      if (pl.told) flags.push([`Got directions ${pl.told} time${pl.told > 1 ? 's' : ''}`]);
    }
    if (e.goal?.type === 'boat') flags.push(e.waitingBoat ? ['Waiting: lake overflowing', true] : ['Heading to boat landing']);
    if (e.evacuating) flags.push(['Moving to dry or open ground']);
    if (e.stranded) flags.push(['Stranded by flooding', true]);
    return { title: `Person ${e.id}`, rows, flags };
  }
  if (k === 'dog') {
    const o = model.person(e.ownerId);
    rows.push(['Position', pt(e)], ['Owner', e.ownerId], ['Distance to owner', o ? `${fmt(Math.hypot(o.x - e.x, o.y - e.y))} ft (max 6)` : '—'], ['Location', regionName(e.location)],
      ['Digs holes', e.personality.digger ? 'yes' : 'no']);
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
    rows.push(['Type', e.type === 'hole' ? 'hole dug by a dog' : e.type === 'poop' ? 'dog poop' : 'trash'], ['Position', pt(e)], ['Location', regionName(e.location)]);
    return { title: `${e.type === 'hole' ? 'Hole' : e.type === 'poop' ? 'Dog poop' : 'Litter'} ${e.id}`, rows, flags };
  }
  if (k === 'center') {
    const here = model.robots().filter((r) => r.state === 'docked' || r.state === 'charging');
    rows.push(['Position', pt(e.position)], ['Skimmer dock', pt(e.dock)], ['Robots here', here.length ? here.map((r) => `${r.id} (${r.state})`).join(', ') : 'none'],
      ['Fleet', `${model.robots().length} robots, $${model.fleetCost() / 1000}k of $${model.budget / 1000}k`], ['Charging', `${RULES.BATTERY.charge}% per minute`]);
    flags.push(['Click the building or press M for the robot monitor']);
    return { title: e.name, rows, flags };
  }
  if (k === 'mower' || k === 'steward' || k === 'skimmer') {
    rows.push(['Position', pt(e)], ['State', e.state + (e.recalled && e.state !== 'docked' ? ' (being parked)' : '')], ['Battery', `${fmt(e.battery, 0)}%`], ['Price', `$${e.price / 1000}k`]);
    if (k === 'steward') rows.push(['Role', { general: 'general (fences, litter, weeds)', fence: 'fence fixer', litter: 'litter picker', weeds: 'weeder' }[e.role]]);
    if (k === 'mower') rows.push(['Target lawn', e.targetLawn ? `${regionName(e.targetLawn)} (${e.task})` : 'none']);
    if (k === 'steward') rows.push(['Target', !e.target ? 'none' : e.target.type === 'woods' ? 'The Ramble (weeding)' : `${e.target.type === 'fence' ? 'Fence' : 'Litter'} ${e.target.id}`]);
    if (k === 'skimmer') rows.push(['Target', !e.target ? 'none' : e.target.type === 'litter' ? `Floating litter ${e.target.id}` : `Duckweed cell ${model.layout.grid.cells[e.target.id].id} (${fmt(model.duckweed[e.target.id], 0)}%)`]);
    if (k !== 'skimmer') rows.push(['Location', regionName(e.location)]);
    rows.push(['Doing', model.taskText(e)], ['Driven', `${Math.round(e.distance).toLocaleString()} ft`]);
    if (e.mind) rows.push(['Knows', `${fmt((e.mind.known / model.kcells) * 100, 1)}% of the park · ${e.mind.landmarks.length} landmarks`], ['Has seen', `${e.mind.others.size} other agents nearby`]);
    if (e.note) flags.push([e.note]);
    const names = { mower: 'Mower robot', steward: 'Steward robot', skimmer: 'Skimmer robot' };
    return { title: `${names[k]} ${e.id}`, rows, flags };
  }
  return { title: e.id, rows, flags };
}

// The toolbar's actions for a selected thing, repeated in its panel.
const CONTEXT_ACTIONS = {
  person: [['addDog', 'Add dog'], ['changeActivity', 'Change activity'], ['goBoating', 'Go boating'], ['dropLitter', 'Drop litter'], ['removePerson', 'Remove']],
  fence: [['breakFence', 'Break fence']],
  lawn: [['mowLawn', 'Mow'], ['reseedLawn', 'Reseed'], ['toggleLawn', 'Open/close']],
};

// Only rebuilt when the selection changes, so a click isn't lost to a re-render.
let actionsFor = null;
function renderActions(e) {
  const key = e ? e.kind : null;
  if (key === actionsFor) return;
  actionsFor = key;
  const acts = e && CONTEXT_ACTIONS[e.kind];
  $('insp-actions').hidden = !acts;
  $('insp-actions').innerHTML = acts ? acts.map(([a, t]) => `<button data-act="${a}">${t}</button>`).join('') : '';
}

function renderInspector() {
  const e = selected();
  renderActions(e);
  $('insp-close').hidden = !e;
  $('inspector').classList.toggle('empty', !e);
  if (!e) {
    $('insp-kind').textContent = 'Nothing selected';
    $('insp-body').innerHTML = '<p class="muted">Click a person, dog, boat, robot, lawn, fence segment or litter item to see its attributes.</p>';
    return;
  }
  const d = describe(e);
  $('insp-kind').textContent = d.title;
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  $('insp-body').innerHTML = `<table>${d.rows.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join('')}</table>` +
    d.flags.map(([t, bad]) => `<span class="flag${bad ? ' bad' : ''}">${esc(t)}</span>`).join('') +
    (e.mind ? `<button class="know-btn${view.knowledge.mode === 'agent' ? ' on' : ''}" data-know>${view.knowledge.mode === 'agent' ? 'Hide what they know' : 'Show what they know'}</button>` : '');
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
  $('st-step').textContent = `Day ${model.day.number} · ${model.clock()}`;
  $('st-duck').textContent = `Duckweed ${fmt(model.duckweedCover(), 0)}%`;
  $('st-weed').textContent = `Weeds ${fmt(model.woods.weedCover, 0)}%`;
  $('btn-rain').textContent = `Rain: ${rain}`;
  renderGoal();
  renderVisitors();
}

function renderGoal() {
  const share = model.dayShares(), now = model.day.now, d = now.detail;
  const lawnsBad = model.lawns.filter((l) => l.grassHeight > RULES.NEEDS_MOWING || l.wear > RULES.NEEDS_RESEEDING || l.standingWater > RULES.PERSON_MAX_WATER).length;
  const why = {
    lawns: `${Math.round(now.lawnShare * 100)}% of lawn area tidy (need 80%)${lawnsBad ? ` · ${lawnsBad} need mowing, reseeding or are flooded` : ''}`,
    woods: `weeds ${fmt(model.woods.weedCover, 0)}% (≤50) · ${d.broken} broken fences (≤3) · ${d.woodsMess} litter (≤3)`,
    lake: `duckweed ${fmt(model.duckweedCover(), 0)}% (≤35) · ${d.lakeMess} floating litter (≤3)`,
  };
  const names = { lawns: 'Lawns', woods: 'Woods', lake: 'Lake' };
  $('goal').innerHTML = ['lawns', 'woods', 'lake'].map((k) => {
    const v = Math.round(share[k] * 100);
    return `<div class="goal-row"><span>${names[k]}</span><span class="bar"><i class="${v < 60 ? 'low' : ''}" style="width:${v}%"></i><b></b></span><span class="now ${now[k] ? 'ok' : 'bad'}">${v}%</span><span class="why">${now[k] ? 'presentable now' : 'not presentable'}: ${why[k]}</span></div>`;
  }).join('');
  const kinds = ['mower', 'steward', 'skimmer'].map((k) => {
    const all = model.robots().filter((r) => r.kind === k), out = all.filter((r) => model.deployed(r) || r.state === 'returning').length;
    return `${out}/${all.length} ${k}s`;
  });
  $('fleet').textContent = `$${model.fleetCost() / 1000}k of $${model.budget / 1000}k`;
  $('controller').textContent = `${model.autoRobots ? '' : 'Off. '}${kinds.join(' · ')} out. ${model.controllerNote}`;
  $('history').textContent = model.history.length ? `Past days: ${model.history.slice(-5).map((h) => `day ${h.day} ${h.met ? 'met' : 'missed'}`).join(', ')}` : '';
  $('btn-auto').textContent = `Auto: ${model.autoRobots ? 'on' : 'off'}`;
  $('btn-auto').classList.toggle('on', model.autoRobots);
}

function renderVisitors() {
  const v = model.visitorStats(), pc = (x) => `${Math.round(x * 100)}%`;
  $('visitors').innerHTML = `<div>${v.inPark} in the park: ${v.exploring} exploring, ${v.heading} heading to a place, ${v.returning} going back</div>` +
    `<div>They know ${pc(v.known)} of the park each, on average. Robots share a map of ${pc(v.fleetKnown)}; ${v.reported} problems reported.</div>` +
    (v.left ? `<div>${v.left} have left: ${pc(v.places)} of their places seen, ${pc(v.allSeen)} saw them all, ${pc(v.onTime)} on time · ${Math.round(v.minutes)} min, ${Math.round(v.distance).toLocaleString()} ft walked</div>` : '<div class="muted">No one has finished a visit yet.</div>');
}

let treesBeforeOverlay = null;
function setOverlay(mode) {
  view.knowledge.setMode(mode);
  // Maps read better from above without the tree canopy.
  if (mode !== 'off' && treesBeforeOverlay === null) { treesBeforeOverlay = view.trees.visible; view.setTreesVisible(false); }
  if (mode === 'off' && treesBeforeOverlay !== null) { view.setTreesVisible(treesBeforeOverlay); treesBeforeOverlay = null; }
  $('btn-trees').classList.toggle('on', view.trees.visible);
  $('overlay').value = mode;
  $('overlay-key').innerHTML = {
    agent: `Dark: unknown to them · <i style="background:#dc3c3c"></i>blocked · <i style="background:#3c82eb"></i>water · <i style="background:#ffe65a"></i>in view now. Pins are their landmarks: ${Object.entries(LANDMARK_COLORS).map(([k, c]) => `<i style="background:${c}"></i>${k}`).join(' ')}. An × marks another agent where they last saw it.`,
    fleet: 'Dark: no robot has seen it yet. Robots merge maps when they charge.',
    paths: 'Every step any visitor or robot has walked. Darker red: more steps.',
    landmarks: 'Where agents saved landmarks: places, hindrances, issues and signposts. Darker: more agents.',
    shared: 'How many of the visitors in the park know each spot. Darker blue: most of them.',
    off: '',
  }[mode] || '';
  if (mode === 'agent' && !(selected() && selected().mind)) toast('Select a person or robot to see what it knows.');
  renderInspector();
}

function updateButtons() {
  const e = selected();
  for (const b of document.querySelectorAll('[data-needs]')) b.disabled = !e || e.kind !== b.dataset.needs;
}

// ---------- actions ----------
function advance() {
  for (let i = fast ? 10 : 1; i > 0; i--) model.advance();
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
    case 'addVisitors': res = model.addVisitors(25); break;
    case 'rain': res = model.cycleRain(); break;
    case 'advance': advance(); break;
    case 'play':
      if (playing) { clearInterval(playing); playing = null; }
      else playing = setInterval(advance, 140);
      $('btn-play').textContent = playing ? 'Pause' : 'Play';
      $('btn-play').classList.toggle('on', !!playing);
      break;
    case 'fast':
      fast = !fast;
      $('btn-fast').classList.toggle('on', fast);
      if (fast && !playing) run('play');
      break;
    case 'auto': res = model.toggleAuto(); break;
    case 'monitor': setMonitor($('monitor').hidden); break;
    case 'about': setAbout($('about').hidden); break;
    case 'trees': view.setTreesVisible(!view.trees.visible); $('btn-trees').classList.toggle('on', view.trees.visible); break;
    case 'reset': model.reset(); $('budget').value = model.budget / 1000; select(null); toast('Example scene restored.', true); break;
  }
  if (res && !res.ok) toast(res.msg);
  else if (res && res.msg) toast(res.msg, true);
  if (res && res.entity && ['addPerson', 'addMower', 'addSteward', 'addSkimmer'].includes(action)) select({ kind: res.entity.kind, id: res.entity.id });
  if (action === 'reset') setOverlay(view.knowledge.mode);
  renderLog();
  renderInspector();
}

document.querySelectorAll('#toolbar [data-action]').forEach((b) => b.addEventListener('click', () => run(b.dataset.action)));
$('insp-close').addEventListener('click', () => select(null));
$('insp-body').addEventListener('click', (ev) => {
  if (ev.target.closest('[data-know]')) setOverlay(view.knowledge.mode === 'agent' ? 'off' : 'agent');
});
$('insp-actions').addEventListener('click', (ev) => { const b = ev.target.closest('[data-act]'); if (b) run(b.dataset.act); });

// ---------- about and the environment designer ----------
function setAbout(open) {
  $('about').hidden = !open;
  $('btn-about').classList.toggle('on', open);
}
$('about-close').addEventListener('click', () => setAbout(false));
const designer = setupDesigner({
  model, toast,
  openInPark(env, label) {
    model.reset(env);
    $('budget').value = model.budget / 1000;
    select(null);
    setOverlay(view.knowledge.mode);
    renderLog();
    toast(`${label} is now running in the park. Reset returns to the example scene.`, true);
  },
});
$('overlay').innerHTML = Object.entries(OVERLAYS).map(([k, t]) => `<option value="${k}">${t}</option>`).join('');
$('overlay').addEventListener('change', (ev) => setOverlay(ev.target.value));

// ---------- robot center monitor ----------
let monitorT = null;
function setMonitor(open) {
  $('monitor').hidden = !open;
  view.showTrails = open;
  $('btn-monitor').classList.toggle('on', open);
  if (open) renderMonitor();
}
function renderMonitor() {
  const sel = selected();
  monitorT = drawRobotMap($('mon-map').getContext('2d'), model, 480, 450, { selectedId: sel && sel.id, pad: 10 });
  const robots = model.robots();
  const count = (k) => robots.filter((r) => r.kind === k).length;
  const charging = robots.filter((r) => r.state === 'charging' || r.state === 'docked').length;
  $('mon-summary').textContent = `${model.clock()} · ${count('mower')} mowers, ${count('steward')} stewards, ${count('skimmer')} skimmers · ${charging} at the center · fleet $${model.fleetCost() / 1000}k of $${model.budget / 1000}k`;
  const roles = { general: 'steward', fence: 'fence fixer', litter: 'litter picker', weeds: 'weeder' };
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  $('mon-table').tBodies[0].innerHTML = robots.map((r) => `<tr data-id="${r.id}" class="${sel && sel.id === r.id ? 'sel' : ''}">
    <td class="rid"><i style="background:${ROBOT_COLORS[r.kind]}"></i>${r.id}<small>${r.kind === 'steward' ? roles[r.role] : r.kind} · ${regionName(r.location)}</small></td>
    <td>${esc(model.taskText(r))}<br><small class="muted">${Math.round(r.distance).toLocaleString()} ft driven</small></td>
    <td><div class="batt"><i style="width:${r.battery}%;background:${batteryColor(r.battery)}"></i></div><span>${Math.round(r.battery)}%</span></td></tr>`).join('');
}
function followRobot(id) {
  const r = model.get(id);
  if (!r) return;
  select({ kind: r.kind, id: r.id });
  view.focus(r.x, r.y, 320);
  renderMonitor();
}
$('monitor-close').addEventListener('click', () => setMonitor(false));
$('mon-table').addEventListener('click', (ev) => { const tr = ev.target.closest('tr[data-id]'); if (tr) followRobot(tr.dataset.id); });
$('mon-map').addEventListener('click', (ev) => {
  if (!monitorT) return;
  const c = ev.currentTarget, rect = c.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * c.width, y = ((ev.clientY - rect.top) / rect.height) * c.height;
  let best = null, bd = 14;
  for (const r of model.robots()) { const d = Math.hypot(monitorT.X(r.x) - x, monitorT.Y(r.y) - y); if (d < bd) { bd = d; best = r; } }
  if (best) followRobot(best.id);
});
$('budget').addEventListener('change', (ev) => {
  const v = Math.max(0, Number(ev.target.value) || 0) * 1000;
  model.setBudget(v);
  if (v < model.fleetCost()) toast(`The fleet already costs $${model.fleetCost() / 1000}k; no more robots will be bought until it's under budget.`);
  renderStatus();
});

// Click to select (ignore drags used for orbiting).
let down = null;
const canvas = view.renderer.domElement;
canvas.addEventListener('pointerdown', (ev) => { down = { x: ev.clientX, y: ev.clientY }; });
canvas.addEventListener('pointerup', (ev) => {
  if (!down || Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 5) return;
  const ref = view.pick(ev.clientX, ev.clientY);
  select(ref);
  if (ref && ref.monitor) setMonitor(true);
});
window.addEventListener('keydown', (ev) => {
  if (ev.target.tagName === 'INPUT') return;
  if (ev.key === 'f' && selected()) { const e = selected(); const p = e.anchor || e.position || e; view.focus(p.x, p.y); }
  if (ev.key === ' ') { ev.preventDefault(); run('play'); }
  if (ev.key === 'Escape') {
    if (!$('designer').hidden) designer.open(false);
    else if (!$('about').hidden) setAbout(false);
    else if (!$('monitor').hidden) setMonitor(false);
    else select(null);
  }
  if (ev.key === 'm') run('monitor');
  if (ev.key === 'k' && selected()?.mind) setOverlay(view.knowledge.mode === 'agent' ? 'off' : 'agent');
});

// ---------- loop ----------
let last = performance.now(), panelTick = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  view.update(dt, selection);
  view.render();
  panelTick += dt;
  if (panelTick > 0.2) { panelTick = 0; renderStatus(); if (selection) renderInspector(); if (!$('monitor').hidden) renderMonitor(); }
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
window.__overlay = setOverlay;
