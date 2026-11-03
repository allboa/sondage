// Values to colour on the GPU's terms: a texture per grid of cells, painted
// through a layer's palette, and the material that drapes it.

import * as THREE from "three";
import { PALETTES, rampAt, rampPos } from "../core/palette.js";

// a w by h RGBA texture with sharp cells
export function makeTexture(w, h) {
  const t = new THREE.DataTexture(new Uint8Array(w * h * 4), w, h, THREE.RGBAFormat);
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

// fills sit a little behind in depth, so contour lines drawn on them win;
// transparent cells are cut out
export const cutout = (map) => new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide, alphaTest: 0.5, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });

// values (row major, w by h) into a texture through style.palette over
// style.range (on a log scale when style.scale is "log10"); NaN, values below the range when style.below is "clear", and
// cells the mask hides are transparent. get(i) reads value i (for a slice
// of a bigger array).
export function paint(tex, values, style, get = (i) => values[i], mask = null) {
  const { width: w, height: h, data } = tex.image;
  const stops = PALETTES[style.palette] || PALETTES.viridis, pos = rampPos(style);
  const clear = style.below === "clear";
  for (let i = 0, n = w * h; i < n; i++) {
    const v = get(i), o = i * 4;
    if (v !== v || (mask && mask[i])) { data[o + 3] = 0; continue; }
    const t = pos(v);
    if (clear && t < 0) { data[o + 3] = 0; continue; }
    const c = rampAt(stops, t);
    data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
  }
  tex.needsUpdate = true;
}

// a palette as a CSS linear-gradient's stops (at most n, evenly spaced
// along the ramp, so a long table stays a short string)
export function cssStops(style, n = 16) {
  const stops = PALETTES[style.palette] || PALETTES.viridis;
  const pick = stops.length <= n ? stops : Array.from({ length: n }, (_, i) => rampAt(stops, i / (n - 1)).map(Math.round));
  return pick.map((c) => `rgb(${c.join(",")})`).join(",");
}
