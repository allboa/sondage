// Layers (src/scene/layers.js) built from descriptions in Node: a surface
// over a whole grid and an ocean box from the synthetic ocean, painted from
// values, with contour lines; and the read window each one asks for.
import * as THREE from "three";
import { makeFrame } from "../src/scene/frame.js";
import { surfaceLayer, volumeLayer, paintLayer, isoLayer, reliefLayer, clearGroup } from "../src/scene/layers.js";
import * as F from "../src/core/fourd.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log("FAIL " + msg); } };

const scene = new THREE.Scene(), frame = makeFrame(scene);
frame.set({ key: "globe", lon0: 75, lat0: -58 });
const syn = F.syntheticOcean();
const style = { palette: "viridis", range: [0, 12], iso_step: 1 };

// the ocean box: window, levels to the depth asked for, six sections, rim
{
  const g = new THREE.Group();
  const P = volumeLayer(frame, g, syn.desc, style, { box: [60, 90, -70, -45], zmax: 1000, lev: 3, exag: 1000 });
  ok(!P.error, `volume: ${P.error}`);
  const ax = syn.desc.axes;
  const wx = F.windowOf(ax.x, 60, 90, { lon: true }), wy = F.windowOf(ax.y, -70, -45);
  ok(P.w.join() === [wy[0], wy[1], wx[0], wx[1]].join(), `volume window ${P.w}`);
  ok(P.k[1] === P.nk && ax.z.values[P.nk - 1] <= 1000 && (P.nk === ax.z.n || ax.z.values[P.nk] > 1000), `levels to 1000 m: ${P.nk}`);
  ok(P.sections.length === 6 && g.children.length === 8, `six sections, a shell and a rim: ${g.children.length}`);
  const values = syn.read(0, 0, P.w[0], P.w[1], P.w[2], P.w[3]);
  const stack = new Float32Array(P.nk * P.nx * P.ny);
  for (let k = 0; k < P.nk; k++) stack.set(syn.read(0, k, P.w[0], P.w[1], P.w[2], P.w[3]), k * P.nx * P.ny);
  paintLayer(P, stack, style);
  ok(P.shellTex.image.data[3] === 255, "the shell is painted");
  const lines = isoLayer(frame, P, stack, style, "both");
  ok(lines && lines.geometry.index.count > 0, "contours on the shell and sections");
  ok(P.fills.every((m) => m.visible), "fills stay for both");
  isoLayer(frame, P, stack, style, "lines");
  ok(P.fills.every((m) => !m.visible), "fills hide for lines alone");
  isoLayer(frame, P, stack, style, "fill");
  ok(!P.isoLines && P.fills.every((m) => m.visible), "fill drops the lines");
  clearGroup(frame, g);
  ok(g.children.length === 0, "cleared");
  ok(values.length === P.nx * P.ny, "a level's read fits the window");
}
// a box outside the grid says so; a projected volume is refused for now
{
  const g = new THREE.Group();
  ok(volumeLayer(frame, g, syn.desc, style, { box: [60, 90, 80, 85], zmax: 100 }).error, "box outside the grid");
  ok(volumeLayer(frame, g, syn.desc, style, { crs: "+proj=stere", box: [60, 90, -70, -45], zmax: 100 }).error, "projected volume refused");
}
// a surface over a whole grid, with a mask and the low end cleared
{
  const desc = { axes: { x: { n: 8, values: Float64Array.from({ length: 8 }, (_, i) => 22.5 + 45 * i) }, y: { n: 4, values: Float64Array.of(-67.5, -22.5, 22.5, 67.5) } } };
  const g = new THREE.Group();
  const P = surfaceLayer(frame, g, desc, { ...style, below: "clear", range: [1, 12] });
  ok(P.kind === "surface" && P.w.join() === "0,4,0,8", `surface window ${P.w}`);
  const v = Float32Array.from({ length: 32 }, (_, i) => i % 12);
  const mask = new Uint8Array(32); mask[5] = 1;
  paintLayer(P, v, { ...style, below: "clear", range: [1, 12] }, mask);
  const a = (i) => P.tex.image.data[4 * i + 3];
  ok(a(0) === 0 && a(1) === 255 && a(5) === 0, "cleared below the range and masked cells are transparent");
  ok(P.centres[0] === 22.5 && P.centres[1] === -67.5, "cell centres as lon, lat");
}

console.log(`layers: surface and ocean box built, painted and contoured${fails ? `, ${fails} failing` : ", all agree"}`);
process.exit(fails ? 1 : 0);// a topography in relief, an image clipped at a latitude
{
  const n = 8, desc = { axes: { x: { n: 2 * n, values: Float64Array.from({ length: 2 * n }, (_, i) => -180 + (360 / (2 * n)) * (i + 0.5)) },
    y: { n, values: Float64Array.from({ length: n }, (_, j) => 90 - (180 / n) * (j + 0.5)) } } };
  const g = new THREE.Group();
  const topo = { palette: "topo", range: [-6000, 6000], relief: true, lift: 0 };
  const P = surfaceLayer(frame, g, desc, topo);
  const vals = Float32Array.from({ length: 2 * n * n }, (_, i) => (i % (2 * n) < n ? -4000 : 2000));
  reliefLayer(frame, P, vals, 100);
  const llr = P.mesh.geometry.userData.llr, rs = [];
  for (let q = 2; q < llr.length; q += 3) rs.push(llr[q]);
  const lo = P.lift - (4000 * 100) / F.EARTH_R, hi = P.lift + (2000 * 100) / F.EARTH_R;
  ok(rs.every((r) => Math.abs(r - lo) < 1e-6 || Math.abs(r - hi) < 1e-6), "relief: every vertex at its cell's height");
  ok(rs.some((r) => r < 1) && rs.some((r) => r > 1), "relief: sea floor below the sphere, land above");
  paintLayer(P, vals, topo);
  ok(P.tex.image.data[3] === 255, "topography painted");
  const lines = isoLayer(frame, P, vals, { ...topo, iso_step: 1000 }, "lines");
  ok(lines && lines.geometry.userData.llr[2] > lo, "contours ride on the relief");
  const img = surfaceLayer(frame, g, { ...desc, rgba: true }, { clip_lat: -45 });
  const rgba = new Uint8Array(2 * n * n * 4).fill(200);
  paintLayer(img, rgba, {});
  const a = (j) => img.tex.image.data[4 * (j * 2 * n) + 3];
  ok(a(0) === 0 && a(n - 1) === 255 && img.tex.image.data[4 * (2 * n * (n - 1))] === 200, "image: its own colours, cleared north of the clip");
  clearGroup(frame, g);
}


