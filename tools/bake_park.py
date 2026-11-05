"""Bake a real section of Central Park (the Lake and the Ramble) from NYC Open
Data into data/park.json for the simulation.

Sources (NYC Open Data):
  he6d-2qns  Land Cover Raster (2017, LiDAR)  -> grass, tree canopy, bare soil and paving
             (read at 4 ft from the dataset's overview file, streamed out of its zip)
  enfh-gkve  Parks Properties                 -> the Central Park boundary
  pjs3-c3z5  Planimetric Hydrography          -> the Lake outline
  vjbm-hsyr  Parks Trails                     -> the Ramble's trails, surfaces and widths
  i36f-5ih7  Planimetric Roadbed              -> the park drives
  vs44-rznx  Planimetric Pavement Edge        -> paved walks the canopy hides from the land cover
  9uxf-ng6q  Planimetric Elevation Points     -> ground elevation (low / medium / high)

How the model's regions come out of that:
  lake   the Lake polygon
  woods  the Ramble: land inside the reach of its trail network (one fenced area)
  paths  paved land cover plus the drive, walk and trail lines (gaps bridged so
         every piece joins one network), split into
         segments about 150 ft long so each has its own standing water and elevation
  lawns  the remaining grass and tree-shaded ground, split by the paths; pieces
         under 5,000 sq ft become plantings that people stay out of
  wear   starting wear comes from the share of bare soil on each lawn

Run: pip install shapely numpy scipy rasterio pyproj && python3 tools/bake_park.py
Output is in NY State Plane feet (EPSG:2263), shifted so (0, 0) is the crop center.
"""
import io, json, math, os, sys, time, urllib.parse, urllib.request, zipfile, shutil
import numpy as np
import shapely
from shapely.geometry import shape, box, Point, Polygon, MultiPolygon, LineString
from shapely.ops import unary_union, nearest_points
from scipy import ndimage
import rasterio
from rasterio import features
from rasterio.windows import from_bounds
from pyproj import Transformer

LON0, LON1, LAT0, LAT1 = -73.9750, -73.9657, 40.7737, 40.7803
CELL = 5.0
CACHE = os.environ.get('LANDCOVER_DIR', '/tmp/landcover')
OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'park.json')
T = Transformer.from_crs(4326, 2263, always_xy=True)
log = lambda *a: print(*a, file=sys.stderr, flush=True)

def fetch(dataset, where=None, extra=''):
    q = '$limit=50000' + ('&$where=' + urllib.parse.quote(where) if where else '') + extra
    for k in range(5):
        try:
            with urllib.request.urlopen(f"https://data.cityofnewyork.us/resource/{dataset}.json?{q}", timeout=120) as r:
                return json.load(r)
        except Exception as e:
            log('retrying', dataset, e); time.sleep(2 ** k)
    raise RuntimeError(f'could not fetch {dataset}')

# ---------- land cover raster ----------
LC_URL = 'https://data.cityofnewyork.us/api/views/he6d-2qns/files/64c49dc7-c17f-43db-a4e3-669a28f73234?filename=Land_Cover.zip'
class RangeFile(io.RawIOBase):
    def __init__(self, url):
        self.url, self.pos = url, 0
        req = urllib.request.Request(url, headers={'Range': 'bytes=0-0'})
        self.size = int(urllib.request.urlopen(req).headers['Content-Range'].split('/')[1])
    def seekable(self): return True
    def readable(self): return True
    def tell(self): return self.pos
    def seek(self, o, w=0):
        self.pos = o if w == 0 else self.pos + o if w == 1 else self.size + o
        return self.pos
    def readinto(self, b):
        if self.pos >= self.size: return 0
        end = min(self.size, self.pos + len(b)) - 1
        for k in range(5):
            try:
                req = urllib.request.Request(self.url, headers={'Range': f'bytes={self.pos}-{end}'})
                d = urllib.request.urlopen(req, timeout=120).read(); break
            except Exception:
                time.sleep(2 ** k)
        b[:len(d)] = d; self.pos += len(d)
        return len(d)

def landcover_path():
    img = os.path.join(CACHE, 'NYC_2017_LiDAR_LandCover.img')
    if os.path.exists(os.path.join(CACHE, 'NYC_2017_LiDAR_LandCover.rrd')): return img
    os.makedirs(CACHE, exist_ok=True)
    log('streaming land cover overviews (~72 MB download, ~2 GB on disk)…')
    z = zipfile.ZipFile(io.BufferedReader(RangeFile(LC_URL), buffer_size=8 << 20))
    for n in ['NYC_2017_LiDAR_LandCover.img', 'NYC_2017_LiDAR_LandCover.img.aux.xml', 'NYC_2017_LiDAR_LandCover.rrd']:
        with z.open('Land_Cover/' + n) as src, open(os.path.join(CACHE, n), 'wb') as dst: shutil.copyfileobj(src, dst, 16 << 20)
    open(os.path.join(CACHE, 'NYC_2017_LiDAR_LandCover.ige'), 'wb').close()  # full-res data not needed
    return img

# ---------- crop and grid ----------
X0, Y0 = T.transform(LON0, LAT0); X1, Y1 = T.transform(LON1, LAT1)
XC, YC = (X0 + X1) / 2, (Y0 + Y1) / 2
W, H = X1 - X0, Y1 - Y0
cols, rows = int(W // CELL), int(H // CELL)
gx0, gy0 = -cols * CELL / 2, -rows * CELL / 2
def to_local(g): return shapely.transform(g, lambda a: np.column_stack([a[:, 0] - XC, a[:, 1] - YC]))
def lonlat_local(g): return to_local(shapely.transform(g, lambda a: np.column_stack(T.transform(a[:, 0], a[:, 1]))))
def ll(lon, lat): x, y = T.transform(lon, lat); return Point(x - XC, y - YC)
CROP = box(gx0, gy0, gx0 + cols * CELL, gy0 + rows * CELL)
cx = gx0 + (np.arange(cols) + 0.5) * CELL
cy = gy0 + (np.arange(rows) + 0.5) * CELL
GX, GY = np.meshgrid(cx, cy)            # row 0 = southmost
def mask_of(g):
    if g.is_empty: return np.zeros((rows, cols), bool)
    shapely.prepare(g)
    return shapely.contains_xy(g, GX, GY)
def polys(g):
    if g is None or g.is_empty: return []
    if isinstance(g, Polygon): return [g]
    out = []
    for p in getattr(g, 'geoms', []): out += polys(p)
    return out

log('land cover…')
with rasterio.open(landcover_path(), OVERVIEW_LEVEL=2) as ds:   # 4 ft cells
    win = from_bounds(X0 - 20, Y0 - 20, X1 + 20, Y1 + 20, ds.transform)
    lc_raw = ds.read(1, window=win)
    tr = ds.window_transform(win)
inv = ~tr
ci, ri = inv * (GX + XC, GY + YC)
LC = lc_raw[np.clip(ri.astype(int), 0, lc_raw.shape[0] - 1), np.clip(ci.astype(int), 0, lc_raw.shape[1] - 1)]
# 1 canopy, 2 grass/shrub, 3 bare soil, 4 water, 5 buildings, 6 roads, 7 other paved

log('vectors…')
BOXQ = f"{LAT1},{LON0},{LAT0},{LON1}"
park = lonlat_local(shape(fetch('enfh-gkve', "gispropnum='M010'")[0]['multipolygon'])).buffer(0).intersection(CROP)
hydro = fetch('pjs3-c3z5', f"within_box(the_geom,{BOXQ})")
lake = lonlat_local(shape(next(h for h in hydro if h['name'] == 'THE LAKE')['the_geom'])).buffer(0).intersection(CROP)
lake = max(polys(lake), key=lambda p: p.area).simplify(1.0)
trails = fetch('vjbm-hsyr', f"within_box(shape,{BOXQ})")
roads = fetch('i36f-5ih7', f"within_box(the_geom,{BOXQ})")
edges = fetch('vs44-rznx', f"within_box(the_geom,{BOXQ})")
elev = fetch('9uxf-ng6q', f"within_box(the_geom,{BOXQ})")

WIDTH = {'Less than 2 feet': 1.8, '2 feet to less than 4 feet': 3, '4 feet to less than 6 feet': 5, '6 feet to less than 8 feet': 7, 'Over 8 feet': 10}
trail_items = [{'g': lonlat_local(shape(t['shape'])), 'w': WIDTH.get(t.get('width_ft'), 5), 'surface': t.get('surface'), 'name': t.get('trail_name')} for t in trails]
ramble = unary_union([t['g'] for t in trail_items]).buffer(45).buffer(-30).intersection(park)
vec_paths = unary_union([lonlat_local(shape(r['the_geom'])).buffer(0) for r in roads] +
                        [lonlat_local(shape(e['the_geom'])).buffer(5) for e in edges]).intersection(park)

M_park = mask_of(park)
M_lake = mask_of(lake) & M_park
M_water = (LC == 4) & M_park & ~M_lake
M_build = (LC == 5) & M_park
M_paved = ((LC == 6) | (LC == 7)) & M_park
M_vec = mask_of(vec_paths)
M_ramble = mask_of(ramble) & M_park & ~M_lake & ~M_water & ~M_build & ~(LC == 6)
# Woods: the largest connected part of the Ramble, with small holes filled.
lab, n = ndimage.label(M_ramble)
sizes = ndimage.sum(M_ramble, lab, range(1, n + 1))
M_woods = lab == (1 + int(np.argmax(sizes)))
M_woods = ndimage.binary_fill_holes(M_woods) & ~M_lake & ~M_water & ~M_build
free = M_park & ~M_lake & ~M_water & ~M_build & ~M_woods
M_path = free & (M_paved | M_vec)
# Paths narrower than the land cover can see: stamp the trail lines outside the woods.
for t in trail_items:
    if t['surface'] in ('Dirt', 'Wood Chips'): continue
    M_path |= mask_of(t['g'].buffer(max(t['w'], CELL) / 2)) & free
# Drop specks of paving (parking spots of a few cells) into the ground around them.
lab, n = ndimage.label(M_path, structure=np.ones((3, 3)))
sizes = ndimage.sum(M_path, lab, range(1, n + 1))
for i, s in enumerate(sizes):
    if s < 12: M_path[lab == i + 1] = False
# The mapped paths have gaps (under trees, at crossings). Join every piece to
# the main network with the shortest run of cells across open ground, so
# anywhere on a path can be walked to (4-connected, no corner cutting).
from collections import deque
lab, n = ndimage.label(M_path)
sizes = ndimage.sum(M_path, lab, range(1, n + 1))
main = 1 + int(np.argmax(sizes))
came = np.full(rows * cols, -2, np.int64)
flat_lab, flat_free = lab.ravel(), free.ravel()
q = deque()
for i in np.flatnonzero(flat_lab == main): came[i] = -1; q.append(i)
joined = set([main])
while q:
    c = q.popleft()
    r, k = divmod(c, cols)
    for j in (c - 1 if k > 0 else -1, c + 1 if k + 1 < cols else -1, c - cols if r > 0 else -1, c + cols if r + 1 < rows else -1):
        if j < 0 or came[j] != -2 or not flat_free[j]: continue
        came[j] = c
        comp = flat_lab[j]
        if comp and comp not in joined:
            joined.add(comp)
            t = came[j]
            while t >= 0 and flat_lab[t] != main:
                M_path.flat[t] = True; t = came[t]
            for i in np.flatnonzero(flat_lab == comp): flat_lab[i] = main; came[i] = c; q.append(i)
        elif comp == 0 or comp == main:
            q.append(j)
lab, n = ndimage.label(M_path)
log(f"path pieces joined: {len(joined) - 1}, still separate: {n - 1}")
# Pieces that open ground can't reach stay as plain ground.
if n > 1:
    sizes = ndimage.sum(M_path, lab, range(1, n + 1))
    M_path = lab == (1 + int(np.argmax(sizes)))
M_ground = free & ~M_path

# Lawns: open grass (and the worn bare soil in it) split by paths; scattered
# trees over a lawn stay part of it. Ground under closed canopy, and lawn
# pieces under 5,000 sq ft, become plantings that people stay out of.
M_open = ndimage.binary_closing((LC == 2) | (LC == 3), structure=np.ones((3, 3)), iterations=2) & M_ground
lab, n = ndimage.label(M_open)
sizes = ndimage.sum(M_open, lab, range(1, n + 1)) * CELL * CELL
lawn_ids = [i + 1 for i, s in enumerate(sizes) if s >= 5000]
M_plant = M_ground.copy()
for i in lawn_ids: M_plant[lab == i] = False
lab_lawn = lab
# Every lawn must border a path (rule); lawns cut off by plantings become plantings.
near_path = ndimage.binary_dilation(M_path, structure=np.ones((3, 3)))
for i in list(lawn_ids):
    if not (near_path & (lab == i)).any():
        lawn_ids.remove(i); M_plant[lab == i] = True

# Path segments: path cells cut into ~150 ft tiles, 8-connected inside each tile.
TILE = 30
tiles = (np.arange(rows)[:, None] // TILE) * 1000 + (np.arange(cols)[None, :] // TILE)
seg = np.zeros((rows, cols), np.int32); nseg = 0
for t in np.unique(tiles[M_path]):
    m = M_path & (tiles == t)
    l, k = ndimage.label(m, structure=np.ones((3, 3)))
    seg[m] = l[m] + nseg; nseg += k
# Fold tiny segments into a neighbor.
for _ in range(3):
    counts = np.bincount(seg.ravel(), minlength=nseg + 1)
    small = [i for i in range(1, nseg + 1) if 0 < counts[i] < 10]
    if not small: break
    for i in small:
        m = seg == i
        ring = ndimage.binary_dilation(m, structure=np.ones((3, 3))) & ~m & (seg > 0)
        if ring.any(): seg[m] = np.bincount(seg[ring]).argmax()

# ---------- elevation ----------
pts = []
for e in elev:
    if e.get('feat_code') not in ('3000', '3020'): continue
    p = lonlat_local(Point(e['the_geom']['coordinates']))
    z = float(e['elevation'])
    if park.contains(p) and z < 140: pts.append((p.x, p.y, z))
EP = np.array(pts)
def elev_at(x, y):
    d = np.hypot(EP[:, 0] - x, EP[:, 1] - y) + 5
    w = 1 / d ** 2
    return float((w * EP[:, 2]).sum() / w.sum())
near_lake = [z for x, y, z in pts if lake.exterior.distance(Point(x, y)) < 25]
lake_elev = float(np.percentile(near_lake, 20))
def region_elev(m):
    ys, xs = np.nonzero(m)
    k = np.linspace(0, len(xs) - 1, min(len(xs), 12)).astype(int)
    return float(np.mean([elev_at(cx[xs[i]], cy[ys[i]]) for i in k]))
def elev_class(z):
    rel = z - lake_elev
    return 'low' if rel < 5 else 'medium' if rel < 14 else 'high'

# ---------- regions and grid ----------
def vectorize(m, smooth=2.0, simp=1.2):
    shapes = features.shapes(m.astype(np.uint8), mask=m, transform=rasterio.Affine(CELL, 0, gx0, 0, CELL, gy0))
    g = unary_union([shape(s) for s, v in shapes if v == 1])
    if smooth: g = g.buffer(smooth, join_style='round').buffer(-smooth, join_style='round')
    return g.simplify(simp)
def rings(g, simp=0):
    out = []
    for p in polys(g):
        if p.area < 30: continue
        rr = [p.exterior] + [h for h in p.interiors if Polygon(h).area > 60]
        out.append([[[round(x, 1), round(y, 1)] for x, y in list(r.coords)[:-1]] for r in rr])
    return out

LANDMARKS = [('Cherry Hill', -73.97275, 40.77505), ('Hernshead', -73.97415, 40.77685), ('Bethesda Lawn', -73.9718, 40.7742),
             ('Strawberry Fields', -73.97505, 40.77575), ('Bank Rock Lawn', -73.97245, 40.77905), ('Boathouse Lawn', -73.9682, 40.7748),
             ('Belvedere Slope', -73.9692, 40.7797), ('Cedar Hill', -73.9665, 40.7765), ('Conservatory Lawn', -73.9668, 40.7740)]
regions = []
label = np.zeros((rows, cols), np.uint16)
def add(r, m):
    regions.append(r); label[m] = len(regions); r['cells'] = int(m.sum())
add({'id': 'lake', 'kind': 'lake', 'name': 'The Lake', 'elevation': 'low', 'area': round(lake.area), 'polygons': rings(lake)}, M_lake)
wz = region_elev(M_woods)
add({'id': 'woods', 'kind': 'woods', 'name': 'The Ramble', 'elevation': elev_class(wz), 'elevationFt': round(wz, 1),
     'area': round(M_woods.sum() * CELL * CELL), 'polygons': rings(vectorize(M_woods, 3, 1.5))}, M_woods)
lawn_meta = []
for k, i in enumerate(sorted(lawn_ids, key=lambda i: -sizes[i - 1])):
    m = lab_lawn == i
    z = region_elev(m)
    g = vectorize(m)
    soil = float(((LC == 3) & m).sum() / m.sum())
    canopy = float(((LC == 1) & m).sum() / m.sum())
    name = None
    for nm, lo, la in LANDMARKS:
        if nm not in [r['name'] for r in regions] and g.buffer(40).contains(ll(lo, la)): name = nm; break
    add({'id': f'lawn-{k + 1}', 'kind': 'lawn', 'name': name or f'Lawn {k + 1}', 'elevation': elev_class(z), 'elevationFt': round(z, 1),
         'area': round(m.sum() * CELL * CELL), 'bareSoil': round(soil, 3), 'canopy': round(canopy, 3), 'polygons': rings(g)}, m)
for i in range(1, nseg + 1):
    m = seg == i
    if not m.any(): continue
    z = region_elev(m)
    g = vectorize(m, 1.5, 1.0)
    per = max(g.length, 1)
    width = max(1.5, min(40, 2 * g.area / per))
    add({'id': f'path-{len([r for r in regions if r["kind"] == "path"]) + 1}', 'kind': 'path', 'name': None, 'elevation': elev_class(z),
         'elevationFt': round(z, 1), 'width': round(width, 1), 'area': round(m.sum() * CELL * CELL), 'polygons': rings(g)}, m)
for r in regions:
    if r['kind'] == 'path': r['name'] = f"Path {r['id'].split('-')[1]}"

other = {'water': rings(vectorize(M_water, 2, 1.5)), 'plantings': rings(vectorize(M_plant, 2, 1.5)),
         'buildings': rings(vectorize(M_build, 1, 1)), 'park': rings(park.simplify(2)), 'outside': None}

# ---------- fences, gate, robot center, landing ----------
wpoly = max(polys(vectorize(M_woods, 3, 1.5)), key=lambda p: p.area)
fences = []
ext = wpoly.exterior
n = max(8, int(round(ext.length / 40)))
for k in range(n):
    a = ext.interpolate(k / n, normalized=True); b = ext.interpolate((k + 1) / n, normalized=True)
    mid = LineString([a, b]).interpolate(0.5, normalized=True)
    if mid.distance(lake) < 10: continue   # the shore needs no fence
    fences.append({'id': f'F{len(fences) + 1}', 'a': [round(a.x, 1), round(a.y, 1)], 'b': [round(b.x, 1), round(b.y, 1)]})

path_union = vectorize(M_path, 0, 0.5)
center_pt = nearest_points(path_union, ll(-73.97275, 40.77490))[0]
center = {'position': [round(center_pt.x, 1), round(center_pt.y, 1)], 'name': 'Cherry Hill Robot Center'}
dock = nearest_points(lake.buffer(-10), center_pt)[0]
center['dock'] = [round(dock.x, 1), round(dock.y, 1)]

best = None
for f in fences:
    m = Point((f['a'][0] + f['b'][0]) / 2, (f['a'][1] + f['b'][1]) / 2)
    d = m.distance(path_union)
    if d > 6: continue
    s = m.distance(center_pt)
    if best is None or s < best[0]: best = (s, f, m)
_, gf, gm = best
fences.remove(gf)
gate = {'position': [round(gm.x, 1), round(gm.y, 1)], 'a': gf['a'], 'b': gf['b']}

bh = ll(-73.96885, 40.77545)
best = None
for k in range(1000):
    q = lake.exterior.interpolate(k / 1000, normalized=True)
    if q.distance(path_union) > 10: continue
    s = q.distance(bh)
    if best is None or s < best[0]: best = (s, q)
lq = best[1]
pp = nearest_points(path_union, lq)[0]
pp = Point(pp.x + (pp.x - lq.x) * 0.3, pp.y + (pp.y - lq.y) * 0.3) if pp.distance(lq) > 0 else pp
wp = nearest_points(lake.buffer(-12), lq)[0]
landing = {'position': [round(lq.x, 1), round(lq.y, 1)], 'pathPoint': [round(pp.x, 1), round(pp.y, 1)], 'waterPoint': [round(wp.x, 1), round(wp.y, 1)], 'name': 'Loeb Boathouse landing'}

# ---------- trees from the canopy layer ----------
rng = np.random.default_rng(7)
can = (LC == 1) & M_park & ~M_lake & ~M_build
ys, xs = np.nonzero(can)
order = rng.permutation(len(xs))
trees, occ = [], {}
for i in order:
    x, y = cx[xs[i]], cy[ys[i]]
    key = (int(x // 20), int(y // 20))
    if key in occ: continue
    if any(occ.get((key[0] + a, key[1] + b)) and math.hypot(occ[(key[0] + a, key[1] + b)][0] - x, occ[(key[0] + a, key[1] + b)][1] - y) < 19 for a in (-1, 0, 1) for b in (-1, 0, 1)): continue
    occ[key] = (x, y)
    trees.append([round(x + rng.uniform(-2, 2), 1), round(y + rng.uniform(-2, 2), 1), round(float(rng.uniform(8, 13)), 1)])

trail_lines = []
for t in trail_items:
    for l in getattr(t['g'], 'geoms', [t['g']]):
        if l.is_empty: continue
        trail_lines.append({'surface': t['surface'], 'width': t['w'], 'name': t['name'], 'points': [[round(x, 1), round(y, 1)] for x, y in l.coords]})

flat = label.ravel().tolist()
rle, prev, run = [], flat[0], 0
for v in flat:
    if v == prev: run += 1
    else: rle += [prev, run]; prev, run = v, 1
rle += [prev, run]

out = {
    'about': 'The Lake and the Ramble, Central Park, baked from NYC Open Data by tools/bake_park.py',
    'sources': ['Land Cover Raster Data (2017) he6d-2qns', 'Parks Properties enfh-gkve', 'Planimetric Hydrography pjs3-c3z5',
                'Parks Trails vjbm-hsyr', 'Planimetric Roadbed i36f-5ih7', 'Planimetric Pavement Edge vs44-rznx', 'Planimetric Elevation Points 9uxf-ng6q'],
    'crs': 'EPSG:2263 feet, shifted', 'origin': {'x': XC, 'y': YC},
    'bounds': {'x0': gx0, 'y0': gy0, 'x1': gx0 + cols * CELL, 'y1': gy0 + rows * CELL},
    'lakeElevationFt': round(lake_elev, 1),
    'grid': {'cell': CELL, 'x0': gx0, 'y0': gy0, 'cols': cols, 'rows': rows, 'rle': rle},
    'regions': regions, 'other': other, 'fences': fences, 'gate': gate, 'landing': landing, 'center': center,
    'trees': trees, 'trails': trail_lines,
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump(out, open(OUT, 'w'), separators=(',', ':'))
kinds = {}
for r in regions: kinds[r['kind']] = kinds.get(r['kind'], 0) + 1
log(f"grid {cols}x{rows}, regions {kinds}, lawns {[(r['name'], r['area'], r['elevation']) for r in regions if r['kind']=='lawn'][:20]}")
log(f"fences {len(fences)}, trees {len(trees)}, lake elev {lake_elev:.1f}, woods {regions[1]['area']} sqft, size {os.path.getsize(OUT)//1024} KB")
log('elev', {c: sum(1 for r in regions if r.get('elevation') == c and r['kind'] == 'path') for c in ('low', 'medium', 'high')})
