# Central Park Section

A single-page three.js simulation of the semantic model in [SPEC.md](SPEC.md) (Lucy & Jay): a stylized section of Central Park inspired by the Lake and the Ramble. Lawns, a fenced woods and a lake are joined by paths. People and dogs wander, row boats, break fences and drop litter. Grass, weeds and duckweed grow. Rain floods low ground and can make the lake overflow. Mower, steward and skimmer robots look after it all.

## Run it

Static files only: vanilla JavaScript, with three.js loaded from a CDN through an import map. No build step.

- **GitHub Pages:** Settings → Pages → Deploy from a branch → `main` / `(root)`.
- **Locally:** `python3 -m http.server` in this folder, then open http://localhost:8000 (ES modules need a server, so opening the file directly won't work).

## Using it

- Drag to orbit, right-drag to pan, scroll to zoom.
- Click a person, dog, boat, robot, lawn, fence segment or litter item to see its attributes. Paths, the woods, the lake, the gate and the boat landing can be clicked too.
- The panel at the bottom left shows rain intensity, the lake level against its rim, and the time step.
- Toolbar buttons that need a selection (for example **Go boating** or **Mow lawn**) light up once something of the right kind is selected. If a rule blocks an action, a message says why.
- **Space** plays or pauses; **Esc** clears the selection. The event log in the panel lists rules as they fire.

## Code

| File | What it holds |
| --- | --- |
| `js/layout.js` | The example scene's fixed geometry: lake, woods, paths, lawns, fence segments, gate, boat landing, region adjacency, walking "portals" between regions, and the duckweed grid. `validateLayout` checks the boundary rules (no overlaps, every lawn/woods/lake borders a path, path width ≥ 1.5 ft). |
| `js/model.js` | Entities, their attributes, and all rules. `RULES` at the top holds every rate and threshold. `advance()` is one time step; the action methods at the bottom back the toolbar. |
| `js/view.js` | three.js rendering: grass colored by height with brown wear patches, hatching for closed and reseeding lawns, standing water, rain streaks, trees over a leaf-litter-to-weeds understory, duckweed cell by cell, boat wakes, fences, robots and target lines. |
| `js/main.js` | Toolbar, click selection, attribute panel, status display. |
| `js/geometry.js` | Polygon helpers. |

Units are feet and inches, with x east and y north. People, dogs and robots are drawn about twice life size so they're visible from the overhead view.

## Modeling choices

Where the spec leaves room for interpretation:

- **Layout:** the woods are west of the lake, the two lawns east of it. West Walk, North Walk and the two Lakeside Walks form the loop around the lake. North Walk is the path crossing from the woods to the lawns, and Lawn Walk runs between the two lawns. The Small Lawn and both Lakeside Walks are low ground.
- **Overflow:** low lawns and paths that border the lake, or border a low lakeside path, flood as soon as the lake rises over its rim. Medium ground floods once the lake is 4″ over the rim. Overflow keeps ground wet until the lake falls back.
- **Boats** are rented at the landing. Each trip lasts a set number of steps, then the boat returns and its rowers walk off. Two people waiting at the landing share one boat.
- **Reseeding:** when the mower arrives, the lawn closes (status *reseeding*) and people walk to the nearest path. Once the lawn is empty, wear drops to 0 and grass to 2″, and the lawn stays closed for 60 steps.
- **Extra behaviors:** walkers who reach a lawn sometimes sit or stand there, and people sitting or standing occasionally get up again, so lawns empty out for mowing. People also stay off a lawn while a robot is mowing it.
