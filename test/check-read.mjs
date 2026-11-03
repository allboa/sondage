// The Source interface (src/read): stores described by their own metadata
// give the same description the arrays.json route gives, reads come back
// as rows by columns of physical values, the registry opens its entries,
// and every read is counted per host. The fixture stores
// (test/fixtures/store) are served from a local HTTP server with ranges.
import fs from "fs";
import http from "http";
import path from "path";
import * as F from "../src/core/fourd.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log("FAIL " + msg); } };

const root = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "store");
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split("?")[0]));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  const buf = fs.readFileSync(p), m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  if (m) {
    let a0, b0;
    if (m[1] === "") { a0 = Math.max(0, buf.length - +m[2]); b0 = buf.length - 1; } else { a0 = +m[1]; b0 = m[2] === "" ? buf.length - 1 : Math.min(+m[2], buf.length - 1); }
    res.writeHead(206, { "content-range": `bytes ${a0}-${b0}/${buf.length}`, "content-length": b0 - a0 + 1 });
    res.end(buf.subarray(a0, b0 + 1));
  } else { res.writeHead(200, { "content-length": buf.length }); res.end(buf); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const R = await import("../src/read/index.js");

// a read agrees with the store explorer's whole slice, unpacked
async function agrees(src, name) {
  const d = src.desc, nx = d.axes.x.n;
  const v = await src.read(0, 0, 0, 2, 0, 3);
  const sl = await R.readSlice(src.store, d.probed, {});
  const raw = Float64Array.from(sl.data, Number);
  const want = F.unpack(raw, d);
  ok(v.length === 6, `${name}: read of 2 x 3 gave ${v.length}`);
  for (const [i, j] of [[0, 0], [0, 2], [1, 1]]) {
    const a = v[i * 3 + j], b = want[i * nx + j];
    ok(Math.abs(a - b) < 1e-4 || (Number.isNaN(a) && Number.isNaN(b)), `${name}: cell ${i},${j} ${a} vs ${b}`);
  }
}

const open = (name, variable, e = {}) => R.openUrl(`${base}/${name}`, variable, e);

// projected: Lambert conformal and polar stereographic, with a time axis
for (const [name, variable, proj] of [["lcc.icechunk", "t2m", "lcc"], ["polar.icechunk", "ice", "stere"]]) {
  const s = await open(name, variable);
  ok(s.kind === "icechunk", `${name}: kind ${s.kind}`);
  ok(s.desc.roles.join() === "t,y,x", `${name}: roles ${s.desc.roles}`);
  ok(s.desc.crs && s.desc.crs.includes(`+proj=${proj}`), `${name}: crs ${s.desc.crs}`);
  ok(s.desc.axes.t && F.isoDay(s.desc.axes.t.dates[0]) === "2026-01-01", `${name}: first date`);
  ok(s.timeAt("2026-01-01").index === 0, `${name}: timeAt`);
  await agrees(s, name);
}

// longitude and latitude: no CRS string, and a lon/lat box finds a window
{
  const s = await open("era.icechunk", "1x91x180/2m_temperature");
  ok(s.desc.crs === null, `era: crs ${s.desc.crs}`);
  ok(s.desc.axes.x.n === 180 && s.desc.axes.y.n === 91, "era: axes");
  const w = s.window({ lon: [0, 20], lat: [-10, 10] });
  ok(w && w.x[1] > w.x[0] && w.y[1] > w.y[0], `era: window ${JSON.stringify(w)}`);
  const g = await s.get({ t: 0, y: w.y, x: w.x });
  ok(g.length === (w.y[1] - w.y[0]) * (w.x[1] - w.x[0]), "era: get over the window");
  await agrees(s, "era");
}
// EPSG:4326 by WKT, and a sphere on Mars, are both longitude and latitude
for (const [name, variable] of [["glad.zarr", "lclu"], ["mars.zarr", "tsurf"]]) {
  const s = await open(name, variable);
  ok(s.desc.crs === null, `${name}: crs ${s.desc.crs}`);
  await agrees(s, name);
}
// uneven latitudes are kept as they are
{
  const s = await open("gaussian.zarr", "tas");
  const lat = s.desc.axes.y.values, yc = s.desc.probed.grid.yc;
  ok(yc && lat.length === 96 && lat.every((v, i) => v === yc[i]), "gaussian: the latitudes as the store has them");
  ok(s.desc.axes.t, "gaussian: time");
}
// what is not placed yet says so
{
  const r = await open("rotated.icechunk", "tas");
  ok(r.desc.notes.some((n) => /rotated-pole/.test(n)), "rotated: note");
  const c = await open("curvilinear.zarr", "tos");
  ok(!c.desc.axes.x && c.desc.notes.some((n) => /curvilinear/.test(n)), "curvilinear: no 1D axes, and a note");
}

// the registry: an object or the file, its synthetic entry, its lookups
{
  const reg = await R.openRegistry(JSON.parse(fs.readFileSync(new URL("../data/fourd/stores.json", import.meta.url))));
  ok(reg.base.startsWith("https://"), "registry base");
  ok(reg.entry("bran-temp").kind === "volume", "registry entry");
  let threw = false; try { reg.entry("nothing"); } catch (e) { threw = true; }
  ok(threw, "an unknown id is refused");
  const syn = await reg.open("synthetic");
  ok(syn.kind === "synthetic" && syn.desc.axes.z, "synthetic source");
  const v = await syn.get({ t: 0, z: [0, 2], y: [0, 2], x: [0, 2] });
  ok(v.length === 8, `synthetic two levels: ${v.length}`);
  const one = await syn.get({ t: 0, z: 1, y: [0, 2], x: [0, 2] });
  ok(one[0] === v[4], "a level read alone matches the same level read in a range");
  // the base given to openRegistry wins
  const reg2 = await R.openRegistry({ base: "https://a.example", datasets: [] }, { base: "https://b.example" });
  ok(reg2.base === "https://b.example", "base override");
}

// the cache shares a read and keeps it
{
  const reader = R.makeReader({ budget: 2 ** 20 });
  const reg = await R.openRegistry({ datasets: [{ id: "syn", synthetic: true }] });
  const ds = await reg.open("syn");
  const [a, b] = await Promise.all([reader.slab(ds, 0, 0, [0, 4, 0, 4]), reader.slab(ds, 0, 0, [0, 4, 0, 4])]);
  ok(a === b && reader.cached(ds, 0, 0, [0, 4, 0, 4]), "one read for two asks, then cached");
}

// every read went through the ledger
{
  const h = R.hosts.get(new URL(base).host);
  ok(h && h.ok > 0 && h.fail === 0, `ledger ${JSON.stringify(h)}`);
}

server.close();
console.log(`read: Sources over 9 fixture stores and the registry${fails ? `, ${fails} failing` : ", all agree"}`);
process.exit(fails ? 1 : 0);
