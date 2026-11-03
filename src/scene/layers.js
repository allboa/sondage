// Layers: what a Source's description becomes in a frame (frame.js).
//
// A surface layer is one texture of the whole grid on a mesh placed through
// the grid's own CRS. A volume layer is a box of the grid down to a depth:
// a shell at one level, the box's four walls and two sections that move
// across it (meridian and parallel), and its rim at the surface and at the
// deepest edge. Both build into a three.js group and return their parts;
// paintLayer() colours the parts from a read's values, and isoLayer() draws
// contour lines through the same cells. Nothing here reads data or touches
// the DOM: a page decides what to read and when.
//
//   const P = surfaceLayer(frame, group, desc, style, { crs, proj4 });
//   paintLayer(P, values, style);
//   reliefLayer(frame, P, values, 20);  // a topography lifted by its values
//   const P = volumeLayer(frame, group, desc, style, { box, zmax, lev, cl, cp, exag });
//   const w = P.w;          // the read window [y0, y1, x0, x1], levels P.k

import * as THREE from "three";
import * as F from "../core/fourd.js";
import { PALETTES, rampAt, rampPos } from "../core/palette.js";
import { makeTexture, cutout, paint, paintRGBA } from "./paint.js";

const axisAt = F.coordAt;

// (x, y) in a grid's CRS to [lon, lat], or [null, null] where it has none;
// the identity when the grid is in longitude and latitude
export function lonLatOf(crs, proj4) {
  if (!crs) return (x, y) => [x, y];
  const P = proj4(crs, "WGS84");
  return (x, y) => { const q = P.forward([x, y]); return isFinite(q[0]) && isFinite(q[1]) ? q : [null, null]; };
}

// Take everything out of a group, giving its geometry back to the frame.
export function clearGroup(frame, group) {
  for (const c of [...group.children]) {
    group.remove(c);
    frame.drop(c.geometry);
    if (c.material.map) c.material.map.dispose();
    c.material.dispose();
  }
}

// The whole grid as one surface, lifted above the sphere by style.lift
// steps (so several surfaces stack). opts: crs (a proj4 string, or none
// for longitude and latitude), proj4, and tag (set as each mesh's
// userData.layer, for picking).
// style.clip_lat clears every cell north of that latitude (a chart's
// neatline); style.relief asks for a finer mesh, for reliefLayer(). An
// image description (desc.rgba) paints its own colours.
export function surfaceLayer(frame, group, desc, style, { crs = null, proj4 = null, tag = null } = {}) {
  const ax = desc.axes;
  if (!ax.x || !ax.y) return { error: "no horizontal axes" };
  const toLonLat = lonLatOf(crs, proj4);
  const nx = ax.x.n, ny = ax.y.n, w = [0, ny, 0, nx];
  const tex = makeTexture(nx, ny);
  const lift = 1 + 0.0012 * (1 + (style.lift || 0));
  const fine = style.relief ? 3 : 1;
  const nu = Math.min(nx, (crs ? 120 : 360) * fine), nv = Math.min(ny, (crs ? 120 : 180) * fine);
  const at = (rOf) => (u, v) => { const [lon, lat] = toLonLat(axisAt(ax.x, u * nx), axisAt(ax.y, v * ny)); return [lon, lat, rOf(u, v)]; };
  const geo = frame.gridGeometry(nu, nv, at(() => lift));
  const mesh = new THREE.Mesh(geo, cutout(tex));
  mesh.userData.layer = tag;
  group.add(mesh);
  // the centre of every cell as lon, lat (for a page's cut over a box)
  const centres = new Float32Array(nx * ny * 2);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const [lon, lat] = toLonLat(ax.x.values[i], ax.y.values[j]);
    centres[(j * nx + i) * 2] = lon === null ? NaN : lon; centres[(j * nx + i) * 2 + 1] = lat === null ? NaN : lat;
  }
  let clip = null;
  if (style.clip_lat !== undefined && style.clip_lat !== null) {
    clip = new Uint8Array(nx * ny);
    for (let q = 0; q < clip.length; q++) { const lat = centres[2 * q + 1]; clip[q] = lat === lat && lat <= style.clip_lat ? 0 : 1; }
  }
  // contours run through cell centres; a mask hides cells as the fill does
  const P = { kind: "surface", w, k: 0, tex, mesh, centres, toLonLat, nx, ny, fills: [mesh], group, lift, nu, nv, at, clip, rgba: !!desc.rgba,
    rAt: () => lift };
  P.iso = [{ w: nx, h: ny, at: (values, mask) => (i, j) => { const q = j * nx + i; return (mask && mask[q]) || (clip && clip[q]) ? NaN : values[q]; },
    place: (x, y) => [...toLonLat(axisAt(ax.x, x + 0.5), axisAt(ax.y, y + 0.5)), P.rAt((x + 0.5) / nx, (y + 0.5) / ny) + 0.0003] }];
  return P;
}

// A surface layer's mesh lifted by its own values (metres, up positive) times
// exag: sea floor below the sphere, land and ice above it. Each vertex takes
// the value of the cell it falls in; a cell with no value stays at the
// layer's height. Contours follow (P.rAt). Call again with new values or a
// new exaggeration; exag 0 lays it flat.
export function reliefLayer(frame, P, values, exag) {
  const s = exag / F.EARTH_R, { nx, ny, lift } = P;
  const cell = (u, v) => {
    const i = Math.min(nx - 1, Math.max(0, Math.floor(u * nx))), j = Math.min(ny - 1, Math.max(0, Math.floor(v * ny)));
    return values[j * nx + i];
  };
  P.rAt = (u, v) => { const z = cell(u, v); return z === z ? lift + z * s : lift; };
  const old = P.mesh.geometry;
  P.mesh.geometry = frame.gridGeometry(P.nu, P.nv, P.at(P.rAt));
  frame.drop(old);
  P.relief = exag;
  return P;
}

// A box of the grid down to a depth. opts: box [lon0, lon1, lat0, lat1],
// zmax (m), lev (the shell's level), cl and cp (where the meridian and
// parallel sections sit across the box, 0 to 1), exag (vertical
// exaggeration), rim (the rim's colour), tag. Longitude and latitude grids
// only, for now.
export function volumeLayer(frame, group, desc, style, { crs = null, box, zmax, lev = 0, cl = 0.5, cp = 0.5, exag = 1000, rim = 0xffd34d, tag = null } = {}) {
  const ax = desc.axes;
  if (!ax.x || !ax.y) return { error: "no horizontal axes" };
  if (crs) return { error: "an ocean layer in a projected CRS is not drawn yet" };
  const wy = F.windowOf(ax.y, box[2], box[3]), wx = F.windowOf(ax.x, box[0], box[1], { lon: true });
  if (!wy || !wx) return { error: "the box is outside this grid" };
  const z = ax.z ? ax.z.values : Float64Array.of(0);
  let nk = 1;
  while (nk < z.length && z[nk] <= zmax) nk++;
  const ny = wy[1] - wy[0], nx = wx[1] - wx[0];
  lev = Math.min(lev, nk - 1);
  const edges = F.depthEdges(z, nk), X = exag;
  const lonAt = (u) => axisAt(ax.x, wx[0] + u * nx), latAt = (v) => axisAt(ax.y, wy[0] + v * ny);
  const shellTex = makeTexture(nx, ny);
  const shell = new THREE.Mesh(frame.gridGeometry(Math.min(nx, 240), Math.min(ny, 240), (u, v) => [lonAt(u), latAt(v), F.depthRadius(z[lev], X)]), cutout(shellTex));
  const ci = Math.min(nx - 1, Math.round(cl * (nx - 1))), rj = Math.min(ny - 1, Math.round(cp * (ny - 1)));
  const lonC = ax.x.values[wx[0] + ci], latC = ax.y.values[wy[0] + rj];
  const rAt = (v) => { const k = v * nk, i = Math.min(nk - 1, Math.floor(k)); return F.depthRadius(edges[i] + (edges[i + 1] - edges[i]) * (k - i), X); };
  // vertical sections, all levels: along a meridian at column c (cells
  // along y) or a parallel at row r (cells along x); the four walls of the
  // box and the two that move across it
  const sections = [];
  const section = (along, at) => {
    const n = along === "m" ? ny : nx, tex = makeTexture(n, nk);
    const lonS = along === "m" ? () => axisAt(ax.x, wx[0] + at + 0.5) : lonAt;
    const latS = along === "m" ? latAt : () => axisAt(ax.y, wy[0] + at + 0.5);
    const mesh = new THREE.Mesh(frame.gridGeometry(Math.min(n, 240), nk, (u, v) => [lonS(u), latS(u), rAt(v)]), cutout(tex));
    sections.push({ along, at, tex, mesh });
  };
  section("m", 0); section("m", nx - 1); section("p", 0); section("p", ny - 1);
  section("m", ci); section("p", rj);
  // the box's rim at the surface and at the deepest edge
  const seg = [];
  for (const r of [1.0015, F.depthRadius(edges[nk], X)]) {
    const ring = [];
    for (let s = 0; s <= 64; s++) ring.push([lonAt(s / 64), latAt(0)]);
    for (let s = 0; s <= 64; s++) ring.push([lonAt(1), latAt(s / 64)]);
    for (let s = 64; s >= 0; s--) ring.push([lonAt(s / 64), latAt(1)]);
    for (let s = 64; s >= 0; s--) ring.push([lonAt(0), latAt(s / 64)]);
    for (let s = 0; s + 1 < ring.length; s++) seg.push(ring[s][0], ring[s][1], r, ring[s + 1][0], ring[s + 1][1], r);
  }
  const rimLines = new THREE.LineSegments(frame.lineGeometry(seg), new THREE.LineBasicMaterial({ color: rim, transparent: true, opacity: 0.6 }));
  for (const m of [shell, ...sections.map((q) => q.mesh)]) { m.userData.layer = tag; group.add(m); }
  group.add(rimLines);
  // contours on the shell and on each section, through cell centres
  const n = nx * ny, rShell = F.depthRadius(z[lev], X);
  const iso = [{ w: nx, h: ny, at: (values) => (i, j) => values[lev * n + j * nx + i],
    place: (x, y) => [axisAt(ax.x, wx[0] + x + 0.5), axisAt(ax.y, wy[0] + y + 0.5), rShell] }];
  for (const q of sections) {
    const rv = (y) => rAt((y + 0.5) / nk);
    if (q.along === "m") iso.push({ w: ny, h: nk, at: (values) => (i, k) => values[k * n + i * nx + q.at],
      place: (x, y) => [axisAt(ax.x, wx[0] + q.at + 0.5), axisAt(ax.y, wy[0] + x + 0.5), rv(y)] });
    else iso.push({ w: nx, h: nk, at: (values) => (i, k) => values[k * n + q.at * nx + i],
      place: (x, y) => [axisAt(ax.x, wx[0] + x + 0.5), axisAt(ax.y, wy[0] + q.at + 0.5), rv(y)] });
  }
  return { kind: "volume", w: [wy[0], wy[1], wx[0], wx[1]], k: [0, nk], nk, nx, ny, lev, ci, rj, lonC, latC, z, edges, shellTex, shell, sections,
    fills: [shell, ...sections.map((q) => q.mesh)], iso, group };
}

// Colour a layer's parts from values read over its window (levels by rows
// by columns for a volume); mask hides surface cells.
export function paintLayer(P, values, style, mask = null) {
  if (P.kind === "surface") {
    const m = P.clip && mask ? P.clip.map((c, i) => c | mask[i]) : (P.clip || mask);
    if (P.rgba) paintRGBA(P.tex, values, m); else paint(P.tex, values, style, undefined, m);
    return;
  }
  const { nx, ny, lev } = P, n = nx * ny;
  paint(P.shellTex, values, style, (i) => values[lev * n + i]);
  for (const q of P.sections) {
    if (q.along === "m") paint(q.tex, values, style, (i) => { const j = i % ny, k = (i / ny) | 0; return values[k * n + j * nx + q.at]; });
    else paint(q.tex, values, style, (i) => { const x = i % nx, k = (i / nx) | 0; return values[k * n + q.at * nx + x]; });
  }
}

// Contour lines of a layer's values, mode "lines" (coloured by the palette
// at their level) or "both" (dark, over the fill); "fill" draws none. Levels
// at style.iso_step, or ten steps over style.range, plus the low end for a
// layer that clears below it (an ice edge). Replaces the lines the parts
// had; the fills are hidden for "lines" but stay in place, so picking still
// answers. On a log scale (style.scale "log10") the levels are 1 and 3 times
// each power of ten in the range. Returns the new lines, or null.
export function isoLayer(frame, P, values, style, mode, mask = null) {
  if (P.isoLines) { P.group.remove(P.isoLines); frame.drop(P.isoLines.geometry); P.isoLines.material.dispose(); P.isoLines = null; }
  for (const m of P.fills) m.visible = mode !== "lines";
  if (mode !== "lines" && mode !== "both") return null;
  const levels = F.isoLevels(style.range, { n: 10, step: style.iso_step ?? null, edge: style.below === "clear", log: style.scale === "log10" });
  const stops = PALETTES[style.palette] || PALETTES.viridis, pos = rampPos(style);
  const cols = levels.map((c) => (mode === "both" ? [0.05, 0.06, 0.09] : rampAt(stops, pos(c)).map((x) => x / 255)));
  const llr = [], rgb = [];
  for (const s of P.iso) {
    const { xy, lev } = F.isolines(s.w, s.h, s.at(values, mask), levels);
    for (let q = 0; q < lev.length; q++) for (const o of [0, 2]) {
      const p = s.place(xy[4 * q + o], xy[4 * q + o + 1]);
      llr.push(p[0] ?? NaN, p[1] ?? NaN, p[2]);
      rgb.push(...cols[lev[q]]);
    }
  }
  if (!llr.length) return null;
  P.isoLines = new THREE.LineSegments(frame.lineGeometry(Float32Array.from(llr), Float32Array.from(rgb)),
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: mode === "both", opacity: mode === "both" ? 0.8 : 1 }));
  P.group.add(P.isoLines);
  return P.isoLines;
}
