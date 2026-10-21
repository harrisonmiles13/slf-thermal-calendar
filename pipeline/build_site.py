"""Package threshold grids into the compact files the web app loads.

Layout under site/data/grid/ (all binary files are gzip-compressed,
little-endian uint16, row-major, north row first; the browser inflates them
with DecompressionStream):

    manifest.json                grid geometry, thresholds, years, dates
    normal/<threshold>.bin    3 layers: mean DOY x10, SD x10, % years reached
                                 (mean/SD are 0 where reached in < 50 % of years)
    <year>/<threshold>.bin    DOY first reached (0 = not reached / not yet)
    <year>/cum.bin            °F·days accumulated 1 Jan -> last data date
    tiles/<ty>_<tx>.bin       every threshold for a 32x32 block of cells, for
                                 the point panel: [threshold][layer][cell] with
                                 layers = normal mean, SD, pct, then each year

The site files double as the long-term store: the daily GitHub Action only
recomputes the current (and previous) year from nClimGrid and reads the
1991-2020 normals and older years back from here.

    python pipeline/build_site.py --normals --years 2021-2026
    python pipeline/build_site.py --years 2026        # daily update
"""
import argparse
import datetime as dt
import glob
import gzip
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import slf_model  # noqa: E402
from build_grids import CACHE, parse_years  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "site", "data", "grid")
TILE = 32


def write_u16(path, arr):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = np.ascontiguousarray(arr, dtype="<u2").tobytes()
    with open(path, "wb") as f:  # mtime=0 keeps unchanged files byte-identical
        f.write(gzip.compress(data, compresslevel=9, mtime=0))


def read_u16(path, shape):
    with open(path, "rb") as f:
        return np.frombuffer(gzip.decompress(f.read()), dtype="<u2").reshape(shape)


def scaled(a, k):
    return np.where(np.isnan(a), 0, np.clip(np.round(a * k), 0, 65535)).astype(np.uint16)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--normals", action="store_true", help="(re)write normal layers")
    ap.add_argument("--years", nargs="*", default=[], help="years to (re)write")
    ap.add_argument("--out", default=OUT, help="output directory (default site/data/grid)")
    a = ap.parse_args()
    out_dir = a.out
    ths = slf_model.thresholds()
    ids = [t["id"] for t in ths]

    man_path = os.path.join(out_dir, "manifest.json")
    man = json.load(open(man_path)) if os.path.exists(man_path) else {"years": {}}

    if a.normals:
        z = np.load(os.path.join(CACHE, "normals.npz"))
        lat, lon = z["lat"], z["lon"]
        for k, tid in enumerate(ids):
            write_u16(os.path.join(out_dir, "normal", f"{tid}.bin"),
                      np.stack([scaled(z["mean"][k], 10), scaled(z["sd"][k], 10),
                                scaled(z["pct"][k], 1)]))
        man["normal_period"] = [int(z["years"][0]), int(z["years"][1])]
        man["grid"] = {
            "nrows": int(len(lat)), "ncols": int(len(lon)),
            "north": float(lat[0] + (lat[0] - lat[1]) / 2),
            "west": float(lon[0] - (lon[1] - lon[0]) / 2),
            "dlat": float(lat[0] - lat[1]), "dlon": float(lon[1] - lon[0]),
        }
        print("wrote normals")

    g = man["grid"]
    shape = (g["nrows"], g["ncols"])
    for y in parse_years(a.years):
        src = os.path.join(CACHE, "years", f"{y}.npz")
        if not os.path.exists(src):
            print(f"{y}: no grid computed, skipped")
            continue
        z = np.load(src)
        for k, tid in enumerate(ids):
            write_u16(os.path.join(out_dir, str(y), f"{tid}.bin"), z["doy"][k])
        write_u16(os.path.join(out_dir, str(y), "cum.bin"), scaled(z["cum"], 1.8))
        man["years"][str(y)] = {"last_date": str(z["last_date"]),
                                "complete": bool(z["complete"]),
                                "final": bool(z["final"]) if "final" in z else bool(z["complete"])}
        print(f"wrote {y} (through {z['last_date']})")

    # Point-lookup tiles from whatever normal + year files now exist.
    years = sorted(int(y) for y in man["years"])
    nl = 3 + len(years)
    cube = np.zeros((len(ids), nl) + shape, np.uint16)
    for k, tid in enumerate(ids):
        cube[k, :3] = read_u16(os.path.join(out_dir, "normal", f"{tid}.bin"), (3,) + shape)
        for j, y in enumerate(years):
            cube[k, 3 + j] = read_u16(os.path.join(out_dir, str(y), f"{tid}.bin"), shape)
    land = cube[:, 2].max(0) > 0
    for old in glob.glob(os.path.join(out_dir, "tiles", "*.bin")):
        os.remove(old)
    tiles = []
    for ty in range(0, shape[0], TILE):
        for tx in range(0, shape[1], TILE):
            if not land[ty:ty + TILE, tx:tx + TILE].any():
                continue
            block = np.zeros((len(ids), nl, TILE, TILE), np.uint16)
            sub = cube[:, :, ty:ty + TILE, tx:tx + TILE]
            block[:, :, :sub.shape[2], :sub.shape[3]] = sub
            name = f"{ty // TILE}_{tx // TILE}"
            write_u16(os.path.join(out_dir, "tiles", f"{name}.bin"), block)
            tiles.append(name)

    man.update({
        "built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "tile": TILE, "tiles": tiles, "tile_years": years,
        "thresholds": ths,
        "model": {"ldt_c": slf_model.LDT_C, "udt_c": slf_model.UDT_C,
                  "method": "single triangle, horizontal cutoff", "start": "01-01"},
        "source": "NOAA nClimGrid-Daily v1.0.0, aggregated to 1/12°",
    })
    with open(man_path, "w") as f:
        json.dump(man, f, indent=1)
    print(f"wrote manifest ({len(tiles)} tiles, years {years})")


if __name__ == "__main__":
    main()
