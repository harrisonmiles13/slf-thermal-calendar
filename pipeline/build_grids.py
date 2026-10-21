"""Build per-year threshold-date grids from NOAA nClimGrid-Daily.

For every year requested, downloads the monthly nClimGrid-Daily netCDF files
(CONUS, 1/24°) from the public NOAA Open Data bucket on AWS, aggregates tmax /
tmin to 1/12° (2x2 block mean), accumulates SLF degree-days from 1 January and
records the day of year (DOY) on which each threshold in `slf_model` is first
reached. One compressed file per year is written to `cache/years/`.

    python pipeline/build_grids.py 1991-2020 2021 2022 ...
    python pipeline/build_grids.py --normals      # 1991-2020 summary

Final ("scaled") monthly files are preferred; "prelim" files are used for the
most recent months that have no final version yet.
"""
import argparse
import concurrent.futures as cf
import os
import sys
import tempfile
import urllib.request
import warnings

import numpy as np
import xarray as xr

sys.path.insert(0, os.path.dirname(__file__))
import slf_model  # noqa: E402

BUCKET = "https://noaa-nclimgrid-daily-pds.s3.amazonaws.com"
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache")
NORMAL_YEARS = (1991, 2020)


def month_url(year, month):
    """URL of the best available file for a month, or None if none exists."""
    for kind in ("scaled", "prelim"):
        url = f"{BUCKET}/access/grids/{year}/ncdd-{year}{month:02d}-grd-{kind}.nc"
        req = urllib.request.Request(url, method="HEAD")
        try:
            with urllib.request.urlopen(req, timeout=60):
                return url
        except urllib.error.HTTPError as e:
            if e.code not in (403, 404):
                raise
    return None


def download(url, dest):
    for attempt in range(4):
        try:
            urllib.request.urlretrieve(url, dest)
            return dest
        except Exception:  # network hiccup: retry with backoff
            if attempt == 3:
                raise
            import time
            time.sleep(2 ** (attempt + 1))


def block_mean(a):
    """(T, 596, 1385) -> (T, 298, 692) nan-mean of 2x2 blocks, north row first."""
    t, h, w = a.shape
    a = np.where(a < -900, np.nan, a)  # prelim files pad future days with -999.99
    a = a[:, : h - h % 2, : w - w % 2]
    a = a.reshape(t, a.shape[1] // 2, 2, a.shape[2] // 2, 2)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        m = np.nanmean(a, axis=(2, 4))
    return m[:, ::-1, :].astype(np.float32)


def grid_info(ds):
    lat = ds["lat"].values
    lon = ds["lon"].values
    lat = lat[: len(lat) - len(lat) % 2].reshape(-1, 2).mean(1)[::-1]
    lon = lon[: len(lon) - len(lon) % 2].reshape(-1, 2).mean(1)
    return lat, lon


def process_year(year, workdir):
    thr = np.array([t["dd_c"] for t in slf_model.thresholds()], dtype=np.float32)
    urls = [month_url(year, m) for m in range(1, 13)]
    urls = [u for u in urls if u]
    if not urls:
        print(f"{year}: no nClimGrid data yet, skipped", flush=True)
        return
    paths = [os.path.join(workdir, os.path.basename(u)) for u in urls]

    cum = doy = valid = lat = lon = None
    day = 0
    last_date = None
    with cf.ThreadPoolExecutor(3) as pool:
        futs = [pool.submit(download, u, p) for u, p in zip(urls, paths)]
        for fut in futs:
            path = fut.result()
            with xr.open_dataset(path) as ds:
                if lat is None:
                    lat, lon = grid_info(ds)
                tmax = block_mean(ds["tmax"].values)
                tmin = block_mean(ds["tmin"].values)
                times = ds["time"].values
            os.remove(path)
            if cum is None:
                cum = np.zeros(tmax.shape[1:], np.float32)
                doy = np.zeros((len(thr),) + cum.shape, np.uint16)
                valid = np.zeros(cum.shape, bool)
            for i in range(tmax.shape[0]):
                if np.isnan(tmax[i]).all():  # prelim month padded past last obs
                    continue
                day += 1
                dd = slf_model.triangle_dd(tmax[i], tmin[i])
                ok = ~np.isnan(dd)
                valid |= ok
                cum += np.where(ok, dd, 0).astype(np.float32)
                hit = (doy == 0) & (cum[None] >= thr[:, None, None])
                doy[hit] = day
                last_date = str(np.datetime_as_string(times[i], unit="D"))
            print(f"  {year}: {os.path.basename(path)} -> day {day}", flush=True)

    doy[:, ~valid] = 0
    out = os.path.join(CACHE, "years", f"{year}.npz")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    complete = (last_date or "").endswith("12-31")
    final = complete and len(urls) == 12 and all(u.endswith("-scaled.nc") for u in urls)
    np.savez_compressed(out, doy=doy, cum=np.where(valid, cum, np.nan).astype(np.float32),
                        valid=valid, lat=lat, lon=lon, last_date=last_date,
                        complete=complete, final=final)
    print(f"{year}: wrote {out} (data through {last_date})", flush=True)


def build_normals(y0=NORMAL_YEARS[0], y1=NORMAL_YEARS[1]):
    """Mean / SD of threshold DOY and % of years reached, 1991-2020."""
    years = list(range(y0, y1 + 1))
    stack = None
    for k, y in enumerate(years):
        with np.load(os.path.join(CACHE, "years", f"{y}.npz")) as z:
            d = z["doy"].astype(np.float32)
            if stack is None:
                stack = np.zeros((len(years),) + d.shape, np.float32)
                lat, lon, valid = z["lat"], z["lon"], z["valid"]
            stack[k] = d
    reached = stack > 0
    n = reached.sum(0)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        s = np.where(reached, stack, np.nan)
        mean = np.nanmean(s, 0)
        sd = np.nanstd(s, 0, ddof=1)
    pct = 100.0 * n / len(years)
    # A normal date is only defined where the threshold is reached in at
    # least half of the normal-period years.
    mean[n < len(years) / 2] = np.nan
    sd[n < len(years) / 2] = np.nan
    out = os.path.join(CACHE, "normals.npz")
    np.savez_compressed(out, mean=mean.astype(np.float32), sd=sd.astype(np.float32),
                        pct=pct.astype(np.float32), valid=valid, lat=lat, lon=lon,
                        years=np.array([y0, y1]))
    print(f"wrote {out}")


def parse_years(tokens):
    years = []
    for t in tokens:
        if "-" in t:
            a, b = t.split("-")
            years += list(range(int(a), int(b) + 1))
        else:
            years.append(int(t))
    return years


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("years", nargs="*", help="years or ranges, e.g. 1991-2020 2026")
    ap.add_argument("--normals", action="store_true", help="summarise 1991-2020")
    ap.add_argument("--jobs", type=int, default=1)
    a = ap.parse_args()
    years = parse_years(a.years)
    with tempfile.TemporaryDirectory() as tmp:
        if a.jobs > 1:
            with cf.ProcessPoolExecutor(a.jobs) as pool:
                list(pool.map(process_year, years, [tmp] * len(years)))
        else:
            for y in years:
                process_year(y, tmp)
    if a.normals:
        build_normals()


if __name__ == "__main__":
    main()
