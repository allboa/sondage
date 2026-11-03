// COG series (src/read/cog.js): a dataset of one COG per time step, listed
// by STAC items and described by flat/arrays.json, read at an overview
// level. The fixture (test/fixtures/cog) is 128 x 64 cells over the globe,
// three months with no file for the second, a log ramp of values from
// 0.01 in the west to 10 in the east (times t + 1), and the top eight rows
// missing; each file has overviews at 2, 4 and 8. It is served from a
// local HTTP server with ranges.
import fs from "fs";
import http from "http";
import path from "path";
import * as F from "../src/core/fourd.js";
import { palette, rampPos, rampValue, PALETTES } from "../src/core/palette.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log("FAIL " + msg); } };

const root = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "cog");
// /relay?u=<encoded URL> serves that URL's path, as a CORS relay would
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const want = u.pathname === "/relay" ? new URL(u.searchParams.get("u")).pathname : decodeURIComponent(u.pathname);
  const p = path.join(root, want);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  const buf = fs.readFileSync(p), m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  if (m && m[1] !== "") {
    const a0 = +m[1], b0 = m[2] === "" ? buf.length - 1 : Math.min(+m[2], buf.length - 1);
    res.writeHead(206, { "content-range": `bytes ${a0}-${b0}/${buf.length}`, "content-length": b0 - a0 + 1 });
    res.end(buf.subarray(a0, b0 + 1));
  } else { res.writeHead(200, { "content-length": buf.length }); res.end(buf); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const R = await import("../src/read/index.js");

const entry = { id: "chl", path: "chl", var: "chlor_a", form: "cog", stamp: "start", kind: "surface" };
const W = 128, H = 64;
// the fixture's value at full-resolution column i, time t
const at = (i, t) => 10 ** (-2 + (3 * i) / (W - 1)) * (1 + t);

// levels: the coarsest at least width wide, or the one asked for
ok(R.chooseLevel([[8640, 4320], [4320, 2160], [2160, 1080], [1080, 540]], {}) === 2, "chooseLevel: 2160 wide by default");
ok(R.chooseLevel([[8640, 4320], [4320, 2160], [2160, 1080]], { width: 3000 }) === 1, "chooseLevel: width 3000");
ok(R.chooseLevel([[1440, 720]], {}) === 0, "chooseLevel: a file narrower than width reads its finest level");
ok(R.chooseLevel([[8640, 4320], [4320, 2160]], { level: 9 }) === 1, "chooseLevel: level clamps to the pyramid");

// a quarter-resolution read
{
  const s = await R.openSource({ ...entry, width: 32 }, base);
  const d = s.desc;
  ok(s.kind === "cog", `kind ${s.kind}`);
  ok(s.level === 2, `level ${s.level} (32 wide)`);
  ok(d.axes.x.n === 32 && d.axes.y.n === 16, `axes ${d.axes.x.n} x ${d.axes.y.n}`);
  ok(d.shape.join() === "3,16,32", `shape ${d.shape}`);
  ok(Math.abs(d.axes.x.values[0] - (-180 + 360 / 64)) < 1e-9, `x centre 0: ${d.axes.x.values[0]}`);
  ok(Math.abs(d.axes.y.values[0] - (90 - 180 / 32)) < 1e-9, `y centre 0: ${d.axes.y.values[0]}`);
  ok(d.axes.t.stamp === "start", "time stamps open their periods");
  ok(s.timeAt("2024-01-31").index === 0 && s.timeAt("2024-03-15").index === 2, "a date takes the month it falls in");
  ok(s.timeAt("2024-04-15").outside && s.timeAt("2023-12-15").outside, "dates past the months are outside");
  const v = await s.read(0, 0, 0, 16, 0, 32);
  ok(v.length === 16 * 32, `read length ${v.length}`);
  ok(Number.isNaN(v[0]) && Number.isNaN(v[31]), "the missing top rows are NaN");
  // nearest-neighbour overviews: level cell c holds full column 4c
  for (const c of [0, 13, 31]) {
    const got = v[5 * 32 + c], want = at(4 * c, 0);
    ok(Math.abs(got / want - 1) < 1e-5, `cell 5,${c}: ${got} vs ${want}`);
  }
  const v2 = await s.read(2, 0, 4, 6, 10, 12);
  ok(Math.abs(v2[0] / at(40, 2) - 1) < 1e-5, `a window at t 2: ${v2[0]} vs ${at(40, 2)}`);
  const st = R.readStats.get(v2);
  ok(st && st.shared === false && st.tiles >= 1 && st.reads >= 1 && st.bytes > 0 && st.ms >= st.rasterMs, `read stats: ${JSON.stringify(st)}`);
  ok(st && st.decodeMs >= 0 && st.unpackMs >= 0 && typeof st.opened === "boolean", "read stats: decode, unpack, opened");
  const miss = await s.read(1, 0, 0, 2, 0, 2);
  ok(miss.length === 4 && miss.every((x) => Number.isNaN(x)), "a month with no file reads as NaN");
  const host = R.hosts.get(new URL(base).host);
  ok(host && host.ok > 0 && host.fail === 0, `the reads are counted: ${JSON.stringify(host)}`);
}

// full resolution when level 0 is asked for
{
  const s = await R.openSource({ ...entry, level: 0 }, base);
  ok(s.desc.axes.x.n === W && s.desc.axes.y.n === H, `level 0: ${s.desc.axes.x.n} x ${s.desc.axes.y.n}`);
  const v = await s.read(0, 0, 20, 21, 100, 101);
  ok(Math.abs(v[0] / at(100, 0) - 1) < 1e-5, `level 0 cell: ${v[0]} vs ${at(100, 0)}`);
}

// a relay: a dataset on a host with no CORS header (here one that does not
// exist), read through the relay and counted under the host
{
  ok(R.relayed("https://a.example/x.tif") === "https://a.example/x.tif", "no relay: urls unchanged");
  R.setRelay({ template: "https://relay.example/{url}", hosts: ["a.example"] });
  ok(R.relayed("https://a.example/x.tif?b=1") === "https://relay.example/https://a.example/x.tif?b=1", "relay {url}");
  ok(R.relayed("https://b.example/x.tif") === "https://b.example/x.tif", "relay: unlisted hosts read directly");
  R.setRelay({ template: "https://relay.example/?u={encoded}", hosts: ["a.example"] });
  ok(R.relayed("https://a.example/x y") === "https://relay.example/?u=" + encodeURIComponent("https://a.example/x y"), "relay {encoded}");
  R.setRelay({ template: "https://relay.example/", hosts: ["a.example"] });
  ok(R.relayed("https://a.example/x") === "https://relay.example/https://a.example/x", "relay prefix");
  R.setRelay({ template: `${base}/relay?u={encoded}`, hosts: ["nocors.invalid"] });
  const s = await R.openSource({ ...entry, id: "chl-relay", base: "http://nocors.invalid", width: 32 }, base);
  const v = await s.read(2, 0, 4, 6, 10, 12);
  ok(Math.abs(v[0] / at(40, 2) - 1) < 1e-5, `read through the relay: ${v[0]}`);
  const h = R.hosts.get("nocors.invalid");
  ok(h && h.ok > 0 && h.fail === 0, `relayed reads counted under the host: ${JSON.stringify(h)}`);
  R.setRelay({});
}

// item files: placed by rv:placement, else in order of date
{
  const f = R.itemFiles([{ properties: { datetime: "2024-02-01T00:00:00Z" }, assets: { data: { href: "b" } } },
    { properties: { datetime: "2024-01-01T00:00:00Z" }, assets: { data: { href: "a" } } }], 2);
  ok(f.join() === "a,b", `unplaced items by date: ${f}`);
}

// the SeaWiFS palette on a log scale
{
  ok(PALETTES.chl.length === 254, `chl stops ${PALETTES.chl.length}`);
  const style = { range: [0.01, 20], scale: "log10" }, pos = rampPos(style);
  ok(Math.abs(pos(0.01)) < 1e-12 && Math.abs(pos(20) - 1) < 1e-12, "log ends");
  ok(Math.abs(pos(Math.sqrt(0.01 * 20)) - 0.5) < 1e-12, "the geometric mean is the middle");
  ok(pos(0) === -Infinity && pos(-1) === -Infinity, "zero and below sit below the start");
  ok(Math.abs(rampValue(style, 0.5) - Math.sqrt(0.2)) < 1e-12, "rampValue inverts rampPos");
  const p = palette({ name: "chl", ...style });
  ok(p(0.01).join() === "144,0,111" && p(20).join() === "105,0,0", `chl ends ${p(0.01)} ${p(20)}`);
  // palr chl_pal(c(0.1, 1, 10)) is #0095FF, #D0FF00, #E10000: within one step
  const near = (a, hex) => [0, 2, 4].every((q, i) => Math.abs(a[i] - parseInt(hex.slice(q, q + 2), 16)) <= 8);
  ok(near(p(0.1), "0095FF") && near(p(1), "D0FF00") && near(p(10), "E10000"), `chl matches palr: ${p(0.1)} ${p(1)} ${p(10)}`);
  ok(palette({ name: "viridis", range: [0, 1] })(0.5).join() === PALETTES.viridis[2].join(), "linear palettes are as before");
  const lv = F.isoLevels([0.01, 20], { log: true });
  ok(lv.join() === "0.03,0.1,0.3,1,3,10", `log contour levels ${lv}`);
}

server.close();
if (fails) { console.log(`${fails} failures`); process.exit(1); }
console.log("cog: all checks passed");
