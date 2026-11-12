# Central Park Section

A single-page three.js simulation of the semantic model in [SPEC.md](SPEC.md) (Lucy & Jay), set on a real section of Central Park: the Lake and the Ramble, built from NYC Open Data. People and dogs wander, row boats, break fences, drop litter and feed the ducks. Grass, weeds and duckweed grow. Rain floods low ground and can make the lake overflow. A robot controller sends out mowers, stewards and skimmers from a charging center to keep all three areas presentable for most of the day. An **environment designer** generates variations of the park's layout, runs them side by side or evolves them over epochs, and scores how the agents do in each.

## Thesis

In a park where nobody holds the whole map, the layout is the information. Visitors and maintenance robots only know what they have seen, so where the signposts stand, which lawns are open and how the money is split decide both whether visitors find what they came for and whether the robots can keep the park presentable. Those two goals pull against each other: a dollar of signage is a dollar not spent on robots, and a lawn closed to rest its grass is a lawn a visitor can't reach. So a good park can't be laid out by intuition. It has to be searched for, by running agents with limited knowledge through each arrangement and comparing how they do.

## Run it

Static files only: vanilla JavaScript, with three.js loaded from a CDN through an import map. No build step.

- **GitHub Pages:** Settings → Pages → Deploy from a branch → `main` / `(root)`.
- **Locally:** `python3 -m http.server` in this folder, then open http://localhost:8000 (ES modules and the park data need a server, so opening the file directly won't work).

## Using it

- Drag to orbit, right-drag to pan, scroll to zoom. Select something and press **F** to fly to it.
- Click a person, dog, boat, robot, lawn, fence segment, litter item or the robot center to see its attributes. Paths, the Ramble, the Lake, the gate and the boat landing can be clicked too.
- The bottom-left panel shows rain, the lake level, the clock, the **daily goal** and what the **robot controller** is doing.
- **Design environments** opens the environment designer (below). **About** shows the thesis and how the site meets the brief.
- **Auto** turns the controller on or off. **Budget** caps the total price of the fleet.
- **Step** advances one minute; **Fast** runs 10 minutes per tick.
- **More actions** holds the rest of the spec's toolbar: adding and removing people, dogs, boating, litter, fences, mowing, reseeding, closing lawns, adding robots, and hiding trees. The ones for a selected person, lawn or fence also show in its panel.
- **Space** plays or pauses; **Esc** closes a panel or clears the selection; **K** shows what the selected agent knows; **M** opens the robot monitor.

## The environment designer

The designer is the simulation's primary function. An **environment** is what a park designer could change:

- which of the 32 **signposts** stand (affordances: a visitor who reads one learns where the places it points to are);
- which **lawns are closed** for restoration (obstacles to walkers, but no wear);
- the **total budget**: signposts cost $2k each and the rest buys robots.

Every environment runs in a web worker for 2, 4 or 8 hours of park time, with the same visitors (same entrances, goals and personalities) and the same weather, so a difference in score comes from the layout. The score is 50 × the visitors' performance (60% places seen, 40% on time) + 50 × the park's (average share of time the lawns, woods and lake were presentable) − 0.04 per $1k spent. Each card shows the score, its parts, and a map of the layout with where agents walked.

- **Choose side by side:** two variations (one to three changes each) of the current environment run next to each other. Keep one and two new variations are made from it. *Neither* tries two more; *Start over* goes back to the example park or a random one.
- **Evolve automatically:** give it a number of epochs. Each epoch makes two variations, runs them, and keeps whichever of the three scores best. A chart shows the score by epoch.
- **Open in park** loads any environment into the 3D view so you can watch it. **Reset** returns to the example scene.
- **Download results** saves every environment run, the choices that led to the current one and the epoch scores as JSON.

## Hindrances and affordances

People walk at full speed on paths, 80% on lawns, 60% in the Ramble's undergrowth and 50% on ground with more than 1″ of standing water. Ground with more than 3″ of water and closed lawns can't be entered. Slower ground costs visitors time against their visit budget. Signposts, broken fences (for people) and the maintenance gate (for stewards) are affordances.

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
- The center is a small building with a **monitor** on its wall that shows a live map of the fleet. Click the building, press **M** or use **Robot monitor** to open it full size. It shows where every robot is, what it is doing, the trail of where it has been over the last 4 hours, how far it has driven and its battery. Click a robot on the map or in the list to follow it. While the monitor is open, the trails are also drawn in the park.
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

## Agents: what they know and how they find their way

Following the *Spatial AI → Spatial Agents* workshop, two kinds of agent, **visitors** and **robots**, only act on what they have seen for themselves.

- **Limited knowledge at spawn.** A visitor comes in at one of 18 entrances found on the edge of the map. They know only the ground within 40 ft and a landmark for where they came in. Robots start knowing nothing.
- **A cone of vision.** Every step each agent casts rays through its cone (people 120° and 90 ft; stewards 140° and 150 ft; mowers 100° and 100 ft; skimmers 360° and 70 ft). Plantings and buildings stop a ray, and the Ramble's undergrowth stops it after a short way. Tall sights (Bow Bridge, Belvedere Castle, Bethesda Terrace and others in `data/sights.json`) can be seen from further off.
- **A map of their own.** Each agent keeps a 10 ft grid of what it has seen: open, blocked, water or unknown. Routes are planned on that map. Unknown ground is assumed walkable until they see otherwise, so agents re-plan when they find a closed lawn or a flooded path.
- **Goals and performance.** Each visitor wants to see 2 to 4 places (named lawns, sights, the Lake, the Ramble) within a 90 to 180 minute visit. They explore toward unknown ground, head straight for a goal once they know where it is, and turn back with enough time to walk out. When they leave, the log records how many places they saw, the time taken against their budget, and the distance walked. The Visitors panel sums these up. Robots are judged by the daily goal.
- **Landmarks.** Agents save landmarks with the useful information about them. Places are saved with where they are relative to something already known (for example "120 ft north of Cherry Hill"). Hindrances are flooded or closed ground. Issues are litter and broken fences, which robots report to the robot center's job board. Affordances are signposts and gaps in the fence. Signposts at busy junctions and entrances point to places within about 900 ft.
- **Using landmarks.** The walk back uses only ground the visitor has seen, through the landmarks they saved. Visitors who meet sometimes ask each other for directions and copy a landmark. Robots merge their maps with the fleet's map whenever they charge.
- **Other agents are obstacles.** An agent that finds someone on its next step sidesteps or waits, then squeezes past after a few tries. A mower that has waited too long on an occupied lawn asks the people there to move.
- **Blind robots.** The controller only knows what robots and some visitors have reported. Stewards with no job patrol the ground the fleet has seen least recently, and the fence fixer walks the fence line.

**Seeing it.** Select a person or robot to see its cone of vision. Press **K** or **Show what they know** to see its map (dark is unknown), its landmarks as pins, the route it planned, and an × where it last saw each other agent. The **Show** menu in the Agents group has park-wide overlays: where everyone walked, where landmarks were left, how much of each spot the visitors in the park know, and the robot fleet's shared map. **Add 25 visitors** brings in 25 more. Trees are hidden while an overlay is on.

## Code

| File | What it holds |
| --- | --- |
| `data/park.json` | The baked scene: region polygons, the 5 ft grid of region labels, fences, gate, landing, robot center, trees and trails. |
| `tools/bake_park.py` | Builds `data/park.json` from NYC Open Data. |
| `js/layout.js` | Loads the scene and works out the grid helpers, region adjacency, distance from the lake, flood tiers, fence crossings and the duckweed grid (20 ft cells). |
| `js/nav.js` | A* search on the grid. |
| `js/model.js` | Entities, their attributes and all rules, plus batteries, the controller, personalities and the daily goal. `RULES` at the top holds every rate and threshold. `advance()` is one time step; the action methods at the bottom back the toolbar. |
| `js/view.js` | three.js rendering. People, dogs and robots get bigger as the camera pulls back, so they stay visible over the whole map. |
| `js/mind.js` | One agent's knowledge: its 10 ft map, landmarks, the others it has seen, and the vision cones. |
| `js/agents.js` | Agent behaviors mixed into the model: vision, visitors' goals, exploring and landmarks, giving way, robots reporting and patrolling, visitor stats. |
| `js/knowledge.js` | Draws an agent's map, cone, landmarks and route, the park-wide overlays, and signposts. |
| `data/sights.json` | Sights visitors can look for, placed from their latitude and longitude. `sight` is how far off each can be seen, in feet. |
| `js/monitor.js` | Draws the robot center's monitor map (used on the building's screen and in the monitor panel). |
| `js/main.js` | Toolbar, click selection, attribute panel, goal and controller panel, robot monitor. |
| `js/designer.js` | Environments: the example one, variations, random ones, running one and scoring it. No page code, so it also runs in workers. |
| `js/designer-worker.js` | A web worker that runs environments off the page's thread. |
| `js/designer-ui.js` | The designer panel: side-by-side rounds, epochs, the score chart, maps and the results download. |
| `js/geometry.js` | Polygon helpers. |

## Modeling choices

Where the spec leaves room for interpretation:

- **Overflow:** low lawns and paths by the lake flood as soon as the lake rises over its rim. Medium ground by the lake floods once it is 4″ over.
- **Boats** launch from the Loeb Boathouse landing. Each trip lasts 90 minutes, then the boat returns and its rowers walk off.
- **Reseeding:** when the mower arrives, the lawn closes and people walk to the nearest path. Once it is empty, wear drops to 0 and grass to 2″, and the lawn stays closed for 2 hours.
- **Extra behaviors:** walkers who reach a lawn sometimes sit or stand there, and people sitting or standing get up again now and then, so lawns empty out for mowing. People also stay off a lawn while a robot is mowing it.
