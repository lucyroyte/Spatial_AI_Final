# Gowanus Flood Routing

A single-page three.js app that shows Citi Bike riders in Gowanus, Brooklyn, routing around flooded streets. It renders the semantic model in [SPEC.md](SPEC.md): street segments, intersections, catch basins, flood sensors, Citi Bike stations, riders and routes, with toolbar buttons for each action in the spec.

## Run it

It's a static site with no build step (vanilla JS, three.js from a CDN).

- **GitHub Pages:** Settings → Pages → Build and deployment → Source: *Deploy from a branch*, then pick the branch and `/ (root)`.
- **Locally:** `python3 -m http.server` in this folder, then open http://localhost:8000. (Opening `index.html` as a file won't work, because ES modules and `fetch` need a server.)

## How to use it

- Drag to orbit, right-drag to pan, scroll to zoom.
- Click any street, intersection, station, rider, catch basin or sensor to see its attributes in the panel on the right. The rule log underneath shows rules as they fire (streets closing, reroutes, strandings, dockings).
- **Rain** cycles off, light, heavy. Then **Advance time** (30 s per click) or **Play**. Streets go gray → light blue → dark blue, and get a red hatched outline once they pass 6″ and become impassable.
- **Send rider**: click a rider, then **Send rider** (or the button in the side panel), then click any station. If that station has no free docks (or is flooded), a red message says so and the rider rides to the nearest station with space instead. If their dock fills up while they're on the way, they keep looking for the next nearest one.
- **Falls**: a rider on a street with more than 3″ of water can fall off their bike. The deeper the water, the more likely. They turn red and lie on their side for 45 simulated seconds, then get back on and carry on. Each fall pops up a message and is counted in the rider's panel. (Streets over 6″ are closed, so falls happen on the 3–6″ streets riders still use.)
- **Find route**: click an origin station, then a destination. You get the flood-avoiding route (cyan), the dry-day route (dashed) and a label with both distances and the detour.
- **Mode** switches to real mode, where flood depths come from FloodNet sensors (nearest sensor within 500 ft) and catch basins with an open 311 complaint are clogged.

## Data

| Source | Live URL | Sample fallback |
| --- | --- | --- |
| Citi Bike stations | `gbfs.citibikenyc.com/.../station_information.json` | `data/sample-station-information.json` |
| Citi Bike availability | `gbfs.citibikenyc.com/.../station_status.json` | `data/sample-station-status.json` |
| FloodNet | `api.floodnet.nyc/api/rest/deployments/flood` (+ each sensor's `/depth`) | `data/sample-floodnet.json` |
| 311 catch basin complaints | NYC Open Data `erm2-nwe9` | `data/sample-311-catch-basins.json` |

If any live request fails, the app loads the sample file and shows a notice in the corner.

The sample files are a snapshot of the live feeds for the study area, taken on 2026-11-05.

**FloodNet:** the app lists FloodNet's deployed sensors, keeps the ones within about 1,000 ft of the study area, and reads each one's latest depth from the last hour (millimetres, converted to inches). Set `DATA.floodnet` in `js/config.js` to `''` to always use the sample instead.

**City context (static):** `data/context.json` holds the real city around the model, baked once from NYC Open Data and converted to local feet: building footprints with roof heights ([5zhs-2jue](https://data.cityofnewyork.us/d/5zhs-2jue)), the 2015 Street Tree Census, live trees only ([uvpi-gqnh](https://data.cityofnewyork.us/d/uvpi-gqnh)), curb lines from the planimetric pavement edge ([vs44-rznx](https://data.cityofnewyork.us/d/vs44-rznx)), the canal from planimetric hydrography ([pjs3-c3z5](https://data.cityofnewyork.us/d/pjs3-c3z5)) and parks ([enfh-gkve](https://data.cityofnewyork.us/d/enfh-gkve)). `js/street-grid.js` holds the real position of every model intersection and the canal centerline, measured from the street centerline file ([inkn-q76z](https://data.cityofnewyork.us/d/inkn-q76z)).

## Code

- `js/config.js`: study area corners, street grid, rule constants, data URLs.
- `js/model.js`: the semantic model and rules (routing, flooding, rider states, station docks). No rendering.
- `js/data.js`: live loaders with sample fallback.
- `js/context.js`: the architectural-model base: plinth, white building massing, curbs, street trees, water and parks.
- `js/street-grid.js`: generated real intersection positions and canal centerline.
- `js/main.js`: three.js scene, toolbar, picking, inspector.

## Simplifications

- The street grid is simplified: 6 north–south streets (Smith, Hoyt, Bond, Nevins, 3rd Ave, 4th Ave) and 12 east–west streets (Union to 9th). Each grid point sits at the real intersection of its two streets. Where two streets don't actually meet (for example Nevins St south of Carroll St), the point is where their lines would cross, so a few model segments run where there is no real street. Buildings that sit on a model street are left out so the street stays visible.
- Only Union, Carroll, 3rd and 9th St bridge the canal.
- Each street segment has one catch basin.
- Fall chance per simulated second is 1.2% for each inch of water above 3″ (`FALL_RATE_PER_IN` in `js/config.js`).
- Docked riders rest for 90 simulated seconds, then wait for a new ride to a random station, so the scene keeps moving.
