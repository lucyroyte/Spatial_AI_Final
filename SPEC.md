# Central Park Section

*Semantic model by Lucy and Jay.*

Create a single-page web application that visualizes the semantic model described below, given its entities, attributes, and associated rules. The scene is a stylized section of Central Park, inspired by the Lake and the Ramble, with lawns, a fenced woodland, and a lake joined by paths. People and their dogs move through the park, row boats on the lake, break fences, and leave litter, while grass, understory weeds, and duckweed grow. Rain can flood low ground and make the lake overflow. Robots mow and reseed the lawns, repair fences, weed the woods, pick up litter, and eat duckweed. Render a demonstrative example of this semantic model and give interactive means (a toolbar with buttons) to manipulate it according to the actions and rules given.

## Application requirements

* Make this project a simple single-page web application.
* Use vanilla javascript.
* The primary view should be a three.js rendered view that fills the browser window.
* Show the scene from an angled overhead camera that the user can orbit, pan, and zoom.
* Let the user select any person, dog, boat, robot, lawn, fence segment, or litter item by clicking it, and show its attributes in a small panel.
* Show the current rain intensity and lake water level in a small status display.

## Entities

* **Weather**
  * rain intensity: none, light, or heavy
* **Lawn**
  * grass height (in inches, between 2 and 20)
  * wear (percent of the lawn worn down by use, between 0 and 100)
  * boundary (a closed polygon)
  * area (calculated from the boundary)
  * elevation: low, medium, or high
  * standing water (in inches, 0 or more)
  * status: open, closed, or reseeding
* **Path**
  * width (in feet)
  * boundary (a closed polygon)
  * elevation: low, medium, or high
  * standing water (in inches, 0 or more)
* **Woods**
  * boundary (a closed polygon)
  * area (calculated from the boundary)
  * weed cover (percent of the understory covered by weeds, between 0 and 100)
* **Fence Segment**
  * position (a line along the edge of the woods)
  * status: intact or broken
* **Maintenance Gate**
  * position (a point on the edge of the woods)
* **Lake**
  * boundary (a closed polygon)
  * area (calculated from the boundary)
  * water level (in inches above or below the lake rim)
  * duckweed grid (the lake surface divided into small cells, each with a duckweed cover between 0 and 100 percent)
  * duckweed cover (percent of the whole lake covered, calculated as the average of the grid cells)
* **Boat Landing**
  * position (a point on the lake edge where a path meets the lake)
* **Boat**
  * position (x, y on the lake)
  * heading (direction of travel)
  * speed
  * rowers (1 or 2 people)
* **Litter**
  * position (x, y on the ground plane)
  * location: the lawn, path, woods, or lake it is in
* **Person**
  * position (x, y on the ground plane)
  * activity: walking, standing, sitting, or boating
  * location: the path, lawn, woods, or boat they are currently in
  * dog (the dog they are walking, if any)
* **Dog**
  * position (x, y on the ground plane)
  * owner (the person walking it)
* **Mower Robot**
  * position (x, y on the ground plane)
  * state: idle, traveling, mowing, or reseeding
  * target lawn
* **Steward Robot**
  * position (x, y on the ground plane)
  * state: idle, traveling, repairing, weeding, or collecting
  * target (a fence segment, the woods, or a litter item)
* **Skimmer Robot**
  * position (x, y on the lake)
  * state: idle, traveling, or eating
  * target (a duckweed grid cell or a floating litter item)

## Relationships

* A path borders one or more lawns, the woods, or the lake.
* A path connects to other paths where their boundaries meet.
* The woods are enclosed by fence segments, with one maintenance gate.
* A boat landing connects a path to the lake.
* A person walks on a path, a lawn, or in the woods.
* A person sits or stands on a lawn or in the woods.
* A person rows a boat on the lake.
* A dog is walked by one person and stays with them.
* A person enters or leaves the woods through a broken fence segment.
* A person boards or leaves a boat at a boat landing.
* A robot enters or leaves the woods through the maintenance gate.
* Litter is left by a person and collected by a steward robot or a skimmer robot.
* A mower robot mows or reseeds one lawn at a time.
* A skimmer robot eats duckweed on the lake.
* Rain raises standing water on lawns and paths and raises the lake water level.

## Rules

### People and dogs

* A person must always be on a path, a lawn, in the woods, or in a boat, never in the water or outside the park.
* A person can only enter a lawn whose status is open.
* The number of people on a lawn cannot exceed its area divided by 10 square feet.
* A person can only enter or leave the woods through a broken fence segment. People cannot use the maintenance gate.
* A walking person may break an intact fence segment they are next to. When time advances, each walking person next to an intact fence has a small chance of breaking it.
* Each time step, each person has a small chance of dropping litter where they stand. A person at the lake edge or in a boat may drop litter into the lake.
* A dog must always stay within 6 feet of its owner.
* A dog can go wherever its owner goes on land, but never into the lake or a boat. A person with a dog cannot board a boat.
* A person cannot enter a lawn or path with more than 3 inches of standing water. People already there move to the nearest dry path or lawn.

### Lawns, paths, and boundaries

* Lawn, path, woods, and lake boundaries cannot overlap.
* Every lawn, the woods, and the lake must border at least one path.
* Path width must be at least 1.5 feet.
* Grass height grows over time and cannot exceed 20 inches.
* A lawn with grass height above 15 inches is shown as needing mowing.
* Mowing sets grass height to 5 inches.
* A lawn can only be mowed when it has no people or dogs on it and no standing water. A mower robot waits at the edge of a lawn until it is ready.
* Each time step, a lawn's wear increases with the number of people and dogs on it. Dogs count as much as two people.
* Wear increases twice as fast while a lawn has standing water, and three times as fast while it is flooded by lake overflow.
* A lawn with wear above 70 percent is shown as needing reseeding.
* Reseeding sets the lawn status to reseeding, wear to 0, and grass height to 2 inches. People and dogs on the lawn move to the nearest path first.
* A reseeding lawn stays closed to people for a set number of time steps, then its status returns to open.
* Grass does not grow on a lawn while its wear is above 70 percent.

### Rain and flooding

* Rain intensity raises standing water on every lawn and path over time: slowly for light rain, quickly for heavy rain.
* Standing water collects fastest on low ground, then medium, then high. This is pluvial flooding.
* Rain raises the lake water level over time.
* When the lake water level rises above the lake rim, the lake overflows. Low lawns and paths bordering the lake flood first, then medium.
* When rain stops, standing water drains over time and the lake water level falls back toward the rim. Low ground drains slowest.
* Litter on a lawn or path with more than 3 inches of standing water washes toward the lake and ends up in the lake.

### Woods

* Weed cover in the woods grows over time and cannot exceed 100 percent. It grows faster for each broken fence segment, because people trampling the understory open ground for weeds.
* Weeding by a steward robot lowers weed cover over time while the robot is in the woods and weeding.
* A fence segment can only be repaired when no person is in the woods. This keeps people from being trapped inside.

### Lake, boats, and duckweed

* Duckweed cover in each grid cell grows over time and cannot exceed 100 percent. Cells next to cells with more cover grow faster, so duckweed spreads.
* A boat must always stay inside the lake boundary.
* A boat can carry at most 2 people.
* Boats cannot launch while the lake is overflowing.
* A moving boat pushes duckweed out of the cells it passes through and into the neighboring cells on either side, leaving a clear trail of open water behind it. The trail fills back in as duckweed grows.

### Robots

* Mower robots travel on paths and lawns only, never in the woods or lake.
* An idle mower robot first goes to any lawn that needs reseeding, then to the lawn with the tallest grass that needs mowing. Two mower robots never target the same lawn.
* Steward robots travel on paths, lawns, and in the woods, never in the lake. They enter the woods only through the maintenance gate.
* A steward robot can collect litter in the lake only if it is within 3 feet of the lake edge.
* An idle steward robot chooses its next task in this order: repair the nearest broken fence segment if the woods are empty, then collect the nearest litter on land, then weed the woods if weed cover is above 30 percent.
* Skimmer robots travel only on the lake.
* A skimmer robot eats duckweed, lowering the cover of the grid cell it is in over time.
* An idle skimmer robot goes to the cell with the most duckweed cover. It collects any floating litter it passes over.
* A skimmer robot must keep at least 10 feet away from boats.
* Robots cannot travel through more than 6 inches of standing water and wait until it drains.

## Actions

The toolbar should have buttons for the following actions:

* **Add person:** places a new person on a random path, with activity set to walking.
* **Remove person:** removes a selected person, along with their dog if they have one.
* **Add dog:** gives a selected person a dog, if they are not in a boat.
* **Change activity:** cycles a selected person between walking, standing, and sitting, moving them onto a nearby lawn, path, or into the woods as the rules require.
* **Go boating:** sends a selected person without a dog to the nearest boat landing and launches a boat, if the rules allow it.
* **Break fence:** breaks a selected fence segment.
* **Drop litter:** places a litter item at a random spot near a selected person.
* **Rain:** cycles rain intensity between none, light, and heavy.
* **Advance time:** moves people, dogs, boats, and robots, makes grass, weeds, and duckweed grow, updates wear, standing water, and the lake level, and applies the chance of people breaking fences and dropping litter.
* **Play / Pause:** runs advance time continuously until pressed again.
* **Add mower robot:** places a new idle mower robot on a random path.
* **Add steward robot:** places a new idle steward robot on a random path.
* **Add skimmer robot:** places a new idle skimmer robot on the lake.
* **Mow lawn:** sends the nearest idle mower robot to a selected lawn, if the rules allow it.
* **Reseed lawn:** sends the nearest idle mower robot to reseed a selected lawn.
* **Open/close lawn:** toggles the status of a selected lawn between open and closed. People and dogs on a lawn that closes move to the nearest path.
* **Reset:** returns the scene to the example scene below.

## Example scene

Render a stylized section of Central Park with a lake in the center, a fenced woods on one side of the lake, and two lawns of different sizes on the other side. A loop of paths runs around the lake, with one path crossing between the lawns and the woods. Place a maintenance gate on the woods fence where it meets a path, and one boat landing on the lake edge. Make the smaller lawn and the path along the lake low ground, so they flood first.

Start with no rain and the lake level just below its rim. Start with 14 people: 6 walking on paths (2 of them with dogs), 3 sitting on lawns, 1 standing on a lawn with a dog, 2 walking in the woods, and 2 rowing one boat on the lake. Start with 2 broken fence segments so the people in the woods can get out. Give the lawns different starting grass heights so at least one needs mowing, and give the smaller lawn a wear of 60 percent so heavy use or rain pushes it into needing reseeding. Start the woods at 40 percent weed cover and the lake at 20 percent duckweed cover, clustered in patches. Scatter 6 litter items across the lawns, paths, woods, and lake. Start with 1 mower robot and 1 steward robot idle on paths, and 1 skimmer robot idle on the lake.

Color grass by height, from short and light green to tall and dark green, and blend in brown patches as wear rises. Show closed lawns with a fence or hatching, and reseeding lawns with a pale straw color and a different hatching. Draw standing water as a translucent blue layer whose opacity rises with depth, and show falling rain as streaks whose density matches the rain intensity. Draw the woods as trees over an understory whose color shifts from brown leaf litter to bright weedy green as weed cover rises. Draw the lake as blue water with duckweed drawn cell by cell, and show each boat's wake as a V-shaped trail of open water. Show intact fence segments as wooden posts and rails, and broken segments as gaps with red markers. Show litter as small bright specks. Color people by activity, and draw dogs as small figures with a thin leash line to their owner. Give the mower, steward, and skimmer robots distinct shapes and colors, and show each robot's current target with a thin line.

---

## Addendum: spatial agents and environment design

*What the site models beyond the original spec above.*

**Thesis.** In a park where nobody holds the whole map, the layout is the information. Visitors and maintenance robots only know what they have seen, so where the signposts stand, which lawns are open and how the money is split decide both whether visitors find what they came for and whether the robots can keep the park presentable. Those goals pull against each other, so a good park has to be searched for by simulation rather than laid out by intuition.

### More entities

* **Visitor** (a person who arrives during the simulation)
  * entrance (one of the entrances where paths leave the map)
  * goals (2 to 4 places to see: named lawns, sights, the Lake, the Ramble)
  * time budget (90 to 180 minutes)
  * map (a 10 ft grid of what they have seen: unknown, open, blocked or water)
  * landmarks (places, hindrances, issues and affordances they have saved, each with where it is relative to something they already know)
  * performance: share of goals seen, whether they left within their budget, distance walked
* **Robot knowledge:** each robot has its own map; robots merge maps with the fleet's shared map when they charge, and report issues (litter, broken fences) to the robot center's job board.
* **Signpost** (position; the places within about 900 ft that it points to)
* **Sight** (a landmark visible from a distance, like Bow Bridge or Belvedere Castle; position and how far off it can be seen)
* **Environment** (what a designer controls)
  * which signposts stand
  * which lawns are closed
  * total budget in $k (signposts cost $2k each; the rest buys robots)
  * test conditions: number of visitors, weather plan (dry, a shower, a storm), random seed

### Location and distance

* **Location:** an occupant has a position in feet (real map coordinates), a region (the lawn, path, woods, lake or boat it is in), a cell on the 5 ft grid, and, in an agent's own map, a position relative to its landmarks.
* **Distance:** straight-line feet (vision range, signpost reach, asking for directions within 25 ft); walking distance along A* routes; travel time in minutes, slowed by terrain; distance from the shore (for flooding).

### More rules

* Each agent sees through a cone (people 120° and 90 ft; stewards 140° and 150 ft; mowers 100° and 100 ft; skimmers 360° and 70 ft). Plantings and buildings block sight, and the Ramble's undergrowth shortens it.
* Agents plan routes on their own maps and treat unknown ground as walkable until they see otherwise. A visitor heads back when the time left is only just enough to walk out, and walks back through ground and landmarks they know. A robot heads home when its battery only just covers the trip.
* Visitors who meet may ask for directions and copy a landmark. Reading a signpost teaches a visitor where the places it points to are.
* Other agents are obstacles: an agent steps aside or waits, then squeezes past.
* **Hindrances and affordances:** people walk at full speed on paths, 80% on lawns, 60% in the Ramble and 50% on ground with over 1″ of standing water. Ground with over 3″ of water, and closed lawns, cannot be entered. Signposts, broken fences (for people) and the gate (for stewards) are affordances.

### Environment design

* **Score:** 50 × visitor performance (60% places seen, 40% on time) + 50 × park performance (average share of time the lawns, woods and lake were presentable) − 0.04 per $1k spent.
* **Variation:** one to three changes to an environment: add or remove a signpost, close or open a lawn (at most 5 closed), or move the budget by $20k (between $80k and $320k).
* **Side by side:** two variations of the current environment run on the same test conditions. The designer keeps one, and two new variations are made from it.
* **Automated:** for a given number of epochs, make two variations of the current environment, run them on the same test conditions, and keep whichever of the three scores best.
