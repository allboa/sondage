// playproj: Time and depth.
//
// Several time series on one globe on one date. Each layer is an array with
// a time axis and, for an ocean model, a depth axis, read in place from a
// virtual store (byte references into the original files). The clock is a
// date; each layer shows its own nearest time step. Surface layers (sea ice,
// SST) are textures on a mesh placed through the grid's own CRS. An ocean
// layer is read over a box, every level down to a chosen depth, and drawn as
// a shell sunk below the surface by its depth times the exaggeration, and two
// sections through the box. The registry (data/fourd/stores.json) names
// where the index lives; src/core/fourd.js holds the axes, the clock and the
// cache; js/fourd-read.js reads.

import * as THREE from "three";
import * as F from "../src/core/fourd.js";
import * as R from "../src/read/index.js";
import { loadCoastline } from "./data.js";
import { makeStage, readParams, hashWriter, shareLinks, oneOf, makeFrame, makeTexture, cutout, cssStops, surfaceLayer, volumeLayer, paintLayer, isoLayer, clearGroup } from "../src/scene/index.js";
import { hashString } from "../src/core/storecrs.js";

const proj4 = window.proj4;
const $ = (id) => document.getElementById(id);
const DEG = "\u00b0";
const D2R = Math.PI / 180;
const DAY = 86400000;
const AHEAD = 3;
const COLORS = { bg: 0x05070d, base: 0x1b2433, coast: 0xd7ecff, box: 0xffd34d, pick: 0xff7ab8 };
const STEPS = ["day", "5day", "month", "year"];

// ---------------------------------------------------------------- state

const defaults = {
  date: "2025-09-15", layers: "oisst-sst,g02202-south,bran-temp", box: "60,90,-70,-45",
  lev: 30, zmax: 3, dz: 3, cl: 0.5, cp: 0.5, cut: 1, coast: 1, step: "day", base: "", view: "globe", t: 1, range: 20000, clon: null, clat: null, cam: null, iso: ""
};
const state = { ...defaults };
function readHash() {
  const num = (r) => (r === "" || !isFinite(+r) ? undefined : +r);
  readParams(state, defaults, { date: (r) => (F.parseDay(r) !== null ? r : undefined), layers: String, box: String, base: String, iso: String, step: oneOf(STEPS, "day"),
    view: oneOf(["globe", "aeqd", "spilhaus"], "globe"), clon: num, clat: num });
  state.t = Math.max(0, Math.min(1, state.t));
  state.range = Math.max(100, Math.min(20000, state.range));
  state.zmax = Math.max(1, Math.min(3.7, state.zmax));
  state.dz = Math.max(0, Math.min(3, state.dz));
  state.cl = Math.max(0, Math.min(1, state.cl));
  state.cp = Math.max(0, Math.min(1, state.cp));
  state.lev = Math.max(0, Math.round(state.lev));
}
const writeHash = hashWriter(state, defaults);
readHash();

// how each layer is drawn: "fill" (the default), "lines" (contours only) or
// "both"; the hash keeps the others as id:mode,id:mode
const ISO = ["fill", "lines", "both"];
function isoOf(id) {
  for (const p of state.iso.split(",")) { const [k, m] = p.split(":"); if (k === id && ISO.includes(m)) return m; }
  return "fill";
}
function setIso(id, mode) {
  const keep = state.iso.split(",").filter((p) => p && p.split(":")[0] !== id);
  if (mode !== "fill") keep.push(`${id}:${mode}`);
  state.iso = keep.join(",");
  writeHash();
}

const ui = {
  date: $("date"), dateOut: $("date-out"), dateText: $("date-text"), play: $("play"), back: $("back"), fwd: $("fwd"), step: $("step"),
  loading: $("loading"), layers: $("layers").tBodies[0], cut: $("cut"), coast: $("coast"),
  box: $("box"), boxGo: $("box-go"), lev: $("lev"), levOut: $("lev-out"), zmax: $("zmax"), zmaxOut: $("zmax-out"),
  dz: $("dz"), dzOut: $("dz-out"), cl: $("cl"), clOut: $("cl-out"), cp: $("cp"), cpOut: $("cp-out"),
  pick: $("pick-table").tBodies[0], profile: $("profile"), pickHint: $("pick-hint"),
  view: $("view"), t: $("t"), tOut: $("t-out"), range: $("range"), rangeOut: $("range-out"), centrePick: $("centre-pick"), centreBox: $("centre-box"),
  probe: $("probe"), reset: $("reset-view"), hosts: $("hosts").tBodies[0], status: $("status"), credit: $("credit")
};

const dayOf = (ms) => Math.floor(ms / DAY);
const exag = () => 10 ** state.dz;
const zmaxM = () => 10 ** state.zmax;
function parseBox(s) {
  const b = String(s).split(",").map(Number);
  if (b.length !== 4 || !b.every(isFinite) || b[3] <= b[2] || b[2] < -90 || b[3] > 90) return null;
  if (b[1] <= b[0]) b[1] += 360;
  return b;
}
let box = parseBox(state.box) || parseBox(defaults.box);

// ---------------------------------------------------------------- stage

const { renderer, scene: world, camera, controls, setCamera, resize } = makeStage($("three"), {
  bg: COLORS.bg, fov: 35, near: 0.01, far: 100,
  onCamera: (cam) => { state.cam = cam; writeHash(); }
});
controls.minDistance = 0.02;
controls.maxDistance = 12;

// ---------------------------------------------------------------- where things go
// (src/scene/frame.js: globe, maps, unfold, range, picking back to the Earth)

const frame = makeFrame(world);
const { root, view, gridGeometry, lineGeometry, placePoint } = frame;
const dropGeometry = (g) => frame.drop(g);
function setView() {
  frame.set({ key: state.view, lon0: state.clon ?? (box[0] + box[1]) / 2, lat0: state.clat ?? (box[2] + box[3]) / 2, rangeKm: state.range, t: state.t });
}
setView();
const relayout = () => { setView(); frame.relayout(); placeMarker(); };
const reblend = () => { frame.set({ t: state.t }); frame.reblend(); placeMarker(); };

function defaultCamera() {
  // the target is the centre (the origin of the frame); the eye stands off
  // to the equator side of a box on the globe, low enough to see down its
  // sections, and south of the centre over a map, so north is up
  let s, p;
  if (view.key === "spilhaus") p = [0, -0.6, 6.8];
  else if (view.key === "aeqd" && state.t > 0.5) { s = Math.min(3, Math.max(0.2, (state.range * 1000) / F.EARTH_R)); p = [0, -1.3 * s, 2.2 * s]; }
  else {
    s = Math.max(0.15, (box[3] - box[2]) * D2R * 1.6);
    const toEq = view.lat0 < 0 ? 1 : -1;
    p = [-0.6 * s, 0.95 * s * toEq, 0.45 * s];
  }
  // frame (x, y, z) to three.js (x, z, -y), as root is turned
  return [p[0], p[2], -p[1], 0, 0, 0];
}

const { cellOf } = F;

const inBox = (lon, lat) => {
  if (lat < box[2] || lat > box[3]) return false;
  const l = ((((lon - box[0]) % 360) + 360) % 360);
  return l <= box[1] - box[0];
};

// ---------------------------------------------------------------- base globe

// an opaque sphere just under the surface layers (land shows through where a
// layer has no data), cut open over the box so the ocean below shows
let base = null;
function buildBase() {
  if (base) { root.remove(base); dropGeometry(base.geometry); base.material.map.dispose(); }
  const w = 720, h = 360, tex = makeTexture(w, h), d = tex.image.data;
  const c = new THREE.Color(COLORS.base);
  const active = activeLayers().some((L) => L.entry.kind === "volume" && L.visible);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const o = (j * w + i) * 4, lon = -180 + (i + 0.5) / 2, lat = -90 + (j + 0.5) / 2;
    d[o] = c.r * 255; d[o + 1] = c.g * 255; d[o + 2] = c.b * 255;
    d[o + 3] = state.cut && active && inBox(lon, lat) ? 0 : 255;
  }
  tex.needsUpdate = true;
  base = new THREE.Mesh(gridGeometry(180, 90, (u, v) => [-180 + 360 * u, -90 + 180 * v, 0.998]), cutout(tex));
  base.renderOrder = 0;
  root.add(base);
}

let coastLines = null;
loadCoastline("110m").then((lines) => {
  const pts = [];
  for (const l of lines) for (let i = 0; i + 3 < l.length; i += 2) pts.push(l[i], l[i + 1], 1.0025, l[i + 2], l[i + 3], 1.0025);
  const g = lineGeometry(pts);
  coastLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: COLORS.coast, transparent: true, opacity: 0.55 }));
  coastLines.visible = !!state.coast;
  root.add(coastLines);
}).catch(() => {});

// ---------------------------------------------------------------- layers

let registry = null, baseUrl = "";
const layers = new Map(); // id -> layer
const reader = R.makeReader({ budget: 384 * 2 ** 20 });
const activeIds = () => state.layers.split(",").filter((id) => layers.has(id));
const activeLayers = () => activeIds().map((id) => layers.get(id));

function newLayer(entry) {
  return { entry, ds: null, opening: null, error: "", group: new THREE.Group(), parts: null, visible: false, shown: null, status: "" };
}

async function openLayer(L) {
  if (L.ds) return L.ds;
  if (!L.opening) L.opening = R.openDataset(L.entry, baseUrl).then((ds) => {
    L.ds = ds;
    // a store described by its own metadata names its CRS itself
    if (!L.entry.crs && ds.desc.crs) L.entry = { ...L.entry, crs: ds.desc.crs };
    buildParts(L);
    return ds;
  },
    (e) => { L.error = e.message || String(e); L.opening = null; throw e; });
  return L.opening;
}

// the time span of a layer, as days
const spanOf = (L) => L.ds && L.ds.desc.axes.t ? [dayOf(L.ds.desc.axes.t.dates[0]), dayOf(L.ds.desc.axes.t.dates.at(-1))] : null;

// what a layer reads for a date: its time index and the window
function readPlan(L, ms) {
  const d = L.ds.desc, tt = F.timeAt(d, ms);
  if (tt.index === null) return null;
  const outside = tt.outside || Math.abs(tt.offsetDays) > 3 * Math.max(1, typicalStep(d));
  return { tt, outside, k: L.parts.k, w: L.parts.w };
}
function typicalStep(d) {
  const t = d.axes.t.dates;
  return t.length > 1 ? (t.at(-1) - t[0]) / (t.length - 1) / DAY : 1;
}

// geometry for a layer: a surface mesh over its whole grid, or for an ocean
// layer the window over the box and its shell and two sections
function buildParts(L) {
  clearGroup(frame, L.group);
  const d = L.ds.desc, e = L.entry;
  const P = e.kind !== "volume"
    ? surfaceLayer(frame, L.group, d, e, { crs: e.crs, proj4, tag: L })
    : volumeLayer(frame, L.group, d, e, { crs: e.crs, box, zmax: zmaxM(), lev: state.lev, cl: state.cl, cp: state.cp, exag: exag(), rim: COLORS.box, tag: L });
  if (P.error) { L.error = P.error; L.parts = null; return; }
  L.parts = P;
  if (!root.children.includes(L.group)) root.add(L.group);
  if (L.shown) applyData(L, L.shown.values);
}

function surfaceMask(L) {
  const P = L.parts;
  if (!state.cut || !activeLayers().some((M) => M.entry.kind === "volume" && M.visible)) return null;
  if (P.mask && P.maskBox === box.join(",")) return P.mask;
  const m = new Uint8Array(P.nx * P.ny);
  for (let i = 0; i < m.length; i++) { const lon = P.centres[2 * i], lat = P.centres[2 * i + 1]; m[i] = lon === lon && inBox(lon, lat) ? 1 : 0; }
  P.mask = m; P.maskBox = box.join(",");
  return m;
}

function applyData(L, values) {
  const P = L.parts;
  if (!P) return;
  const mask = P.kind === "surface" ? surfaceMask(L) : null;
  paintLayer(P, values, L.entry, mask);
  isoLayer(frame, P, values, L.entry, isoOf(L.entry.id), mask);
}

// The same array in gridlook, and in this site's store explorer, at a time
// step (and level), centred on the view's centre.
function lookUrls(ds, t, k = null) {
  if (!ds || !ds.urls) return null;
  const d = ds.desc, p = { varname: ds.entry.var };
  if (d.axes.t && t != null) p[`dimIndices_${d.axes.t.dim}`] = t;
  if (d.axes.z && k) p[`dimIndices_${d.axes.z.dim}`] = k;
  p.lat = +view.lat0.toFixed(2); p.lon = +view.lon0.toFixed(2);
  const h = hashString("icechunk+" + ds.urls.icechunk, p);
  return { gridlook: "https://gridlook.pages.dev/#" + h, store: "./store.html#" + h };
}
function lookLinks(parent, urls) {
  if (!urls) return;
  for (const [label, href] of [["gridlook", urls.gridlook], ["store", urls.store]]) {
    const a = document.createElement("a");
    a.href = href; a.target = "_blank"; a.rel = "noopener"; a.textContent = label;
    a.title = label === "gridlook" ? "open this array in gridlook" : "open this array in the store explorer";
    parent.append(" ", a);
  }
}

// ---------------------------------------------------------------- the clock

let span = [dayOf(F.parseDay(defaults.date)) - 365, dayOf(F.parseDay(defaults.date)) + 365];
function setSpan() {
  const s = activeLayers().map(spanOf).filter(Boolean);
  if (!s.length) return;
  span = [Math.min(...s.map((x) => x[0])), Math.max(...s.map((x) => x[1]))];
  ui.date.min = span[0]; ui.date.max = span[1];
}
// the clock is the middle of the day, where daily means are stamped
const dateMs = () => F.parseDay(state.date) + DAY / 2;

let showing = 0;
// Show every active layer on state.date: read what each needs (from the
// cache when it is there), and paint all of them together once all have
// answered, so a frame is never half one date and half another.
async function show() {
  const ticket = ++showing, ms = dateMs();
  ui.date.value = dayOf(ms); ui.dateOut.textContent = state.date; ui.dateText.value = state.date;
  const todo = activeLayers();
  for (const L of layers.values()) if (!todo.includes(L)) { L.group.visible = false; L.visible = false; }
  ui.loading.textContent = "reading\u2026";
  const results = await Promise.allSettled(todo.map(async (L) => {
    await openLayer(L);
    if (!L.parts) throw new Error(L.error || "not drawn");
    const plan = readPlan(L, ms);
    if (!plan || plan.outside) return { L, outside: true };
    const values = await reader.slab(L.ds, plan.tt.index, plan.k, plan.w);
    return { L, plan, values };
  }));
  if (ticket !== showing) return false;
  const needBase = [];
  results.forEach((r, i) => {
    const L = todo[i];
    if (r.status === "rejected") {
      L.group.visible = false; L.visible = false;
      const why = L.error || r.reason?.message || String(r.reason);
      L.status = /fetch/i.test(why) ? "not read: the data host did not answer (blocked, or no CORS)" : `not read: ${why}`;
      L.failed = true;
      return;
    }
    const { outside, plan, values } = r.value;
    if (outside) {
      const s = spanOf(L);
      L.group.visible = false; L.visible = false;
      L.status = s ? `no data near this date (${F.isoDay(s[0] * DAY)} to ${F.isoDay(s[1] * DAY)})` : "no time axis";
      return;
    }
    const was = L.visible;
    L.failed = false;
    L.visible = true; L.group.visible = true; L.shown = { values, plan };
    if (L.entry.kind === "volume" && !was) needBase.push(L);
    const off = plan.tt.offsetDays;
    L.status = `${F.isoDay(plan.tt.date)}${Math.abs(off) >= 1 ? ` (${off > 0 ? "+" : ""}${off.toFixed(0)} d)` : ""}, step ${plan.tt.index}`;
  });
  buildBase();
  for (const L of todo) if (L.visible) applyData(L, L.shown.values);
  ui.loading.textContent = "";
  renderLayers(); renderHosts(); refreshPick();
  prefetch(ms);
  return true;
}

// read ahead: the next few dates of every active layer, one at a time
let fetching = 0;
async function prefetch(ms) {
  const ticket = ++fetching;
  let t = ms;
  for (let s = 0; s < AHEAD; s++) {
    t = F.stepFrom(t, state.step, 1);
    for (const L of activeLayers()) {
      if (ticket !== fetching) return;
      if (!L.ds || !L.parts || L.failed) continue;
      const plan = readPlan(L, t);
      if (!plan || plan.outside) continue;
      try { await reader.slab(L.ds, plan.tt.index, plan.k, plan.w); } catch (e) { /* shown when it is the date */ }
    }
  }
}

function setDate(ms) {
  const d = Math.max(span[0], Math.min(span[1], dayOf(ms)));
  state.date = F.isoDay(d * DAY);
  writeHash();
  return show();
}

let playing = false;
async function play() {
  playing = true; ui.play.textContent = "Stop";
  while (playing) {
    const t0 = performance.now(), next = F.stepFrom(dateMs(), state.step, 1);
    if (dayOf(next) > span[1]) break;
    await setDate(next);
    const wait = 220 - (performance.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  playing = false; ui.play.textContent = "Play";
}

// ---------------------------------------------------------------- panel

function renderLayers() {
  ui.layers.innerHTML = "";
  const on = new Set(activeIds());
  for (const L of layers.values()) {
    const tr = document.createElement("tr");
    const a = document.createElement("td"), b = document.createElement("td");
    const lab = document.createElement("label"), cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = on.has(L.entry.id);
    cb.addEventListener("change", () => {
      const ids = activeIds().filter((x) => x !== L.entry.id);
      if (cb.checked) ids.push(L.entry.id);
      state.layers = [...layers.keys()].filter((x) => ids.includes(x)).join(",");
      writeHash();
      openActive().then(show);
    });
    const sw = document.createElement("span");
    sw.style.cssText = `display:inline-block;width:28px;height:8px;margin:0 6px;vertical-align:middle;background:linear-gradient(90deg,${cssStops(L.entry)})`;
    lab.append(cb, sw, document.createTextNode(L.entry.title));
    if (L.entry.crs_note) lab.title = L.entry.crs_note;
    a.append(lab); a.style.textAlign = "left";
    b.textContent = on.has(L.entry.id) ? (L.status || (L.ds ? "" : "opening\u2026")) : "";
    b.style.fontSize = "11px";
    tr.append(a, b); ui.layers.append(tr);
    if (on.has(L.entry.id)) {
      const t2 = document.createElement("tr"), c = document.createElement("td");
      c.colSpan = 2; c.className = "hint"; c.style.textAlign = "left";
      const u = L.entry.units ?? (L.ds ? L.ds.desc.units : "");
      c.append(`colour ${L.entry.range[0]} to ${L.entry.range[1]} ${u}${L.entry.below === "clear" ? ", clear below" : ""} `);
      const sel = document.createElement("select");
      sel.setAttribute("aria-label", `${L.entry.title}: fill, contour lines or both`);
      for (const m of ISO) { const o = document.createElement("option"); o.value = m; o.textContent = m === "fill" ? "fill" : m === "lines" ? "lines" : "fill + lines"; sel.append(o); }
      sel.value = isoOf(L.entry.id);
      sel.addEventListener("change", () => { setIso(L.entry.id, sel.value); if (L.visible && L.shown) applyData(L, L.shown.values); });
      c.append(sel);
      if (L.visible && L.shown) lookLinks(c, lookUrls(L.ds, L.shown.plan.tt.index, L.parts.kind === "volume" ? L.parts.lev : null));
      t2.append(c); ui.layers.append(t2);
    }
  }
}

function renderHosts() {
  ui.hosts.innerHTML = "";
  if (!R.hosts.size) return;
  const head = document.createElement("tr");
  for (const t of ["Host", "Reads", "Failed", "MB"]) { const td = document.createElement("td"); td.textContent = t; head.append(td); }
  ui.hosts.append(head);
  for (const [h, s] of R.hosts) {
    const tr = document.createElement("tr");
    for (const t of [h, s.ok, s.fail, (s.bytes / 2 ** 20).toFixed(1)]) { const td = document.createElement("td"); td.textContent = t; tr.append(td); }
    if (s.fail && !s.ok) { tr.title = s.error; tr.style.color = "var(--orange)"; }
    ui.hosts.append(tr);
  }
}
R.setFetchListener(() => { clearTimeout(renderHosts.t); renderHosts.t = setTimeout(renderHosts, 150); });

function renderControls() {
  ui.box.value = state.box;
  ui.zmax.value = state.zmax; ui.zmaxOut.textContent = `${Math.round(zmaxM())} m`;
  ui.dz.value = state.dz; ui.dzOut.textContent = `x ${Math.round(exag())}`;
  ui.cl.value = state.cl; ui.cp.value = state.cp;
  ui.cut.checked = !!state.cut; ui.coast.checked = !!state.coast;
  ui.step.value = state.step;
  ui.view.value = state.view; ui.t.value = state.t; ui.t.disabled = state.view === "globe";
  ui.tOut.textContent = state.view === "globe" ? "" : state.t.toFixed(2);
  ui.range.value = Math.log10(state.range);
  ui.rangeOut.textContent = state.range >= 20000 ? "the whole Earth" : `${Math.round(state.range)} km`;
  const V = activeLayers().find((L) => L.entry.kind === "volume" && L.parts);
  if (V) {
    const P = V.parts;
    ui.lev.max = P.nk - 1; ui.lev.value = P.lev;
    ui.levOut.textContent = `${P.z[P.lev].toFixed(1)} m (level ${P.lev})`;
    ui.clOut.textContent = `${P.lonC.toFixed(2)}${DEG}`; ui.cpOut.textContent = `${P.latC.toFixed(2)}${DEG}`;
  } else { ui.levOut.textContent = ui.clOut.textContent = ui.cpOut.textContent = "no ocean layer"; }
}

function rebuildVolumes() {
  for (const L of activeLayers()) if (L.ds && L.entry.kind === "volume") buildParts(L);
  renderControls(); writeHash();
}

ui.date.addEventListener("input", () => { state.date = F.isoDay(+ui.date.value * DAY); ui.dateOut.textContent = state.date; });
ui.date.addEventListener("change", () => setDate(+ui.date.value * DAY));
ui.dateText.addEventListener("change", () => { const t = F.parseDay(ui.dateText.value); if (t !== null) setDate(t); });
ui.back.addEventListener("click", () => setDate(F.stepFrom(dateMs(), state.step, -1)));
ui.fwd.addEventListener("click", () => setDate(F.stepFrom(dateMs(), state.step, 1)));
ui.play.addEventListener("click", () => { if (playing) playing = false; else play(); });
ui.step.addEventListener("change", () => { state.step = ui.step.value; writeHash(); prefetch(dateMs()); });
ui.cut.addEventListener("change", () => { state.cut = ui.cut.checked ? 1 : 0; writeHash(); show(); });
ui.coast.addEventListener("change", () => { state.coast = ui.coast.checked ? 1 : 0; if (coastLines) coastLines.visible = !!state.coast; writeHash(); });
ui.boxGo.addEventListener("click", () => {
  const b = parseBox(ui.box.value);
  if (!b) { ui.status.textContent = "box: west, east, south, north in degrees"; return; }
  ui.status.textContent = ""; box = b; state.box = ui.box.value.trim(); relayout(); rebuildVolumes(); show();
});
ui.lev.addEventListener("input", () => { state.lev = +ui.lev.value; rebuildVolumes(); });
ui.zmax.addEventListener("input", () => { ui.zmaxOut.textContent = `${Math.round(10 ** +ui.zmax.value)} m`; });
ui.zmax.addEventListener("change", () => { state.zmax = +ui.zmax.value; rebuildVolumes(); show(); });
ui.dz.addEventListener("input", () => { state.dz = +ui.dz.value; rebuildVolumes(); });
ui.cl.addEventListener("input", () => { state.cl = +ui.cl.value; rebuildVolumes(); });
ui.cp.addEventListener("input", () => { state.cp = +ui.cp.value; rebuildVolumes(); });
ui.view.addEventListener("change", () => {
  state.view = ui.view.value;
  if (state.view !== "globe" && state.t === 0) state.t = 1;
  relayout(); state.cam = null; setCamera(defaultCamera()); renderControls(); writeHash();
});
ui.t.addEventListener("input", () => { state.t = +ui.t.value; ui.tOut.textContent = state.t.toFixed(2); reblend(); writeHash(); });
ui.range.addEventListener("input", () => {
  const km = 10 ** +ui.range.value;
  state.range = km >= 19900 ? 20000 : Math.round(km);
  ui.rangeOut.textContent = state.range >= 20000 ? "the whole Earth" : `${state.range} km`;
});
ui.range.addEventListener("change", () => { relayout(); writeHash(); });
ui.centrePick.addEventListener("click", () => {
  if (!pickAt) { ui.status.textContent = "click the globe or map first"; return; }
  ui.status.textContent = "";
  state.clon = +pickAt.lon.toFixed(3); state.clat = +pickAt.lat.toFixed(3);
  relayout(); state.cam = null; setCamera(defaultCamera()); writeHash();
});
ui.centreBox.addEventListener("click", () => { state.clon = state.clat = null; relayout(); state.cam = null; setCamera(defaultCamera()); writeHash(); });
ui.reset.addEventListener("click", () => { state.cam = null; setCamera(defaultCamera()); writeHash(); });

// ---------------------------------------------------------------- picking

let pickAt = null;
const marker = new THREE.Mesh(new THREE.SphereGeometry(0.004, 12, 8), new THREE.MeshBasicMaterial({ color: COLORS.pick }));
marker.visible = false; root.add(marker);
function placeMarker() {
  const p = pickAt && placePoint(pickAt.lon, pickAt.lat, pickAt.r, marker.position);
  marker.visible = !!p;
}
const ray = new THREE.Raycaster();
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const targets = [];
  for (const L of activeLayers()) if (L.visible) L.group.traverse((o) => { if (o.isMesh) targets.push(o); });
  if (base) targets.push(base);
  const hit = ray.intersectObjects(targets, false)[0];
  if (!hit || !hit.face) return;
  // back from the picture to the Earth, whatever the view and unfold
  pickAt = frame.earthAt(hit);
  if (!pickAt) return;
  placeMarker();
  refreshPick();
});

function row(k, v, cls) {
  const tr = document.createElement("tr"), a = document.createElement("td"), b = document.createElement("td");
  a.textContent = k; b.textContent = v; if (cls) tr.className = cls;
  tr.append(a, b); ui.pick.append(tr);
}
const fmt = (v) => (v === v ? (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3)) : "no data");

function refreshPick() {
  ui.pick.innerHTML = "";
  ui.profile.hidden = true;
  if (!pickAt) return;
  ui.pickHint.hidden = true;
  const lon = pickAt.lon, lat = pickAt.lat;
  const depth = pickAt.r < 0.9995 ? (1 - pickAt.r) * F.EARTH_R / exag() : 0;
  row("Point", `${lat.toFixed(2)}${DEG}, ${lon.toFixed(2)}${DEG}${depth > 1 ? `, ${depth.toFixed(0)} m down` : ""}`);
  for (const L of activeLayers()) {
    if (!L.visible || !L.shown) continue;
    const d = L.ds.desc, ax = d.axes, P = L.parts, vals = L.shown.values, plan = L.shown.plan;
    let i, j;
    if (L.entry.crs) {
      const q = proj4(L.entry.crs).forward([lon, lat]);
      i = cellOf(ax.x, q[0]); j = cellOf(ax.y, q[1]);
    } else {
      i = cellOf(ax.x, ((((lon - ax.x.values[0]) % 360) + 360) % 360) + ax.x.values[0]); j = cellOf(ax.y, lat);
    }
    row(L.entry.title, "", "sub");
    if (i < 0 || j < 0) { row("cell", "outside this grid"); continue; }
    const t = plan.tt.index;
    let v, k = null;
    if (P.kind === "surface") v = vals[j * P.nx + i];
    else {
      const li = i - P.w[2], lj = j - P.w[0];
      if (li < 0 || lj < 0 || li >= P.nx || lj >= P.ny) { row("cell", "outside the box"); continue; }
      k = depth > 1 ? Math.max(0, P.edges.findIndex((e, q) => q > 0 && e >= depth) - 1) : P.lev;
      if (k < 0) k = P.nk - 1;
      v = vals[k * P.nx * P.ny + lj * P.nx + li];
      drawProfile(L, li, lj, k);
    }
    row(`value${k !== null ? ` at ${P.z[k].toFixed(1)} m` : ""}`, `${fmt(v)} ${L.entry.units ?? d.units}`);
    const idx = d.roles.map((r) => (r === "t" ? t : r === "z" ? (k ?? 0) : r === "y" ? j : r === "x" ? i : 0));
    row("cell", d.dims.map((n, q) => `${n} ${idx[q]}`).join(", "));
    row("chunk", idx.map((x, q) => Math.floor(x / d.chunks[q])).join("."));
  }
}

function drawProfile(L, li, lj, kOn) {
  const P = L.parts, vals = L.shown.values, n = P.nx * P.ny, c = ui.profile, g = c.getContext("2d");
  const W = c.width, H = c.height, m = { l: 44, r: 10, t: 14, b: 26 };
  const ys = [], xs = [];
  for (let k = 0; k < P.nk; k++) { const v = vals[k * n + lj * P.nx + li]; if (v === v) { ys.push(P.z[k]); xs.push(v); } }
  c.hidden = false;
  const css = getComputedStyle(document.body);
  const ink = css.getPropertyValue("--text") || "#ddd", muted = css.getPropertyValue("--muted") || "#999";
  g.clearRect(0, 0, W, H);
  if (!xs.length) return;
  let lo = Math.min(...xs), hi = Math.max(...xs);
  if (hi - lo < 1e-6) { lo -= 0.5; hi += 0.5; }
  const zmax = P.edges[P.nk];
  const X = (v) => m.l + ((v - lo) / (hi - lo)) * (W - m.l - m.r), Y = (z) => m.t + (z / zmax) * (H - m.t - m.b);
  g.strokeStyle = muted; g.lineWidth = 1; g.strokeRect(m.l, m.t, W - m.l - m.r, H - m.t - m.b);
  g.fillStyle = muted; g.font = "11px system-ui, sans-serif";
  g.textAlign = "right"; g.fillText("0 m", m.l - 4, m.t + 4); g.fillText(`${Math.round(zmax)} m`, m.l - 4, H - m.b);
  g.textAlign = "left"; g.fillText(lo.toFixed(2), m.l, H - 8); g.textAlign = "right"; g.fillText(`${hi.toFixed(2)} ${L.ds.desc.units}`, W - m.r, H - 8);
  g.strokeStyle = ink.trim() || "#ddd"; g.lineWidth = 1.5; g.beginPath();
  xs.forEach((v, q) => (q ? g.lineTo(X(v), Y(ys[q])) : g.moveTo(X(v), Y(ys[q]))));
  g.stroke();
  g.strokeStyle = "#ff7ab8"; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(m.l, Y(P.z[kOn])); g.lineTo(W - m.r, Y(P.z[kOn])); g.stroke(); g.setLineDash([]);
}

// ---------------------------------------------------------------- probe

ui.probe.addEventListener("click", async () => {
  ui.probe.disabled = true; ui.status.textContent = "reading one chunk from each dataset\u2026";
  const out = document.createElement("ul");
  out.className = "probe-list";
  for (const e of [...registry.datasets, ...(registry.probe || [])]) {
    if (e.synthetic) continue;
    const t0 = performance.now();
    try {
      const ds = await R.openDataset(e, baseUrl), d = ds.desc;
      const t = d.axes.t ? d.axes.t.n - 1 : 0;
      await ds.read(t, 0, 0, 1, 0, 1);
      const li = document.createElement("li");
      li.append(`${e.id}: read (${Math.round(performance.now() - t0)} ms)`);
      lookLinks(li, lookUrls(ds, t));
      out.append(li);
    } catch (err) { const li = document.createElement("li"); li.textContent = `${e.id}: not read`; li.style.color = "var(--orange)"; out.append(li); }
    renderHosts();
  }
  ui.status.replaceChildren(out);
  ui.probe.disabled = false;
});

// ---------------------------------------------------------------- start

async function openActive() {
  await Promise.allSettled(activeLayers().map(openLayer));
  setSpan(); renderControls(); renderLayers();
}

async function start() {
  try {
    registry = await (await fetch(new URL("../data/fourd/stores.json", import.meta.url))).json();
  } catch (e) { ui.status.textContent = "could not read data/fourd/stores.json"; return; }
  baseUrl = state.base || registry.base;
  for (const e of registry.datasets) layers.set(e.id, newLayer(e));
  ui.credit.textContent = "OISST v2.1: NOAA NCEI. Sea ice: NOAA/NSIDC CDR G02202 v6. BRAN: CSIRO Bluelink, at NCI. Indexes: raad.virtualize, on source.coop.";
  setCamera(state.cam || defaultCamera());
  resize();
  renderControls(); renderLayers();
  await openActive();
  await show();
  window.__fourd = { state, layers, reader, hosts: R.hosts, ready: true };
}

function tick() {
  controls.update();
  renderer.render(world, camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
shareLinks("sondage: Time and depth");
start();
