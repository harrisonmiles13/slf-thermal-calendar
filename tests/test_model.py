"""Model and data checks. Run from the repo root: python tests/test_model.py

Exits non-zero on failure. The JS model (site/js/model.js) is checked against
the Python one when Node is available; the data checks run when the site data
has been built.
"""
import gzip
import json
import math
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "pipeline"))
import slf_model  # noqa: E402

CASES = [  # (tmax, tmin, expected °C·days), worked by hand
    (8, -2, 0.0),            # below LDT all day
    (38, 36, 25.0),          # above UDT all day: capped at UDT - LDT
    (20, 12, 6.0),           # between thresholds: mean - LDT
    (15, 5, 1.25),           # crosses LDT: (15-10)^2 / (2*10)
    (40, 20, 19.375),        # crosses UDT: 20 - (40-35)^2 / (2*20)
    (40, 5, 12.5),           # crosses both: (30^2 - 5^2) / (2*35)
    (10, 10, 0.005),         # tmax == tmin: DDRP nudges tmax by 0.01
]
failures = []


def check(cond, msg):
    if not cond:
        failures.append(msg)


for tmax, tmin, want in CASES:
    got = float(slf_model.triangle_dd(tmax, tmin))
    check(math.isclose(got, want, abs_tol=1e-3), f"py triangle_dd({tmax},{tmin}) = {got}, want {want}")
check(math.isnan(float(slf_model.triangle_dd(float("nan"), 5))), "NaN input must give NaN")

ths = slf_model.thresholds()
check(len({t["id"] for t in ths}) == len(ths), "threshold ids must be unique")
slf = [t["dd_c"] for t in ths if t["kind"] == "slf"]
check(slf == sorted(slf), "SLF events must be in developmental order")
check([round(t["dd_c"]) for t in ths if t["kind"] == "slf"] == [135, 202, 644, 1092, 1722, 1868],
      "SLF event degree-days must match DDRP SLF.params")

if shutil.which("node"):
    js = os.path.join(ROOT, "site", "js", "model.js")
    script = (f"const M=require({json.dumps(js)});"
              f"console.log(JSON.stringify({json.dumps([c[:2] for c in CASES])}.map(([a,b])=>M.triangleDD(a,b))));"
              "console.log(JSON.stringify([M.fmtDoy(1), M.fmtDoy(59), M.fmtDoy(60, 2024), M.dateToDoy(new Date('2026-12-31T00:00:00Z'))]));")
    out = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True).stdout.splitlines()
    for (tmax, tmin, want), got in zip(CASES, json.loads(out[0])):
        check(math.isclose(got, want, abs_tol=1e-3), f"js triangleDD({tmax},{tmin}) = {got}, want {want}")
    check(json.loads(out[1]) == ["Jan 1", "Feb 28", "Feb 29", 365], f"js date helpers: {out[1]}")

grid = os.path.join(ROOT, "site", "data", "grid")
if os.path.exists(os.path.join(grid, "manifest.json")):
    man = json.load(open(os.path.join(grid, "manifest.json")))
    g = man["grid"]
    n = g["nrows"] * g["ncols"]

    def layer(path):
        return memoryview(gzip.decompress(open(os.path.join(grid, path), "rb").read())).cast("H")

    for t in man["thresholds"]:
        check(len(layer(f"normal/{t['id']}.bin")) == 3 * n, f"normal/{t['id']} has wrong size")

    def normal_doy(tid, lat, lon):
        i = int((g["north"] - lat) / g["dlat"])
        j = int((lon - g["west"]) / g["dlon"])
        return layer(f"normal/{tid}.bin")[i * g["ncols"] + j] / 10

    raleigh, reading = normal_doy("hatch", 35.78, -78.64), normal_doy("hatch", 40.34, -75.93)
    check(60 < raleigh < reading < 170, f"normal hatch should come earlier in Raleigh ({raleigh}) than Reading ({reading})")
    a = normal_doy("adult", 40.34, -75.93)
    check(190 < a < 240, f"normal first adults in Reading, PA should be late Jul/Aug (DOY {a})")
    for y, info in man["years"].items():
        check(len(layer(f"{y}/hatch.bin")) == n, f"{y}/hatch has wrong size")

if failures:
    print("FAILED:\n  " + "\n  ".join(failures))
    sys.exit(1)
print(f"ok: {len(CASES)} degree-day cases (py{' + js' if shutil.which('node') else ''}), thresholds, data checks")
