# Central Park Section

A single-page three.js simulation of the semantic model in [SPEC.md](SPEC.md) (Lucy & Jay), set on a real section of Central Park: the Lake and the Ramble, built from NYC Open Data. People and dogs wander, row boats, break fences, drop litter and feed the ducks. Grass, weeds and duckweed grow. Rain floods low ground and can make the lake overflow. A robot controller sends out mowers, stewards and skimmers from a charging center to keep all three areas presentable for most of the day.

## Run it

Static files only: vanilla JavaScript, with three.js loaded from a CDN through an import map. No build step.

- **GitHub Pages:** Settings → Pages → Deploy from a branch → `main` / `(root)`.
- **Locally:** `python3 -m http.server` in this folder, then open http://localhost:8000 (ES modules and the park data need a server, so opening the file directly won't work).

## Using it

- Drag to orbit, right-drag to pan, scroll to zoom. Select something and press **F** to fly to it.
- Click a person, dog, boat, robot, lawn, fence segment, litter item or the robot center to see its attributes. Paths, the Ramble, the Lake, the gate and the boat landing can be clicked too.
- The bottom-left panel shows rain, the lake level, the clock, the **daily goal** and what the **robot controller** is doing.
- **Auto** turns the controller on or off. **Budget** caps the total price of the fleet.
- **Fast** runs 10 minutes per tick. **Trees** hides the canopy so you can see the ground.
- **Space** plays or pauses; **Esc** clears the selection.

## The real park

`tools/bake_park.py` turns NYC Open Data into `data/park.json`. Run it again to rebuild the scene (it needs Python with numpy, scipy, shapely, rasterio and pyproj).

| Data set | Used for |
| --- | --- |
| Parks Properties (enfh-gkve) | Central Park's boundary |
| Planimetric Hydrography (pjs3-c3z5) | The Lake |
| Land Cover 2017 (he6d-2qns) | Grass, bare soil, tree canopy, buildings, paving and other water |
| Parks Trails (vjbm-hsyr) | The Ramble's trail network, surfaces and widths |
| Planimetric Roadbed (i36f-5ih7) and Pavement Edge (vs44-rznx) | Drives and walks |
| Planimetric Elevation Points (9uxf-ng6q) | Low, medium or high ground for each lawn and path |

How the regions are made:

- **The Ramble** (the woods) is the land within reach of its trail network, with a fence segment about every 40 ft along its edge, except along the shore. The maintenance gate is on the fence closest to the robot center that touches a path.
- **Paths** are paved land cover plus the mapped drives, walks and paved trails, split into pieces about 150 ft long. Gaps in the mapped network are bridged so every path can be reached.
- **Lawns** are open grass of at least 5,000 sq ft that borders a path. Lawns at known places get their names (Cherry Hill, Strawberry Fields, Cedar Hill, Boathouse Lawn and so on).
- **Plantings** (wooded ground outside the Ramble) and buildings are drawn but nobody walks there.
- Low ground is less than 5 ft above the lake, medium less than 14 ft, high anything above.

The simulation runs on a 5 ft grid. Each cell belongs to one region, and people and robots find their way with A* search. A person can only cross the Ramble's edge where a fence is broken; a robot only at the gate. One time step is one minute, and a day runs 6:00 to 22:00.

## Robots, batteries and the controller

- All robots live at the **Cherry Hill Robot Center**: a charging pad on the path, with a floating dock on the lake for skimmers.
- Each robot has a **battery**. Working drains it; when it only has enough left to get home, it drives back and charges.
- Prices: mower $18k, steward $12k, skimmer $15k. The default budget is $150k.
- Every 5 minutes the **controller** works out how many robots each job needs:
  - mowers for lawns that need mowing or reseeding;
  - a **fence fixer** steward when a fence is broken;
  - litter-picking stewards for litter, dog poop and holes;
  - a weeding steward when weeds pass 30%;
  - skimmers for duckweed over 15% and floating litter.
  
  It adds one more for any area that is behind on today's goal. Then it deploys parked robots, buys new ones if the budget allows, and parks the ones it doesn't need.
- A fence fixer goes to the broken fence and waits there until the Ramble is empty, since a fence can only be repaired with nobody inside.

## People and dogs

Every person and dog gets a random personality, shown when you click them:

- how often they **litter** and how often they **break fences**;
- whether they **feed the ducks**, which makes duckweed grow near where they stand by the water;
- whether they **pick up after their dog**, and whether they **let the dog into the woods**;
- for dogs, whether they **dig holes** in lawns.

Litter, uncollected dog poop and holes all count as mess. Stewards pick up the first two and fill holes.

## The daily goal

Each area must be presentable for at least 60% of the day:

- **Lawns:** at least 80% of the lawn area has grass at 15″ or less, wear at 70% or less, 3″ or less of standing water, and no litter, poop or holes.
- **Woods:** weeds at 50% or less, at most 3 broken fences and at most 3 pieces of litter.
- **Lake:** duckweed at 35% or less and at most 3 pieces of floating litter.

The panel shows how much of the day each area has been presentable so far, and why it is or isn't right now. At 22:00 the day is scored and a new one starts.

## Code

| File | What it holds |
| --- | --- |
| `data/park.json` | The baked scene: region polygons, the 5 ft grid of region labels, fences, gate, landing, robot center, trees and trails. |
| `tools/bake_park.py` | Builds `data/park.json` from NYC Open Data. |
| `js/layout.js` | Loads the scene and works out the grid helpers, region adjacency, distance from the lake, flood tiers, fence crossings and the duckweed grid (20 ft cells). |
| `js/nav.js` | A* search on the grid. |
| `js/model.js` | Entities, their attributes and all rules, plus batteries, the controller, personalities and the daily goal. `RULES` at the top holds every rate and threshold. `advance()` is one time step; the action methods at the bottom back the toolbar. |
| `js/view.js` | three.js rendering. People, dogs and robots get bigger as the camera pulls back, so they stay visible over the whole map. |
| `js/main.js` | Toolbar, click selection, attribute panel, goal and controller panel. |
| `js/geometry.js` | Polygon helpers. |

## Modeling choices

Where the spec leaves room for interpretation:

- **Overflow:** low lawns and paths by the lake flood as soon as the lake rises over its rim. Medium ground by the lake floods once it is 4″ over.
- **Boats** launch from the Loeb Boathouse landing. Each trip lasts 90 minutes, then the boat returns and its rowers walk off.
- **Reseeding:** when the mower arrives, the lawn closes and people walk to the nearest path. Once it is empty, wear drops to 0 and grass to 2″, and the lawn stays closed for 2 hours.
- **Extra behaviors:** walkers who reach a lawn sometimes sit or stand there, and people sitting or standing get up again now and then, so lawns empty out for mowing. People also stay off a lawn while a robot is mowing it.
