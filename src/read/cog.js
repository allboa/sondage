// A COG series: one Cloud Optimized GeoTIFF per time step, read at one of
// its overview levels. A global 4 km field is 8640 by 4320 cells, about
// 50 MB a month at full resolution, which is far more than a globe needs;
// the files' own overviews give the same field at a half, a quarter or an
// eighth of that, a few MB a month, with nothing re-encoded.
//
//   const src = await openCogSeries(entry, base);
//   src.read(t, 0, y0, y1, x0, x1)    // rows by columns at the chosen level
//
// The dataset is a registry entry with form "cog" and a path (as for the
// Icechunk route): its flat/arrays.json gives the axes, time and fill, and
// its stac/items.ndjson the file of each time step (each item's data asset,
// placed in the cube by rv:placement, as raad.virtualize writes them). The
// level is chosen once, from the first file's pyramid: the coarsest whose
// width is at least entry.width (2160 by default), or entry.level when that
// is given (0 is full resolution). The description is the array's, with x
// and y as that level's cell centres, so a page draws it like any Source.
//
// geotiff.js is loaded when a COG series is first opened: the GeoTIFF
// global when a page has loaded the browser build, else the "geotiff"
// import (node_modules in Node), and
// every read goes through countedFetch, so the host ledger counts it.

import * as F from "../core/fourd.js";
import { countedFetch, getJson, readStats } from "./hosts.js";

let geotiffModule = null;
// a page that loaded geotiff.js's browser build as a script has it as a
// global (as the cutaway and basemap pages do); otherwise the import
const geotiff = () => (geotiffModule ||= globalThis.GeoTIFF ? Promise.resolve(globalThis.GeoTIFF) : import("geotiff"));
// Hand in a geotiff.js module (a page that has its own copy, or a test).
export const setGeoTIFF = (m) => { geotiffModule = Promise.resolve(m); };

// geotiff.js's client interface over countedFetch, keeping its own count
// (tally: reads, bytes, and ms summed over requests, to the body's end).
class CountedClient {
  constructor(url) { this.url = url; this.tally = { reads: 0, bytes: 0, ms: 0 }; }
  async request({ headers, signal } = {}) {
    const t0 = performance.now(), r = await countedFetch(this.url, { headers, signal }), T = this.tally;
    return { ok: r.ok, status: r.status, getHeader: (n) => r.headers.get(n) || undefined,
      getData: async () => { const b = await r.arrayBuffer(); T.reads++; T.bytes += b.byteLength; T.ms += performance.now() - t0; return b; } };
  }
}

// A decoder "pool" for readRasters that decodes on this thread, as
// geotiff.js does with no pool, and sums the time it takes into acc.ms.
function timedDecoders(GT, acc) {
  if (!GT.getDecoder) return null;
  return { bindParameters: (compression, params) => ({
    decode: async (slice) => { const d = await GT.getDecoder(compression, params), t0 = performance.now(); const r = await d.decode(slice); acc.ms += performance.now() - t0; acc.n++; return r; }
  }) };
}

// Each file's pyramid, finest first: { tiff, images, client, GT }. Opening
// reads only the header and IFDs. Kept per URL, the most recent few.
const opened = new Map();
const OPEN_MAX = 48;
export function openCog(url) {
  if (opened.has(url)) { const p = opened.get(url); opened.delete(url); opened.set(url, p); return p; }
  const p = (async () => {
    const GT = await geotiff();
    const client = new CountedClient(url);
    const tiff = await GT.fromCustomClient(client, { cacheSize: 64 });
    const n = await tiff.getImageCount(), images = [];
    for (let i = 0; i < n; i++) images.push(await tiff.getImage(i));
    return { tiff, images, client, GT };
  })();
  p.catch(() => opened.delete(url));
  opened.set(url, p);
  while (opened.size > OPEN_MAX) opened.delete(opened.keys().next().value);
  return p;
}

// The level to read from a pyramid's sizes [[w, h], ...] (finest first):
// level when it is given (clamped to the pyramid), else the coarsest at
// least width wide, else the finest.
export function chooseLevel(sizes, { level = null, width = 2160 } = {}) {
  if (level !== null && level !== undefined) return Math.max(0, Math.min(sizes.length - 1, level));
  let best = 0;
  sizes.forEach(([w], i) => { if (w >= width && w <= sizes[best][0]) best = i; });
  return best;
}

// The x and y axes of a level, as cell centres: the level spans the same
// box as the full grid (the full axes' first centre and step give the
// box), with cells as many times larger as it is narrower.
export function levelAxes(full, [w, h]) {
  const axis = (ax, n) => {
    const v = ax.values, step = ax.n > 1 ? v[1] - v[0] : 1;
    const edge = v[0] - step / 2, s = (step * ax.n) / n;
    const values = Float64Array.from({ length: n }, (_, i) => edge + s * (i + 0.5));
    return { ...ax, n, values, affine: { start: values[0], step: s } };
  };
  return { x: axis(full.x, w), y: axis(full.y, h) };
}

// The file of each time step from STAC items (ndjson text or a list of
// items): the data asset's href, at the time index rv:placement gives (or
// in order of datetime, when an item has no placement).
export function itemFiles(items, n) {
  const list = typeof items === "string" ? items.split("\n").filter((s) => s.trim()).map((s) => JSON.parse(s)) : items;
  const files = new Array(n).fill(null);
  const unplaced = [];
  for (const it of list) {
    const href = it.assets && (it.assets.data || Object.values(it.assets)[0])?.href;
    const pl = it.properties && it.properties["rv:placement"];
    const dest = pl && Object.values(pl)[0] && Object.values(pl)[0].dest;
    if (href && dest && dest[0] < n) files[dest[0]] = href;
    else if (href) unplaced.push({ href, at: Date.parse(it.properties?.datetime || "") });
  }
  unplaced.sort((a, b) => a.at - b.at);
  for (const u of unplaced) { const i = files.indexOf(null); if (i < 0) break; files[i] = u.href; }
  return files;
}

// A COG series as a Source (see source.js for the interface).
export async function openCogSeries(entry, base) {
  const urls = F.storeUrls(entry.base || base, entry);
  urls.items = urls.root + "/stac/items.ndjson";
  const meta = await getJson(urls.arrays);
  const full = F.describe(meta, entry.var);
  const nt = full.axes.t ? full.axes.t.n : 1;
  const r = await countedFetch(urls.items);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${urls.items}`);
  // hrefs may be relative to the items file, as STAC allows
  const files = itemFiles(await r.text(), nt).map((h) => (h ? new URL(h, new URL(urls.items, "http://localhost/")).href : h));
  const first = files.find(Boolean);
  if (!first) throw new Error(`no files in ${urls.items}`);
  const { images } = await openCog(first);
  const sizes = images.map((im) => [im.getWidth(), im.getHeight()]);
  const level = chooseLevel(sizes, entry);
  const im = images[level], tile = [im.getTileHeight(), im.getTileWidth()];
  const ax = levelAxes(full.axes, sizes[level]);
  const desc = { ...full, axes: { ...full.axes, ...ax }, crs: null, notes: [] };
  desc.shape = full.roles.map((q, i) => (q === "x" ? ax.x.n : q === "y" ? ax.y.n : full.shape[i]));
  desc.chunks = full.roles.map((q, i) => (q === "x" ? tile[1] : q === "y" ? tile[0] : full.chunks[i]));
  desc.cog = { level, sizes, full: [full.axes.x.n, full.axes.y.n] };
  if (level > 0) desc.notes.push(`overview ${level} of ${sizes.length - 1}: ${sizes[level][0]} x ${sizes[level][1]}, from ${sizes[0][0]} x ${sizes[0][1]}`);
  const nodata = im.getGDALNoData();
  const read = async (t, k, y0, y1, x0, x1) => {
    const n = (y1 - y0) * (x1 - x0), url = files[t];
    if (!url) return new Float32Array(n).fill(NaN);
    // what this read costs: opening the file (its header, unless open
    // already), fetching tiles, decoding them, and unpacking to values
    const wasOpen = opened.has(url), t0 = performance.now();
    const { images: ims, client, GT } = await openCog(url);
    // a file opened by this read counts its header reads too
    const t1 = performance.now(), c0 = wasOpen ? { ...client.tally } : { reads: 0, bytes: 0, ms: 0 }, dec = { ms: 0, n: 0 };
    const img = ims[Math.min(level, ims.length - 1)];
    const raw = await img.readRasters({ window: [x0, y0, x1, y1], samples: [0], interleave: true, pool: timedDecoders(GT, dec) });
    const t2 = performance.now();
    let v = F.unpack(raw, { ...desc, fill: desc.fill ?? nodata }, { valid: entry.valid || null });
    if (Array.isArray(k)) {
      const out = new Float32Array((k[1] - k[0]) * n);
      for (let q = 0; q < k[1] - k[0]; q++) out.set(v, q * n);
      v = out;
    }
    const T = client.tally;
    readStats.set(v, { shared: false, file: url.split("/").pop(), level, opened: !wasOpen, openMs: t1 - t0,
      reads: T.reads - c0.reads, bytes: T.bytes - c0.bytes, fetchMs: T.ms - c0.ms, rasterMs: t2 - t1,
      tiles: dec.n, decodeMs: dec.ms, unpackMs: performance.now() - t2 });
    return v;
  };
  return { kind: "cog", entry, desc, meta, urls, files, level, read };
}
