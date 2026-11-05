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
- **Find route**: click an origin station, then a destination. You get the flood-avoiding route (cyan), the dry-day route (dashed) and a label with both distances and the detour.
- **Mode** switches to real mode, where flood depths come from FloodNet sensors (nearest sensor within 500 ft) and catch basins with an open 311 complaint are clogged.

## Data

| Source | Live URL | Sample fallback |
| --- | --- | --- |
| Citi Bike stations | `gbfs.citibikenyc.com/.../station_information.json` | `data/sample-station-information.json` |
| Citi Bike availability | `gbfs.citibikenyc.com/.../station_status.json` | `data/sample-station-status.json` |
| FloodNet | not set yet (see below) | `data/sample-floodnet.json` |
| 311 catch basin complaints | NYC Open Data `erm2-nwe9` | `data/sample-311-catch-basins.json` |

If any live request fails, the app loads the sample file and shows a notice in the corner.

The sample files are made up for offline use. Station names and positions are approximate, and the FloodNet readings are illustrative (one sensor near Nevins St & 3rd St reads 7.2″ so real mode has something to show).

**FloodNet endpoint:** the spec says this is still to be confirmed, so `DATA.floodnet` in `js/config.js` is empty and the sample is always used. Set it to a URL that returns a list of sensors with `id`, `lat`, `lon` and a depth (`depth_in`, `depth_inches`, `depth` in inches, or `depth_mm`).

## Code

- `js/config.js`: study area corners, street grid, rule constants, data URLs.
- `js/model.js`: the semantic model and rules (routing, flooding, rider states, station docks). No rendering.
- `js/data.js`: live loaders with sample fallback.
- `js/main.js`: three.js scene, toolbar, picking, inspector.

## Simplifications

- The street grid is simplified: 6 north–south streets (Smith, Hoyt, Bond, Nevins, 3rd Ave, 4th Ave) and 12 east–west streets (Union to 9th). Grid points are placed by interpolating between the four real corner coordinates, then every lat/lon is converted to local feet.
- Only Union, Carroll, 3rd and 9th St bridge the canal.
- Each street segment has one catch basin.
- Docked riders rest for 90 simulated seconds, then wait for a new ride to a random station, so the scene keeps moving.
