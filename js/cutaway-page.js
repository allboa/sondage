// playproj: Cutaway.
//
// A line across Antarctic ice, drawn as a section (the ice surface, the ice
// base, the cavity under a floating shelf, the bed and the sea) and as a
// block diagram cut along the line. Bedmap3 gives surface, thickness, bed,
// the grounding mask and the bed's uncertainty; REMA's surface and GEBCO
// 2026 are drawn beside it along the section. Every source is a COG read in
// place by its byte ranges at the pyramid level the line needs. The pure
// parts (sources, geometry, levels, layering) are in src/core/cutaway.js.

import * as THREE from "three";
import * as C from "../src/core/cutaway.js";
import * as GE from "../src/core/geoid.js";
import { loadScript } from "./basemap-load.js";
import { makeStage, readParams, hashWriter, shareLinks, oneOf, drawBlock as drawCut, paintBands, sectionLine, INK } from "../src/scene/index.js";

const proj4 = window.proj4;
proj4.defs("EPSG:3031", "+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs");
const toXY = (lon, lat) => proj4("EPSG:4326", "EPSG:3031", [lon, lat]);
const toLL = (x, y) => proj4("EPSG:3031", "EPSG:4326", [x, y]);
const $ = (id) => document.getElementById(id);
const DEG = "\u00b0";
const GEOTIFF_JS = "https://cdn.jsdelivr.net/npm/geotiff@3.0.5/dist-browser/geotiff.js";
// ---------------------------------------------------------------- state

// w, side, curve and site left empty take the preset's own (or the usual)
const defaults = { at: "amery", a: "", b: "", w: 0, side: "", curve: "", site: "", guide: 1, ve: 0, ice: "solid", rema: 1, gebco: 1, unc: 1, cam: null };
const state = { ...defaults };
const lonlat = (s) => { const v = String(s).split(",").map(Number); return v.length === 2 && v.every(isFinite) && v[1] < -50 && v[1] >= -90 ? s : undefined; };
readParams(state, defaults, {
  at: oneOf(C.PRESETS.map((p) => p.key), "amery"), a: lonlat, b: lonlat, ice: oneOf(["solid", "glass", "off"], "solid"),
  side: oneOf(["1", "-1", "0"], ""), curve: oneOf(["flat", "earth"], ""),
  site: (s) => (s === "none" || C.SITES.some((x) => x.key === s) || lonlat(s) ? s : undefined)
});
state.w = state.w ? Math.max(10, Math.min(3000, state.w)) : 0;
state.ve = state.ve > 0 ? Math.max(1, Math.min(C.VE_MAX, state.ve)) : 0;
const writeHash = hashWriter(state, defaults);

const preset = () => C.PRESETS.find((p) => p.key === state.at) || C.PRESETS[0];
const widthKm = () => state.w || preset().w || 120;
const sideOf = () => (state.side !== "" ? +state.side : preset().side ?? 1);
const curved = () => (state.curve || preset().curve || "flat") === "earth";
// the drill site: a named site, a typed longitude,latitude, or the preset's
function siteOf() {
  const k = state.site || preset().site || "none";
  if (k === "none") return null;
  const named = C.SITES.find((x) => x.key === k);
  if (named) return { key: k, label: named.label, short: named.label.split(" (")[0], ll: named.ll };
  const ll = k.split(",").map(Number);
  return { key: k, label: `${ll[1].toFixed(3)}${DEG}, ${ll[0].toFixed(3)}${DEG}`, short: "site", ll };
}
const ends = () => {
  const p = preset();
  const a = state.a ? state.a.split(",").map(Number) : p.a, b = state.b ? state.b.split(",").map(Number) : p.b;
  return { a, b, A: toXY(a[0], a[1]), B: toXY(b[0], b[1]) };
};

// ---------------------------------------------------------------- reading

// every request to a source is counted, as the cost of a view
const ledger = { req: 0, bytes: 0 };
const rawFetch = window.fetch.bind(window);
window.fetch = async (url, init) => {
  const r = await rawFetch(url, init);
  const u = String(url && url.url ? url.url : url);
  if (/source\.coop|githubusercontent/.test(u)) { ledger.req++; ledger.bytes += +(r.headers.get("content-length") || 0); }
  return r;
};

async function geotiff() {
  if (typeof GeoTIFF === "undefined") await loadScript(GEOTIFF_JS);
  return window.GeoTIFF;
}
// a COG's pyramid, finest first, each level with its image
const opened = new Map();
function openCog(url) {
  if (!opened.has(url)) {
    const p = (async () => {
      const GT = await geotiff();
      const tiff = await GT.fromUrl(url);
      const n = await tiff.getImageCount(), imgs = [];
      for (let i = 0; i < n; i++) imgs.push(await tiff.getImage(i));
      const [x0, y0] = imgs[0].getOrigin(), [res] = imgs[0].getResolution();
      const L = C.levelsOf(x0, y0, res, imgs.map((im) => [im.getWidth(), im.getHeight()]));
      L.forEach((l, i) => { l.img = imgs[i]; });
      return L;
    })();
    p.catch(() => opened.delete(url));
    opened.set(url, p);
  }
  return opened.get(url);
}
// REMA: three files, one level each
async function remaLevels() {
  const each = await Promise.all(C.SOURCES.rema.files.map(openCog));
  return each.map((L) => L[0]);
}
// A box of a pyramid at about px per pixel, as a sampling window.
async function readBox(levels, box, px, nodata, max = 1600) {
  const p = C.plan(levels, box, px, max);
  if (!p.win) return null;
  const [data] = await p.level.img.readRasters({ window: p.win, samples: [0] });
  const g = C.windowGrid(p.level, p.win, data, nodata);
  g.level = p.k;
  return g;
}

// A drill site at Bedmap3's full resolution: every array in a small window
// round it.
async function readSite(site, f) {
  const p = toXY(site.ll[0], site.ll[1]), box = [p[0] - 2000, p[1] - 2000, p[0] + 2000, p[1] + 2000];
  const v = {};
  await Promise.all([...C.SOURCES.bedmap.arrays, "thickness_uncertainty"].map(async (a) => {
    const w = await readBox(await openCog(C.SOURCES.bedmap.url(a)), box, 500, C.SOURCES.bedmap.nodata);
    v[a] = a === "mask" ? C.nearest(w, p[0], p[1]) : C.sample(w, p[0], p[1]);
  }));
  const l = C.layer(v.surface_topography, v.ice_thickness, v.bed_topography, v.mask);
  return { ...site, p, ...C.frameOf(f, p), l, unc: v.bed_uncertainty, hunc: v.thickness_uncertainty };
}

let geoid = null;
async function loadGeoid() {
  if (!geoid) geoid = fetch(new URL("../data/geoid-egm2008-1deg.bin", import.meta.url)).then((r) => r.arrayBuffer()).then((b) => GE.fromInt16(b));
  return geoid;
}

// ---------------------------------------------------------------- the section

let current = null;   // { f, blk, rows, grid, floor, top, ... }
let building = 0;

async function build() {
  const ticket = ++building;
  const { A, B } = ends();
  const W = widthKm() * 1000, side = sideOf();
  const f = C.lineFrame(A, B), blk = C.blockOf(f, W, side);
  const req0 = ledger.req, b0 = ledger.bytes, t0 = performance.now();
  setStatus("Reading Bedmap3...");
  try {
    const bedmap = {};
    const pxBlock = Math.max(500, Math.max(blk.box[2] - blk.box[0], blk.box[3] - blk.box[1]) / 1400);
    await Promise.all(C.SOURCES.bedmap.arrays.map(async (a) => {
      bedmap[a] = await readBox(await openCog(C.SOURCES.bedmap.url(a)), blk.box, pxBlock, C.SOURCES.bedmap.nodata);
    }));
    if (ticket !== building) return;
    const res = bedmap.bed_topography.dx;
    const N = Math.max(200, Math.min(1200, Math.round(f.L / res)));
    const layerAt = ([x, y]) => C.layer(C.sample(bedmap.surface_topography, x, y), C.sample(bedmap.ice_thickness, x, y),
      C.sample(bedmap.bed_topography, x, y), C.nearest(bedmap.mask, x, y));
    const rows = C.samplesAlong(f, N).map((r) => ({ ...r, l: layerAt(r.p), unc: C.sample(bedmap.bed_uncertainty, r.p[0], r.p[1]), ll: toLL(r.p[0], r.p[1]) }));
    // the block's grid
    // the block's grid; with the block on both sides of the line, the ice
    // comes off the right-hand side
    const span = Math.abs(blk.t1 - blk.t0);
    const nu = Math.max(40, Math.min(300, Math.round(f.L / res))), nv = Math.max(8, Math.min(300, Math.round(span / res)));
    const grid = [];
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      const s = (f.L * i) / nu, t = blk.t0 + ((blk.t1 - blk.t0) * j) / nv, l = layerAt(C.at(f, s, t));
      grid.push({ s, t, l: side === 0 && t < 0 ? C.bare(l) : l });
    }
    const all = rows.map((r) => r.l).concat(grid.map((g) => g.l));
    const floor = C.floorOf(all);
    let top = 0;
    for (const l of all) if (l.top === l.top && l.top > top) top = l.top;
    top = Math.ceil((top + 200) / 100) * 100;
    current = { f, blk, rows, grid, nu, nv, floor, top, res, N, side, curve: curved(), levels: { bedmap: bedmap.bed_topography.level }, cost: null, site: null };
    drawAll();
    // REMA and GEBCO along the section, after the first picture
    const lineBox = [Math.min(A[0], B[0]), Math.min(A[1], B[1]), Math.max(A[0], B[0]), Math.max(A[1], B[1])];
    const spacing = f.L / N;
    const extras = [];
    const site = siteOf();
    if (site) extras.push(readSite(site, f).then((v) => { current.site = v; }).catch((e) => { current.siteErr = e.message || String(e); }));
    if (state.rema) extras.push((async () => {
      setStatus("Reading REMA...");
      const [L, g] = await Promise.all([remaLevels(), loadGeoid()]);
      const w = await readBox(L, lineBox, spacing, C.SOURCES.rema.nodata, 2400);
      if (!w) return;
      current.levels.rema = L[w.level].res;
      for (const r of rows) { const v = C.sample(w, r.p[0], r.p[1]); r.rema = v === v ? v - GE.undulation(g, r.ll[0], r.ll[1]) : NaN; }
    })().catch((e) => { current.remaErr = e.message || String(e); }));
    if (state.gebco) extras.push((async () => {
      setStatus("Reading GEBCO 2026...");
      const L = await openCog(C.SOURCES.gebco.url);
      // one box, or two either side of the antimeridian
      const boxes = C.lonBoxes(rows.map((r) => r.ll[0]), rows.map((r) => r.ll[1]));
      const ws = (await Promise.all(boxes.map((b) => readBox(L, b, spacing / 111320, C.SOURCES.gebco.nodata, 2400)))).filter(Boolean);
      if (!ws.length) return;
      current.levels.gebco = Math.min(...ws.map((w) => L[w.level].res)) * 111320;
      for (const r of rows) {
        const w = ws.find((q) => r.ll[0] >= q.x0 && r.ll[0] <= q.x0 + q.width * q.dx) || ws[0];
        r.gebco = C.sample(w, r.ll[0], r.ll[1]);
      }
    })().catch((e) => { current.gebcoErr = e.message || String(e); }));
    await Promise.all(extras);
    if (ticket !== building) return;
    current.cost = { req: ledger.req - req0, bytes: ledger.bytes - b0, ms: performance.now() - t0 };
    setStatus("");
    drawSection(); drawBlock(); drawMap(); renderReadout();
  } catch (e) {
    if (ticket === building) setStatus(`The read failed: ${e.message || e}`);
  }
}

// ---------------------------------------------------------------- drawing a section

// A section into a 2D context over [x0, x1] x [y0, y1] pixels: rock, water
// and ice as filled runs, then the surface, base and bed lines. rows have
// s (metres along) and l (a layer). Shared by the panel's section and the
// faces of the block, so the two always agree.
const line = sectionLine;

let hoverS = null;
function drawSection() {
  const c = $("section"), g = c.getContext("2d");
  const W = (c.width = c.clientWidth * devicePixelRatio), H = (c.height = c.clientHeight * devicePixelRatio);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = INK.sky; g.fillRect(0, 0, W, H);
  if (!current) return;
  const k = devicePixelRatio, m = { l: 52 * k, r: 12 * k, t: 18 * k, b: 26 * k };
  const { rows, floor, top, f } = current;
  const X = (s) => m.l + (s / f.L) * (W - m.l - m.r), Y = (z) => m.t + ((top - z) / (top - floor)) * (H - m.t - m.b);
  paintBands(g, rows, floor, top, X, Y);
  // the bed's uncertainty, as a band about it
  if (state.unc) {
    g.fillStyle = INK.unc;
    g.beginPath();
    const ok = rows.filter((r) => r.unc === r.unc && r.l.bed === r.l.bed);
    ok.forEach((r, i) => (i ? g.lineTo(X(r.s), Y(r.l.bed + r.unc)) : g.moveTo(X(r.s), Y(r.l.bed + r.unc))));
    for (let i = ok.length - 1; i >= 0; i--) g.lineTo(X(ok[i].s), Y(ok[i].l.bed - ok[i].unc));
    g.closePath(); g.fill();
  }
  line(g, rows, (r) => r.l.bed, X, Y, INK.bed, 1.2 * k);
  line(g, rows, (r) => (r.l.ice > 0 ? r.l.top : NaN), X, Y, INK.surface, 1 * k);
  if (state.gebco) line(g, rows, (r) => r.gebco, X, Y, INK.gebco, 1.2 * k, [4 * k, 3 * k]);
  if (state.rema) line(g, rows, (r) => r.rema, X, Y, INK.rema, 1.2 * k);
  // sea level, grid and labels
  g.font = `${11 * k}px system-ui, sans-serif`;
  g.strokeStyle = INK.grid; g.fillStyle = INK.text; g.lineWidth = 1;
  const step = niceStep((top - floor) / 5);
  g.textAlign = "right";
  for (let z = Math.ceil(floor / step) * step; z <= top; z += step) {
    g.beginPath(); g.moveTo(m.l, Y(z)); g.lineTo(W - m.r, Y(z)); g.stroke();
    g.fillText(`${z} m`, m.l - 4 * k, Y(z) + 4 * k);
  }
  const xs = niceStep(f.L / 1000 / 6);
  g.textAlign = "center";
  for (let d = 0; d <= f.L / 1000; d += xs) g.fillText(`${d} km`, X(d * 1000), H - 8 * k);
  g.strokeStyle = "rgba(127,224,255,0.6)"; g.setLineDash([2 * k, 3 * k]);
  g.beginPath(); g.moveTo(m.l, Y(0)); g.lineTo(W - m.r, Y(0)); g.stroke(); g.setLineDash([]);
  // grounding lines
  const S = C.summary(rows);
  g.strokeStyle = INK.ground; g.lineWidth = 1.2 * k;
  for (const s of S.grounding) { g.beginPath(); g.moveTo(X(s), m.t); g.lineTo(X(s), H - m.b); g.stroke(); }
  // the drill site, where it lies near the line
  const st = current.site;
  if (st && Math.abs(st.t) < Math.max(20000, 0.03 * f.L) && st.s >= 0 && st.s <= f.L) {
    g.strokeStyle = "#ff3b3b"; g.lineWidth = 2 * k;
    g.beginPath(); g.moveTo(X(st.s), Y(st.l.top === st.l.top ? st.l.top + (top - floor) * 0.08 : top)); g.lineTo(X(st.s), Y(st.l.bed === st.l.bed ? st.l.bed : floor)); g.stroke();
    g.fillStyle = "#ff8080"; g.textAlign = "center"; g.fillText(st.short, X(st.s), m.t + 10 * k);
  }
  // the vertical exaggeration as drawn
  const ve = ((f.L / (W - m.l - m.r)) / ((top - floor) / (H - m.t - m.b)));
  g.textAlign = "left"; g.fillStyle = INK.text;
  g.fillText(`A  (vertical x ${ve.toFixed(0)})`, m.l + 4 * k, m.t - 5 * k);
  g.textAlign = "right"; g.fillText("B", W - m.r, m.t - 5 * k);
  // the hovered sample
  if (hoverS !== null) {
    const i = Math.round((hoverS / f.L) * (rows.length - 1)), r = rows[i], l = r.l;
    g.strokeStyle = "rgba(255,255,255,0.7)"; g.beginPath(); g.moveTo(X(r.s), m.t); g.lineTo(X(r.s), H - m.b); g.stroke();
    const parts = [`${(r.s / 1000).toFixed(1)} km`, l.kind];
    if (l.ice > 0) parts.push(`ice ${l.ice.toFixed(0)} m`);
    if (l.top === l.top) parts.push(`surface ${l.top.toFixed(0)} m`);
    if (l.water && l.kind === "floating") parts.push(`cavity ${(l.water[0] - l.water[1]).toFixed(0)} m`);
    if (l.bed === l.bed) parts.push(`bed ${l.bed.toFixed(0)}${r.unc === r.unc ? ` \u00b1 ${r.unc.toFixed(0)}` : ""} m`);
    if (r.rema === r.rema && r.rema !== undefined) parts.push(`REMA ${r.rema.toFixed(0)} m`);
    if (r.gebco === r.gebco && r.gebco !== undefined) parts.push(`GEBCO ${r.gebco.toFixed(0)} m`);
    g.textAlign = "right"; g.fillStyle = "#fff";
    g.fillText(parts.join(", "), W - m.r - 30 * k, m.t - 5 * k);
  }
}
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}

$("section").addEventListener("mousemove", (e) => {
  if (!current) return;
  const r = e.target.getBoundingClientRect(), x = e.clientX - r.left;
  hoverS = Math.max(0, Math.min(1, (x - 52) / (r.width - 64))) * current.f.L;
  drawSection(); drawMap(); placePin();
});
$("section").addEventListener("mouseleave", () => { hoverS = null; drawSection(); drawMap(); placePin(); });

// ---------------------------------------------------------------- the map

// The legend map: Bedmap3's whole grid from a coarse overview, zoomed and
// panned in EPSG:3031 metres (view), with a finer read of the same arrays
// over the view once it is zoomed in far enough for the overview to blur.
const MAP = { half: C.MAP_HALF };
let view = { cx: 0, cy: 0, half: C.MAP_HALF };
let overview = null, detail = null;
// a canvas of a window of surface, bed and mask, shaded as the map is
function shadeMap(s, b, m, W, H) {
  const img = new ImageData(W, H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i, o = k * 4, z = s[k], bed = b[k], mk = m[k];
    let c;
    if (mk === 3 || mk === 2) c = [150, 190, 220];
    else if (mk === 4) c = [130, 105, 85];
    else if (z !== -9999) {
      const e = j > 0 && i > 0 && s[k - 1] !== -9999 && s[k - W] !== -9999 ? (z - s[k - 1]) + (z - s[k - W]) : 0;
      const v = Math.max(120, Math.min(255, 205 + z / 60 + e * 0.8));
      c = [v, v, Math.min(255, v + 12)];
    } else if (bed !== -9999) { const d = Math.max(0, Math.min(1, -bed / 4500)); c = [20 * (1 - d) + 5, 70 * (1 - d) + 20, 140 * (1 - d) + 50]; }
    else c = [5, 7, 13];
    img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
  }
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  cv.getContext("2d").putImageData(img, 0, 0);
  return cv;
}
async function loadOverview() {
  const read = async (a) => {
    const L = await openCog(C.SOURCES.bedmap.url(a));
    const lv = L[L.length - 2];
    const [data] = await lv.img.readRasters({ samples: [0] });
    return { data, width: lv.width, height: lv.height };
  };
  const [s, b, m] = await Promise.all(["surface_topography", "bed_topography", "mask"].map(read));
  overview = shadeMap(s.data, b.data, m.data, s.width, s.height);
  overview.res = (2 * MAP.half) / s.width;
  drawMap();
}
// the finer read over the view, a moment after the view settles
let detailTimer = 0, detailTicket = 0;
function wantDetail() {
  clearTimeout(detailTimer);
  detailTimer = setTimeout(async () => {
    const t = ++detailTicket, n = $("cut-map").width, px = Math.max(500, (2 * view.half) / n);
    if (!overview || px >= overview.res * 0.9) { detail = null; drawMap(); return; }
    const box = [view.cx - view.half, view.cy - view.half, view.cx + view.half, view.cy + view.half];
    try {
      const [s, b, m] = await Promise.all(["surface_topography", "bed_topography", "mask"].map(async (a) => readBox(await openCog(C.SOURCES.bedmap.url(a)), box, px, -9999, 1200)));
      if (t !== detailTicket || !s) return;
      detail = { cv: shadeMap(s.data, b.data, m.data, s.width, s.height), x0: s.x0, y0: s.y0, x1: s.x0 + s.width * s.dx, y1: s.y0 - s.height * s.dy, res: s.dx };
      drawMap();
    } catch (e) { /* the overview stands in */ }
  }, 250);
}
function setView(v) { view = C.clampView(v); drawMap(); wantDetail(); }

function drawMap() {
  const c = $("cut-map"), dpr = devicePixelRatio || 1, n = Math.round((c.clientWidth || 300) * dpr);
  if (c.width !== n) { c.width = n; c.height = n; }
  const g = c.getContext("2d"), W = n, H = n, k = n / (c.clientWidth || 300);
  g.fillStyle = INK.sky; g.fillRect(0, 0, W, H);
  const P = (p) => C.toPixel(view, n, p);
  if (overview) {
    const ow = overview.width, sx = ((view.cx - view.half + MAP.half) / (2 * MAP.half)) * ow, sy = ((MAP.half - view.cy - view.half) / (2 * MAP.half)) * ow;
    g.imageSmoothingEnabled = view.half > MAP.half / 8;
    g.drawImage(overview, sx, sy, (view.half / MAP.half) * ow, (view.half / MAP.half) * ow, 0, 0, W, H);
  }
  if (detail) {
    const [x0, y0] = P([detail.x0, detail.y0]), [x1, y1] = P([detail.x1, detail.y1]);
    g.imageSmoothingEnabled = false;
    g.drawImage(detail.cv, x0, y0, x1 - x0, y1 - y0);
  }
  const { A, B } = ends();
  if (current) {
    g.fillStyle = "rgba(255,211,77,0.25)"; g.strokeStyle = "rgba(255,211,77,0.9)"; g.lineWidth = k;
    g.beginPath(); current.blk.corners.forEach((q, i) => { const [x, y] = P(q); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.closePath(); g.fill(); g.stroke();
  }
  const site = siteOf(), sp = site ? toXY(site.ll[0], site.ll[1]) : null;
  const pa = P(pending || A), pb = P(B);
  if (pending) {
    // placing B: the guide from A through the site, out to the map's
    // edge (B anywhere on it gives a line through the site), and the line
    // to the cursor as it would be
    if (sp && state.guide) {
      const e = P(C.guideEnd(pending, sp, MAP.half));
      // dark under bright, so it shows over the ice and the sea alike
      g.lineWidth = 3 * k; g.strokeStyle = "rgba(5,7,13,0.75)";
      g.beginPath(); g.moveTo(pa[0], pa[1]); g.lineTo(e[0], e[1]); g.stroke();
      g.lineWidth = 1.5 * k; g.strokeStyle = "#ffd34d"; g.setLineDash([6 * k, 4 * k]);
      g.beginPath(); g.moveTo(pa[0], pa[1]); g.lineTo(e[0], e[1]); g.stroke(); g.setLineDash([]);
    }
    if (cursor) {
      const q = P(cursor);
      g.strokeStyle = "#ff7ab8"; g.lineWidth = 2 * k;
      g.beginPath(); g.moveTo(pa[0], pa[1]); g.lineTo(q[0], q[1]); g.stroke();
    }
  } else {
    g.strokeStyle = "#ff7ab8"; g.lineWidth = 2 * k;
    g.beginPath(); g.moveTo(pa[0], pa[1]); g.lineTo(pb[0], pb[1]); g.stroke();
  }
  // the ends as handles to drag, ringed when the pointer is on one
  g.font = `${11 * k}px system-ui, sans-serif`;
  const handle = (q, label, hot) => {
    g.fillStyle = "#ff7ab8"; g.strokeStyle = hot ? "#ffd34d" : "#fff"; g.lineWidth = (hot ? 2 : 1.2) * k;
    g.beginPath(); g.arc(q[0], q[1], (hot ? 5.5 : 4) * k, 0, 7); g.fill(); g.stroke();
    g.fillStyle = "#fff"; g.fillText(label, q[0] + 6 * k, q[1] - 6 * k);
  };
  handle(pa, "A", !pending && hot === "a");
  if (!pending) handle(pb, "B", hot === "b");
  if (hoverS !== null && current) {
    const [x, y] = P(C.at(current.f, hoverS, 0));
    g.fillStyle = "#fff"; g.beginPath(); g.arc(x, y, 3.5 * k, 0, 7); g.fill();
  }
  if (site) {
    const [x, y] = P(sp);
    g.fillStyle = "#ff3b3b"; g.strokeStyle = "#fff"; g.lineWidth = k;
    g.beginPath(); g.arc(x, y, 3.5 * k, 0, 7); g.fill(); g.stroke();
  }
  // a scale bar, bottom left (true at 71S; the map is polar stereographic)
  const bar = C.scaleBar(2 * view.half), bw = (bar / (2 * view.half)) * W, bx = 8 * k, by = H - 10 * k;
  const label = bar >= 1000 ? `${bar / 1000} km` : `${bar} m`, tw = g.measureText(label).width;
  g.fillStyle = "rgba(5,7,13,0.6)"; g.fillRect(bx - 4 * k, by - 16 * k, Math.max(bw, tw) + 8 * k, 22 * k);
  g.strokeStyle = "#fff"; g.lineWidth = 1.5 * k;
  g.beginPath(); g.moveTo(bx, by - 4 * k); g.lineTo(bx, by); g.lineTo(bx + bw, by); g.lineTo(bx + bw, by - 4 * k); g.stroke();
  g.fillStyle = "#fff"; g.textAlign = "center";
  g.fillText(label, bx + Math.max(bw, tw) / 2, by - 5 * k);
  g.textAlign = "left";
}

// Placing the ends: two clicks, the first A and the second B, or drag
// either end; drag elsewhere to pan, wheel or pinch (or the buttons) to
// zoom.
let pending = null, cursor = null, hot = null;
const HINT = "Click twice on the map for a new line, A then B, or drag an end. Wheel or pinch to zoom, drag to pan.";
const mapPx = (e) => { const r = $("cut-map").getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top, r.width]; };
const mapXY = (e) => { const [x, y, w] = mapPx(e); return C.fromPixel(view, w, [x, y]); };
const llText = (p) => { const ll = toLL(p[0], p[1]); return `${ll[0].toFixed(4)},${ll[1].toFixed(4)}`; };
// the end under the pointer, within a few pixels
function endAt(e) {
  if (pending) return null;
  const [x, y, w] = mapPx(e), { A, B } = ends();
  const d = (p) => { const q = C.toPixel(view, w, p); return Math.hypot(q[0] - x, q[1] - y); };
  const da = d(A), db = d(B), r = e.pointerType === "touch" ? 16 : 9;
  return Math.min(da, db) > r ? null : da <= db ? "a" : "b";
}
// while B is being placed, how far the line to the cursor passes from the
// site
function placingHint() {
  const site = siteOf();
  if (!pending) return HINT;
  if (!site || !cursor) return site && state.guide ? `Now click B: on the dashed line, the section passes through ${site.short}.` : "Now click the other end (B).";
  const o = C.offLine(pending, cursor, toXY(site.ll[0], site.ll[1]));
  return `Now click B: this line passes ${(o.d / 1000).toFixed(o.d < 10000 ? 1 : 0)} km from ${site.short}${o.u <= 0 || o.u >= 1 ? " (beyond its end)" : ""}.`;
}
function showAt(p) {
  const ll = toLL(p[0], p[1]);
  $("map-at").textContent = `${Math.abs(ll[1]).toFixed(4)}${DEG}S, ${Math.abs(ll[0]).toFixed(4)}${DEG}${ll[0] < 0 ? "W" : "E"} (${(p[0] / 1000).toFixed(1)}, ${(p[1] / 1000).toFixed(1)} km)`;
}
function clickAt(p) {
  const s = llText(p);
  if (!pending) { pending = p; cursor = null; state.a = s; $("a").value = s; $("map-hint").textContent = placingHint(); drawMap(); return; }
  pending = null; cursor = null; state.b = s; $("map-hint").textContent = HINT;
  state.cam = null; syncInputs(); writeHash(); build();
}
const pointers = new Map();
let drag = null;   // { kind: "pan" | "a" | "b" | "pinch", ... }
const cm = $("cut-map");
cm.addEventListener("pointerdown", (e) => {
  cm.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, mapPx(e));
  if (pointers.size === 2) {
    const [p, q] = [...pointers.values()];
    drag = { kind: "pinch", d0: Math.hypot(p[0] - q[0], p[1] - q[1]), v0: view, mid: C.fromPixel(view, p[2], [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]) };
    return;
  }
  const end = endAt(e);
  drag = { kind: end || "pan", x: e.clientX, y: e.clientY, v0: view, moved: false };
});
cm.addEventListener("pointermove", (e) => {
  const p = mapXY(e);
  showAt(p);
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, mapPx(e));
  if (drag && drag.kind === "pinch" && pointers.size === 2) {
    const [a, b] = [...pointers.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (drag.d0 > 0) setView(C.zoomView(drag.v0, drag.mid, d / drag.d0));
    return;
  }
  if (drag) {
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
    if (!drag.moved) return;
    if (drag.kind === "pan") {
      const w = mapPx(e)[2], f = (2 * drag.v0.half) / w;
      setView({ cx: drag.v0.cx - (e.clientX - drag.x) * f, cy: drag.v0.cy + (e.clientY - drag.y) * f, half: drag.v0.half });
    } else {
      // an end being dragged: the line follows, the section waits for the drop
      state[drag.kind] = llText(p); $(drag.kind).value = state[drag.kind];
      drawMap();
    }
    return;
  }
  const h = endAt(e);
  if (h !== hot) { hot = h; cm.style.cursor = h ? "grab" : ""; drawMap(); }
  if (pending) { cursor = p; $("map-hint").textContent = placingHint(); drawMap(); }
});
const endDrag = (e) => {
  pointers.delete(e.pointerId);
  const d = drag;
  if (!d) return;
  if (d.kind === "pinch") { if (!pointers.size) drag = null; return; }
  drag = null;
  if (e.type === "pointercancel") return;
  if (!d.moved) { clickAt(mapXY(e)); return; }
  if (d.kind === "a" || d.kind === "b") { state.cam = null; syncInputs(); writeHash(); build(); }
};
cm.addEventListener("pointerup", endDrag);
cm.addEventListener("pointercancel", endDrag);
cm.addEventListener("pointerleave", () => { $("map-at").textContent = ""; if (!drag) { cursor = null; hot = null; drawMap(); } });
cm.addEventListener("wheel", (e) => {
  e.preventDefault();
  const dy = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
  setView(C.zoomView(view, mapXY(e), Math.exp(-dy * 0.002)));
}, { passive: false });
const zoomBy = (k) => setView(C.zoomView(view, [view.cx, view.cy], k));
$("map-in").addEventListener("click", () => zoomBy(2));
$("map-out").addEventListener("click", () => zoomBy(0.5));
$("map-fit").addEventListener("click", () => { const { A, B } = ends(); setView(C.viewOf([A, B])); });
$("map-all").addEventListener("click", () => setView({ cx: 0, cy: 0, half: MAP.half }));
// Escape gives up placing B
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && pending) { pending = null; cursor = null; state.a = state.b = ""; $("map-hint").textContent = HINT; syncInputs(); drawMap(); }
});

// ---------------------------------------------------------------- the block

const { renderer, scene, camera, controls, setCamera, resize } = makeStage($("three"), {
  bg: 0x05070d, fov: 35, near: 0.5, far: 60000,
  onCamera: (cam) => { state.cam = cam.map((v) => +v.toFixed(1)); writeHash(); }
});
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(-0.4, 1, 0.6);
scene.add(sun);
const block = new THREE.Group();
scene.add(block);
const pin = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]), new THREE.LineBasicMaterial({ color: 0xffffff }));
pin.visible = false; scene.add(pin);

const ve = () => (state.ve > 0 ? state.ve : current ? C.autoExaggeration(current.f.L, current.top - current.floor) : 25);
// the block's frame: x along the line (km), z off it (km, the left side
// towards -z), y up (km, exaggerated); flat, or bent over the Earth
const posOf = (s, t, m) => C.place(s, t, m * ve(), { curve: current.curve, cs: current.f.L / 2, ct: (current.blk.t0 + current.blk.t1) / 2 });

function drawBlock() {
  drawCut(block, current, { ve: ve(), ice: state.ice });
  placePin();
}

function defaultCamera() {
  if (!current) return [0, 200, 800, 0, 0, 0];
  const { blk } = current, L = current.f.L / 1000, w0 = blk.t0 / 1000, w1 = blk.t1 / 1000, z = C.zOf((current.top + current.floor) / 2, ve());
  // in front of the cut face (from the bare side for a block on both
  // sides), a little above it and towards A
  const back = Math.max(L, Math.abs(w1 - w0)) * 1.1, toward = current.side === 0 ? 1 : current.side;
  return [L * 0.35, z + back * 0.45, toward * back * 0.9 - (w0 + w1) / 2 + (current.side === 0 ? back * 0.3 : 0), L / 2, z, -(w0 + w1) / 2];
}

function placePin() {
  if (!current || hoverS === null) { pin.visible = false; return; }
  const a = posOf(hoverS, 0, current.floor), b = posOf(hoverS, 0, current.top);
  pin.geometry.setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]);
  pin.visible = true;
}

// ---------------------------------------------------------------- panel

function setStatus(s) { $("status").textContent = s; }

function renderReadout() {
  const tb = $("readout").tBodies[0];
  tb.innerHTML = "";
  if (!current) return;
  const row = (k, v) => { const tr = tb.insertRow(); tr.insertCell().textContent = k; tr.insertCell().textContent = v; };
  const { f, rows, levels, cost } = current, S = C.summary(rows), km = (m) => `${(m / 1000).toFixed(0)} km`;
  const { a, b } = ends();
  row("A", `${a[1].toFixed(2)}${DEG}, ${a[0].toFixed(2)}${DEG}`);
  row("B", `${b[1].toFixed(2)}${DEG}, ${b[0].toFixed(2)}${DEG}`);
  row("Length", `${km(f.L)} (in the projection's plane)`);
  row("Floating / grounded", `${km(S.floating)} / ${km(S.grounded)}${S.sea ? `, open sea ${km(S.sea)}` : ""}`);
  row("Thickest ice", `${S.maxIce.toFixed(0)} m`);
  row("Deepest bed", Number.isFinite(S.minBed) ? `${S.minBed.toFixed(0)} m` : "none");
  if (S.maxCavity) row("Deepest cavity", `${S.maxCavity.toFixed(0)} m of water under the shelf`);
  row("Grounding lines", S.grounding.length ? S.grounding.map((s) => `${(s / 1000).toFixed(0)} km`).join(", ") : "none crossed");
  const st = current.site;
  if (st) {
    const l = st.l, fmt = (v, u = "") => (v === v ? `${v.toFixed(0)}${u}` : "no data");
    row(st.short, `${st.ll[1].toFixed(3)}${DEG}, ${st.ll[0].toFixed(3)}${DEG}, ${(Math.abs(st.t) / 1000).toFixed(1)} km off the line at ${(st.s / 1000).toFixed(0)} km`);
    row(`${st.short}: ice`, `${fmt(l.ice)}${st.hunc === st.hunc ? ` \u00b1 ${st.hunc.toFixed(0)}` : ""} m thick, surface ${fmt(l.top, " m")}`);
    row(`${st.short}: bed`, `${fmt(l.bed)}${st.unc === st.unc ? ` \u00b1 ${st.unc.toFixed(0)}` : ""} m (${l.kind}, Bedmap3 at 500 m)`);
  } else if (current.siteErr) row("Site", current.siteErr);
  row("Bedmap3 read at", `${(current.res / 1000).toFixed(current.res < 1000 ? 1 : 0)} km (${current.N + 1} samples)`);
  if (state.rema) row("REMA read at", levels.rema ? `${levels.rema} m, minus EGM2008` : current.remaErr || "reading");
  if (state.gebco) row("GEBCO read at", levels.gebco ? `about ${(levels.gebco / 1000).toFixed(1)} km north to south` : current.gebcoErr || "reading");
  if (cost) row("Cost", `${cost.req} requests, ${(cost.bytes / 2 ** 20).toFixed(1)} MB, ${(cost.ms / 1000).toFixed(1)} s`);
  $("vert").textContent = `x ${ve()}${state.ve ? "" : " (auto)"}`;
}

function syncInputs() {
  const { a, b } = ends();
  $("preset").value = state.at;
  $("a").value = `${a[0]},${a[1]}`; $("b").value = `${b[0]},${b[1]}`;
  $("width").value = widthKm(); $("width-out").textContent = `${widthKm()} km`;
  $("side").value = String(sideOf());
  $("curve").value = curved() ? "earth" : "flat";
  const site = siteOf();
  $("site").value = site ? (C.SITES.some((x) => x.key === site.key) ? site.key : "custom") : "none";
  $("site-ll").value = site ? `${site.ll[0]},${site.ll[1]}` : "";
  $("ve").value = C.sliderOfVe(state.ve); $("vert").textContent = state.ve ? `x ${state.ve}` : "auto";
  $("ice").value = state.ice;
  $("guide").checked = !!state.guide;
  $("rema").checked = !!state.rema; $("gebco").checked = !!state.gebco; $("unc").checked = !!state.unc;
}

for (const p of C.PRESETS) { const o = document.createElement("option"); o.value = p.key; o.textContent = p.label; $("preset").append(o); }
$("preset").addEventListener("change", () => {
  state.at = $("preset").value; state.a = state.b = ""; state.w = 0; state.side = state.curve = state.site = ""; state.cam = null;
  syncInputs(); writeHash(); build();
});
for (const x of C.SITES) { const o = document.createElement("option"); o.value = x.key; o.textContent = x.label; $("site").insertBefore(o, $("site").lastElementChild); }
$("site").addEventListener("change", () => {
  const v = $("site").value;
  if (v === "custom") { $("site-ll").focus(); return; }
  state.site = v; syncInputs(); writeHash(); build();
});
$("site-ll").addEventListener("change", () => {
  const v = lonlat($("site-ll").value.replace(/\s+/g, ""));
  if (!v) { setStatus("site: longitude,latitude in degrees, south of 50S"); return; }
  state.site = v; syncInputs(); writeHash(); build();
});
$("guide").addEventListener("change", () => { state.guide = $("guide").checked ? 1 : 0; writeHash(); if (pending) { $("map-hint").textContent = placingHint(); drawMap(); } });
$("curve").addEventListener("change", () => { state.curve = $("curve").value; state.cam = null; writeHash(); build(); });
const endInput = (id) => $(id).addEventListener("change", () => {
  const v = lonlat($(id).value.replace(/\s+/g, ""));
  if (!v) { setStatus("ends: longitude,latitude in degrees, south of 50S"); return; }
  state[id] = v; state.cam = null; writeHash(); build();
});
endInput("a"); endInput("b");
$("swap").addEventListener("click", () => { const { a, b } = ends(); state.a = `${b[0]},${b[1]}`; state.b = `${a[0]},${a[1]}`; state.cam = null; syncInputs(); writeHash(); build(); });
$("width").addEventListener("input", () => { $("width-out").textContent = `${$("width").value} km`; });
$("width").addEventListener("change", () => { state.w = +$("width").value; state.cam = null; writeHash(); build(); });
$("side").addEventListener("change", () => { state.side = $("side").value; state.cam = null; writeHash(); build(); });
$("ve").addEventListener("input", () => { state.ve = C.veOfSlider(+$("ve").value); $("vert").textContent = state.ve ? `x ${state.ve}` : "auto"; });
$("ve").addEventListener("input", () => { clearTimeout(veTimer); veTimer = setTimeout(() => { drawBlock(); renderReadout(); }, 60); });
let veTimer = 0;
$("ve").addEventListener("change", () => { writeHash(); drawBlock(); renderReadout(); });
$("ice").addEventListener("change", () => { state.ice = $("ice").value; writeHash(); drawBlock(); });
for (const id of ["rema", "gebco", "unc"]) $(id).addEventListener("change", () => { state[id] = $(id).checked ? 1 : 0; writeHash(); if (id === "unc") drawSection(); else build(); });
$("reset-view").addEventListener("click", () => { state.cam = null; setCamera(defaultCamera()); writeHash(); });
$("csv").addEventListener("click", () => {
  if (!current) return;
  const out = ["dist_km,x,y,lon,lat,kind,surface_m,ice_thickness_m,ice_base_m,bed_m,bed_uncertainty_m,cavity_m,rema_m,gebco_m"];
  const n = (v, d = 1) => (v === v && v !== undefined && v !== null ? (+v).toFixed(d) : "");
  for (const r of current.rows) {
    const l = r.l;
    out.push([n(r.s / 1000, 3), n(r.p[0], 0), n(r.p[1], 0), n(r.ll[0], 5), n(r.ll[1], 5), l.kind, n(l.top), n(l.ice), n(l.base), n(l.bed), n(r.unc),
      l.kind === "floating" && l.water ? n(l.water[0] - l.water[1]) : "", n(r.rema), n(r.gebco)].join(","));
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([out.join("\n") + "\n"], { type: "text/csv" }));
  a.download = `cutaway_${state.at}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

function drawAll() {
  drawSection(); drawMap(); drawBlock(); renderReadout();
  setCamera(state.cam || defaultCamera());
}

// ---------------------------------------------------------------- start

new ResizeObserver(() => drawSection()).observe($("section"));
new ResizeObserver(() => drawMap()).observe($("cut-map"));
$("credit").textContent = [C.SOURCES.bedmap.credit, C.SOURCES.rema.credit, C.SOURCES.gebco.credit].join(". ") + ".";
syncInputs();
resize();
function frame() { controls.update(); renderer.render(scene, camera); requestAnimationFrame(frame); }
requestAnimationFrame(frame);
shareLinks("sondage: Cutaway");
loadOverview().catch((e) => setStatus(`The overview map did not load (${e.message || e})`));
build().then(() => { window.__cutaway = { state, get current() { return current; }, ready: true }; });
