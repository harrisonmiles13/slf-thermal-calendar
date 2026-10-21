"""Build the static (rarely changing) map layers for the web app.

* site/data/boundaries.json - US state lines plus Canada / Mexico outlines as
  compact polylines, decoded from the us-atlas and world-atlas TopoJSON
  packages (npm, public domain / ISC; Natural Earth + US Census).
* site/data/slf_range.json  - spotted lanternfly survey records aggregated to
  the ~10 km cells of lydemapr v4.1.0 (De Bona et al. 2023, CC BY 4.0): first
  biological year with any SLF record and first year with an established
  population.

    python pipeline/build_static.py
"""
import csv
import io
import json
import os
import tarfile
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SITE_DATA = os.path.join(HERE, "..", "site", "data")
NPM = "https://registry.npmjs.org"
LYDE_ZIP = ("https://raw.githubusercontent.com/ieco-lab/lydemapr/main/"
            "download_data/v4.1.0_2025/lyde_data_v4.1.0.zip")

# Rough lon/lat window of the map (CONUS plus the southern edge of Canada).
BBOX = (-130.0, 22.0, -60.0, 53.0)


def npm_json(pkg, version, path):
    url = f"{NPM}/{pkg}/-/{pkg}-{version}.tgz"
    with urllib.request.urlopen(url) as r:
        tf = tarfile.open(fileobj=io.BytesIO(r.read()))
    return json.load(tf.extractfile(f"package/{path}"))


def decode_arcs(topo):
    tr = topo.get("transform")
    out = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for p in arc:
            if tr:
                x += p[0]
                y += p[1]
                pts.append((x * tr["scale"][0] + tr["translate"][0],
                            y * tr["scale"][1] + tr["translate"][1]))
            else:
                pts.append(tuple(p[:2]))
        out.append(pts)
    return out


def arcs_of(geom):
    """Arc indices used by a Polygon / MultiPolygon geometry."""
    rings = geom["arcs"] if geom["type"] == "Polygon" else [r for p in geom["arcs"] for r in p]
    return {a if a >= 0 else ~a for ring in rings for a in ring}


def thin(pts, tol=0.02):
    """Drop vertices closer than `tol` degrees to the last kept one."""
    keep = [pts[0]]
    for p in pts[1:-1]:
        if abs(p[0] - keep[-1][0]) + abs(p[1] - keep[-1][1]) >= tol:
            keep.append(p)
    keep.append(pts[-1])
    return keep


def in_bbox(pts):
    return any(BBOX[0] <= x <= BBOX[2] and BBOX[1] <= y <= BBOX[3] for x, y in pts)


def boundaries():
    states = npm_json("us-atlas", "3.0.1", "states-10m.json")
    world = npm_json("world-atlas", "2.0.2", "countries-50m.json")
    lines = []
    st_arcs = decode_arcs(states)
    used = set()
    for g in states["objects"]["states"]["geometries"]:
        used |= arcs_of(g)
    for i in sorted(used):
        lines.append(st_arcs[i])
    w_arcs = decode_arcs(world)
    for g in world["objects"]["countries"]["geometries"]:
        if g.get("properties", {}).get("name") in ("Canada", "Mexico"):
            for i in sorted(arcs_of(g)):
                lines.append(w_arcs[i])
    lines = [thin(l) for l in lines if in_bbox(l)]
    flat = [[round(c, 2) for p in l for c in p] for l in lines]
    path = os.path.join(SITE_DATA, "boundaries.json")
    with open(path, "w") as f:
        json.dump(flat, f, separators=(",", ":"))
    print(f"wrote {path}: {len(flat)} lines, {os.path.getsize(path) // 1024} KB")


def slf_range():
    with urllib.request.urlopen(LYDE_ZIP) as r:
        z = zipfile.ZipFile(io.BytesIO(r.read()))
    name = next(n for n in z.namelist() if n.endswith("/lyde_10k.csv") and "MACOSX" not in n)
    cells = {}
    with z.open(name) as f:
        for row in csv.DictReader(io.TextIOWrapper(f)):
            key = (round(float(row["longitude"]), 3), round(float(row["latitude"]), 3))
            yr = int(row["bio_year"])
            c = cells.setdefault(key, [9999, 9999])
            if row["lyde_present"] == "TRUE":
                c[0] = min(c[0], yr)
            if row["lyde_established"] == "TRUE":
                c[1] = min(c[1], yr)
    recs = [[lon, lat, p, e if e < 9999 else 0]
            for (lon, lat), (p, e) in sorted(cells.items()) if p < 9999]
    out = {
        "source": "lydemapr v4.1.0 (De Bona et al. 2023, NeoBiota 86:151-168), CC BY 4.0",
        "cell_km": 10,
        "fields": ["lon", "lat", "first_year_present", "first_year_established"],
        "records": recs,
    }
    path = os.path.join(SITE_DATA, "slf_range.json")
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    est = sum(1 for r in recs if r[3])
    print(f"wrote {path}: {len(recs)} cells with SLF, {est} established")


if __name__ == "__main__":
    os.makedirs(SITE_DATA, exist_ok=True)
    boundaries()
    slf_range()
