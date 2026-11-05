// Study area, simplified street grid, data sources, and rule constants.

// Corners of the study area (lat, lon), measured from the NYC street centerline file.
// Union St to the north, 9th St to the south, Smith St to the west, 4th Ave to the east.
export const CORNERS = {
  nw: { lat: 40.681649, lon: -73.993915 }, // Union St & Smith St
  ne: { lat: 40.677387, lon: -73.98298 }, // Union St & 4th Ave
  sw: { lat: 40.67475, lon: -73.997771 }, // 9th St & Smith St
  se: { lat: 40.670333, lon: -73.988648 }, // 9th St & 4th Ave
};

// Real intersection positions and the canal centerline (generated, see js/street-grid.js).
export { INTERSECTIONS, CANAL_LINE } from './street-grid.js';

// North–south streets, placed by a 0..1 position across the area (west to east).
export const COLUMNS = [
  { name: 'Smith St', u: 0.0, width: 60 },
  { name: 'Hoyt St', u: 0.15, width: 50 },
  { name: 'Bond St', u: 0.3, width: 50 },
  { name: 'Nevins St', u: 0.54, width: 50 },
  { name: '3rd Ave', u: 0.74, width: 70 },
  { name: '4th Ave', u: 1.0, width: 100 },
];

// East–west streets, placed by a 0..1 position down the area (north to south).
export const ROWS = [
  'Union St', 'President St', 'Carroll St', '1st St', '2nd St', '3rd St',
  '4th St', '5th St', '6th St', '7th St', '8th St', '9th St',
].map((name, i, all) => ({ name, v: i / (all.length - 1), width: name === 'Union St' || name === '9th St' ? 60 : 50 }));

// The canal sits between Bond St (column 2) and Nevins St (column 3).
// Only these streets have bridges over it.
export const CANAL_WEST_COL = 2;
export const CANAL_EAST_COL = 3;
export const BRIDGE_ROWS = ['Union St', 'Carroll St', '3rd St', '9th St'];

// Grid segments with no real street under them (checked against the NYC street
// centerline file). They are left out of the network. ns-{column}-{row}, ew-{row}-{column}.
export const MISSING_SEGMENTS = [
  'ns-1-7', 'ns-1-8', 'ns-1-9', 'ns-1-10', // Hoyt St south of 5th St
  'ns-2-6', 'ns-2-7', 'ns-2-8', 'ns-2-9', 'ns-2-10', // Bond St south of 4th St
  'ns-3-2', 'ns-3-3', 'ns-3-4', 'ns-3-5', 'ns-3-6', 'ns-3-7', 'ns-3-8', 'ns-3-9', 'ns-3-10', // Nevins St south of Carroll St
  'ew-2-0', 'ew-2-1', 'ew-3-0', 'ew-3-3', 'ew-4-4', 'ew-6-3', 'ew-6-4', 'ew-7-1', 'ew-7-3', 'ew-7-4',
  'ew-8-0', 'ew-8-1', 'ew-9-0', 'ew-9-1', 'ew-10-0', 'ew-10-1',
];
export const CANAL = { u: 0.42, halfWidth: 0.016, extend: 0.12 };

// Elevation bands by distance from the canal (feet).
export const ELEVATION_BANDS = { low: 450, medium: 1100 };

// Rules
export const IMPASSABLE_DEPTH_IN = 6; // a segment is impassable when depth > 6 in
export const SENSOR_RADIUS_FT = 500; // real mode: nearest sensor within 500 ft
export const COMPLAINT_SNAP_FT = 200; // 311 complaint -> nearest segment within this distance
export const MAX_DEPTH_IN = 18;

// Simulation rates, inches per simulated second.
export const RAIN_RATES = {
  heavy: { low: 0.02, medium: 0.009, high: 0.004 },
  light: { low: 0.007, medium: 0.0032, high: 0.0014 },
};
export const DRAIN_RATE = 0.012; // clear basins; clogged drain at half this
export const CLOGGED_FLOOD_FACTOR = 2;
export const CLOGGED_DRAIN_FACTOR = 0.5;

export const RIDER_SPEED_FT_S = 14; // about 9.5 mph
export const STEP_SECONDS = 30; // "Advance time" moves the clock this far
export const PLAY_SPEED = 20; // simulated seconds per real second while playing
export const DOCKED_REST_S = 90; // docked riders rest, then wait for a new ride
// Falls: on a street with more than FALL_DEPTH_IN of water, a rider can fall off.
// The chance per simulated second grows with every inch above the threshold.
export const FALL_DEPTH_IN = 3;
export const FALL_RATE_PER_IN = 0.012; // per second, per inch above 3 in (about 3.5%/s at 6 in)
export const FALL_RECOVER_S = 45; // a fallen rider gets back on the bike after this long

// Seed for the example scene, so Reset always looks the same.
export const EXAMPLE_SEED = 20261105;
// Segments whose catch basins start clogged in the example scene (all near the canal).
export const EXAMPLE_CLOGGED = ['ew-2-2', 'ns-2-3', 'ns-2-4'];

// Data sources
export const DATA = {
  stationInfo: 'https://gbfs.citibikenyc.com/gbfs/en/station_information.json',
  stationStatus: 'https://gbfs.citibikenyc.com/gbfs/en/station_status.json',
  // FloodNet public API: the list of deployed flood sensors, then each sensor's recent
  // depth readings (millimetres). Set floodnet to '' to always use the bundled sample.
  floodnet: 'https://api.floodnet.nyc/api/rest/deployments/flood',
  floodnetDepth: (id, start, end) => `https://api.floodnet.nyc/api/rest/deployments/flood/${encodeURIComponent(id)}/depth?start_time=${start}&end_time=${end}`,
  floodnetWindowMin: 60, // use the latest reading from the last hour
  // NYC Open Data 311 Service Requests (Socrata). The query is built in data.js.
  nyc311: 'https://data.cityofnewyork.us/resource/erm2-nwe9.json',
  samples: {
    stationInfo: 'data/sample-station-information.json',
    stationStatus: 'data/sample-station-status.json',
    floodnet: 'data/sample-floodnet.json',
    nyc311: 'data/sample-311-catch-basins.json',
  },
  timeoutMs: 8000,
};
