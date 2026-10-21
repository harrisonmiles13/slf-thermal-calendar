"""Spotted lanternfly (Lycorma delicatula) degree-day model.

Parameters follow the DDRP SLF model (Barker, Beyer & Coop 2025, Insects
16:790; parameter file `SLF.params` in github.com/bbarker505/ddrp_v3):
lower developmental threshold 10 °C, upper threshold 35 °C (horizontal
cutoff), single-triangle method, accumulation from 1 January.

All degree-day (DD) values in this module are in °C·days. The web app shows
°F·days (x 1.8) alongside.
"""
import numpy as np

LDT_C = 10.0  # lower developmental threshold
UDT_C = 35.0  # upper developmental threshold (horizontal cutoff)

# SLF life-stage events (cumulative DD °C from 1 Jan), from SLF.params:
#   xdist1 = 135    earliest overwintered-egg cohort completes development
#   OWeggDD = 202   egg hatch (DDRP pest-event-map "egg hatch")
#   + larvaeEventDD 442 -> 644   nymphs halfway developed
#   + larvaeDD 890 -> 1092        first adults
#   + pupDD 630 -> 1722           first egg laying (end of pre-oviposition)
#   + adultDD 146 -> 1868         50 % egg laying
SLF_EVENTS = [
    {"id": "hatch_first", "dd_c": 135.0, "label": "First egg hatch",
     "short": "First hatch", "note": "Earliest overwintered-egg cohort (DDRP xdist1)"},
    {"id": "hatch", "dd_c": 202.0, "label": "Egg hatch",
     "short": "Egg hatch", "note": "DDRP egg-hatch event (OWeggDD)"},
    {"id": "mid_nymph", "dd_c": 644.0, "label": "Nymphs halfway developed",
     "short": "Mid-nymph", "note": "202 + 442 DD; roughly 2nd to 3rd instar"},
    {"id": "adult", "dd_c": 1092.0, "label": "First adults",
     "short": "First adults", "note": "202 + 890 DD nymphal development"},
    {"id": "ovip_first", "dd_c": 1722.0, "label": "First egg laying",
     "short": "Egg laying", "note": "1092 + 630 DD pre-oviposition"},
    {"id": "ovip_50", "dd_c": 1868.0, "label": "50% egg laying",
     "short": "50% egg laying", "note": "1722 + 146 DD"},
]

# Generic thermal-calendar thresholds, NPN style, in °F·days (base 50 °F).
GENERIC_F = list(range(100, 3700, 100))


def thresholds():
    """All thresholds as a list of dicts with id, dd_c, dd_f, kind."""
    out = []
    for f in GENERIC_F:
        out.append({"id": f"gdd{f}", "dd_c": f / 1.8, "dd_f": float(f),
                    "kind": "generic", "label": f"{f} °F·days"})
    for e in SLF_EVENTS:
        out.append({**e, "dd_f": round(e["dd_c"] * 1.8, 1), "kind": "slf"})
    return out


def triangle_dd(tmax, tmin, ldt=LDT_C, udt=UDT_C):
    """Daily degree-days, single triangle with horizontal upper cutoff.

    Same branches as DDRP `TriDD` (Sevacherian et al. 1977). Works on numpy
    arrays; NaN in -> NaN out.
    """
    tmax = np.asarray(tmax, dtype=np.float64)
    tmin = np.asarray(tmin, dtype=np.float64)
    # Guard against tmax == tmin (and the rare tmax < tmin in gridded data).
    lo = np.minimum(tmax, tmin)
    hi = np.maximum(tmax, tmin)
    hi = np.where(hi == lo, hi + 0.01, hi)
    rng = hi - lo
    t1 = (hi - ldt) ** 2 / (2 * rng)  # area above LDT when lo <= LDT
    t2 = (hi - udt) ** 2 / (2 * rng)  # area above UDT when hi >= UDT
    mean_above = (hi + lo) / 2 - ldt
    dd = np.select(
        [hi < ldt,
         lo >= udt,
         (hi < udt) & (lo <= ldt),
         (lo <= ldt) & (hi >= udt),
         (lo > ldt) & (hi >= udt),
         (lo > ldt) & (hi < udt)],
        [0.0,
         udt - ldt,
         t1,
         t1 - t2,
         mean_above - t2,
         mean_above],
        default=np.nan)
    return np.where(np.isnan(tmax) | np.isnan(tmin), np.nan, dd)
