// The cutaway's drawing: a section painted as bands of rock, water and ice,
// and a block diagram cut along a line, in the line's own frame (s along
// the line, t across it, height up, from cutaway.place: flat, or bent over
// the sphere). A cut is what src/core/cutaway.js gives a page: the line
// frame f, the block's extent blk, the samples along the line (rows), the
// block's grid of samples (grid, nu by nv), the floor and top, and a drill
// site. Each sample's l is a layering (cutaway.layer: bed, top, base, ice,
// kind). Painting the section needs a 2D canvas, so this runs in a browser.
//
//   drawBlock(group, cut, { ve, ice: "solid" | "glass" | "off" });
//   paintBands(ctx2d, rows, floor, top, X, Y);   // the section, in a chart

import * as THREE from "three";
import * as C from "../core/cutaway.js";

export const INK = { rock: "#7a6552", water: "#1d5f9e", ice: "#e3f0fb", sky: "#05070d", bed: "#3a2c20", surface: "#ffffff", base: "#9cc8ec",
  rema: "#ffb347", gebco: "#7fe0ff", unc: "rgba(255,211,77,0.22)", ground: "#ff7ab8", grid: "rgba(160,200,255,0.16)", text: "#c4cedb" };

// The section's rock, water and ice as filled bands between the floor and
// the top, and a fine line at the base of floating ice. rows: [{ s, l }];
// X(s) and Y(height) in canvas pixels; bands picks some of the three (the
// base line goes with the ice).
export function paintBands(g, rows, floor, top, X, Y, bands = ["rock", "water", "ice"]) {
  const st = rows.map((r) => C.stack(r.l, floor));
  for (const [band, ink] of [["rock", INK.rock], ["water", INK.water], ["ice", INK.ice]]) {
    if (!bands.includes(band)) continue;
    g.fillStyle = ink;
    let run = [];
    const flush = () => {
      if (run.length > 1) {
        g.beginPath();
        run.forEach((i, k) => (k ? g.lineTo(X(rows[i].s), Y(st[i][band][1])) : g.moveTo(X(rows[i].s), Y(st[i][band][1]))));
        for (let k = run.length - 1; k >= 0; k--) g.lineTo(X(rows[run[k]].s), Y(st[run[k]][band][0]));
        g.closePath(); g.fill();
      }
      run = [];
    };
    rows.forEach((r, i) => (st[i] ? run.push(i) : flush()));
    flush();
  }
  if (!bands.includes("ice")) return;
  g.strokeStyle = INK.base; g.lineWidth = 1;
  g.beginPath();
  let pen = false;
  rows.forEach((r) => {
    if (r.l.kind === "floating") { const x = X(r.s), y = Y(r.l.base); pen ? g.lineTo(x, y) : g.moveTo(x, y); pen = true; } else pen = false;
  });
  g.stroke();
}

// A line through rows where get(row) has a value, broken where it has none.
export function sectionLine(g, rows, get, X, Y, ink, width = 1.5, dash = []) {
  g.strokeStyle = ink; g.lineWidth = width; g.setLineDash(dash);
  g.beginPath();
  let pen = false;
  for (const r of rows) {
    const v = get(r);
    if (v === v && v !== undefined) { pen ? g.lineTo(X(r.s), Y(v)) : g.moveTo(X(r.s), Y(v)); pen = true; } else pen = false;
  }
  g.stroke(); g.setLineDash([]);
}

// Take the block's meshes out of the group and free them.
export function clearBlock(group) {
  for (const o of [...group.children]) {
    group.remove(o); o.geometry.dispose();
    if (o.material.map) o.material.map.dispose();
    o.material.dispose();
  }
}

// the bed: where the ice was taken off as the capvis renders had it,
// blue under the sea by depth, and brown to sand above it
export function bedColour(l, h) {
  if (l.wasIce) return [0.4, 0.29, 0.2];
  if (h < 0) { const d = Math.max(0, Math.min(1, -h / 3000)); return [0.35 - 0.25 * d, 0.5 - 0.3 * d, 0.62 - 0.25 * d]; }
  const u = Math.max(0, Math.min(1, h / 3000));
  return [0.48 + 0.3 * u, 0.4 + 0.3 * u, 0.32 + 0.3 * u];
}

// The position of (s, t) at height m (metres), for a cut and a vertical
// exaggeration.
export const placeIn = (cut, ve) => (s, t, m) => C.place(s, t, m * ve, { curve: cut.curve, cs: cut.f.L / 2, ct: (cut.blk.t0 + cut.blk.t1) / 2 });

// how opaque see-through ice is, on its surfaces and the block's sides
const GLASS = 0.35;

// The block: the bed everywhere, the sea's surface over open water, the ice
// (solid, glass or off) at its top and under floating ice, the four sides
// painted with the section along them, and the drill site as a red rod.
export function drawBlock(group, cut, { ve, ice = "solid" } = {}) {
  clearBlock(group);
  if (!cut) return;
  const posOf = placeIn(cut, ve);
  const { grid, nu, nv, rows, f, blk, floor, top } = cut;

  // a surface over the block's grid: height(l) in metres or NaN, colour(l)
  // as [r, g, b] in 0..1; triangles only where all three corners have height
  const surface = (heightOf, colourOf, material) => {
    const n = grid.length, pos = new Float32Array(n * 3), col = new Float32Array(n * 3), ok = new Uint8Array(n);
    grid.forEach((g, k) => {
      const h = heightOf(g.l);
      if (h === h) { ok[k] = 1; pos.set(posOf(g.s, g.t, h), 3 * k); col.set(colourOf(g.l, h), 3 * k); }
    });
    const idx = [];
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
      if (ok[a] && ok[b] && ok[d]) idx.push(a, b, d);
      if (ok[a] && ok[d] && ok[c]) idx.push(a, d, c);
    }
    if (!idx.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, material);
    group.add(mesh);
    return mesh;
  };

  // one side: a vertical strip from (s0, t0) to (s1, t1), floor to top,
  // painted with the section along it (sky transparent); a strip of many
  // steps, so a curved block bends with it. With the ice see-through the
  // side is two strips on one shape: the rock solid, and the water and ice
  // as see-through as the ice's surfaces, so the block shows through its
  // walls.
  const glass = ice === "glass";
  const face = (side, s0, t0, s1, t1) => {
    const len = Math.hypot(s1 - s0, t1 - t0) || 1;
    const rr = side.map((r) => ({ s: Math.hypot(r.s0 - s0, r.t0 - t0), l: r.l }));
    const paint = (bands) => {
      const cv = document.createElement("canvas");
      cv.width = 1024; cv.height = 512;
      paintBands(cv.getContext("2d"), rr, floor, top, (d) => (d / len) * cv.width, (z) => ((top - z) / (top - floor)) * cv.height, bands);
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    };
    const n = cut.curve ? 96 : 1, pos = [], uv = [], idx = [];
    for (let q = 0; q <= n; q++) {
      const u = q / n, s = s0 + (s1 - s0) * u, t = t0 + (t1 - t0) * u;
      pos.push(...posOf(s, t, floor), ...posOf(s, t, top));
      uv.push(u, 0, u, 1);
      if (q) idx.push(2 * q - 2, 2 * q, 2 * q + 1, 2 * q - 2, 2 * q + 1, 2 * q - 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(pos), 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(Float32Array.from(uv), 2));
    geo.setIndex(idx);
    if (!glass) {
      group.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: paint(["rock", "water", "ice"]), transparent: true, alphaTest: 0.5, side: THREE.DoubleSide })));
      return;
    }
    group.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: paint(["rock"]), transparent: true, alphaTest: 0.5, side: THREE.DoubleSide })));
    group.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: paint(["water", "ice"]), transparent: true, opacity: GLASS, alphaTest: 0.01, depthWrite: false, side: THREE.DoubleSide })));
  };

  surface((l) => l.bed, bedColour, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  surface((l) => (l.kind === "sea" ? 0 : NaN), () => [0.12, 0.38, 0.62], new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }));
  if (ice !== "off") {
    const iceMat = () => new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: glass, opacity: glass ? GLASS : 1, depthWrite: !glass });
    surface((l) => (l.ice > 0 ? l.top : NaN), () => [0.92, 0.96, 1], iceMat());
    surface((l) => (l.kind === "floating" ? l.base : NaN), () => [0.62, 0.78, 0.92], iceMat());
  }
  // the cut along the line from the section itself, the others from the grid
  const edge = (pick) => grid.filter(pick).map((g) => ({ s0: g.s, t0: g.t, l: g.l }));
  face(rows.map((r) => ({ s0: r.s, t0: 0, l: r.l })), 0, 0, f.L, 0);
  face(edge((g, k) => Math.floor(k / (nu + 1)) === nv), 0, blk.t1, f.L, blk.t1);
  if (blk.t0 !== 0) face(edge((g, k) => Math.floor(k / (nu + 1)) === 0), 0, blk.t0, f.L, blk.t0);
  face(edge((g, k) => k % (nu + 1) === 0), 0, blk.t0, 0, blk.t1);
  face(edge((g, k) => k % (nu + 1) === nu), f.L, blk.t0, f.L, blk.t1);

  // the drill: a red rod from the bed up through the surface
  const st = cut.site;
  if (st && st.l.bed === st.l.bed) {
    const up = st.l.top === st.l.top ? st.l.top : 0, over = (top - floor) * 0.15;
    const a = new THREE.Vector3(...posOf(st.s, st.t, st.l.bed)), b = new THREE.Vector3(...posOf(st.s, st.t, up + over));
    const len = a.distanceTo(b), r = Math.max(f.L, Math.abs(blk.t1 - blk.t0)) / 1000 * 0.0025;
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 12), new THREE.MeshBasicMaterial({ color: 0xff2a2a }));
    rod.position.copy(a).add(b).multiplyScalar(0.5);
    rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    group.add(rod);
  }
}
