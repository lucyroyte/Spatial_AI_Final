"""
Markdown file of semantic model
Lucy and Jay
"""

# Gowanus Flood Routing

Create a single-page web application that visualizes the semantic model described below, given its entities, attributes, and associated rules. The scene is the Gowanus neighborhood in Brooklyn: a street network around the Gowanus Canal, Citi Bike stations, and riders who move between stations on routes that avoid flooded streets. Render a demonstrative example of this semantic model and give interactive means (a toolbar with buttons) to manipulate it according to the actions and rules given.

The app has two modes. **Real mode** loads live data: Citi Bike station locations and availability, FloodNet flood sensor readings, and recent 311 catch basin complaints. **Simulation mode** ignores live flood data and lets the user make it rain and flood the streets.

## Application requirements

- Make this project a simple single-page web application.
- Use vanilla javascript.
- The primary view should be a three.js rendered view that fills the browser window.
- Show the scene from an angled overhead camera that the user can orbit, pan, and zoom.
- Convert all latitude/longitude data into local x, y coordinates in feet on the ground plane, centered on the study area.
- If a live data request fails, load a bundled sample JSON file instead and show a small notice in the interface saying that sample data is in use.

## Study area

- Bounded roughly by Union Street to the north, 9th Street to the south, Smith Street to the west, and 4th Avenue to the east.
- The Gowanus Canal runs north–south through the middle of the area and is shown as water.
- Streets nearest the canal are the lowest ground and flood first.

## Entities

Describe each entity with the following parameters:

- Street Segment
    - name (street name)
    - centerline (a line between two intersections)
    - width (in feet)
    - boundary (a closed polygon calculated from the centerline and width)
    - length (in feet, calculated from the centerline)
    - elevation (low, medium, or high, based on distance from the canal)
    - flood depth (in inches, 0 or more)
    - passable: yes or no (calculated from flood depth)
- Intersection
    - position (x, y on the ground plane)
    - connected segments (the street segments that meet here)
- Catch Basin
    - position (x, y on the ground plane)
    - segment (the street segment it drains)
    - status: clear or clogged
- Flood Sensor
    - id (FloodNet sensor id)
    - position (x, y on the ground plane)
    - segment (the street segment it sits on)
    - depth reading (in inches)
- Citi Bike Station
    - id and name (from the Citi Bike feed)
    - position (x, y on the ground plane)
    - capacity (total docks)
    - bikes available
    - docks available
    - status: open or flooded
- Rider
    - position (x, y on the ground plane)
    - state: waiting, riding, docked, or stranded
    - origin station
    - destination station
    - route (the current route they are following)
- Route
    - segments (an ordered list of street segments from origin station to destination station)
    - flood-avoiding distance (in feet, the sum of segment lengths)
    - dry-day distance (in feet, the shortest route if no streets were flooded)
    - detour (in feet, flood-avoiding distance minus dry-day distance)

## Relationships

- A street segment connects two intersections.
- Street segments connect to each other at intersections.
- A catch basin drains one street segment.
- A flood sensor sits on one street segment.
- A Citi Bike station sits beside one street segment.
- A rider starts at an origin station and travels to a destination station.
- A rider follows one route, made of connected street segments.

## Rules

- A rider must always be at a station or on a street segment, never inside a building block or in the canal.
- A street segment is impassable for bikes when its flood depth is greater than 6 inches.
- A route can only use passable street segments.
- A route is always the shortest path through passable segments between its two stations.
- A rider can only start a ride at a station with at least 1 bike available. Starting a ride takes one bike from that station and frees one dock.
- A rider can only end a ride at a station with at least 1 dock available. Ending a ride returns one bike and fills one dock.
- If the destination station is full or flooded, the rider is rerouted to the nearest open station that has a dock available.
- Bikes available plus docks available can never exceed a station's capacity.
- A station is flooded when the street segment beside it is impassable. Riders cannot start or end rides at a flooded station.
- When a street segment becomes impassable, every rider whose route crosses it is given a new route.
- If no route exists, the rider's state becomes stranded and they wait in place until a route opens.
- In real mode, a segment's flood depth comes from the nearest flood sensor within 500 feet. Segments with no sensor within 500 feet have a depth of 0.
- In real mode, catch basins on segments with an open 311 catch basin complaint are clogged.
- In simulation mode, rain raises flood depth on every segment over time. Low segments rise fastest, then medium, then high.
- A segment with a clogged catch basin floods twice as fast as one with a clear catch basin.
- When rain stops, flood depth drains back toward 0 over time. Segments with clogged catch basins drain at half speed.

## Actions

The toolbar should have buttons for the following actions:

- Real / Simulation: toggles between real mode and simulation mode. Switching to simulation mode starts with all flood depths at 0 and keeps the current stations and riders.
- Refresh live data: in real mode, reloads Citi Bike, FloodNet, and 311 data.
- Find route: the user clicks an origin station and then a destination station. Shows the flood-avoiding route, the dry-day route as a faint dashed line, and a label with both distances and the detour.
- Add rider: places a new rider at a random open station with bikes available, picks a random destination station, and gives them a route.
- Remove rider: removes a selected rider.
- Rain: in simulation mode, cycles rain intensity between off, light, and heavy.
- Advance time / Play: moves riding riders along their routes and updates flood depths. Play runs time continuously until pressed again.
- Clog / clear catch basin: toggles the status of a selected catch basin.
- Reset: returns the scene to the example scene below.

## Data sources

- Citi Bike station information: `https://gbfs.citibikenyc.com/gbfs/en/station_information.json` (names, positions, capacity). Keep only stations inside the study area.
- Citi Bike station status: `https://gbfs.citibikenyc.com/gbfs/en/station_status.json` (bikes and docks available).
- FloodNet: sensor locations and current depth readings for sensors inside the study area, from the FloodNet API or a saved export (endpoint to be confirmed).
- NYC 311 (NYC Open Data): recent open catch basin complaints inside the study area.

## Example scene

Render the Gowanus study area with a simplified street grid, the canal down the middle, and the Citi Bike stations inside the area. Start in simulation mode with no rain, all streets dry, and 8 riders: 5 riding between stations, 2 waiting at stations, and 1 docked. Make 3 catch basins near the canal clogged so that heavy rain floods those blocks first and forces visible detours.

Color street segments by flood depth, from dry gray through light blue to dark blue, and outline impassable segments in red with hatching. Show each Citi Bike station as a column whose height shows bikes available, gray out flooded stations, and show flood sensors as small markers labeled with their depth reading. Color riders by state, and draw each riding rider's route as a glowing line on the street.
