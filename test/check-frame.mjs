// The frame (src/scene/frame.js): the globe turned to its centre, the
// azimuthal equidistant map in Earth radii, unfold between them, the range
// limit, cuts on a map, and a pick back to the Earth through barycentric
// weights; plus the axis helpers the layers use (src/core/fourd.js).
import * as THREE from "three";
import { makeFrame, toVec, fromVec, aeqd } from "../src/scene/frame.js";
import * as F from "../src/core/fourd.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log("FAIL " + msg); } };
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const D2R = Math.PI / 180;

// toVec and fromVec are inverses
{
  const p = fromVec(toVec(147.3, -42.9, 0.97));
  near(p.lon, 147.3, 1e-9, "lon back"); near(p.lat, -42.9, 1e-9, "lat back"); near(p.r, 0.97, 1e-12, "r back");
}
// aeqd keeps the great-circle distance from the centre
{
  const f = aeqd(75, -58);
  const q = f(110, -40);
  const c = Math.acos(Math.sin(-58 * D2R) * Math.sin(-40 * D2R) + Math.cos(-58 * D2R) * Math.cos(-40 * D2R) * Math.cos(35 * D2R));
  near(Math.hypot(q[0], q[1]), c, 1e-12, "aeqd radius is the distance");
  ok(f(-105, 58) === null, "the antipode has no place");
}

const scene = new THREE.Scene();
const frame = makeFrame(scene);
frame.set({ key: "globe", lon0: 75, lat0: -58, rangeKm: 20000, t: 1 });
// the centre is the origin of the frame, on the globe and the map alike
{
  const g = frame.placePoint(75, -58, 1);
  ok(g.length() < 1e-9, `centre on the globe at ${g.toArray()}`);
  const d = frame.placePoint(75, -58, 0.9);
  near(d.z, -0.1, 1e-9, "a point below the centre is straight down");
  frame.set({ key: "aeqd" });
  ok(frame.placePoint(75, -58, 1).length() < 1e-9, "centre on the map");
  near(frame.placePoint(75, -58, 0.9).z, -0.1, 1e-9, "depth on the map is r - 1");
}
// a grid placed on the map, unfolded half way, and a pick in one of its triangles
{
  frame.set({ key: "aeqd", t: 1 });
  const g = frame.gridGeometry(4, 4, (u, v) => [60 + 30 * u, -70 + 25 * v, 1]);
  ok(g.index.count === 4 * 4 * 6, `all triangles kept: ${g.index.count}`);
  const flat = aeqd(75, -58)(60, -70), pos = g.attributes.position.array;
  near(pos[0], flat[0], 1e-6, "first vertex x on the map"); near(pos[1], flat[1], 1e-6, "first vertex y on the map");
  frame.set({ t: 0.5 }); frame.reblend();
  const G = g.userData.G, Fl = g.userData.F;
  near(pos[3], (G[3] + Fl[3]) / 2, 1e-6, "half unfolded is half way");
  // a hit at the middle of the first triangle (corners a, b, d) maps back to
  // the middle of those corners on the Earth
  const mesh = new THREE.Mesh(g); frame.root.add(mesh); scene.updateMatrixWorld(true);
  const [a, b, c] = [g.index.array[0], g.index.array[1], g.index.array[2]];
  const P = [a, b, c].map((i) => new THREE.Vector3().fromBufferAttribute(g.attributes.position, i));
  const point = mesh.localToWorld(P[0].clone().add(P[1]).add(P[2]).multiplyScalar(1 / 3));
  const e = frame.earthAt({ face: { a, b, c }, point, object: mesh });
  const L = g.userData.llr, want = fromVec([a, b, c].reduce((s, i) => s.add(toVec(L[3 * i], L[3 * i + 1], L[3 * i + 2])), new THREE.Vector3()));
  near(e.lon, want.lon, 1e-6, "pick lon"); near(e.lat, want.lat, 1e-6, "pick lat");
}
// the range drops what lies beyond it; a map drops triangles across its cut
{
  frame.set({ key: "globe", rangeKm: 500 });
  ok(frame.placePoint(75, -50, 1) === null, "900 km away is out of a 500 km range");
  ok(frame.placePoint(75, -55, 1) !== null, "330 km away is in");
  frame.set({ key: "aeqd", rangeKm: 20000, t: 1 });
  const g = frame.gridGeometry(36, 2, (u, v) => [-180 + 360 * u, 50 + 10 * v, 1]);
  ok(g.index.count < 36 * 2 * 6, `triangles near the antipode are cut: ${g.index.count / 6} of 72 quads' halves kept`);
}
// axis helpers
{
  const ax = { values: Float64Array.of(0.5, 1.5, 2.5, 3.5) };
  near(F.coordAt(ax, 2), 2, 1e-12, "coordAt an edge between centres");
  near(F.coordAt(ax, 0), 0, 1e-12, "coordAt beyond the first centre");
  ok(F.cellOf(ax, 2.4) === 2 && F.cellOf(ax, 9) === -1, "cellOf");
  const down = { values: Float64Array.of(3.5, 2.5, 1.5, 0.5) };
  ok(F.cellOf(down, 3.4) === 0, "cellOf a descending axis");
  ok(F.depthEdges([5, 15, 30], 3).join() === "0,10,22.5,37.5", "depth edges");
}

console.log(`frame: globe, map, unfold, range, cuts and picks${fails ? `, ${fails} failing` : ", all agree"}`);
process.exit(fails ? 1 : 0);
