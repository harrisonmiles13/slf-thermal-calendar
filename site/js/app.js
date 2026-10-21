/* SLF Thermal Calendar: map + location panel.
 * Data: data/grid/ (see pipeline/build_site.py). Live point data: Open-Meteo.
 * Everything that needs the network beyond our own files (basemap tiles,
 * Open-Meteo, place search, geolocation) is optional; the maps and the
 * gridded location panel work without it. */
(function () {
  "use strict";
  const M = window.SLFModel;
  const BASE = "data/grid/";
  // Hosts that cannot serve binary files get the same layers as base64 text.
  const EXT = window.SLF_DATA_EXT || ".bin";
  const $ = (s, el = document) => el.querySelector(s);
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(kid));
    return el;
  };

  // ---------------------------------------------------------------- state
  const EXAMPLE = { lat: 40.42, lon: -75.93, name: "Berks County, PA (first US detection, 2014)" };
  const state = {
    thr: "hatch", year: null, view: "date", layout: "single", units: "F",
    stageDoy: null, stageSrc: "year", records: true, loc: { ...EXAMPLE },
  };
  let man = null;
  const SLF_IDS = ["hatch_first", "hatch", "mid_nymph", "adult", "ovip_first", "ovip_50"];

  // ---------------------------------------------------------------- data
  const cache = new Map();
  function fetchBin(path) {
    if (!cache.has(path)) {
      cache.set(path, fetch(BASE + path).then(async (r) => {
        if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
        let buf;
        if (EXT.endsWith(".txt")) buf = Uint8Array.from(atob((await r.text()).trim()), (c) => c.charCodeAt(0)).buffer;
        else buf = await r.arrayBuffer();
        const b = new Uint8Array(buf, 0, 2);
        if (b[0] === 0x1f && b[1] === 0x8b) {
          const ds = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
          buf = await new Response(ds).arrayBuffer();
        }
        return new Uint16Array(buf);
      }).catch((e) => { cache.delete(path); throw e; }));
    }
    return cache.get(path);
  }
  const N = () => man.grid.nrows * man.grid.ncols;
  const thrById = (id) => man.thresholds.find((t) => t.id === id);
  const yearInfo = (y) => man.years[String(y)];
  const lastDoy = (y) => M.dateToDoy(new Date(yearInfo(y).last_date + "T00:00:00Z"));
  const isComplete = (y) => yearInfo(y).complete;

  function cellOf(lat, lon) {
    const g = man.grid;
    const i = Math.floor((g.north - lat) / g.dlat), j = Math.floor((lon - g.west) / g.dlon);
    if (i < 0 || j < 0 || i >= g.nrows || j >= g.ncols) return null;
    return { i, j, idx: i * g.ncols + j };
  }

  // ---------------------------------------------------------------- units
  const ddUnit = () => (state.units === "F" ? "°F·days" : "°C·days");
  const fmtDD = (vF) => Math.round(state.units === "F" ? vF : vF / 1.8).toLocaleString();
  const thrLabel = (t) => (t.kind === "slf" ? t.label : `${fmtDD(t.dd_f)} ${ddUnit()}`);

  // ---------------------------------------------------------------- colour
  const hex = (s) => [1, 3, 5].map((k) => parseInt(s.slice(k, k + 2), 16));
  const VIRIDIS = ["#440154", "#482878", "#3e4989", "#31688e", "#26828e", "#1f9e89", "#35b779", "#6ece58", "#b5de2b", "#fde725"].map(hex);
  function ramp(stops, t) {
    const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(x)), f = x - k;
    return stops[k].map((c, n) => Math.round(c + (stops[k + 1][n] - c) * f));
  }
  const DIVERGE = ["#a50f15", "#de2d26", "#fc9272", "#fdd5c4", "#e6e4df", "#d1e5f0", "#92c5de", "#4393c3", "#1f5f9f"].map(hex);
  const ORANGES = ["#fee6c6", "#fdc58c", "#fd9f55", "#f2701d", "#d4500b", "#a33a05", "#6e2a05"].map(hex);
  const BLUES = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"].map(hex);
  const HEAT = ["#fff3c4", "#fee391", "#fec44f", "#fe9929", "#ec7014", "#cc4c02", "#993404", "#662506"].map(hex);
  const NODATA = hex("#bdb9b0"), NOTYET = hex("#e8e5de");

  // Each scale: classes [{c:[r,g,b], label}] and classify(idx) -> class index,
  // or -1 (transparent), or a special key ("notyet" | "notreached" | "nonormal").
  const SPECIAL = {
    notyet: { c: NOTYET, label: "Not reached yet", hatch: true },
    notreached: { c: NODATA, label: "Not reached this year" },
    nonormal: { c: NODATA, label: "Reached in < half of years" },
  };

  function dateBins(values) {
    const v = values.filter((x) => x > 0).sort((a, b) => a - b);
    if (!v.length) return [91, 121];
    const p = (q) => v[Math.floor(q * (v.length - 1))];
    const lo = p(0.02), hi = p(0.98);
    const semi = [], month = [];
    for (let m = 0; m < 12; m++) {
      const d1 = M.dateToDoy(new Date(Date.UTC(2021, m, 1)));
      const d16 = M.dateToDoy(new Date(Date.UTC(2021, m, 16)));
      semi.push(d1, d16); month.push(d1);
    }
    semi.push(366); month.push(366);
    for (const edges of [semi, month]) {
      const a = edges.filter((e) => e <= lo).pop() ?? edges[0];
      const b = edges.find((e) => e > hi) ?? 366;
      const sel = edges.filter((e) => e >= a && e <= b);
      if (sel.length - 1 <= 12 || edges === month) return sel;
    }
  }

  function dateScale(edges) {
    const n = edges.length - 1;
    const classes = [];
    for (let k = 0; k < n; k++) {
      const a = M.fmtDoy(edges[k]), b = M.fmtDoy(edges[k + 1] - 1);
      const label = k === 0 ? `by ${b}` : k === n - 1 ? `${a} or later` : `${a}–${b}`;
      classes.push({ c: ramp(VIRIDIS, 1 - k / Math.max(1, n - 1)), label });
    }
    const cls = (doy) => {
      for (let k = 1; k < n; k++) if (doy < edges[k]) return k - 1;
      return n - 1;
    };
    return { classes, cls };
  }

  // ---------------------------------------------------------------- views
  const VIEWS = {
    date: { name: "Date reached", short: "Date reached" },
    anom: { name: "Days early or late", short: "vs. normal" },
    normal: { name: "Normal date", short: "Normal" },
    sd: { name: "Year-to-year variability", short: "Variability" },
    pct: { name: "Years reached", short: "Years reached" },
    stage: { name: "SLF stage on date", short: "Stage on date" },
    heat: { name: "Heat accumulated", short: "Heat to date" },
  };
  const QUAD = ["date", "anom", "normal", "sd"];
  const STAGES = [
    { label: "Overwintering eggs", c: hex("#d6d2c8") },
    { label: "Hatch beginning", c: hex("#fde725") },
    { label: "Young nymphs", c: hex("#7ad151") },
    { label: "Older nymphs", c: hex("#22a884") },
    { label: "Adults", c: hex("#2a788e") },
    { label: "Egg laying", c: hex("#414487") },
    { label: "Egg laying past 50%", c: hex("#440154") },
  ];

  /** Load data and build {title, sub, scale, at(idx) -> {k, text}} for a view. */
  async function buildView(view) {
    const t = thrById(state.thr), y = state.year;
    const np = man.normal_period.join("–");
    const nrm = () => fetchBin(`normal/${t.id}${EXT}`);
    const yr = () => fetchBin(`${y}/${t.id}${EXT}`);
    const n = N();
    const yLabel = `${y}${isComplete(y) ? "" : ` through ${M.fmtDoy(lastDoy(y), y)}`}`;
    const meanOf = (a, idx) => a[idx] / 10;

    if (view === "date" || view === "normal") {
      const norm = await nrm();
      const sc = dateScale(dateBins(Array.from(norm.subarray(0, n), (v) => v / 10)));
      if (view === "normal") {
        return {
          title: `${thrLabel(t)}: normal date`, sub: `Mean date reached, ${np}`, scale: sc,
          specials: ["nonormal"],
          at(idx) {
            if (norm[2 * n + idx] === 0) return null;
            const m = meanOf(norm, idx);
            if (!m) return { k: "nonormal", text: `reached in ${norm[2 * n + idx]}% of ${np} years` };
            return { k: sc.cls(m), text: `normally ${M.fmtDoy(m)}` };
          },
        };
      }
      const a = await yr();
      const ld = lastDoy(y), done = isComplete(y);
      return {
        title: `${thrLabel(t)}: date reached in ${y}`, sub: `Accumulated from Jan 1, ${yLabel}`, scale: sc,
        specials: done ? ["notreached"] : ["notyet"],
        at(idx) {
          if (norm[2 * n + idx] === 0 && a[idx] === 0) return null;
          if (a[idx] === 0) return done ? { k: "notreached", text: `not reached in ${y}` } : { k: "notyet", text: `not reached as of ${M.fmtDoy(ld, y)}` };
          return { k: sc.cls(a[idx]), text: `reached ${M.fmtDoy(a[idx], y)}, ${y}` };
        },
      };
    }

    if (view === "anom") {
      const [norm, a] = await Promise.all([nrm(), yr()]);
      const ld = lastDoy(y), done = isComplete(y);
      const edges = [-21, -14, -7, -3, 3, 7, 14, 21];
      const labels = ["21+ days early", "14–21 early", "7–14 early", "3–7 early", "Within 3 days", "3–7 late", "7–14 late", "14–21 late", "21+ days late"];
      const classes = labels.map((label, k) => ({ c: DIVERGE[k], label }));
      const cls = (d) => { let k = 0; while (k < edges.length && d > edges[k]) k++; return k; };
      return {
        title: `${thrLabel(t)}: ${y} vs. normal`, sub: `Days earlier or later than the ${np} mean`, scale: { classes, cls },
        specials: ["nonormal"], diverging: true,
        at(idx) {
          if (norm[2 * n + idx] === 0 && a[idx] === 0) return null;
          const m = meanOf(norm, idx);
          if (!m) return a[idx] ? { k: "nonormal", text: `reached ${M.fmtDoy(a[idx], y)}; rarely reached ${np}` } : null;
          if (a[idx]) {
            const d = a[idx] - m;
            const txt = Math.abs(d) < 0.5 ? "on the normal date" : `${Math.abs(d).toFixed(0)} days ${d < 0 ? "earlier" : "later"} than normal`;
            return { k: cls(d), text: `${M.fmtDoy(a[idx], y)}, ${txt}` };
          }
          if (done) return { k: classes.length - 1, text: `not reached in ${y} (normally ${M.fmtDoy(m)})` };
          if (m < ld) return { k: cls(ld - m), text: `not reached yet; already ${Math.round(ld - m)}+ days late` };
          return { k: "notyet", text: `not reached yet (normally ${M.fmtDoy(m)})` };
        },
      };
    }

    if (view === "sd") {
      const norm = await nrm();
      const edges = [3, 5, 7, 10, 14, 21];
      const labels = ["< 3 days", "3–5", "5–7", "7–10", "10–14", "14–21", "21+ days"];
      const classes = labels.map((label, k) => ({ c: ORANGES[k], label }));
      const cls = (d) => { let k = 0; while (k < edges.length && d >= edges[k]) k++; return k; };
      return {
        title: `${thrLabel(t)}: variability`, sub: `Standard deviation of the date reached, ${np}`, scale: { classes, cls },
        specials: ["nonormal"],
        at(idx) {
          if (norm[2 * n + idx] === 0) return null;
          if (!norm[idx]) return { k: "nonormal", text: `reached in ${norm[2 * n + idx]}% of years` };
          const s = norm[n + idx] / 10;
          return { k: cls(s), text: `± ${s.toFixed(1)} days (1 SD)` };
        },
      };
    }

    if (view === "pct") {
      const norm = await nrm();
      const labels = ["Never", "1–24%", "25–49%", "50–74%", "75–89%", "90–99%", "Every year"];
      const classes = labels.map((label, k) => ({ c: k === 0 ? NODATA : BLUES[k], label }));
      const cls = (p) => (p === 0 ? 0 : p < 25 ? 1 : p < 50 ? 2 : p < 75 ? 3 : p < 90 ? 4 : p < 100 ? 5 : 6);
      return {
        title: `${thrLabel(t)}: share of years reached`, sub: `Share of ${np} years in which the threshold was reached by Dec 31`,
        scale: { classes, cls }, specials: [],
        at(idx) {
          const g = norm[2 * n + idx];
          if (g === 0 && !norm[idx] && !isLand(idx)) return null;
          return { k: cls(g), text: `reached in ${g}% of years` };
        },
      };
    }

    if (view === "heat") {
      const cum = await fetchBin(`${y}/cum${EXT}`);
      const edgesF = [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 5000, 6000];
      const pal = edgesF.length + 1;
      const classes = [];
      for (let k = 0; k <= edgesF.length; k++) {
        const a = k ? edgesF[k - 1] : 0, b = edgesF[k];
        classes.push({ c: ramp(HEAT, k / (pal - 1)), label: b ? `${fmtDD(a)}–${fmtDD(b)}` : `${fmtDD(a)}+` });
      }
      const cls = (v) => { let k = 0; while (k < edgesF.length && v >= edgesF[k]) k++; return k; };
      return {
        title: `Heat accumulated in ${y}`, sub: `${ddUnit()} above 50 °F (10 °C), Jan 1 to ${M.fmtDoy(lastDoy(y), y)}. SLF needs about ${fmtDD(3362)} for 50% egg laying.`,
        scale: { classes, cls }, specials: [],
        at(idx) {
          if (!isLand(idx)) return null;
          return { k: cls(cum[idx]), text: `${fmtDD(cum[idx])} ${ddUnit()}` };
        },
      };
    }

    if (view === "stage") {
      const src = state.stageSrc;
      const layers = await Promise.all(SLF_IDS.map((id) => (src === "normal" ? fetchBin(`normal/${id}${EXT}`) : fetchBin(`${y}/${id}${EXT}`))));
      const d = state.stageDoy;
      const ld = lastDoy(y), done = isComplete(y);
      const future = src === "year" && !done && d > ld;
      const classes = STAGES.map((s) => ({ c: s.c, label: s.label }));
      const when = src === "normal" ? `${M.fmtDoy(d)} in a normal year (${np})` : `${M.fmtDoy(d, y)}, ${y}`;
      return {
        title: `SLF life stage on ${when}`,
        sub: future ? `No data after ${M.fmtDoy(ld, y)}; showing the stage reached by then.` : "Most advanced stage reached, from the DDRP SLF degree-day model",
        scale: { classes, cls: (k) => k }, specials: [],
        at(idx) {
          if (!isLand(idx)) return null;
          let k = 0;
          for (let e = 0; e < layers.length; e++) {
            const v = src === "normal" ? layers[e][idx] / 10 : layers[e][idx];
            if (v > 0 && v <= d) k = e + 1;
          }
          return { k, text: STAGES[k].label.toLowerCase() };
        },
      };
    }
  }

  let landMask = null;
  const isLand = (idx) => landMask && landMask[idx] === 1;
  async function loadLand() {
    const a = await fetchBin(`normal/gdd100${EXT}`);
    const n = N();
    landMask = new Uint8Array(n);
    for (let i = 0; i < n; i++) landMask[i] = a[2 * n + i] > 0 ? 1 : 0;
  }

  // ---------------------------------------------------------------- raster
  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  function gridBounds() {
    const g = man.grid;
    return [[g.north - g.nrows * g.dlat, g.west], [g.north, g.west + g.ncols * g.dlon]];
  }
  function rasterURL(v) {
    const g = man.grid;
    const [[s], [nth]] = gridBounds();
    const W = g.ncols * 2;
    const yN = mercY(nth), yS = mercY(s);
    const H = Math.round((W * (yN - yS)) / ((g.ncols * g.dlon * Math.PI) / 180));
    const rows = new Int32Array(H);
    for (let r = 0; r < H; r++) {
      const y = yN - ((r + 0.5) / H) * (yN - yS);
      const lat = (Math.atan(Math.exp(y)) * 360) / Math.PI - 90;
      rows[r] = Math.min(g.nrows - 1, Math.floor((g.north - lat) / g.dlat));
    }
    // Colour every grid cell once, then resample rows into Web Mercator.
    const n = N(), rgba = new Uint8ClampedArray(n * 4), hatch = new Uint8Array(n);
    for (let idx = 0; idx < n; idx++) {
      const r = v.at(idx);
      if (!r) continue;
      let c;
      if (typeof r.k === "string") { c = SPECIAL[r.k].c; if (SPECIAL[r.k].hatch) hatch[idx] = 1; }
      else c = v.scale.classes[r.k].c;
      rgba.set([c[0], c[1], c[2], 255], idx * 4);
    }
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    const img = ctx.createImageData(W, H);
    for (let r = 0; r < H; r++) {
      const base = rows[r] * g.ncols;
      for (let x = 0; x < W; x++) {
        const idx = base + (x >> 1);
        let o = idx * 4;
        const p = (r * W + x) * 4;
        if (hatch[idx] && (x + r) % 6 < 2) { img.data.set([170, 165, 155, 255], p); continue; }
        img.data[p] = rgba[o]; img.data[p + 1] = rgba[o + 1]; img.data[p + 2] = rgba[o + 2]; img.data[p + 3] = rgba[o + 3];
      }
    }
    ctx.putImageData(img, 0, 0);
    return cv.toDataURL();
  }

  // ---------------------------------------------------------------- map panels
  const darkMode = () => {
    const t = document.documentElement.getAttribute("data-theme");
    return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  };
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const tileURL = (kind) => `https://{s}.basemaps.cartocdn.com/${darkMode() ? "dark" : "light"}_${kind}/{z}/{x}/{y}{r}.png`;

  let boundaries = null, records = null;
  const panels = [];
  let syncing = false;

  class Panel {
    constructor(host, view) {
      this.view = view;
      this.el = h("figure", { class: "panel" },
        h("figcaption", {}, h("h3", { class: "panel-title" }), h("p", { class: "panel-sub" })),
        h("div", { class: "map", role: "application", "aria-label": "Map. Click to see dates for a location." }),
        h("p", { class: "readout", "aria-live": "polite" }, "Hover or tap the map for values."),
        h("div", { class: "legend" }));
      host.append(this.el);
      const map = L.map($(".map", this.el), { zoomSnap: 0.25, minZoom: 3, maxZoom: 11, worldCopyJump: false, maxBounds: [[5, -175], [72, -35]] });
      this.map = map;
      for (const [name, z] of [["raster", 350], ["lines", 420], ["labels", 430], ["records", 440]]) {
        const p = map.createPane(name); p.style.zIndex = z;
        if (name !== "raster") p.style.pointerEvents = "none";
      }
      map.attributionControl.setPrefix(false);
      this.base = L.tileLayer(tileURL("nolabels"), { subdomains: "abcd", maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>' }).addTo(map);
      this.labels = L.tileLayer(tileURL("only_labels"), { subdomains: "abcd", maxZoom: 19, pane: "labels" }).addTo(map);
      this.overlay = L.imageOverlay("data:image/gif;base64,R0lGODlhAQABAAAAACw=", gridBounds(), { pane: "raster", opacity: 0.88, interactive: false }).addTo(map);
      this.lineRenderer = L.canvas({ pane: "lines" });
      this.recRenderer = L.canvas({ pane: "records" });
      this.addLines();
      this.recLayer = L.layerGroup();
      this.marker = L.circleMarker([state.loc.lat, state.loc.lon], { radius: 7, weight: 3, color: cssVar("--accent"), fillColor: "#fff", fillOpacity: 1, interactive: false, pane: "markerPane" }).addTo(map);
      map.fitBounds([[24.6, -124.5], [49.2, -67]], { padding: [4, 4] });
      map.on("move", () => this.sync());
      map.on("zoomend", () => this.sizeRecords());
      map.on("mousemove", (e) => this.hover(e.latlng));
      map.on("mouseout", () => { $(".readout", this.el).textContent = "Hover or tap the map for values."; });
      map.on("click", (e) => { this.hover(e.latlng); selectLocation(e.latlng.lat, e.latlng.lng); });
    }
    addLines() {
      if (!boundaries) return;
      const col = cssVar("--map-line");
      this.lines = L.polyline(boundaries, { renderer: this.lineRenderer, color: col, weight: 0.7, opacity: 0.9, interactive: false }).addTo(this.map);
    }
    restyle() {
      this.base.setUrl(tileURL("nolabels"));
      this.labels.setUrl(tileURL("only_labels"));
      if (this.lines) this.lines.setStyle({ color: cssVar("--map-line") });
      this.marker.setStyle({ color: cssVar("--accent") });
    }
    sync() {
      if (syncing) return;
      syncing = true;
      for (const p of panels) if (p !== this) p.map.setView(this.map.getCenter(), this.map.getZoom(), { animate: false });
      syncing = false;
    }
    setRecords(on) {
      this.recLayer.clearLayers();
      if (on && records) {
        for (const [lon, lat, , est] of records) {
          L.circleMarker([lat, lon], { renderer: this.recRenderer, radius: 1, weight: est ? 0 : 0.8, color: "#111", fillColor: "#111", fillOpacity: est ? 0.55 : 0, opacity: 0.6, interactive: false, est }).addTo(this.recLayer);
        }
        this.recLayer.addTo(this.map);
        this.sizeRecords();
      } else this.recLayer.remove();
    }
    sizeRecords() {
      // Records sit on ~10 km cells: keep dots smaller than a cell when zoomed out.
      const r = Math.max(0.9, Math.min(4, 0.45 * 2 ** (this.map.getZoom() - 4)));
      this.recLayer.eachLayer((m) => m.setRadius(m.options.est ? r : r * 0.85));
    }
    async render() {
      const token = (this.token = {});
      const el = this.el;
      el.classList.add("loading");
      try {
        const v = await buildView(this.view);
        if (token !== this.token) return;
        this.v = v;
        $(".panel-title", el).textContent = v.title;
        $(".panel-sub", el).textContent = v.sub;
        this.overlay.setUrl(rasterURL(v));
        drawLegend($(".legend", el), v);
      } catch (e) {
        $(".panel-sub", el).textContent = `Could not load map data (${e.message}).`;
      } finally {
        el.classList.remove("loading");
      }
    }
    hover(ll) {
      const out = $(".readout", this.el);
      const c = man && this.v ? cellOf(ll.lat, ll.lng) : null;
      const r = c ? this.v.at(c.idx) : null;
      const where = `${Math.abs(ll.lat).toFixed(2)}°${ll.lat >= 0 ? "N" : "S"} ${Math.abs(ll.lng).toFixed(2)}°${ll.lng < 0 ? "W" : "E"}`;
      out.textContent = r ? `${where}: ${r.text}` : `${where}: outside the gridded area (contiguous US). Click for a live estimate.`;
    }
  }

  function drawLegend(el, v) {
    el.replaceChildren();
    const sw = (c, label, hatched) => h("li", {},
      h("span", { class: "sw" + (hatched ? " hatched" : ""), style: `background-color: rgb(${c.join(",")})` }), h("span", {}, label));
    const list = h("ul", { class: "legend-list" + (v.diverging ? " diverging" : "") });
    v.scale.classes.forEach((k) => list.append(sw(k.c, k.label)));
    for (const s of v.specials || []) list.append(sw(SPECIAL[s].c, SPECIAL[s].label, SPECIAL[s].hatch));
    el.append(list);
  }

  function layoutPanels() {
    const host = $("#maps");
    const want = state.layout === "quad" ? QUAD : [state.view];
    const center = panels[0]?.map.getCenter(), zoom = panels[0]?.map.getZoom();
    if (panels.length !== want.length) {
      for (const p of panels) p.map.remove();
      panels.length = 0;
      host.replaceChildren();
      host.className = state.layout === "quad" ? "maps quad" : "maps single";
      for (const v of want) panels.push(new Panel(host, v));
      if (center) for (const p of panels) p.map.setView(center, zoom, { animate: false });
      for (const p of panels) p.setRecords(state.records);
    }
    panels.forEach((p, k) => { p.view = want[k]; });
    for (const p of panels) p.render();
    $("#stage-controls").hidden = !(state.layout === "single" && state.view === "stage");
    $("#view-tabs").hidden = state.layout === "quad";
    syncControls();
    writeHash();
  }

  // ---------------------------------------------------------------- controls
  function syncControls() {
    $("#thr").value = state.thr;
    $("#year").value = String(state.year);
    for (const b of document.querySelectorAll("#view-tabs button")) b.setAttribute("aria-pressed", String(b.dataset.view === state.view));
    for (const b of document.querySelectorAll("#layout button")) b.setAttribute("aria-pressed", String(b.dataset.layout === state.layout));
    for (const b of document.querySelectorAll("#units button")) b.setAttribute("aria-pressed", String(b.dataset.units === state.units));
    $("#records").checked = state.records;
    $("#stage-doy").value = state.stageDoy;
    $("#stage-src").value = state.stageSrc;
    $("#stage-date").textContent = state.stageSrc === "normal" ? M.fmtDoy(state.stageDoy) : M.fmtDoy(state.stageDoy, state.year);
    $("#thr").disabled = state.layout === "single" && state.view === "stage";
  }

  function fillThresholdSelect() {
    const sel = $("#thr");
    sel.replaceChildren();
    const g1 = h("optgroup", { label: "SLF life stages (DDRP model)" });
    const g2 = h("optgroup", { label: `Degree-day thresholds, base 50 °F` });
    for (const t of man.thresholds) {
      const o = h("option", { value: t.id }, t.kind === "slf" ? `${t.label} (${fmtDD(t.dd_f)} ${ddUnit()})` : `${fmtDD(t.dd_f)} ${ddUnit()}`);
      (t.kind === "slf" ? g1 : g2).append(o);
    }
    sel.append(g1, g2);
    sel.value = state.thr;
  }

  let playTimer = null;
  function wireControls() {
    $("#thr").addEventListener("change", (e) => { state.thr = e.target.value; layoutPanels(); renderSide(); });
    $("#year").addEventListener("change", (e) => {
      state.year = +e.target.value;
      clampStageDoy();
      layoutPanels(); renderSide();
    });
    for (const b of document.querySelectorAll("#view-tabs button")) b.addEventListener("click", () => { state.view = b.dataset.view; layoutPanels(); });
    for (const b of document.querySelectorAll("#layout button")) b.addEventListener("click", () => { state.layout = b.dataset.layout; layoutPanels(); });
    for (const b of document.querySelectorAll("#units button")) b.addEventListener("click", () => {
      state.units = b.dataset.units; fillThresholdSelect(); layoutPanels(); renderSide();
    });
    $("#records").addEventListener("change", (e) => { state.records = e.target.checked; for (const p of panels) p.setRecords(state.records); writeHash(); });
    $("#stage-doy").addEventListener("input", (e) => { state.stageDoy = +e.target.value; syncControls(); throttledRender(); });
    $("#stage-src").addEventListener("change", (e) => { state.stageSrc = e.target.value; clampStageDoy(); layoutPanels(); });
    $("#play").addEventListener("click", togglePlay);
    $("#copy-link").addEventListener("click", async () => {
      const btn = $("#copy-link");
      try { await navigator.clipboard.writeText(location.href); btn.textContent = "Link copied"; }
      catch { btn.textContent = "Copy the address bar"; }
      setTimeout(() => { btn.textContent = "Copy link"; }, 2000);
    });
    $("#search").addEventListener("submit", onSearch);
    $("#locate").addEventListener("click", onLocate);
  }

  function clampStageDoy() {
    if (state.stageDoy == null) {
      const y = state.year;
      state.stageDoy = isComplete(y) ? M.dateToDoy(new Date(Date.UTC(y, 6, 1))) : lastDoy(y);
    }
  }

  let pending = null;
  function throttledRender() {
    if (pending) return;
    pending = requestAnimationFrame(() => { pending = null; for (const p of panels) p.render(); writeHash(); });
  }

  function togglePlay() {
    const btn = $("#play");
    if (playTimer) { clearInterval(playTimer); playTimer = null; btn.textContent = "Play season"; return; }
    btn.textContent = "Pause";
    if (state.stageDoy >= 330) state.stageDoy = 60;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    playTimer = setInterval(() => {
      state.stageDoy += reduce ? 14 : 3;
      if (state.stageDoy > 335) { state.stageDoy = 335; togglePlay(); }
      syncControls(); throttledRender();
    }, reduce ? 900 : 120);
  }

  // ---------------------------------------------------------------- URL hash (works on a normal web host)
  function writeHash() {
    const p = new URLSearchParams({ t: state.thr, y: state.year, v: state.view, l: state.layout, u: state.units,
      at: `${state.loc.lat.toFixed(3)},${state.loc.lon.toFixed(3)}` });
    if (state.view === "stage") { p.set("d", state.stageDoy); p.set("s", state.stageSrc); }
    if (!state.records) p.set("r", "0");
    try { history.replaceState(null, "", "#" + p.toString()); } catch { /* sandboxed */ }
  }
  function readHash() {
    if (!location.hash.includes("=")) return;
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.get("t") && thrById(p.get("t"))) state.thr = p.get("t");
    if (p.get("y") && yearInfo(p.get("y"))) state.year = +p.get("y");
    if (p.get("v") in VIEWS) state.view = p.get("v");
    if (["single", "quad"].includes(p.get("l"))) state.layout = p.get("l");
    if (["F", "C"].includes(p.get("u"))) state.units = p.get("u");
    if (p.get("d")) state.stageDoy = Math.min(366, Math.max(1, +p.get("d")));
    if (["year", "normal"].includes(p.get("s"))) state.stageSrc = p.get("s");
    if (p.get("r") === "0") state.records = false;
    const at = (p.get("at") || "").split(",").map(Number);
    if (at.length === 2 && at.every(Number.isFinite)) state.loc = { lat: at[0], lon: at[1], name: null };
  }

  // ---------------------------------------------------------------- location panel
  async function selectLocation(lat, lon, name = null) {
    state.loc = { lat, lon, name };
    for (const p of panels) p.marker.setLatLng([lat, lon]);
    writeHash();
    renderSide();
  }

  async function pointGrid(lat, lon) {
    const c = cellOf(lat, lon);
    if (!c) return null;
    const T = man.tile, ty = Math.floor(c.i / T), tx = Math.floor(c.j / T);
    const name = `${ty}_${tx}`;
    if (!man.tiles.includes(name)) return null;
    const a = await fetchBin(`tiles/${name}${EXT}`);
    const L_ = 3 + man.tile_years.length, cell = (c.i % T) * T + (c.j % T);
    const get = (k, l) => a[(k * L_ + l) * T * T + cell];
    const out = {};
    man.thresholds.forEach((t, k) => {
      const years = {};
      man.tile_years.forEach((y, j) => { years[y] = get(k, 3 + j); });
      out[t.id] = { mean: get(k, 0) / 10 || NaN, sd: get(k, 1) / 10 || NaN, pct: get(k, 2), years };
    });
    if (out.gdd100.pct === 0 && !out.gdd100.mean) return null;
    return out;
  }

  // Open-Meteo: ERA5-based archive + forecast, daily max/min (°C).
  const omCache = new Map();
  async function omDaily(url) {
    if (!omCache.has(url)) omCache.set(url, fetch(url).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }));
    try { return await omCache.get(url); } catch (e) { omCache.delete(url); throw e; }
  }
  const daily = (j) => j.daily.time.map((t, k) => ({ date: t, tmax: j.daily.temperature_2m_max[k], tmin: j.daily.temperature_2m_min[k] }));
  const q = (lat, lon) => `latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&daily=temperature_2m_max,temperature_2m_min&timezone=auto`;

  async function liveSeason(lat, lon, year) {
    const today = new Date();
    const todayISO = M.iso(new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())));
    const end = new Date(Date.now() - 2 * 864e5);
    const rows = new Map();
    const startISO = `${year}-01-01`;
    if (M.iso(end) >= startISO) {
      const j = await omDaily(`https://archive-api.open-meteo.com/v1/archive?${q(lat, lon)}&start_date=${startISO}&end_date=${M.iso(end)}`);
      for (const d of daily(j)) if (d.tmax != null && d.tmin != null) rows.set(d.date, { ...d, kind: "obs" });
    }
    const f = await omDaily(`https://api.open-meteo.com/v1/forecast?${q(lat, lon)}&past_days=14&forecast_days=16`);
    for (const d of daily(f)) {
      if (d.tmax == null || d.tmin == null || d.date < startISO || rows.has(d.date)) continue;
      rows.set(d.date, { ...d, kind: d.date > todayISO ? "fcst" : "obs" });
    }
    const days = [...rows.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    // Fill any gap days so DOY lines up; gaps contribute nothing.
    const series = M.accumulate(days).map((d) => ({ ...d, doy: M.dateToDoy(new Date(d.date + "T00:00:00Z")) }));
    return { series, todayISO };
  }

  async function liveNormals(lat, lon) {
    const j = await omDaily(`https://archive-api.open-meteo.com/v1/archive?${q(lat, lon)}&start_date=${man.normal_period[0]}-01-01&end_date=${man.normal_period[1]}-12-31`);
    const byYear = new Map();
    for (const d of daily(j)) {
      const y = d.date.slice(0, 4);
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(d);
    }
    const out = {};
    const acc = [...byYear.values()].map((days) => M.accumulate(days));
    for (const t of man.thresholds) {
      const doys = acc.map((s) => { const i = M.firstReach(s, t.dd_f); return i < 0 ? 0 : i + 1; });
      const st = M.yearStats(doys);
      out[t.id] = { mean: st.mean, sd: st.sd, pct: Math.round(st.pct), years: {} };
    }
    return out;
  }

  let sideToken = null;
  async function renderSide() {
    const token = (sideToken = {});
    const { lat, lon, name } = state.loc;
    const y = state.year;
    const side = $("#side-body");
    $("#loc-name").textContent = name || "Selected location";
    $("#loc-coords").textContent = `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(2)}° ${lon < 0 ? "W" : "E"}`;
    side.classList.add("loading");
    let grid = null, normSrc = "grid";
    try { grid = await pointGrid(lat, lon); } catch { grid = null; }
    if (token !== sideToken) return;

    const liveStatus = $("#live-status");
    let live = null, liveErr = null;
    const currentYear = new Date().getFullYear();
    const ctx = { grid, live, y, normSrc };
    paintSide(ctx);
    side.classList.remove("loading");

    if (!grid) {
      liveStatus.textContent = "Outside the gridded area. Computing normals from Open-Meteo (ERA5), 1991–2020…";
      try {
        ctx.grid = await liveNormals(lat, lon);
        ctx.normSrc = "era5";
      } catch (e) { liveErr = e; }
      if (token !== sideToken) return;
    }
    if (y === currentYear) {
      liveStatus.textContent = "Loading this season's weather and forecast from Open-Meteo…";
      try { live = await liveSeason(lat, lon, currentYear); } catch (e) { liveErr = e; }
      if (token !== sideToken) return;
      ctx.live = live;
    }
    paintSide(ctx);
    if (liveErr) liveStatus.textContent = "Live weather (Open-Meteo) is not reachable from this page, so only the gridded NOAA data is shown.";
    else if (live) {
      const s = live.series, lastObs = [...s].reverse().find((d) => d.kind === "obs"), lastF = s[s.length - 1];
      liveStatus.textContent = `Live line: Open-Meteo observations through ${M.fmtDoy(lastObs.doy, currentYear)} and forecast to ${M.fmtDoy(lastF.doy, currentYear)}; later dates assume normal temperatures.`;
    } else if (ctx.normSrc === "era5") liveStatus.textContent = "Normals from Open-Meteo (ERA5 reanalysis), 1991–2020.";
    else liveStatus.textContent = y === currentYear ? "" : `Showing ${y} from the gridded NOAA data. Live weather is shown for ${currentYear}.`;
  }

  function normalCurve(grid) {
    const pts = man.thresholds.filter((t) => t.kind === "generic").map((t) => [grid[t.id].mean, t.dd_f, grid[t.id].sd]).filter((p) => p[0] > 0);
    return pts.sort((a, b) => a[1] - b[1]);
  }

  function paintSide({ grid, live, y, normSrc }) {
    const np = man.normal_period.join("–");
    const tbody = $("#stage-rows");
    tbody.replaceChildren();
    $("#col-year").textContent = String(y);
    const curve = grid ? normalCurve(grid) : [];
    let proj = null;
    if (live && grid) proj = projectSeason(live.series, curve, y);
    for (const id of SLF_IDS) {
      const t = thrById(id);
      const g = grid ? grid[id] : null;
      const nm = g && g.mean > 0 ? `${M.fmtDoy(g.mean)}` : g ? (g.pct ? `${g.pct}% of yrs` : "never") : "…";
      const sd = g && g.sd > 0 ? ` ± ${Math.round(g.sd)} d` : "";
      let yd = g && g.years[y] ? g.years[y] : 0;
      let ytxt = yd ? M.fmtDoy(yd, y) : "", tag = null;
      if (!yd && proj && proj[id]) { yd = proj[id].doy; ytxt = M.fmtDoy(yd, y); tag = proj[id].kind; }
      if (!ytxt) ytxt = !g ? "…" : isComplete(y) || (!yearInfo(y)) ? "not reached" : "not yet";
      let diff = "";
      if (yd && g && g.mean > 0) {
        const d = Math.round(yd - g.mean);
        diff = d === 0 ? "on time" : `${Math.abs(d)} d ${d < 0 ? "early" : "late"}`;
      }
      tbody.append(h("tr", {},
        h("th", { scope: "row" }, t.label, h("span", { class: "dd" }, `${fmtDD(t.dd_f)} ${ddUnit()}`)),
        h("td", { class: "date" }, nm, sd ? h("span", { class: "sd" }, sd.trim()) : null),
        h("td", { class: "date" }, ytxt, tag ? h("span", { class: "tag" }, tag === "fcst" ? "forecast" : tag === "proj" ? "projected" : "observed") : null),
        h("td", { class: "diff" + (diff.includes("early") ? " early" : diff.includes("late") ? " late" : "") }, diff)));
    }
    $("#norm-src").textContent = normSrc === "era5" ? `Normal: Open-Meteo ERA5, ${np}` : `Normal: NOAA nClimGrid, ${np}`;
    drawChart({ grid, live, y, curve });
  }

  /** Dates of SLF events from the live series, extended with normal increments. */
  function projectSeason(series, curve, y) {
    const out = {};
    if (!series.length) return out;
    const last = series[series.length - 1];
    for (const id of SLF_IDS) {
      const t = thrById(id);
      const i = M.firstReach(series, t.dd_f);
      if (i >= 0) { out[id] = { doy: series[i].doy, kind: series[i].kind }; continue; }
      if (!curve.length) continue;
      let cum = last.cum;
      for (let d = last.doy + 1; d <= M.daysIn(y); d++) {
        const inc = M.curveAt(curve, d) - M.curveAt(curve, d - 1);
        if (!(inc >= 0)) break;
        cum += inc;
        if (cum >= t.dd_f) { out[id] = { doy: d, kind: "proj" }; break; }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- chart
  function drawChart({ grid, live, y, curve }) {
    const host = $("#chart");
    const W = 380, H = 258, m = { l: 40, r: 84, t: 18, b: 24 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const yMaxF = 4000;
    const X = (doy) => m.l + ((doy - 1) / 365) * iw;
    const Y = (vF) => m.t + ih - (Math.min(vF, yMaxF) / yMaxF) * ih;
    const ns = "http://www.w3.org/2000/svg";
    const s = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; };
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Cumulative degree-days through the year at this location, ${y} against the normal` });
    svg.append(s("clipPath", { id: "plot-clip" }));
    svg.lastChild.append(s("rect", { x: m.l, y: m.t, width: iw, height: ih }));
    // grid + axes
    for (let k = 0; k <= yMaxF; k += state.units === "F" ? 1000 : 900) {
      svg.append(s("line", { x1: m.l, x2: m.l + iw, y1: Y(k), y2: Y(k), class: "gridline" }));
      svg.append(s("text", { x: m.l - 6, y: Y(k) + 4, class: "tick", "text-anchor": "end" }, fmtDD(k)));
    }
    for (let mo = 0; mo < 12; mo++) {
      const d = M.dateToDoy(new Date(Date.UTC(2021, mo, 1)));
      svg.append(s("line", { x1: X(d), x2: X(d), y1: m.t + ih, y2: m.t + ih + 4, class: "axis" }));
      if (mo % 2 === 0) svg.append(s("text", { x: X(d + 14), y: H - 8, class: "tick", "text-anchor": "middle" }, M.MONTHS[mo]));
    }
    svg.append(s("line", { x1: m.l, x2: m.l + iw, y1: m.t + ih, y2: m.t + ih, class: "axis" }));
    svg.append(s("text", { x: 2, y: 0, class: "tick unit", "dominant-baseline": "hanging" }, ddUnit().replace("·days", "·d")));

    // SLF event lines with de-collided labels
    const ev = SLF_IDS.map((id) => thrById(id)).filter((t) => t.dd_f <= yMaxF);
    let lastY = -Infinity;
    const placed = ev.map((t) => Y(t.dd_f)).reverse().map((yy) => { const v = Math.max(yy, lastY + 11); lastY = v; return v; }).reverse();
    ev.forEach((t, k) => {
      svg.append(s("line", { x1: m.l, x2: m.l + iw, y1: Y(t.dd_f), y2: Y(t.dd_f), class: "event-line" }));
      svg.append(s("text", { x: m.l + iw + 6, y: placed[k] + 3.5, class: "event-label" }, t.short));
    });

    const plot = s("g", { "clip-path": "url(#plot-clip)" });
    svg.append(plot);
    const path = (pts) => pts.map((p, k) => `${k ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
    if (curve.length) {
      const up = curve.filter((p) => p[2] > 0).map((p) => [p[0] - p[2], p[1]]);
      const dn = curve.filter((p) => p[2] > 0).map((p) => [p[0] + p[2], p[1]]).reverse();
      if (up.length > 1) plot.append(s("path", { d: path(up) + path(dn).replace("M", "L") + "Z", class: "band" }));
      plot.append(s("path", { d: path([[1, 0], ...curve]), class: "normal-line" }));
    }
    let yearPts = [];
    if (grid && grid.gdd100 && grid.gdd100.years[y] != null) {
      yearPts = man.thresholds.filter((t) => t.kind === "generic" && grid[t.id].years[y] > 0).map((t) => [grid[t.id].years[y], t.dd_f]).sort((a, b) => a[1] - b[1]);
      if (yearPts.length) plot.append(s("path", { d: path([[1, 0], ...yearPts]), class: "year-line" }));
    }
    if (live) {
      const obs = live.series.filter((d) => d.kind === "obs").map((d) => [d.doy, d.cum]);
      const fc = live.series.filter((d, k, a) => d.kind === "fcst" || (a[k + 1] && a[k + 1].kind === "fcst" && d.kind === "obs")).map((d) => [d.doy, d.cum]);
      if (obs.length) plot.append(s("path", { d: path(obs), class: "live-line" }));
      if (fc.length > 1) plot.append(s("path", { d: path(fc), class: "live-line fcst" }));
    }
    // hover
    const cross = s("line", { y1: m.t, y2: m.t + ih, class: "cross", visibility: "hidden" });
    svg.append(cross);
    const hit = s("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" });
    svg.append(hit);
    host.replaceChildren(svg);
    const tip = $("#chart-tip");
    tip.hidden = true;
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const doy = Math.max(1, Math.min(365, Math.round(((px - m.l) / iw) * 365 + 1)));
      cross.setAttribute("x1", X(doy)); cross.setAttribute("x2", X(doy)); cross.setAttribute("visibility", "visible");
      const lines = [h("strong", {}, y ? M.fmtDoy(doy, y) : M.fmtDoy(doy))];
      const nv = curve.length ? M.curveAt([[1, 0], ...curve], doy) : NaN;
      if (nv >= 0) lines.push(h("span", { class: "k-normal" }, `Normal: ${fmtDD(nv)}`));
      const yv = yearPts.length ? M.curveAt([[1, 0], ...yearPts], doy) : NaN;
      if (yv >= 0) lines.push(h("span", { class: "k-year" }, `${y} (NOAA): ${fmtDD(yv)}`));
      if (live) {
        const d = live.series.find((x) => x.doy === doy);
        if (d) lines.push(h("span", { class: "k-live" }, `${d.kind === "fcst" ? "Forecast" : "Open-Meteo"}: ${fmtDD(d.cum)}`));
      }
      tip.replaceChildren(...lines.flatMap((l, k) => (k ? [h("br"), l] : [l])));
      tip.hidden = false;
      const left = Math.min(r.width - 150, Math.max(0, ((X(doy) / W) * r.width) + 10));
      tip.style.left = `${left}px`;
    };
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerdown", move);
    hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); tip.hidden = true; });
    $("#key-year").textContent = `${y} (NOAA grid)`;
    $("#key-live").hidden = !live;
  }

  // ---------------------------------------------------------------- search / locate
  async function onSearch(e) {
    e.preventDefault();
    const text = $("#q").value.trim();
    const msg = $("#search-msg");
    msg.textContent = "";
    const ll = text.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (ll) { selectLocation(+ll[1], +ll[2], `${(+ll[1]).toFixed(2)}, ${(+ll[2]).toFixed(2)}`); flyTo(+ll[1], +ll[2]); return; }
    if (!text) return;
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us,ca,mx&q=${encodeURIComponent(text)}`, { headers: { Accept: "application/json" } });
      const j = await r.json();
      if (!j.length) { msg.textContent = `No place found for “${text}”. Try a town and state, or “lat, lon”.`; return; }
      const name = j[0].display_name.split(",").slice(0, 3).join(",");
      selectLocation(+j[0].lat, +j[0].lon, name);
      flyTo(+j[0].lat, +j[0].lon);
    } catch {
      msg.textContent = "Place search is not reachable here. Enter coordinates as “lat, lon”, or click the map.";
    }
  }
  function onLocate() {
    const msg = $("#search-msg");
    if (!navigator.geolocation) { msg.textContent = "This browser does not share location."; return; }
    navigator.geolocation.getCurrentPosition(
      (p) => { selectLocation(p.coords.latitude, p.coords.longitude, "Your location"); flyTo(p.coords.latitude, p.coords.longitude); },
      () => { msg.textContent = "Location access was not allowed. Click the map or search instead."; },
      { timeout: 10000 });
  }
  function flyTo(lat, lon) { panels[0]?.map.setView([lat, lon], Math.max(6, panels[0].map.getZoom()), { animate: true }); }

  // ---------------------------------------------------------------- boot
  async function boot() {
    try {
      man = await fetch(BASE + "manifest.json").then((r) => r.json());
    } catch (e) {
      $("#maps").textContent = "The map data could not be loaded. Reload the page to try again.";
      return;
    }
    const years = Object.keys(man.years).map(Number).sort();
    // Early in a year almost nothing has been reached yet; open on last year until May.
    const newest = years[years.length - 1];
    state.year = man.years[newest].complete || M.dateToDoy(new Date(man.years[newest].last_date + "T00:00:00Z")) >= 120 || years.length < 2 ? newest : years[years.length - 2];
    readHash();
    clampStageDoy();
    const ys = $("#year");
    for (const y of [...years].reverse()) ys.append(h("option", { value: y }, `${y}${man.years[y].complete ? "" : " (to date)"}`));
    fillThresholdSelect();
    $("#updated").textContent = `Data through ${M.fmtDoy(lastDoy(state.year), state.year)}, ${state.year}`;
    if (/claude/.test(location.hostname)) $("#copy-link").hidden = true;
    wireControls();
    try {
      const [b, r] = await Promise.all([fetch("data/boundaries.json").then((x) => x.json()), fetch("data/slf_range.json").then((x) => x.json()), loadLand()]);
      boundaries = b.map((flat) => { const out = []; for (let k = 0; k < flat.length; k += 2) out.push([flat[k + 1], flat[k]]); return out; });
      records = r.records;
    } catch { /* overlays are optional */ }
    layoutPanels();
    renderSide();
    const restyle = () => panels.forEach((p) => p.restyle());
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", restyle);
    new MutationObserver(restyle).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }
  boot();
})();
