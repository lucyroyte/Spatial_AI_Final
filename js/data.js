// Live data loaders. Each one falls back to a bundled sample file if the request fails.
import { DATA, CORNERS } from './config.js';

async function fetchJSON(url, timeoutMs = DATA.timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Try the live loader; on any error use the sample loader. Returns {data, sample, error}.
async function withFallback(live, sample) {
  try {
    return { data: await live(), sample: false };
  } catch (err) {
    console.warn('Live data failed, using sample:', err);
    return { data: await sample(), sample: true, error: String(err.message || err) };
  }
}

function parseStations(info, status) {
  const stations = (info.data?.stations || []).map((s) => ({
    station_id: String(s.station_id), name: s.name, lat: +s.lat, lon: +s.lon, capacity: +s.capacity || 0,
  }));
  const st = {};
  for (const s of status.data?.stations || []) {
    st[String(s.station_id)] = { bikes: +s.num_bikes_available || 0, docks: +s.num_docks_available || 0 };
  }
  if (!stations.length) throw new Error('No stations in feed');
  return { stations, status: st };
}

export function loadStations() {
  return withFallback(
    async () => {
      const [info, status] = await Promise.all([fetchJSON(DATA.stationInfo), fetchJSON(DATA.stationStatus)]);
      return parseStations(info, status);
    },
    async () => {
      const [info, status] = await Promise.all([fetchJSON(DATA.samples.stationInfo), fetchJSON(DATA.samples.stationStatus)]);
      return parseStations(info, status);
    },
  );
}

// FloodNet readings normalised to [{id, name, lat, lon, depth}] with depth in inches.
function parseFloodNet(json) {
  const list = Array.isArray(json) ? json : json.sensors || json.data || json.deployments || [];
  const out = list.map((s) => {
    let depth = s.depth_in ?? s.depth_inches ?? s.depth;
    if (depth === undefined && s.depth_mm !== undefined) depth = s.depth_mm / 25.4;
    return {
      id: String(s.id ?? s.deployment_id ?? s.sensor_id),
      name: s.name || s.sensor_name || s.address || String(s.id ?? s.deployment_id),
      lat: +(s.lat ?? s.latitude), lon: +(s.lon ?? s.lng ?? s.longitude),
      depth: Math.max(0, +depth || 0),
    };
  }).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
  if (!out.length) throw new Error('No FloodNet sensors');
  return out;
}

export function loadFloodNet() {
  return withFallback(
    async () => {
      if (!DATA.floodnet) throw new Error('FloodNet endpoint not configured');
      return parseFloodNet(await fetchJSON(DATA.floodnet));
    },
    async () => parseFloodNet(await fetchJSON(DATA.samples.floodnet)),
  );
}

// Recent open 311 catch basin complaints inside the study area's bounding box.
function bbox() {
  const lats = Object.values(CORNERS).map((c) => c.lat), lons = Object.values(CORNERS).map((c) => c.lon);
  return { s: Math.min(...lats), n: Math.max(...lats), w: Math.min(...lons), e: Math.max(...lons) };
}

function parse311(rows) {
  return rows.map((r) => ({
    id: r.unique_key, descriptor: r.descriptor, status: r.status, created: r.created_date,
    address: r.incident_address || '', lat: +r.latitude, lon: +r.longitude,
  })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
}

export function load311() {
  return withFallback(
    async () => {
      const b = bbox();
      const since = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 19);
      const where = [
        "descriptor like '%Catch Basin%'",
        "status != 'Closed'",
        `created_date > '${since}'`,
        `latitude between ${b.s} and ${b.n}`,
        `longitude between ${b.w} and ${b.e}`,
      ].join(' AND ');
      const url = `${DATA.nyc311}?$where=${encodeURIComponent(where)}&$limit=500&$order=created_date DESC`;
      return parse311(await fetchJSON(url));
    },
    async () => parse311(await fetchJSON(DATA.samples.nyc311)),
  );
}
