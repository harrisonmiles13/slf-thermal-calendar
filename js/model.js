/* SLF degree-day model and date helpers, shared by the map and the point
 * panel. Mirrors pipeline/slf_model.py (DDRP SLF model: Barker, Beyer & Coop
 * 2025): LDT 10 °C, UDT 35 °C horizontal cutoff, single triangle, from 1 Jan.
 * Pure functions only, so it also runs under Node for the tests. */
(function (root) {
  "use strict";
  const LDT = 10, UDT = 35;

  /** Daily °C degree-days, single triangle with horizontal upper cutoff. */
  function triangleDD(tmax, tmin, ldt = LDT, udt = UDT) {
    if (tmax == null || tmin == null || Number.isNaN(tmax) || Number.isNaN(tmin)) return NaN;
    let lo = Math.min(tmax, tmin), hi = Math.max(tmax, tmin);
    if (hi === lo) hi += 0.01;
    const rng = hi - lo;
    const t1 = (hi - ldt) ** 2 / (2 * rng);
    const t2 = (hi - udt) ** 2 / (2 * rng);
    const meanAbove = (hi + lo) / 2 - ldt;
    if (hi < ldt) return 0;
    if (lo >= udt) return udt - ldt;
    if (hi < udt && lo <= ldt) return t1;
    if (lo <= ldt && hi >= udt) return t1 - t2;
    if (lo > ldt && hi >= udt) return meanAbove - t2;
    return meanAbove; // lo > ldt && hi < udt
  }

  /** Cumulative °F·days for a daily series [{date, tmax, tmin}] (°C in). */
  function accumulate(days) {
    let cum = 0;
    return days.map((d) => {
      const dd = triangleDD(d.tmax, d.tmin);
      if (!Number.isNaN(dd)) cum += dd * 1.8;
      return { ...d, cum };
    });
  }

  /** Index of the first element whose .cum reaches `thr`, or -1. */
  function firstReach(series, thr) {
    for (let i = 0; i < series.length; i++) if (series[i].cum >= thr) return i;
    return -1;
  }

  const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const daysIn = (y) => (isLeap(y) ? 366 : 365);
  /** Day of year (1-based) -> UTC Date in year y. */
  const doyToDate = (doy, y) => new Date(Date.UTC(y, 0, Math.round(doy)));
  const dateToDoy = (d) => Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5);
  const iso = (d) => d.toISOString().slice(0, 10);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  /** "Apr 23" for a DOY; normals use a non-leap reference year. */
  function fmtDoy(doy, y = 2021) {
    const d = doyToDate(doy, y);
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  }

  /** Piecewise-linear cumulative-DD curve through (doy, dd) points. */
  function curveAt(points, doy) {
    if (!points.length) return NaN;
    if (doy <= points[0][0]) return points[0][1] * Math.max(0, doy - 1) / Math.max(1, points[0][0] - 1);
    for (let i = 1; i < points.length; i++) {
      const [x0, y0] = points[i - 1], [x1, y1] = points[i];
      if (doy <= x1) return y0 + (y1 - y0) * (doy - x0) / Math.max(1e-9, x1 - x0);
    }
    return NaN; // past the last known point
  }

  /** Threshold DOY stats across years: mean, SD, share of years reached. */
  function yearStats(doys) {
    const hit = doys.filter((d) => d > 0);
    const n = hit.length;
    const mean = n ? hit.reduce((a, b) => a + b, 0) / n : NaN;
    const sd = n > 1 ? Math.sqrt(hit.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : NaN;
    return { mean: n >= doys.length / 2 ? mean : NaN, sd: n >= doys.length / 2 ? sd : NaN, pct: 100 * n / doys.length };
  }

  const api = { LDT, UDT, triangleDD, accumulate, firstReach, isLeap, daysIn, doyToDate, dateToDoy, iso, fmtDoy, MONTHS, curveAt, yearStats };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SLFModel = api;
})(this);
