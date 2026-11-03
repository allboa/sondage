// Named palettes for scene layers: a scenespec palette is a name and a
// value range, so a renderer needs its own table of names. Each is a list
// of RGB stops spaced evenly from the start of the range to its end;
// values outside the range are clamped, as the spec says. A style may also
// say scale "log10": the stops are then spaced evenly over the logs of the
// range, as ocean colour is drawn (scenespec has no such field yet; see
// rampPos).

// "RRGGBB RRGGBB ..." as RGB stops
const hexStops = (s) => s.trim().split(/\s+/).map((h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)));

// The SeaWiFS chlorophyll-a palette, as CRAN palr's chl_pal() carries it
// (derived there from the NASA OBPG palette_chl_etc table): magenta through
// blue, cyan, green, yellow and red to dark red, over log10 chlorophyll from
// 0.01 to 20 mg m-3. These are palr's 254 colours between its two black
// ends (below 0.01 and at 1000 and over), so with range [0.01, 20] and scale
// "log10" a value takes the colour palr gives it, to within one step.
const CHL = hexStops(
  "90006F 8D0072 8A0075 870078 84007B 81007E 7E0081 7B0084 780087 75008A 72008D 6F0090 " +
  "6C0093 690096 660099 63009C 60009F 5D00A2 5A00A5 5700A8 5400AB 5100AE 4E00B1 4B00B4 " +
  "4800B7 4500BA 4200BD 3F00C0 3C00C3 3900C6 3600C9 3300CC 3000CF 2D00D2 2A00D5 2700D8 " +
  "2400DB 2100DE 1E00E1 1B00E4 1800E7 1500EA 1200ED 0F00F0 0C00F3 0900F6 0600F9 0000FC " +
  "0000FF 0005FF 000AFF 0010FF 0015FF 001AFF 0020FF 0025FF 002AFF 0030FF 0035FF 003AFF " +
  "0040FF 0045FF 004AFF 0050FF 0055FF 005AFF 0060FF 0065FF 006AFF 0070FF 0075FF 007AFF " +
  "0080FF 0085FF 008AFF 0090FF 0095FF 009AFF 00A0FF 00A5FF 00AAFF 00B0FF 00B5FF 00BAFF " +
  "00C0FF 00C5FF 00CAFF 00D0FF 00D5FF 00DAFF 00E0FF 00E5FF 00EAFF 00F0FF 00F5FF 00FAFF " +
  "00FFFF 00FFF7 00FFEF 00FFE7 00FFDF 00FFD7 00FFCF 00FFC7 00FFBF 00FFB7 00FFAF 00FFA7 " +
  "00FF9F 00FF97 00FF8F 00FF87 00FF7F 00FF77 00FF6F 00FF67 00FF5F 00FF57 00FF4F 00FF47 " +
  "00FF3F 00FF37 00FF2F 00FF27 00FF1F 00FF17 00FF0F 00FF00 08FF00 10FF00 18FF00 20FF00 " +
  "28FF00 30FF00 38FF00 40FF00 48FF00 50FF00 58FF00 60FF00 68FF00 70FF00 78FF00 80FF00 " +
  "88FF00 90FF00 98FF00 A0FF00 A8FF00 B0FF00 B8FF00 C0FF00 C8FF00 D0FF00 D8FF00 E0FF00 " +
  "E8FF00 F0FF00 F8FF00 FFFF00 FFFB00 FFF700 FFF300 FFEF00 FFEB00 FFE700 FFE300 FFDF00 " +
  "FFDB00 FFD700 FFD300 FFCF00 FFCB00 FFC700 FFC300 FFBF00 FFBB00 FFB700 FFB300 FFAF00 " +
  "FFAB00 FFA700 FFA300 FF9F00 FF9B00 FF9700 FF9300 FF8F00 FF8B00 FF8700 FF8300 FF7F00 " +
  "FF7B00 FF7700 FF7300 FF6F00 FF6B00 FF6700 FF6300 FF5F00 FF5B00 FF5700 FF5300 FF4F00 " +
  "FF4B00 FF4700 FF4300 FF3F00 FF3B00 FF3700 FF3300 FF2F00 FF2B00 FF2700 FF2300 FF1F00 " +
  "FF1B00 FF1700 FF1300 FF0F00 FF0B00 FF0700 FF0300 FF0000 FA0000 F50000 F00000 EB0000 " +
  "E60000 E10000 DC0000 D70000 D20000 CD0000 C80000 C30000 BE0000 B90000 B40000 AF0000 " +
  "AA0000 A50000 A00000 9B0000 960000 910000 8C0000 870000 820000 7D0000 780000 730000 " +
  "6E0000 690000");

export const PALETTES = {
  viridis: [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]],
  terrain: [[44, 123, 182], [171, 217, 233], [255, 255, 191], [166, 217, 106], [26, 150, 65], [140, 81, 10], [245, 245, 245]],
  ocean: [[8, 29, 88], [37, 52, 148], [34, 94, 168], [29, 145, 192], [65, 182, 196], [127, 205, 187], [199, 233, 180]],
  ice: [[4, 6, 19], [42, 52, 112], [62, 108, 160], [102, 165, 196], [168, 214, 226], [240, 250, 250]],
  blues: [[247, 251, 255], [198, 219, 239], [107, 174, 214], [33, 113, 181], [8, 48, 107]],
  grey: [[0, 0, 0], [255, 255, 255]],
  diverging: [[33, 102, 172], [146, 197, 222], [247, 247, 247], [244, 165, 130], [178, 24, 43]],
  chl: CHL
};

// Where a value sits along a style's ramp: 0 at range[0], 1 at range[1],
// outside that beyond the ends. With scale "log10" the position is along
// the logs of the range, and a value at or below zero is below the start
// (-Infinity). range is { range, scale } (a layer's style, or a scenespec
// palette with the extra field).
export function rampPos({ range: [lo, hi], scale = null }) {
  if (scale === "log10") {
    const a = Math.log10(lo), b = Math.log10(hi);
    return (v) => (v > 0 ? (Math.log10(v) - a) / (b - a) : -Infinity);
  }
  return (v) => (v - lo) / (hi - lo);
}

// A value at a position along the ramp (the inverse of rampPos), for
// legends and tick labels.
export function rampValue({ range: [lo, hi], scale = null }, t) {
  if (scale === "log10") return 10 ** (Math.log10(lo) + t * (Math.log10(hi) - Math.log10(lo)));
  return lo + t * (hi - lo);
}

// t in 0..1 to [r, g, b] (0 to 255) along a list of stops.
export function rampAt(stops, t) {
  t = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t)), f = t - i;
  const a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

// A scenespec palette { name, range } (and scale, see rampPos) as
// v -> [r, g, b], or null for a name not in the table (the spec says a
// renderer reports that rather than substituting). A reversed range
// reverses the ramp; NaN gives null.
export function palette(p) {
  const stops = PALETTES[p && p.name];
  if (!stops) return null;
  const pos = rampPos(p);
  return (v) => (Number.isFinite(v) ? rampAt(stops, pos(v)) : null);
}
