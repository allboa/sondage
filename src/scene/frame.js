// Where things go: one frame for every layer, on a globe or a map.
//
// Every vertex is kept as (lon, lat, r) (r in Earth radii, 1 at the
// surface, less below it) and placed in a frame on the view's centre: x
// east, y north, z up, with the centre on the surface at the origin. On the
// globe that is the sphere turned to face the viewer; on a map it is the
// projection's (x, y) in Earth radii and z = r - 1, so depth goes down from
// the plane by the same exaggeration. Unfold (t) moves every vertex in a
// straight line between the two. Only what lies within the range of the
// centre is drawn, and on a map a triangle or line that would cross a cut
// of the projection (the antipode, the edge of the Spilhaus square) is left
// out. A pick goes back to the Earth through the hit triangle's barycentric
// weights, whatever the view and unfold.
//
//   const frame = makeFrame(scene);
//   frame.set({ key: "aeqd", lon0: 75, lat0: -58, rangeKm: 3000, t: 1 });
//   const g = frame.gridGeometry(90, 45, (u, v) => [lon(u), lat(v), 1]);
//   frame.root.add(new THREE.Mesh(g, material));
//   frame.relayout();                         // after set() changes the view
//   frame.earthAt(hit) -> { lon, lat, r }     // from a raycaster hit

import * as THREE from "three";
import * as spilhaus from "../core/families/spilhaus.js";

const D2R = Math.PI / 180;
export const EARTH_R = 6371000;
export const VIEWS = ["globe", "aeqd", "spilhaus"];

// lon, lat (degrees) and a radius to a point, y up (the pole), lon 0
// towards +x
export function toVec(lon, lat, r, out = new THREE.Vector3()) {
  const c = Math.cos(lat * D2R);
  return out.set(r * c * Math.cos(lon * D2R), r * Math.sin(lat * D2R), -r * c * Math.sin(lon * D2R));
}
export function fromVec(p) {
  const r = p.length();
  return { lon: Math.atan2(-p.z, p.x) / D2R, lat: Math.asin(p.y / r) / D2R, r };
}

// Azimuthal equidistant on the sphere about (lon0, lat0), in Earth radii:
// the distance from the centre is kept along every great circle through it.
export function aeqd(lon0, lat0) {
  const s0 = Math.sin(lat0 * D2R), c0 = Math.cos(lat0 * D2R);
  return (lon, lat) => {
    const sp = Math.sin(lat * D2R), cp = Math.cos(lat * D2R), dl = (lon - lon0) * D2R, cl = Math.cos(dl);
    const cc = Math.max(-1, Math.min(1, s0 * sp + c0 * cp * cl)), c = Math.acos(cc);
    if (c > Math.PI - 1e-6) return null;
    const k = c < 1e-9 ? 1 : c / Math.sin(c);
    return [k * cp * Math.sin(dl), k * (c0 * sp - s0 * cp * cl)];
  };
}

export function makeFrame(parent) {
  const root = new THREE.Group();
  root.rotation.x = -Math.PI / 2; // the frame's z up is three.js's y up
  parent.add(root);

  const params = { key: "globe", lon0: 0, lat0: 0, rangeKm: 20000, t: 0 };
  const view = { key: "globe", E: new THREE.Vector3(), N: new THREE.Vector3(), U: new THREE.Vector3(), cosRange: -2, flat: null, lon0: 0, lat0: 0 };
  const unfold = () => (view.flat ? params.t : 0);

  // set any of key, lon0, lat0 (the centre; Spilhaus has its own),
  // rangeKm (20000 for the whole Earth) and t; then relayout() or reblend()
  function set(p = {}) {
    Object.assign(params, p);
    view.key = VIEWS.includes(params.key) ? params.key : "globe";
    let lon0 = params.lon0, lat0 = params.lat0;
    if (view.key === "spilhaus") { lon0 = spilhaus.defaults.lon0; lat0 = spilhaus.defaults.lat0; }
    view.lon0 = lon0; view.lat0 = lat0;
    toVec(lon0, lat0, 1, view.U);
    view.N.set(0, 1, 0).sub(view.U.clone().multiplyScalar(view.U.y));
    if (view.N.lengthSq() < 1e-12) view.N.set(-1, 0, 0);
    view.N.normalize();
    view.E.crossVectors(view.N, view.U).normalize();
    view.cosRange = params.rangeKm >= 20000 ? -2 : Math.cos((params.rangeKm * 1000) / EARTH_R);
    if (view.key === "aeqd") view.flat = aeqd(lon0, lat0);
    else if (view.key === "spilhaus") view.flat = (lon, lat) => { const q = spilhaus.project(lon, lat); return q && isFinite(q[0]) && isFinite(q[1]) ? [q[0], q[1]] : null; };
    else view.flat = null;
  }
  set();

  const placed = new Set();
  const v3a = new THREE.Vector3();
  // the two homes of (lon, lat, r): on the turned globe and on the map, or
  // null when it is out of range or off the map
  function homes(lon, lat, r) {
    toVec(lon, lat, 1, v3a);
    if (v3a.dot(view.U) < view.cosRange) return null;
    const g = [r * v3a.dot(view.E), r * v3a.dot(view.N), r * v3a.dot(view.U) - 1];
    if (!view.flat) return { g, f: g };
    const q = view.flat(lon, lat);
    if (!q || !isFinite(q[0]) || !isFinite(q[1])) return null;
    return { g, f: [q[0], q[1], r - 1] };
  }
  // both homes of every vertex, and which triangles (or segments) to draw
  function layout(geo) {
    const { llr, prims, per } = geo.userData, n = llr.length / 3;
    const G = new Float32Array(n * 3), Fl = new Float32Array(n * 3), ok = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const lon = llr[3 * i], lat = llr[3 * i + 1];
      const h = lon === lon && lat === lat ? homes(lon, lat, llr[3 * i + 2]) : null;
      if (!h) continue;
      ok[i] = 1;
      G.set(h.g, 3 * i); Fl.set(h.f, 3 * i);
    }
    const cut = view.flat ? 0.35 : Infinity, keep = [];
    for (let k = 0; k < prims.length; k += per) {
      let good = true;
      for (let a = 0; a < per && good; a++) {
        const i = prims[k + a];
        if (!ok[i]) good = false;
        else for (let b = a + 1; b < per && good; b++) {
          const j = prims[k + b];
          if (Math.hypot(Fl[3 * i] - Fl[3 * j], Fl[3 * i + 1] - Fl[3 * j + 1]) > cut) good = false;
        }
      }
      if (good) for (let a = 0; a < per; a++) keep.push(prims[k + a]);
    }
    geo.userData.G = G; geo.userData.F = Fl;
    geo.setIndex(keep);
    blend(geo);
  }
  function blend(geo) {
    const { G, F: Fl } = geo.userData, pos = geo.attributes.position.array, t = unfold();
    for (let i = 0; i < pos.length; i++) pos[i] = G[i] + (Fl[i] - G[i]) * t;
    geo.attributes.position.needsUpdate = true;
    geo.computeBoundingSphere();
  }
  // a geometry over vertices llr (lon, lat, r triples) with primitives of
  // per vertices each (3 triangles, 2 segments), kept placed by the frame
  function placedGeometry(llr, prims, per, uv = null) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(llr.length), 3));
    if (uv) g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.userData = { llr, prims, per };
    placed.add(g);
    layout(g);
    return g;
  }
  function drop(g) { placed.delete(g); g.dispose(); }
  const relayout = () => { for (const g of placed) layout(g); };
  const reblend = () => { for (const g of placed) blend(g); };

  // one point placed for the current view and unfold, or null
  function placePoint(lon, lat, r, out = new THREE.Vector3()) {
    const h = homes(lon, lat, r);
    if (!h) return null;
    const t = unfold();
    return out.set(h.g[0] + (h.f[0] - h.g[0]) * t, h.g[1] + (h.f[1] - h.g[1]) * t, h.g[2] + (h.f[2] - h.g[2]) * t);
  }

  // A mesh over a grid of (u, v) in [0, 1], placed by at(u, v) -> [lon, lat,
  // r]; uv runs with u and v, so a texture of the grid's cells drapes on it.
  function gridGeometry(nu, nv, at) {
    const n = (nu + 1) * (nv + 1), llr = new Float32Array(n * 3), uv = new Float32Array(n * 2);
    let p = 0, q = 0;
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      const u = i / nu, v = j / nv, [lon, lat, r] = at(u, v);
      const bad = lon === null || !isFinite(lon) || !isFinite(lat);
      llr[p++] = bad ? NaN : lon; llr[p++] = bad ? NaN : lat; llr[p++] = r;
      uv[q++] = u; uv[q++] = v;
    }
    const idx = [];
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
    return placedGeometry(llr, idx, 3, uv);
  }
  // line segments from a flat list of lon, lat, r pairs of points
  function lineGeometry(pairs, rgb = null) {
    const llr = pairs instanceof Float32Array ? pairs : Float32Array.from(pairs);
    const g = placedGeometry(llr, Array.from({ length: llr.length / 3 }, (_, i) => i), 2);
    if (rgb) g.setAttribute("color", new THREE.BufferAttribute(rgb, 3));
    return g;
  }

  // Back from the picture to the Earth: a raycaster hit on a placed mesh,
  // its barycentric weights in the triangle as drawn applied to the
  // triangle's corners on the Earth. Returns { lon, lat, r } or null.
  function earthAt(hit) {
    if (!hit || !hit.face || !hit.object.geometry.userData.llr) return null;
    const geo = hit.object.geometry, pos = geo.attributes.position, llr = geo.userData.llr;
    const local = hit.object.worldToLocal(hit.point.clone());
    const cs = [hit.face.a, hit.face.b, hit.face.c], P = cs.map((i) => new THREE.Vector3().fromBufferAttribute(pos, i));
    const w = new THREE.Triangle(P[0], P[1], P[2]).getBarycoord(local, new THREE.Vector3());
    const earth = new THREE.Vector3(), q = new THREE.Vector3();
    cs.forEach((i, k) => earth.add(toVec(llr[3 * i], llr[3 * i + 1], llr[3 * i + 2], q).multiplyScalar(w.getComponent(k))));
    return fromVec(earth);
  }

  return { root, view, params, set, homes, placedGeometry, gridGeometry, lineGeometry, drop, relayout, reblend, placePoint, earthAt };
}
