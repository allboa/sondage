// A Source is one array of a dataset, ready to read by index windows:
//
//   { kind, entry, desc, read(t, k, y0, y1, x0, x1), get(sel), timeAt(ms), window(box) }
//
// desc is the description src/core/fourd.js works with (dims with roles
// t, z, y, x or other; shape and chunks; coordinate values per role, time
// as dates, depth with its direction; units; scale, offset and fill). read
// returns physical values (NaN for missing), rows y0..y1-1 by columns
// x0..x1-1, at time index t and level k (k as [k0, k1] reads those levels,
// level by level). It runs in Node too.
//
// A Source comes from one of four places, and every one gives the same
// desc, so a page draws them alike:
//
// - a registry entry with a path: the dataset's flat/arrays.json
//   (mdim-refs/0.2, as raad.virtualize writes it) gives the axes without
//   reading the store's own metadata, and its Icechunk form the chunks;
// - an entry (or a call) with a url: any public Zarr or Icechunk store,
//   described by probing its metadata (store.js: CF names, grid mappings,
//   coordinate variables);
// - a registry entry with form "cog": one Cloud Optimized GeoTIFF per time
//   step, listed by the dataset's STAC items, read at one overview level
//   (cog.js);
// - a synthetic entry: an ocean on the same axes, with no network.

import { IcechunkStore } from "icechunk-js";
import * as zarr from "zarrita";
import * as F from "../core/fourd.js";
import { knownProj4 } from "../core/structure.js";
import { fetchClient, getJson, setRelay } from "./hosts.js";
import { openStore, describeVariable, nodeMeta, read1d } from "./store.js";
import { openCogSeries } from "./cog.js";

const parentOf = (p) => p.split("/").slice(0, -1).join("/");
const join = (...p) => p.filter((s) => s !== "" && s != null).join("/").replace(/^\/+/, "");
const num = (v) => (v === null || v === undefined || v === "" ? null : +v);

// The read function over a zarrita array with dims in desc.roles order.
function readerOf(arr, desc, { valid = null } = {}) {
  return async (t, k, y0, y1, x0, x1) => {
    const sel = desc.roles.map((r) => r === "t" ? t : r === "z" ? (Array.isArray(k) ? zarr.slice(k[0], k[1]) : (k ?? 0)) : r === "y" ? zarr.slice(y0, y1) : r === "x" ? zarr.slice(x0, x1) : 0);
    const c = await zarr.get(arr, sel);
    const v = F.unpack(c.data, desc, { valid });
    // zarr.get keeps the dims in store order: rows by columns needs y before x
    return desc.roles.indexOf("x") < desc.roles.indexOf("y") ? transpose(v, desc, k, y1 - y0, x1 - x0) : v;
  };
}

// Values read x-major (x before y in the store) as y-major, per level.
function transpose(v, desc, k, ny, nx) {
  const nk = Array.isArray(k) ? k[1] - k[0] : 1, n = nx * ny, out = new Float32Array(v.length);
  for (let kk = 0; kk < nk; kk++)
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) out[kk * n + j * nx + i] = v[kk * n + i * ny + j];
  return out;
}

// The parts every Source shares.
function finish(src) {
  const { desc } = src;
  // an entry may say how its time stamps sit in their periods (fourd.js timeAt)
  if (src.entry && src.entry.stamp && desc.axes.t) desc.axes.t.stamp = src.entry.stamp;
  src.timeAt = (ms) => F.timeAt(desc, typeof ms === "string" ? F.parseDay(ms) : ms);
  // a lon/lat box as index windows { y: [y0, y1], x: [x0, x1] }, for axes in
  // degrees; null where the box misses the grid
  src.window = ({ lon, lat }) => {
    const x = desc.axes.x && lon ? F.windowOf(desc.axes.x, lon[0], lon[1], { lon: true }) : null;
    const y = desc.axes.y && lat ? F.windowOf(desc.axes.y, Math.min(...lat), Math.max(...lat)) : null;
    return x && y ? { x, y } : null;
  };
  // the same read with named parts: { t, z, y: [y0, y1], x: [x0, x1] }
  src.get = ({ t = 0, z = 0, y, x }) => src.read(t, z, y[0], y[1], x[0], x[1]);
  return src;
}

// ------------------------------------------------------------ probed stores

// The vertical and time roles of a coordinate variable, from CF attributes.
function extraRole(name, attrs = {}) {
  const sn = String(attrs.standard_name || "").toLowerCase(), u = String(attrs.units || "");
  if (attrs.axis === "T" || sn === "time" || /\bsince\b/.test(u)) return "t";
  if (attrs.axis === "Z" || attrs.positive || /^(depth|height|altitude|air_pressure|model_level_number)$/.test(sn)) return "z";
  const b = name.toLowerCase();
  if (/^(time|t|time_counter|valid_time)$/.test(b)) return "t";
  if (/^(depth|lev|level|z|plev|st_ocean|sw_ocean|deptht|depthu|depthv)$/.test(b)) return "z";
  return null;
}

// The proj4 string of a projected CRS description (store.js), or null for
// longitude and latitude (on any body) and for what has no string here.
function projectedDef(crs) {
  if (!crs || crs.longlat || crs.rotated) return null;
  if (crs.proj4) return crs.proj4;
  if (crs.epsg && crs.epsg !== 4326) return knownProj4(crs.epsg) || null;
  return null;
}

// A description (as F.describe gives one) from a store's own metadata.
export async function describeStore(s, path, opts = {}) {
  const v = await describeVariable(s, path, opts);
  const dir = parentOf(path), a = v.meta.attrs || {}, g = v.grid;
  const roles = v.dims.map((d, i) => (i === v.ix ? "x" : i === v.iy ? "y" : "other"));
  const desc = {
    name: path.split("/").pop(), dims: v.dims.slice(), roles, shape: v.meta.shape.slice(),
    chunks: (v.meta.chunks || v.meta.shape).slice(), dtype: v.meta.dtype,
    units: a.units || "", longName: a.long_name || path,
    scale: num(a.scale_factor) ?? 1, offset: num(a.add_offset) ?? 0,
    fill: num(a._FillValue ?? a.missing_value ?? v.meta.fill),
    axes: {}, crs: null, notes: v.notes.slice(), probed: v
  };
  // the grid axes as cell centres
  const centres = (x0, dx, n) => Float64Array.from({ length: n }, (_, i) => x0 + dx * (i + 0.5));
  if (g && g.kind !== "curvilinear") {
    const xs = g.xc ? Float64Array.from(g.xc) : centres(g.x0, g.dx, g.nx);
    const ys = g.yc ? Float64Array.from(g.yc) : centres(g.y0, g.dy, g.ny);
    desc.axes.x = { dim: v.dims[v.ix], index: v.ix, n: g.nx, chunk: desc.chunks[v.ix], values: xs, units: "" };
    desc.axes.y = { dim: v.dims[v.iy], index: v.iy, n: g.ny, chunk: desc.chunks[v.iy], values: ys, units: "" };
    desc.crs = projectedDef(v.crs);
    if (v.crs && v.crs.rotated) desc.notes.push("a rotated-pole grid: its axes are rotated longitude and latitude, not placed on the Earth yet");
  } else if (g) desc.notes.push("a curvilinear grid has no 1D axes: not drawn as a layer yet");
  // time and depth from the other dims' coordinate variables
  for (let i = 0; i < v.dims.length; i++) {
    if (i === v.ix || i === v.iy) continue;
    const d = v.dims[i], m = await nodeMeta(s, join(dir, d)).catch(() => null);
    const r = extraRole(d, m && !m.group ? m.attrs : {});
    if (!r || desc.axes[r]) continue;
    const c = await read1d(s, join(dir, d)).catch(() => null);
    if (!c) continue;
    const values = Float64Array.from(c.values, Number);
    const ax = { dim: d, index: i, n: desc.shape[i], chunk: desc.chunks[i], values, units: c.attrs.units || "" };
    if (r === "t") {
      let tu;
      try { tu = F.timeUnits(ax.units); } catch (e) { desc.notes.push(`time ${d}: ${e.message}`); continue; }
      const cal = String(c.attrs.calendar || "standard").toLowerCase();
      if (!/^(standard|gregorian|proleptic_gregorian)$/.test(cal)) { desc.notes.push(`time ${d}: calendar ${cal} is not handled`); continue; }
      ax.dates = Float64Array.from(values, (q) => tu.epoch + q * tu.step);
    }
    if (r === "z") ax.down = String(c.attrs.positive || "down").toLowerCase() !== "up";
    roles[i] = r;
    desc.axes[r] = ax;
  }
  return desc;
}

// A Source over any Zarr or Icechunk store: url, and the array's path in it.
export async function openUrl(url, path, entry = {}) {
  const s = await openStore(url);
  const desc = await describeStore(s, path, { assume: entry.assume });
  const arr = await s.open(path);
  return finish({ kind: s.kind, entry: { ...entry, url, var: path }, desc, store: s, read: readerOf(arr, desc, entry) });
}

// ------------------------------------------------------------- the registry

// A registry entry as a Source. base is the registry's base URL, for
// entries named by path.
export async function openSource(entry, base) {
  if (entry.synthetic) {
    const s = F.syntheticOcean();
    const read = async (t, k, y0, y1, x0, x1) => {
      if (!Array.isArray(k)) return s.read(t, k, y0, y1, x0, x1);
      const n = (y1 - y0) * (x1 - x0), out = new Float32Array((k[1] - k[0]) * n);
      for (let kk = k[0]; kk < k[1]; kk++) out.set(s.read(t, kk, y0, y1, x0, x1), (kk - k[0]) * n);
      return out;
    };
    return finish({ kind: "synthetic", entry, desc: s.desc, meta: null, read });
  }
  if (entry.url) return openUrl(entry.url, entry.var, entry);
  if (entry.form === "cog") return finish(await openCogSeries(entry, base));
  const urls = F.storeUrls(entry.base || base, entry);
  const meta = await getJson(urls.arrays);
  const desc = F.describe(meta, entry.var);
  const store = await IcechunkStore.open(urls.icechunk, { fetchClient });
  const arr = await zarr.open(zarr.root(store).resolve(entry.var), { kind: "array" });
  return finish({ kind: "icechunk", entry, desc, meta, urls, read: readerOf(arr, desc, entry) });
}

// The registry file (data/fourd/stores.json and its like) or the object
// itself, as { base, datasets, probe, entry(id), open(id) }. A base given
// here wins over the file's (the page's #base= key), and so does a relay
// template (#relay=) over the file's relay.template; the relay is set for
// every read from then on (hosts.js setRelay).
export async function openRegistry(where, { base = null, relay = null } = {}) {
  const reg = typeof where === "string" ? await getJson(where) : where;
  const b = base || reg.base;
  setRelay({ hosts: (reg.relay && reg.relay.hosts) || [], template: relay || (reg.relay && reg.relay.template) || null });
  const byId = new Map([...(reg.datasets || []), ...(reg.probe || [])].map((e) => [e.id, e]));
  const entry = (id) => { const e = byId.get(id); if (!e) throw new Error(`no dataset ${id} in the registry`); return e; };
  return { base: b, datasets: reg.datasets || [], probe: reg.probe || [], entry, open: (id) => openSource(entry(id), b) };
}

// The name the 4D page has used since it began.
export const openDataset = openSource;

// A cache of decoded windows shared by every layer, keyed by dataset, time,
// level and window; in flight reads are shared too.
export function makeReader({ budget = 256 * 2 ** 20 } = {}) {
  const cache = new F.ByteLRU(budget);
  const inflight = new Map();
  const idOf = (ds) => ds.entry.id || `${ds.entry.url}|${ds.entry.var}`;
  const key = (ds, t, k, w) => `${idOf(ds)}|${t}|${k}|${w.join(",")}`;
  function slab(ds, t, k, w) {
    const kk = key(ds, t, k, w);
    const hit = cache.get(kk);
    if (hit) return Promise.resolve(hit);
    if (inflight.has(kk)) return inflight.get(kk);
    const p = ds.read(t, k, w[0], w[1], w[2], w[3]).then((v) => { cache.set(kk, v); inflight.delete(kk); return v; },
      (e) => { inflight.delete(kk); throw e; });
    inflight.set(kk, p);
    return p;
  }
  const cached = (ds, t, k, w) => cache.has(key(ds, t, k, w));
  return { slab, cached, cache };
}
